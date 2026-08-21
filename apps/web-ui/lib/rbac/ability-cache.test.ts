/**
 * Cache correctness (§14.6).
 *
 * A bug in any of these is a STALE-PERMISSION bug: a revoked admin keeps access
 * until something happens to evict a key. That failure is silent, and it is the
 * one the version-keyed design exists to prevent — so these belong next to the
 * unresolvable-$var test in priority, not below it.
 *
 * Three properties:
 *   1. a version bump makes the previous key unreachable
 *   2. the 5s version-probe TTL is respected (bounded revocation lag, bounded reads)
 *   3. concurrent compiles for one key produce exactly ONE compile (single-flight)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AbilityPrincipal, RbacRoleRuleRow, RegistrySnapshot } from '@nucleus/rbac';

vi.mock('./registry', () => ({
    loadRegistrySnapshot: vi.fn(),
    loadRoleRules: vi.fn(),
    readRbacVersion: vi.fn(),
    resolveRoleIdByName: vi.fn(),
}));

import {
    getAbilityForPrincipal,
    getCachedRegistrySnapshot,
    getRbacVersion,
    hashAttributes,
    resetAbilityCaches,
} from './ability-cache';
import { loadRegistrySnapshot, loadRoleRules, readRbacVersion } from './registry';

const mockRegistry = vi.mocked(loadRegistrySnapshot);
const mockRules = vi.mocked(loadRoleRules);
const mockVersion = vi.mocked(readRbacVersion);

// ─────────────────────────────────────────────────────────────────────────────

function registry(): RegistrySnapshot {
    return {
        tenantId: 't1',
        modules: [
            {
                id: 'm-sched',
                tenantId: null,
                key: 'Schedules',
                label: 'Schedules',
                description: null,
                icon: null,
                navPath: null,
                sortOrder: 10,
                isSystem: true,
                enabled: true,
            },
        ],
        actions: [
            {
                id: 'a-update',
                tenantId: null,
                key: 'update',
                label: 'update',
                description: null,
                aliasOfKey: null,
                isDangerous: false,
                sortOrder: 10,
                isSystem: true,
            },
        ],
        subjects: [
            { id: 's-sched', tenantId: null, key: 'Schedule', label: 'Schedule', kind: 'resource', isSystem: true },
        ],
        subjectModules: [{ tenantId: null, subjectId: 's-sched', moduleId: 'm-sched' }],
        moduleActions: [{ tenantId: null, moduleId: 'm-sched', actionId: 'a-update', grantable: true }],
        subjectAttributes: [],
        principalAttributes: [],
    };
}

function rules(): RbacRoleRuleRow[] {
    return [
        {
            id: 'r1',
            tenantId: null,
            roleId: 'role-1',
            actionId: 'a-update',
            moduleId: 'm-sched',
            subjectId: null,
            conditions: null,
            fields: [],
            inverted: false,
            reason: null,
        },
    ];
}

function principal(patch: Partial<AbilityPrincipal> = {}): AbilityPrincipal {
    return {
        userId: 'u1',
        email: 'u1@example.com',
        tenantId: 't1',
        roleId: 'role-1',
        roleName: 'Ops',
        level: 2,
        isSuperAdmin: false,
        attributes: {},
        ...patch,
    };
}

const T0 = new Date('2026-01-01T00:00:00.000Z');

beforeEach(() => {
    resetAbilityCaches();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    mockRegistry.mockResolvedValue(registry());
    mockRules.mockResolvedValue(rules());
    mockVersion.mockResolvedValue('0.0');
});

afterEach(() => {
    vi.useRealTimers();
});

/** Moves the wall clock forward; the probe TTL is measured with Date.now(). */
function advance(ms: number): void {
    vi.setSystemTime(new Date(T0.getTime() + ms));
}

// ─────────────────────────────────────────────────────────────────────────────

