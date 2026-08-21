/**
 * Gate 4 — a scheduled task whose creator lost the permission fails closed.
 *
 * A scheduled task is a STORED GRANT: authorized once at creation, then fired
 * unattended for as long as it exists. The property under test is that the
 * worker treats a revoked grant as TERMINAL — the task is taken out of the
 * firing set (`taskStatus = 'permission_revoked'`, which loadActiveTasks no
 * longer selects), an audit row is written, and the tick does NOT throw, because
 * throwing would send it back through pg-boss's retry ladder to be denied again.
 *
 * The contrast case matters just as much: a plain 403 with no revocation code is
 * almost always an INTERNAL_API_KEY misconfiguration and MUST stay retryable, so
 * a broken deployment is loud instead of silently dropping every tenant's runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
const mockFindMany = vi.fn().mockResolvedValue([]);

vi.mock('@prisma/client', () => ({
    PrismaClient: vi.fn().mockImplementation(() => ({
        scheduledTask: { findMany: mockFindMany, updateMany: mockUpdateMany },
    })),
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();

vi.mock('pg', () => ({
    Pool: vi.fn().mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
        end: vi.fn().mockResolvedValue(undefined),
    })),
}));

vi.mock('../../env.js', () => ({
    env: {
        INTERNAL_API_KEY: 'test-internal-key',
        WEB_UI_BASE_URL: 'http://web-ui.test',
        DATABASE_URL: 'postgres://test/test',
        PORT: '3000',
    },
}));

import {
    handleAgentOpsTick,
    parseTriggerFailure,
    PERMISSION_REVOKED,
} from './index.js';

const TICK = { taskId: 'task-1', tenantId: 'ten-1' };

/** Stubs global fetch with one response. */
function respond(status: number, body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => body,
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/** Every audit row written through the raw-pg writer, as {eventType, details}. */
function auditRows() {
    return mockQuery.mock.calls.map(([, values]) => ({
        eventType: (values as unknown[])[4],
        resourceId: (values as unknown[])[9],
        status: (values as unknown[])[10],
        severity: (values as unknown[])[11],
        details: (values as unknown[])[12],
    }));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockQuery.mockResolvedValue({ rows: [] });
});

describe('parseTriggerFailure', () => {
    it('extracts the revocation code from a JSON error body', () => {
        expect(parseTriggerFailure('{"success":false,"code":"permission_revoked","error":"gone"}'))
            .toEqual({ code: 'permission_revoked', error: 'gone' });
    });

    it('never throws on a non-JSON body (an HTML 502 from a proxy, say)', () => {
        expect(parseTriggerFailure('<html>502 Bad Gateway</html>')).toEqual({});
    });
});

describe('handleAgentOpsTick — creator permission revoked', () => {
    const revoked = {
        success: false,
        code: PERMISSION_REVOKED,
        error: "role 'Viewer' no longer grants 'execute Agent'",
    };

    it('marks the task permission_revoked so the sweeper stops firing it', async () => {
        respond(403, revoked);

        await handleAgentOpsTick(TICK);

        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { tenantId: 'ten-1', taskId: 'task-1' },
            data: { taskStatus: 'permission_revoked' },
        });
    });

    it('does not throw — a revoked grant is terminal, not retryable', async () => {
        respond(403, revoked);
        await expect(handleAgentOpsTick(TICK)).resolves.toBeUndefined();
    });

    it('writes a high-severity audit event naming the reason', async () => {
        respond(403, revoked);

        await handleAgentOpsTick(TICK);

        const revocation = auditRows().find((r) => r.eventType === 'agent.task.permission_revoked');
        expect(revocation).toBeDefined();
        expect(revocation).toMatchObject({
            resourceId: 'task-1',
            status: 'error',
            severity: 'high',
        });
        expect(String(revocation!.details)).toContain("role 'Viewer' no longer grants 'execute Agent'");
    });

    it('does not write the generic cron_failed event for a revocation', async () => {
        respond(403, revoked);

        await handleAgentOpsTick(TICK);

        expect(auditRows().map((r) => r.eventType)).not.toContain('agent.task.cron_failed');
    });

    it('still ends the tick terminally when the status write fails', async () => {
        respond(403, revoked);
        mockUpdateMany.mockRejectedValue(new Error('db down'));

        // No throw: the run did not happen, which is the fail-closed outcome. A
        // retry would only re-deny.
        await expect(handleAgentOpsTick(TICK)).resolves.toBeUndefined();
        expect(auditRows().some((r) => r.eventType === 'agent.task.permission_revoked')).toBe(true);
    });
});

describe('handleAgentOpsTick — failures that are NOT revocations', () => {
    it('keeps a bare 403 retryable (INTERNAL_API_KEY misconfiguration must be loud)', async () => {
        respond(403, { success: false, error: 'Forbidden' });

        await expect(handleAgentOpsTick(TICK)).rejects.toThrow(/retryable/);
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('keeps a 500 retryable and leaves the task active', async () => {
        respond(500, { error: 'boom' });

        await expect(handleAgentOpsTick(TICK)).rejects.toThrow(/retryable/);
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('leaves the task active on a 409 (duplicate/paused — terminal task state)', async () => {
        respond(409, { success: false, skipped: true, error: 'Duplicate trigger suppressed' });

        await expect(handleAgentOpsTick(TICK)).resolves.toBeUndefined();
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('runs the task normally on success', async () => {
        respond(200, { runId: 'run-9' });

        await handleAgentOpsTick(TICK);

        expect(mockUpdateMany).not.toHaveBeenCalled();
        expect(auditRows().map((r) => r.eventType)).toContain('agent.task.cron_completed');
    });
});
