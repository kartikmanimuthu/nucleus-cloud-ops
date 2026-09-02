import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: vi.fn(), getRunEvents: vi.fn() },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { GET } from './route';

const makeParams = (runId: string) => ({ params: Promise.resolve({ runId }) });

async function readAll(res: Response): Promise<string> {
    return res.text();
}

describe('GET /api/agent-ops/[runId]/stream', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });
    afterEach(() => vi.useRealTimers());

    it('returns 401 when the session cannot be resolved', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await GET({} as any, makeParams('run-1'));
        expect(res.status).toBe(401);
    });

    it('returns 404 when the run does not exist for this tenant', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('run-missing'));
        expect(res.status).toBe(404);
    });

    it('streams buffered events and a status frame, then closes on a terminal status', async () => {
        vi.mocked(agentOpsService.getRun)
            .mockResolvedValueOnce({ id: 'run-1', status: 'in_progress', result: null, error: null } as any)
            .mockResolvedValueOnce({ id: 'run-1', status: 'completed', result: 'done', error: null } as any);
        vi.mocked(agentOpsService.getRunEvents)
            .mockResolvedValueOnce([{ id: 'e1' }])
            .mockResolvedValueOnce([{ id: 'e1' }]);

        const res = await GET({} as any, makeParams('run-1'));
        const text = await readAll(res);

        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        expect(text).toContain('event: run-event');
        expect(text).toContain('"id":"e1"');
        expect(text).toContain('event: status');
        expect(text).toContain('"status":"completed"');
    });

    it('closes the stream without throwing when the poll loop errors mid-run', async () => {
        vi.mocked(agentOpsService.getRun)
            .mockResolvedValueOnce({ id: 'run-1', status: 'in_progress', result: null, error: null } as any)
            .mockResolvedValueOnce({ id: 'run-1', status: 'in_progress', result: null, error: null } as any)
            .mockRejectedValue(new Error('DB down mid-stream'));
        vi.mocked(agentOpsService.getRunEvents).mockResolvedValue([]);

        const res = await GET({} as any, makeParams('run-1'));
        const text = await readAll(res);
        // The loop's own catch swallows the error and the finally closes the controller —
        // the client just sees the frames sent before the failure, not a thrown error.
        expect(text).toContain('event: status');
    });

    it('stops polling immediately once the client has already aborted', async () => {
        const controller = new AbortController();
        vi.mocked(agentOpsService.getRun).mockImplementation(async () => {
            controller.abort();
            return { id: 'run-1', status: 'in_progress', result: null, error: null } as any;
        });
        vi.mocked(agentOpsService.getRunEvents).mockResolvedValue([]);

        const res = await GET({ signal: controller.signal } as any, makeParams('run-1'));
        const text = await readAll(res);
        // The abort happens during the initial existence check, so the loop's
        // first aborted-signal check breaks before ever calling getRun again.
        expect(agentOpsService.getRun).toHaveBeenCalledTimes(1);
        expect(text).toBe('');
    });
});
