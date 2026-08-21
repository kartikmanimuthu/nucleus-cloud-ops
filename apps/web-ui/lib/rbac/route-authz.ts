/**
 * Layer 1 route resolution — the default-deny choke point.
 *
 * Resolution order, first match wins:
 *   1. DB overrides (`rbac_route_permissions`, sortOrder asc) — the emergency
 *      kill-switch. `deny` blocks an endpoint for one tenant with no deploy.
 *   2. The build-time manifest — the declared (action, subject) for the handler.
 *   3. The public allowlist.
 *   4. Nothing matched → DENY.
 *
 * Step 4 is the entire point: an endpoint nobody declared is dead on arrival
 * rather than open. `rbac:sync --check` refuses the build before it can ship, so
 * the 403 here is a backstop for something CI already caught.
 *
 * Cost: the manifest is a compiled regex list held in module scope — no I/O. DB
 * overrides are cached under the RBAC version, so steady state adds zero queries
 * beyond the one version probe every 5s that the ability cache already makes.
 */

import manifestJson from '@nucleus/rbac/generated/route-manifest.json';
import type { HttpMethod, RouteManifest } from '@nucleus/rbac';

import { PUBLIC_ROUTES } from './rbac-allowlist';
import { loadRoutePermissions } from './registry';

const manifest = manifestJson as RouteManifest;

export type RouteRequirement =
    | { mode: 'public'; why: string }
    | { mode: 'require'; action: string; subject: string; source: 'manifest' | 'override' }
    | { mode: 'deny'; reason: string }
    | { mode: 'unmapped' };

/**
 * `/api/schedules/:id/history` → /^\/api\/schedules\/[^/]+\/history$/
 * `:name*` is a catch-all and matches the remainder of the path.
 */
