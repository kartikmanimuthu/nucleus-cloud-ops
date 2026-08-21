/**
 * Two-level ability cache.
 *
 * Two levels rather than one because rules belong to a ROLE but conditions
 * resolve against a PERSON: two users holding the same role but different
 * principal attributes need different final rules, while still sharing the
 * expensive registry load and expansion.
 *
 *   L1  tenantId:roleId:version                    -> registry snapshot + raw rule rows
 *   L2  tenantId:roleId:version:attributesHash     -> the compiled CASL ability
 *
 * Entries are keyed by RBAC version, which makes them immutable: bumping the
 * version does not clear anything, it makes the old keys unreachable and they
 * fall out of the LRU naturally. That is why there is no TTL on either level and
 * no invalidation message to get wrong.
 *
 * Steady state per request: zero database queries, plus one two-row version probe
 * per 5 seconds per ECS task. The 5s probe TTL is the documented revocation SLA —
 * a permission change applies within ~5s. For the coarse emergency case there is
 * the immediate `mode: 'deny'` route override instead.
 */

import { createHash } from 'node:crypto';

import { createMongoAbility } from '@casl/ability';
import { buildActionAliasMap, compileRules } from '@nucleus/rbac';
import type { AbilityPrincipal, AppAbility, DroppedRule, RbacRoleRuleRow, RegistrySnapshot } from '@nucleus/rbac';

import { loadRegistrySnapshot, loadRoleRules, readRbacVersion } from './registry';

const MAX_ENTRIES = 500;
const VERSION_TTL_MS = 5_000;

/** Insertion-ordered Map used as an LRU — re-set on read to move to the end. */
class LruCache<V> {
    private readonly store = new Map<string, V>();

    constructor(private readonly max: number) {}

    get(key: string): V | undefined {
        const value = this.store.get(key);
        if (value === undefined) return undefined;
        this.store.delete(key);
        this.store.set(key, value);
        return value;
    }

    set(key: string, value: V): void {
        if (this.store.has(key)) this.store.delete(key);
        this.store.set(key, value);
        if (this.store.size > this.max) {
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) this.store.delete(oldest);
        }
    }

    get size(): number {
        return this.store.size;
    }

    clear(): void {
        this.store.clear();
    }
}

interface RoleRulesEntry {
    registry: RegistrySnapshot;
    rules: RbacRoleRuleRow[];
}

export interface CompiledAbility {
    ability: AppAbility;
    dropped: DroppedRule[];
    version: string;
    /**
     * Action key -> terminal action. Rules are compiled with terminal verbs, so a
     * check for an aliased verb ('execute', 'validate') must be translated before
     * it reaches CASL. See buildActionAliasMap().
     */
    actionAliases: Record<string, string>;
}

const roleRulesCache = new LruCache<RoleRulesEntry>(MAX_ENTRIES);
const abilityCache = new LruCache<CompiledAbility>(MAX_ENTRIES);
const registrySnapshotCache = new LruCache<RegistrySnapshot>(MAX_ENTRIES);

interface VersionProbe {
    value: string;
    readAt: number;
}
const versionProbes = new Map<string, VersionProbe>();

/**
 * In-flight de-duplication: a cold cache under concurrent load would otherwise
 * compile the same key N times. Callers share one promise.
 */
const inFlight = new Map<string, Promise<CompiledAbility>>();

/** `${globalVersion}.${tenantVersion}`, memoised for 5s per task. */
export async function getRbacVersion(tenantId: string): Promise<string> {
    const cached = versionProbes.get(tenantId);
    const now = Date.now();
    if (cached && now - cached.readAt < VERSION_TTL_MS) return cached.value;

    const value = await readRbacVersion(tenantId);
    versionProbes.set(tenantId, { value, readAt: now });
    return value;
}

