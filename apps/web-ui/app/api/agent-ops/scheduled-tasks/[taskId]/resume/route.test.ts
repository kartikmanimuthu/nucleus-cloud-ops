import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({ getScheduledTask: vi.fn(), resumeScheduledTask: vi.fn() }));
vi.mock('@/lib/agent-ops/scheduler-engine', () => ({ registerTask: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getScheduledTask, resumeScheduledTask } from '@/lib/agent-ops/scheduled-task-service';
import { registerTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeParams = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const makeRequest = () => ({} as any);

describe('POST /api/agent-ops/scheduled-tasks/[taskId]/resume', () => {
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

    it('returns 404 when resume finds no row', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1' } as any);
        vi.mocked(resumeScheduledTask).mockResolvedValue(null);
        const res = await POST(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(404);
        expect(registerTask).not.toHaveBeenCalled();
    });

    it('resumes and re-registers the task, logging an audit event', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1' } as any);
        vi.mocked(resumeScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x', taskStatus: 'active' } as any);

        const res = await POST(makeRequest(), makeParams('t1'));
        const body = await res.json();

        expect(registerTask).toHaveBeenCalledWith({ taskId: 't1', name: 'x', taskStatus: 'active' });
        expect(res.status).toBe(200);
        expect(body).toEqual({ task: { taskId: 't1', name: 'x', taskStatus: 'active' } });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.resumed' })
        );
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(getScheduledTask).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(500);
    });
});