function patternToRegExp(pattern: string): RegExp {
    const source = pattern
        .split('/')
        .filter(Boolean)
        .map((segment) => {
            if (segment.startsWith(':') && segment.endsWith('*')) return '.*';
            if (segment.startsWith(':')) return '[^/]+';
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');
    return new RegExp(`^/${source}/?$`);
}

interface CompiledRoute {
    regex: RegExp;
    methods: Partial<Record<HttpMethod, { action?: string; subject?: string; source: string; why?: string }>>;
}

/**
 * Orders patterns so the MOST SPECIFIC match is tested first.
 *
 * Both matchers below take the first regex that matches, and a dynamic segment
 * happily matches a literal one: `/api/agent-ops/:runId` compiles to
 * `^/api/agent-ops/[^/]+/?$`, which also matches `/api/agent-ops/mcp-settings`
 * and `/api/agent-ops/scheduled-tasks`. In manifest order (`:runId` sorts before
 * `mcp-settings` and `scheduled-tasks` alphabetically) those two literal entries
 * were never reachable, so both endpoints were judged by `:runId`'s subject —
 * every request answering to `Agent` no matter what they declared, and no amount
 * of correcting their own declarations could change it.
 *
 * Ranking, ascending:
 *   1. catch-all segments (`:name*` → `.*`) — the greediest, so always last
 *   2. dynamic segments — fewer wildcards means a closer fit
 *   3. depth, DESCENDING — among equals, the longer path is the tighter one
 *
 * Only the relative order of patterns that can match the SAME path matters; the
 * rest is a stable tiebreak.
 */
function specificityRank(pattern: string): [number, number, number] {
    const segments = pattern.split('/').filter(Boolean);
    const catchAll = segments.filter((s) => s.startsWith(':') && s.endsWith('*')).length;
    const dynamic = segments.filter((s) => s.startsWith(':')).length;
    return [catchAll, dynamic, -segments.length];
}

function bySpecificity<T extends { pattern: string }>(a: T, b: T): number {
    const [ac, ad, an] = specificityRank(a.pattern);
    const [bc, bd, bn] = specificityRank(b.pattern);
    return ac - bc || ad - bd || an - bn;
}

/** Compiled once at module load; the middleware performs no parsing per request. */
const COMPILED: CompiledRoute[] = [...manifest.routes].sort(bySpecificity).map((route) => ({
    regex: patternToRegExp(route.pattern),
    methods: route.methods,
}));

// Sorted on the same rule, and for a sharper reason: a wrongly-won allowlist
// match does not pick the wrong subject, it declares the endpoint PUBLIC.
const COMPILED_PUBLIC = [...PUBLIC_ROUTES].sort(bySpecificity).map((entry) => ({
    regex: patternToRegExp(entry.pattern),
    why: entry.why,
}));

export function matchAllowlist(pathname: string): { why: string } | null {
    const hit = COMPILED_PUBLIC.find((entry) => entry.regex.test(pathname));
    return hit ? { why: hit.why } : null;
}

export function matchManifest(
    method: string,
    pathname: string
): { action: string; subject: string } | { public: true } | null {
    for (const route of COMPILED) {
        if (!route.regex.test(pathname)) continue;
        const entry = route.methods[method as HttpMethod];
        if (!entry) continue;
        if (entry.source === 'allowlist') return { public: true };
        if (entry.action && entry.subject) return { action: entry.action, subject: entry.subject };
        // Present but undeclared — CI should have refused this build.
        return null;
    }
    return null;
}

// ── DB overrides ─────────────────────────────────────────────────────────────

interface OverrideRow {
    method: string;
    pathPattern: string;
    actionKey: string;
    subjectKey: string | null;
    mode: string;
    enforced: boolean;
    reason: string | null;
    regex: RegExp;
}

const overrideCache = new Map<string, OverrideRow[]>();

/**
 * Route overrides for a tenant, cached under the RBAC version so a change
 * propagates within the same ~5s window as everything else, and steady-state
 * requests perform no query.
 */
export async function loadRouteOverrides(tenantId: string, version: string): Promise<OverrideRow[]> {
    const key = `${tenantId}:${version}`;
    const hit = overrideCache.get(key);
    if (hit) return hit;

    // Read via registry.ts — it owns the "global rows plus this tenant's" query,
    // which is the one place allowed to bypass the tenant extension.
    const rows = await loadRoutePermissions(tenantId);

    const compiled: OverrideRow[] = rows.map((row) => ({
        method: row.method,
        pathPattern: row.pathPattern,
        actionKey: row.actionKey,
        subjectKey: row.subject?.key ?? null,
        mode: row.mode,
        enforced: row.enforced,
        reason: row.reason,
        regex: patternToRegExp(row.pathPattern),
    }));

    if (overrideCache.size > 200) overrideCache.clear();
    overrideCache.set(key, compiled);
    return compiled;
}

export function matchOverride(overrides: OverrideRow[], method: string, pathname: string): RouteRequirement | null {
    for (const row of overrides) {
        if (row.method !== '*' && row.method !== method) continue;
        if (!row.regex.test(pathname)) continue;
        // `enforced: false` is shadow — the row is visible in the admin UI but
        // does not decide, so an override can be staged before it bites.
        if (!row.enforced) continue;

        if (row.mode === 'deny') {
            return { mode: 'deny', reason: row.reason ?? 'Blocked by an administrator' };
        }
        if (row.mode === 'public') {
            return { mode: 'public', why: row.reason ?? 'Marked public by an administrator' };
        }
        if (row.subjectKey) {
            return { mode: 'require', action: row.actionKey, subject: row.subjectKey, source: 'override' };
        }
    }
    return null;
}

/** Full resolution. `overrides` is passed in so the caller controls when it is loaded. */
export function resolveRouteRequirement(
    method: string,
    pathname: string,
    overrides: OverrideRow[]
): RouteRequirement {
    const override = matchOverride(overrides, method, pathname);
    if (override) return override;

    const declared = matchManifest(method, pathname);
    if (declared && 'public' in declared) {
        const allow = matchAllowlist(pathname);
        return { mode: 'public', why: allow?.why ?? 'Allowlisted' };
    }
    if (declared) {
        return { mode: 'require', action: declared.action, subject: declared.subject, source: 'manifest' };
    }

    const allow = matchAllowlist(pathname);
    if (allow) return { mode: 'public', why: allow.why };

    return { mode: 'unmapped' };
}