/** Stable fingerprint of the principal's attributes — two users with none share an entry. */
export function hashAttributes(attributes: Record<string, unknown>): string {
    const entries = Object.entries(attributes)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return 'none';
    return createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

async function loadRoleRulesCached(tenantId: string, roleId: string, version: string): Promise<RoleRulesEntry> {
    const key = `${tenantId}:${roleId}:${version}`;
    const hit = roleRulesCache.get(key);
    if (hit) return hit;

    const [registry, rules] = await Promise.all([loadRegistrySnapshot(tenantId), loadRoleRules(tenantId, roleId)]);
    const entry: RoleRulesEntry = { registry, rules };
    roleRulesCache.set(key, entry);
    return entry;
}

/**
 * Cached registry snapshot, keyed by RBAC version — same immutable-key idiom
 * as the rest of this file (module doc comment above): a version bump makes
 * the previous key unreachable rather than clearing anything, so this stays
 * fresh the moment the registry actually changes and never any staler than
 * that.
 *
 * For callers that need the registry ALONE, with no role in hand — the page
 * guard in middleware.ts being the motivating case. Before this existed,
 * `enforcePageRead` called the raw `loadRegistrySnapshot` (7 findMany's) on
 * every `/app/*` navigation, including RSC/prefetch requests the Next.js
 * middleware matcher also covers, with no cache at all.
 *
 * Deliberately separate from `loadRoleRulesCached` above rather than built on
 * top of it: that cache is keyed by roleId (it bundles the registry with one
 * role's rules), so reusing it here would mean either fabricating a roleId or
 * fetching once per role per version instead of once per tenant per version.
 */
export async function getCachedRegistrySnapshot(tenantId: string): Promise<RegistrySnapshot> {
    const version = await getRbacVersion(tenantId);
    const key = `${tenantId}:${version}`;
    const hit = registrySnapshotCache.get(key);
    if (hit) return hit;

    const registry = await loadRegistrySnapshot(tenantId);
    registrySnapshotCache.set(key, registry);
    return registry;
}

/**
 * Compiles (or returns a cached) ability for a principal.
 *
 * Fail-closed contract (section 8.7): a principal with no resolvable role gets an
 * EMPTY ability, which denies everything. Compiler exceptions propagate — the
 * caller turns them into a 500, never into an allow.
 */
export async function getAbilityForPrincipal(principal: AbilityPrincipal): Promise<CompiledAbility> {
    const version = await getRbacVersion(principal.tenantId);

    if (principal.isSuperAdmin) {
        const { rules, dropped } = compileRules(
            { tenantId: principal.tenantId } as RegistrySnapshot,
            [],
            principal
        );
        return { ability: createMongoAbility(rules), dropped, version, actionAliases: {} };
    }

    if (!principal.roleId) {
        // No role resolved -> deny everything. An empty ability is the safe default.
        return { ability: createMongoAbility([]), dropped: [], version, actionAliases: {} };
    }

    const attributesHash = hashAttributes(principal.attributes);
    const key = `${principal.tenantId}:${principal.roleId}:${version}:${attributesHash}`;

    const hit = abilityCache.get(key);
    if (hit) return hit;

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<CompiledAbility> => {
        const { registry, rules } = await loadRoleRulesCached(principal.tenantId, principal.roleId!, version);
        const compiled = compileRules(registry, rules, principal);
        const result: CompiledAbility = {
            ability: createMongoAbility(compiled.rules),
            dropped: compiled.dropped,
            version,
            actionAliases: buildActionAliasMap(registry.actions),
        };
        abilityCache.set(key, result);
        return result;
    })().finally(() => {
        inFlight.delete(key);
    });

    inFlight.set(key, promise);
    return promise;
}

/** Test seam and break-glass. Not called in normal operation — version keys handle staleness. */
export function resetAbilityCaches(): void {
    roleRulesCache.clear();
    abilityCache.clear();
    registrySnapshotCache.clear();
    versionProbes.clear();
    inFlight.clear();
}

export function abilityCacheStats(): {
    roleRules: number;
    abilities: number;
    registrySnapshots: number;
    versionProbes: number;
} {
    return {
        roleRules: roleRulesCache.size,
        abilities: abilityCache.size,
        registrySnapshots: registrySnapshotCache.size,
        versionProbes: versionProbes.size,
    };
}
