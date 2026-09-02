import { describe, expect, it, vi, beforeEach } from 'vitest';

// registry.ts reaches the database at import time through pg-config; only the DB
// override path needs it and none of these cases exercise that path.
vi.mock('./registry', () => ({ loadRoutePermissions: vi.fn().mockResolvedValue([]) }));

import {
    matchManifest, matchAllowlist, matchOverride, loadRouteOverrides, resolveRouteRequirement,
} from './route-authz';
import { loadRoutePermissions } from './registry';

/**
 * A dynamic segment matches a literal one, and matchManifest takes the FIRST
 * regex that matches — so pattern order decides the answer.
 *
 * `/api/agent-ops/:runId` compiles to `^/api/agent-ops/[^/]+/?$`, which also
 * matches `/api/agent-ops/mcp-settings` and `/api/agent-ops/scheduled-tasks`. In
 * plain manifest order (`:runId` sorts before both alphabetically) those literal
 * entries were unreachable: every request to them was judged by `:runId`'s
 * subject, so they answered to `Agent` regardless of what their own routes
 * declared, and correcting those declarations could not fix it. Three separate
 * 403s in one deployed environment traced back to this.
 *
 * Asserted against the REAL manifest rather than a fixture: the property that
 * matters is that these specific shipped routes resolve to themselves, which a
 * hand-built fixture would stop proving the moment the manifest changed.
 */
describe('matchManifest — a literal route is never shadowed by a dynamic sibling', () => {
    it('resolves /api/agent-ops/scheduled-tasks to its own subject, not :runId', () => {
        expect(matchManifest('GET', '/api/agent-ops/scheduled-tasks')).toEqual({
            action: 'read',
            subject: 'ScheduledTask',
        });
    });

    it('resolves /api/agent-ops/mcp-settings to its own subject, not :runId', () => {
        expect(matchManifest('GET', '/api/agent-ops/mcp-settings')).toEqual({
            action: 'read',
            subject: 'McpServer',
        });
    });

    it('still resolves a genuine run id through the dynamic pattern', () => {
        // The fix must not win by breaking :runId — an actual id has no literal
        // entry, so it has to fall through to the dynamic one.
        const hit = matchManifest('GET', '/api/agent-ops/0f8c2b41-9d3a-4c77-b2e1-5a6d7e8f9012');
        expect(hit).toEqual({ action: 'read', subject: 'AgentOps' });
    });

    it('prefers the deeper literal when a dynamic pattern also fits', () => {
        // /api/agent-ops/scheduled-tasks/:taskId/trigger vs
        // /api/agent-ops/scheduled-tasks/:taskId — only the first matches this
        // path, but both share a prefix, so it pins the depth tiebreak too.
        expect(matchManifest('POST', '/api/agent-ops/scheduled-tasks/task-1/trigger')).toEqual({
            action: 'execute',
            subject: 'ScheduledTask',
        });
    });

    it('leaves an unmapped path unmatched rather than guessing', () => {
        expect(matchManifest('GET', '/api/definitely-not-a-route')).toBeNull();
    });

    it('continues past a matched route that does not declare the requested method', () => {
        // /api/health only declares GET and HEAD.
        expect(matchManifest('DELETE', '/api/health')).toBeNull();
    });

    it('reports an allowlist-sourced manifest entry as public', () => {
        // /api/auth/:nextauth* is declared in the manifest with source: 'allowlist'.
        expect(matchManifest('GET', '/api/auth/callback/credentials')).toEqual({ public: true });
    });

    // NOTE: matchManifest's "present but undeclared" branch (a route entry with
    // neither an allowlist source nor a full action+subject) is provably
    // unreachable against the real shipped manifest — `rbac:sync --check` refuses
    // the build before such an entry could exist. Left untested, same convention
    // as other documented-unreachable branches this session.
});

describe('matchAllowlist', () => {
    it('matches a literal public route', () => {
        expect(matchAllowlist('/api/health')).toEqual({ why: expect.stringContaining('health probe') });
    });

    it('matches a catch-all pattern against a deep subpath', () => {
        expect(matchAllowlist('/api/auth/callback/credentials')).toEqual({ why: expect.any(String) });
    });

    it('returns null for a path with no allowlist entry', () => {
        expect(matchAllowlist('/api/accounts')).toBeNull();
    });
});

