import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({
    getScheduledTask: vi.fn(), updateScheduledTask: vi.fn(), deleteScheduledTask: vi.fn(), validateScheduleInput: vi.fn(),
}));
vi.mock('@/lib/agent-ops/scheduler-engine', () => ({ registerTask: vi.fn(), unregisterTask: vi.fn() }));
vi.mock('@/lib/agent-ops/agent-ops-service', () => ({ cancelActiveRunsForTask: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import {
    getScheduledTask, updateScheduledTask, deleteScheduledTask, validateScheduleInput,
} from '@/lib/agent-ops/scheduled-task-service';
import { registerTask, unregisterTask } from '@/lib/agent-ops/scheduler-engine';
import { cancelActiveRunsForTask } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET, PATCH, DELETE } from './route';

const makeParams = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const makeRequest = (body: unknown = {}) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/agent-ops/scheduled-tasks/[taskId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 404 when the task does not exist', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(null);
        const res = await GET(makeRequest(), makeParams('t-missing'));
        expect(res.status).toBe(404);
    });

    it('returns the task scoped by tenant', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1' } as any);
        const res = await GET(makeRequest(), makeParams('t1'));
        const body = await res.json();
        expect(getScheduledTask).toHaveBeenCalledWith('tenant-1', 't1');
        expect(body).toEqual({ task: { taskId: 't1' } });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(getScheduledTask).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(500);
    });
});

describe('PATCH /api/agent-ops/scheduled-tasks/[taskId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when the task does not exist for this tenant', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(null);
        const res = await PATCH(makeRequest({ name: 'x' }), makeParams('t-missing'));
        expect(res.status).toBe(403);
    });

    it('whitelists mutable fields, silently dropping unknown ones like runCount', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', scheduleType: 'cron', cronExpression: '0 0 * * *' } as any);
        vi.mocked(updateScheduledTask).mockResolvedValue({ taskId: 't1', name: 'Renamed', taskStatus: 'paused' } as any);

        await PATCH(makeRequest({ name: 'Renamed', runCount: 999 }), makeParams('t1'));
        expect(updateScheduledTask).toHaveBeenCalledWith('tenant-1', 't1', { name: 'Renamed' });
    });

    // mode used to be dropped with the unknown fields — it became mutable when
    // deep mode shipped, but only for a mode the client may actually pick.
    it('passes a selectable mode through', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', scheduleType: 'cron', cronExpression: '0 0 * * *' } as any);
        vi.mocked(updateScheduledTask).mockResolvedValue({ taskId: 't1', taskStatus: 'paused' } as any);

        await PATCH(makeRequest({ mode: 'deep' }), makeParams('t1'));
        expect(updateScheduledTask).toHaveBeenCalledWith('tenant-1', 't1', { mode: 'deep' });
    });

    it('400s on a mode the client may not pick, without touching the task', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', scheduleType: 'cron', cronExpression: '0 0 * * *' } as any);

        const res = await PATCH(makeRequest({ mode: 'fast' }), makeParams('t1'));
        expect(res.status).toBe(400);
        expect(updateScheduledTask).not.toHaveBeenCalled();
    });

    it('validates the merged schedule when schedule fields change, and rejects an invalid one', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', scheduleType: 'cron', cronExpression: '0 0 * * *' } as any);
        vi.mocked(validateScheduleInput).mockReturnValue('Invalid cron expression');

        const res = await PATCH(makeRequest({ cronExpression: 'bogus' }), makeParams('t1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('Invalid cron expression');
        expect(updateScheduledTask).not.toHaveBeenCalled();
    });

    it('whitelists the remaining mutable fields (autoApprove, model, accountId, accountName, mcpServerIds)', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1' } as any);
        vi.mocked(updateScheduledTask).mockResolvedValue({ taskId: 't1', taskStatus: 'paused' } as any);

        await PATCH(makeRequest({
            autoApprove: true,
            model: 'sonnet',
            accountId: 'acc-1',
            accountName: 'Prod',
            mcpServerIds: ['mcp-1'],
        }), makeParams('t1'));

        expect(updateScheduledTask).toHaveBeenCalledWith('tenant-1', 't1', {
            autoApprove: true,
            model: 'sonnet',
            accountId: 'acc-1',
            accountName: 'Prod',
            mcpServerIds: ['mcp-1'],
        });
    });

    it('clears cronExpression when switching to an interval schedule', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', scheduleType: 'cron', cronExpression: '0 0 * * *' } as any);
        vi.mocked(validateScheduleInput).mockReturnValue(null);
        vi.mocked(updateScheduledTask).mockResolvedValue({ taskId: 't1', taskStatus: 'active' } as any);

        await PATCH(makeRequest({ scheduleType: 'interval', intervalMinutes: 10 }), makeParams('t1'));
        expect(updateScheduledTask).toHaveBeenCalledWith('tenant-1', 't1', expect.objectContaining({
            scheduleType: 'interval', intervalMinutes: 10, cronExpression: '',
        }));
    });

    it('returns 404 when the update finds no row', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1' } as any);
        vi.mocked(updateScheduledTask).mockResolvedValue(null);
        const res = await PATCH(makeRequest({ name: 'x' }), makeParams('t1'));
        expect(res.status).toBe(404);
    });

    it('re-registers the task when it is active, and logs an audit event', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1' } as any);
        vi.mocked(updateScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x', taskStatus: 'active' } as any);

        await PATCH(makeRequest({ name: 'x' }), makeParams('t1'));
        expect(registerTask).toHaveBeenCalledWith({ taskId: 't1', name: 'x', taskStatus: 'active' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.updated' })
        );
    });

    it('does not re-register a paused task', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1' } as any);
        vi.mocked(updateScheduledTask).mockResolvedValue({ taskId: 't1', taskStatus: 'paused' } as any);
        await PATCH(makeRequest({ name: 'x' }), makeParams('t1'));
        expect(registerTask).not.toHaveBeenCalled();
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(getScheduledTask).mockRejectedValue(new Error('DB down'));
        const res = await PATCH(makeRequest({ name: 'x' }), makeParams('t1'));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/agent-ops/scheduled-tasks/[taskId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when the task does not exist for this tenant', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(null);
        const res = await DELETE(makeRequest(), makeParams('t-missing'));
        expect(res.status).toBe(403);
    });

    it('unregisters, deletes, cancels active runs, and logs an audit event', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x' } as any);

        const res = await DELETE(makeRequest(), makeParams('t1'));
        const body = await res.json();

        expect(unregisterTask).toHaveBeenCalledWith('t1');
        expect(deleteScheduledTask).toHaveBeenCalledWith('tenant-1', 't1');
        expect(cancelActiveRunsForTask).toHaveBeenCalledWith('tenant-1', 't1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.deleted' })
        );
    });

    it('still succeeds when cancelling active runs fails', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x' } as any);
        vi.mocked(cancelActiveRunsForTask).mockRejectedValueOnce(new Error('cancel failed'));

        const res = await DELETE(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(200);
    });

    it('returns 500 when deletion throws', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ taskId: 't1', name: 'x' } as any);
        vi.mocked(deleteScheduledTask).mockRejectedValue(new Error('DB down'));
        const res = await DELETE(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(500);
    });
});
