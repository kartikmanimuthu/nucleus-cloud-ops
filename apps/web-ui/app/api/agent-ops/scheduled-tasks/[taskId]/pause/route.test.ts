import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({ getScheduledTask: vi.fn(), pauseScheduledTask: vi.fn() }));
vi.mock('@/lib/agent-ops/agent-ops-service', () => ({ cancelActiveRunsForTask: vi.fn() }));
vi.mock('@/lib/agent-ops/scheduler-engine', () => ({ unregisterTask: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getScheduledTask, pauseScheduledTask } from '@/lib/agent-ops/scheduled-task-service';
import { cancelActiveRunsForTask } from '@/lib/agent-ops/agent-ops-service';
import { unregisterTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeParams = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const makeRequest = () => ({} as any);

describe('POST /api/agent-ops/scheduled-tasks/[taskId]/pause', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when the task does not exist for this tenant', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(null);
        const res = await POST(makeRequest(), makeParams('t-missing'));
        expect(res.status).toBe(403);
    });

    it('unregisters, pauses, cancels active runs, and reports the cancelled count', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x' } as any);
        vi.mocked(cancelActiveRunsForTask).mockResolvedValue(['run-1', 'run-2']);

        const res = await POST(makeRequest(), makeParams('t1'));
        const body = await res.json();

        expect(unregisterTask).toHaveBeenCalledWith('t1');
        expect(pauseScheduledTask).toHaveBeenCalledWith('tenant-1', 't1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, cancelledRuns: 2 });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.paused', metadata: expect.objectContaining({ cancelledRuns: 2 }) })
        );
    });

    it('still pauses and returns success when cancelling active runs fails', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x' } as any);
        vi.mocked(cancelActiveRunsForTask).mockRejectedValue(new Error('cancel failed'));

        const res = await POST(makeRequest(), makeParams('t1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.cancelledRuns).toBe(0);
    });

    it('returns 500 when pausing throws', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x' } as any);
        vi.mocked(cancelActiveRunsForTask).mockResolvedValue([]);
        vi.mocked(pauseScheduledTask).mockRejectedValue(new Error('DB down'));

        const res = await POST(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(500);
    });
});