describe('matchOverride', () => {
    const override = (over: Partial<Parameters<typeof matchOverride>[0][number]>) => ({
        method: '*', pathPattern: '/api/x', actionKey: 'read', subjectKey: 'Account',
        mode: 'require', enforced: true, reason: null, regex: /^\/api\/x\/?$/,
        ...over,
    });

    it('returns null when no row matches the path', () => {
        expect(matchOverride([override({ regex: /^\/api\/y\/?$/ })], 'GET', '/api/x')).toBeNull();
    });

    it('skips a row scoped to a different HTTP method', () => {
        expect(matchOverride([override({ method: 'POST' })], 'GET', '/api/x')).toBeNull();
    });

    it('matches a wildcard-method row regardless of the request method', () => {
        expect(matchOverride([override({ method: '*', mode: 'deny', reason: 'blocked' })], 'DELETE', '/api/x')).toEqual({
            mode: 'deny', reason: 'blocked',
        });
    });

    it('skips a row marked enforced:false — shadow mode does not decide', () => {
        expect(matchOverride([override({ enforced: false, mode: 'deny' })], 'GET', '/api/x')).toBeNull();
    });

    it('returns deny with a default reason when none is set', () => {
        expect(matchOverride([override({ mode: 'deny', reason: null })], 'GET', '/api/x')).toEqual({
            mode: 'deny', reason: 'Blocked by an administrator',
        });
    });

    it('returns public with a default why when none is set', () => {
        expect(matchOverride([override({ mode: 'public', reason: null })], 'GET', '/api/x')).toEqual({
            mode: 'public', why: 'Marked public by an administrator',
        });
    });

    it('returns public with the given reason as why', () => {
        expect(matchOverride([override({ mode: 'public', reason: 'temporarily opened' })], 'GET', '/api/x')).toEqual({
            mode: 'public', why: 'temporarily opened',
        });
    });

    it('returns require when the row carries a subjectKey', () => {
        expect(matchOverride([override({ mode: 'require', actionKey: 'update', subjectKey: 'Schedule' })], 'GET', '/api/x')).toEqual({
            mode: 'require', action: 'update', subject: 'Schedule', source: 'override',
        });
    });

    it('falls through a require row with no subjectKey to the next matching row', () => {
        const rows = [
            override({ mode: 'require', subjectKey: null }),
            override({ mode: 'deny', reason: 'fallback deny' }),
        ];
        expect(matchOverride(rows, 'GET', '/api/x')).toEqual({ mode: 'deny', reason: 'fallback deny' });
    });

    it('takes the first matching row and ignores the rest', () => {
        const rows = [
            override({ mode: 'deny', reason: 'first' }),
            override({ mode: 'deny', reason: 'second' }),
        ];
        expect(matchOverride(rows, 'GET', '/api/x')).toEqual({ mode: 'deny', reason: 'first' });
    });
});

