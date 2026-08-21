import { describe, expect, it, vi } from 'vitest';

// registry.ts reaches the database at import time through pg-config; only the DB
// override path needs it and none of these cases exercise that path.
vi.mock('./registry', () => ({ loadRoutePermissions: vi.fn().mockResolvedValue([]) }));

import { matchManifest } from './route-authz';

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
});