describe('ability cache — version bump invalidation', () => {
    it('reuses the compiled ability while the version is unchanged', async () => {
        const first = await getAbilityForPrincipal(principal());
        const second = await getAbilityForPrincipal(principal());

        expect(first.ability.can('update', 'Schedule')).toBe(true);
        expect(second).toBe(first); // same cached object, not merely equivalent
        expect(mockRules).toHaveBeenCalledTimes(1);
        expect(mockRegistry).toHaveBeenCalledTimes(1);
    });

    it('recompiles once the version bumps — the old key becomes unreachable', async () => {
        await getAbilityForPrincipal(principal());
        expect(mockRules).toHaveBeenCalledTimes(1);

        // An admin edits a rule: the tenant's rbacVersion moves. The probe is
        // memoised for 5s, so the change is only observable past the TTL.
        mockVersion.mockResolvedValue('0.1');
        advance(5_001);

        const after = await getAbilityForPrincipal(principal());

        expect(after.version).toBe('0.1');
        expect(mockRules).toHaveBeenCalledTimes(2);
        expect(mockRegistry).toHaveBeenCalledTimes(2);
    });

    it('a revoked grant stops being served after the bump', async () => {
        const before = await getAbilityForPrincipal(principal());
        expect(before.ability.can('update', 'Schedule')).toBe(true);

        // The grant is withdrawn and the version bumped.
        mockRules.mockResolvedValue([]);
        mockVersion.mockResolvedValue('0.1');
        advance(5_001);

        const after = await getAbilityForPrincipal(principal());
        expect(after.ability.can('update', 'Schedule')).toBe(false);
    });

    it('keys separately per principal attributes, so one user cannot serve another', async () => {
        const a = await getAbilityForPrincipal(principal({ attributes: {} }));
        const b = await getAbilityForPrincipal(principal({ attributes: { 'user.allowedAccountIds': ['dev-1'] } }));

        expect(b).not.toBe(a);
        expect(hashAttributes({})).toBe('none');
        expect(hashAttributes({ 'user.allowedAccountIds': ['dev-1'] })).not.toBe('none');

        // Two principals with identical attributes share the L2 entry, which is
        // the whole reason rules and abilities are cached at different levels.
        const c = await getAbilityForPrincipal(principal({ userId: 'u2', attributes: {} }));
        expect(c).toBe(a);
    });
});

describe('ability cache — 5s version probe TTL', () => {
    it('reads the version at most once per 5s window', async () => {
        await getRbacVersion('t1');
        advance(1_000);
        await getRbacVersion('t1');
        advance(3_999); // still inside the window
        await getRbacVersion('t1');

        expect(mockVersion).toHaveBeenCalledTimes(1);
    });

    it('re-reads once the window has elapsed', async () => {
        await getRbacVersion('t1');
        advance(5_001);
        await getRbacVersion('t1');

        expect(mockVersion).toHaveBeenCalledTimes(2);
    });

    it('probes each tenant independently', async () => {
        await getRbacVersion('t1');
        await getRbacVersion('t2');

        expect(mockVersion).toHaveBeenCalledTimes(2);
        expect(mockVersion).toHaveBeenCalledWith('t1');
        expect(mockVersion).toHaveBeenCalledWith('t2');
    });

    it('serves steady-state requests with zero registry reads', async () => {
        await getAbilityForPrincipal(principal());
        vi.clearAllMocks();

        // The documented steady state: no DB work at all on a warm cache.
        for (let i = 0; i < 25; i++) await getAbilityForPrincipal(principal());

        expect(mockVersion).not.toHaveBeenCalled();
        expect(mockRegistry).not.toHaveBeenCalled();
        expect(mockRules).not.toHaveBeenCalled();
    });
});

/**
 * FINDING 2: the page guard in middleware.ts called the raw loadRegistrySnapshot
 * on every /app/* request with no cache at all — unlike every other RBAC read in
 * this file, which is version-keyed. getCachedRegistrySnapshot() closes that gap
 * for callers (the page guard) that need the registry alone, with no role in
 * hand. Same immutable-key idiom as loadRoleRulesCached above: a version bump
 * makes the previous key unreachable rather than clearing anything.
 */