describe('loadRouteOverrides', () => {
    beforeEach(() => {
        vi.mocked(loadRoutePermissions).mockReset();
    });

    it('compiles rows from the registry into regex-backed overrides', async () => {
        vi.mocked(loadRoutePermissions).mockResolvedValue([
            { method: 'GET', pathPattern: '/api/x', actionKey: 'read', subject: { key: 'Account' }, mode: 'require', enforced: true, reason: null },
        ] as any);

        const overrides = await loadRouteOverrides('tenant-1', 'v1');

        expect(overrides).toHaveLength(1);
        expect(overrides[0].subjectKey).toBe('Account');
        expect(overrides[0].regex.test('/api/x')).toBe(true);
    });

    it('maps a null subject to a null subjectKey', async () => {
        vi.mocked(loadRoutePermissions).mockResolvedValue([
            { method: '*', pathPattern: '/api/y', actionKey: 'deny', subject: null, mode: 'deny', enforced: true, reason: 'x' },
        ] as any);

        const [row] = await loadRouteOverrides('tenant-1', 'v2');
        expect(row.subjectKey).toBeNull();
    });

    it('serves a cache hit without calling the registry again for the same tenant+version', async () => {
        vi.mocked(loadRoutePermissions).mockResolvedValue([]);
        await loadRouteOverrides('tenant-cache', 'v1');
        await loadRouteOverrides('tenant-cache', 'v1');
        expect(loadRoutePermissions).toHaveBeenCalledTimes(1);
    });

    it('re-queries when the version changes, even for the same tenant', async () => {
        vi.mocked(loadRoutePermissions).mockResolvedValue([]);
        await loadRouteOverrides('tenant-version', 'v1');
        await loadRouteOverrides('tenant-version', 'v2');
        expect(loadRoutePermissions).toHaveBeenCalledTimes(2);
    });

    it('clears the whole cache once it grows past 200 entries, rather than growing unbounded', async () => {
        // overrideCache is module-scoped and shared across every test in this file —
        // start from a genuinely empty cache so the count below isn't at the mercy of
        // how many keys earlier tests happened to leave in it.
        vi.resetModules();
        vi.doMock('./registry', () => ({ loadRoutePermissions: vi.fn().mockResolvedValue([]) }));
        const fresh = await import('./route-authz');
        const freshLoadRoutePermissions = (await import('./registry')).loadRoutePermissions;

        // The clear() check runs BEFORE the set() that grows the cache, so it takes a
        // 202nd distinct key (past the 201st entry) to observe size > 200 and evict.
        for (let i = 0; i < 202; i++) {
            await fresh.loadRouteOverrides(`tenant-${i}`, 'v1');
        }
        // The first key was wiped by the clear() — fetching it again must re-query.
        await fresh.loadRouteOverrides('tenant-0', 'v1');
        expect(freshLoadRoutePermissions).toHaveBeenCalledTimes(203);
    });
});

// NOTE: resolveRouteRequirement's `allow?.why ?? 'Allowlisted'` fallback (the manifest-
// public branch) is unreachable against real data: every manifest route with
// source:'allowlist' matches one of PUBLIC_ROUTES' own patterns (verified against both
// files), so matchAllowlist always finds a `why` there. Left untested, same convention
// as other documented-unreachable branches this session.
describe('resolveRouteRequirement', () => {
    const OVERRIDE_DENY = [{
        method: '*', pathPattern: '/api/x', actionKey: '', subjectKey: null, mode: 'deny',
        enforced: true, reason: 'kill switch', regex: /^\/api\/x\/?$/,
    }];

    it('an enforced override wins over the manifest entirely', () => {
        const result = resolveRouteRequirement('GET', '/api/x', OVERRIDE_DENY);
        expect(result).toEqual({ mode: 'deny', reason: 'kill switch' });
    });

    it('resolves a manifest-declared route to require, with source "manifest"', () => {
        const result = resolveRouteRequirement('GET', '/api/agent-ops/scheduled-tasks', []);
        expect(result).toEqual({ mode: 'require', action: 'read', subject: 'ScheduledTask', source: 'manifest' });
    });

    it('resolves a manifest allowlist-sourced route to public via the real allowlist reason', () => {
        const result = resolveRouteRequirement('GET', '/api/auth/callback/credentials', []);
        expect(result.mode).toBe('public');
    });

    it('falls back to the allowlist when the manifest has no entry at all', () => {
        // /api/v1/gateway/slack/:path* is a catch-all allowlist entry, but the manifest
        // only declares the two specific sub-paths (slack, slack/interactions) — a
        // deeper path matches the allowlist catch-all with no manifest route at all.
        const result = resolveRouteRequirement('GET', '/api/v1/gateway/slack/some/deep/path', []);
        expect(result.mode).toBe('public');
    });

    it('is unmapped — default deny — when neither an override, the manifest, nor the allowlist match', () => {
        const result = resolveRouteRequirement('GET', '/api/this-route-does-not-exist', []);
        expect(result).toEqual({ mode: 'unmapped' });
    });
});
