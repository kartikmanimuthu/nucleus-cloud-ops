/**
 * Unit tests for GET /api/agent-ops/scheduled-tasks/[taskId]/runs.
 *
 * The route previously fetched a tenant-wide page of scheduled runs and filtered
 * by taskId in JS. It must now push taskId + page/limit into the query so the run
 * history is complete and `total` counts only this task's runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListRuns, mockGetSessionTenantId } = vi.hoisted(() => ({
    mockListRuns: vi.fn(),
    mockGetSessionTenantId: vi.fn(),
}));

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { listRuns: mockListRuns },
}));

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: mockGetSessionTenantId,
}));

import { GET } from '../../app/api/agent-ops/scheduled-tasks/[taskId]/runs/route';

const TENANT = 'tenant-abc';
const params = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const req = (qs = '') => new Request(`http://localhost/api/agent-ops/scheduled-tasks/task-42/runs${qs}`);

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionTenantId.mockResolvedValue(TENANT);
    mockListRuns.mockResolvedValue({ runs: [{ runId: 'r1' }], total: 42, stats: {} });
});

describe('GET scheduled task runs', () => {
    it('pushes taskId, source and pagination into the query', async () => {
        const res = await GET(req('?page=3&limit=10'), params('task-42'));
        const body = await res.json();

        expect(mockListRuns).toHaveBeenCalledWith({
            tenantId: TENANT,
            source: 'scheduled',
            taskId: 'task-42',
            page: 3,
            limit: 10,
        });
        expect(body).toMatchObject({ runs: [{ runId: 'r1' }], total: 42, page: 3, limit: 10 });
    });

    it('defaults to page 1 / limit 25', async () => {
        await GET(req(), params('task-42'));

        expect(mockListRuns).toHaveBeenCalledWith(
            expect.objectContaining({ page: 1, limit: 25 })
        );
    });

    it('clamps a hostile limit and rejects non-positive pages', async () => {
        await GET(req('?page=0&limit=100000'), params('task-42'));

        expect(mockListRuns).toHaveBeenCalledWith(
            expect.objectContaining({ page: 1, limit: 100 })
        );
    });

    it('falls back to defaults on unparseable pagination params', async () => {
        await GET(req('?page=abc&limit=xyz'), params('task-42'));

        expect(mockListRuns).toHaveBeenCalledWith(
            expect.objectContaining({ page: 1, limit: 25 })
        );
    });

    it('returns 500 when the service throws', async () => {
        mockListRuns.mockRejectedValue(new Error('db down'));

        const res = await GET(req(), params('task-42'));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('db down');
    });
});