describe('ability cache — getCachedRegistrySnapshot (Finding 2)', () => {
    it('reuses the snapshot while the version is unchanged', async () => {
        const first = await getCachedRegistrySnapshot('t1');
        const second = await getCachedRegistrySnapshot('t1');

        expect(second).toBe(first); // same cached object, not merely equivalent
        expect(mockRegistry).toHaveBeenCalledTimes(1);
    });

    it('re-fetches once the version bumps — the old key becomes unreachable', async () => {
        await getCachedRegistrySnapshot('t1');
        expect(mockRegistry).toHaveBeenCalledTimes(1);

        mockVersion.mockResolvedValue('0.1');
        advance(5_001); // past the 5s version-probe TTL

        await getCachedRegistrySnapshot('t1');
        expect(mockRegistry).toHaveBeenCalledTimes(2);
    });

    it('caches independently per tenant', async () => {
        await getCachedRegistrySnapshot('t1');
        await getCachedRegistrySnapshot('t2');

        expect(mockRegistry).toHaveBeenCalledTimes(2);
        expect(mockRegistry).toHaveBeenCalledWith('t1');
        expect(mockRegistry).toHaveBeenCalledWith('t2');
    });

    it('is cleared by resetAbilityCaches, same as every other cache in this module', async () => {
        await getCachedRegistrySnapshot('t1');
        expect(mockRegistry).toHaveBeenCalledTimes(1);

        resetAbilityCaches();
        // resetAbilityCaches also clears the version probe, so this re-reads
        // the version too — not just the snapshot.
        mockVersion.mockResolvedValue('0.0');

        await getCachedRegistrySnapshot('t1');
        expect(mockRegistry).toHaveBeenCalledTimes(2);
    });
});

describe('ability cache — single-flight', () => {
    it('compiles once when many requests race on a cold key', async () => {
        // Hold the registry load open so every caller arrives before it resolves —
        // without de-duplication a cold cache under load compiles N times.
        let release!: (value: RegistrySnapshot) => void;
        mockRegistry.mockReturnValue(
            new Promise<RegistrySnapshot>((resolve) => {
                release = resolve;
            })
        );

        const inflight = Array.from({ length: 12 }, () => getAbilityForPrincipal(principal()));
        release(registry());
        const results = await Promise.all(inflight);

        expect(mockRegistry).toHaveBeenCalledTimes(1);
        expect(mockRules).toHaveBeenCalledTimes(1);

        // Every caller gets the same object, not 12 equivalent compilations.
        for (const result of results) expect(result).toBe(results[0]);
        expect(results[0].ability.can('update', 'Schedule')).toBe(true);
    });

    it('does not leave a rejected compile cached', async () => {
        mockRegistry.mockRejectedValueOnce(new Error('db down'));

        await expect(getAbilityForPrincipal(principal())).rejects.toThrow('db down');

        // The in-flight entry must be cleared, or every later request for this
        // key replays the failure forever.
        mockRegistry.mockResolvedValue(registry());
        const recovered = await getAbilityForPrincipal(principal());
        expect(recovered.ability.can('update', 'Schedule')).toBe(true);
    });
});

describe('ability cache — fail-closed shapes', () => {
    it('gives a principal with no role an empty ability', async () => {
        const result = await getAbilityForPrincipal(principal({ roleId: null }));

        expect(result.ability.can('update', 'Schedule')).toBe(false);
        expect(mockRules).not.toHaveBeenCalled();
    });

    it('short-circuits SuperAdmin without touching the registry', async () => {
        const result = await getAbilityForPrincipal(principal({ isSuperAdmin: true }));

        expect(result.ability.can('delete', 'AnythingAtAll')).toBe(true);
        expect(mockRegistry).not.toHaveBeenCalled();
        expect(mockRules).not.toHaveBeenCalled();
    });
});
