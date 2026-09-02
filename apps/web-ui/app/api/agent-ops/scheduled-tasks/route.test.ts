import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({
    listScheduledTasks: vi.fn(), createScheduledTask: vi.fn(), validateScheduleInput: vi.fn(),
}));
vi.mock('@/lib/agent-ops/scheduler-engine', () => ({ registerTask: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/rbac/session-ability', () => ({ getAbilityForSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { listScheduledTasks, createScheduledTask, validateScheduleInput } from '@/lib/agent-ops/scheduled-task-service';
import { registerTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getAbilityForSession } from '@/lib/rbac/session-ability';
import { AuditService } from '@/lib/audit-service';
import { GET, POST } from './route';

const makeGetRequest = (search = '') => ({ url: `http://localhost/api/agent-ops/scheduled-tasks${search}` }) as any;
const makePostRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { name: 'Nightly cleanup', scheduleType: 'cron', cronExpression: '0 0 * * *' };

describe('GET /api/agent-ops/scheduled-tasks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('lists tasks with defaults, scoped by tenant', async () => {
        vi.mocked(listScheduledTasks).mockResolvedValue({ tasks: [{ id: 't1' }], total: 1, stats: {} } as any);

        const res = await GET(makeGetRequest());
        const body = await res.json();

        expect(listScheduledTasks).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1', page: 1, limit: 25, sortBy: 'createdAt', sortDir: 'desc',
        }));
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: [{ id: 't1' }], total: 1, stats: {} });
    });

    it('accepts a valid sortBy and rejects an invalid one', async () => {
        vi.mocked(listScheduledTasks).mockResolvedValue({ tasks: [], total: 0, stats: {} } as any);
        await GET(makeGetRequest('?sortBy=runCount'));
        expect(listScheduledTasks).toHaveBeenCalledWith(expect.objectContaining({ sortBy: 'runCount' }));

        await GET(makeGetRequest('?sortBy=bogus'));
        expect(listScheduledTasks).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'createdAt' }));
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(listScheduledTasks).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeGetRequest());
        expect(res.status).toBe(500);
    });
});

describe('POST /api/agent-ops/scheduled-tasks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
        vi.mocked(getAbilityForSession).mockResolvedValue({ principal: { roleId: 'role-1' } } as any);
        vi.mocked(validateScheduleInput).mockReturnValue(null);
    });

    it('returns 400 when schedule validation fails', async () => {
        vi.mocked(validateScheduleInput).mockReturnValue('cronExpression is required');
        const res = await POST(makePostRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('cronExpression is required');
        expect(createScheduledTask).not.toHaveBeenCalled();
    });

    it('creates a cron-type task, forces plan mode, and records the creator identity', async () => {
        vi.mocked(createScheduledTask).mockResolvedValue({ taskId: 't1', name: 'Nightly cleanup' } as any);

        const res = await POST(makePostRequest(VALID_BODY));
        const body = await res.json();

        expect(createScheduledTask).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1', scheduleType: 'cron', cronExpression: '0 0 * * *', mode: 'plan',
            createdByUserId: 'u1', createdByRoleId: 'role-1',
        }));
        expect(registerTask).toHaveBeenCalledWith({ taskId: 't1', name: 'Nightly cleanup' });
        expect(res.status).toBe(201);
        expect(body.task).toEqual({ taskId: 't1', name: 'Nightly cleanup' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.created' })
        );
    });

    it('clears cronExpression and parses intervalMinutes for an interval-type task', async () => {
        vi.mocked(createScheduledTask).mockResolvedValue({ taskId: 't2' } as any);
        await POST(makePostRequest({ name: 'x', scheduleType: 'interval', intervalMinutes: '15' }));

        expect(createScheduledTask).toHaveBeenCalledWith(expect.objectContaining({
            scheduleType: 'interval', cronExpression: '', intervalMinutes: 15,
        }));
    });

    it('returns 500 when creation throws', async () => {
        vi.mocked(createScheduledTask).mockRejectedValue(new Error('DB down'));
        const res = await POST(makePostRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });
});
