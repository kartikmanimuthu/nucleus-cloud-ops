import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({
    getScheduledTask: vi.fn(), updateLastRun: vi.fn(), tryAcquireExecutionLock: vi.fn(),
}));
vi.mock('@/lib/agent-ops/agent-ops-service', () => ({ agentOpsService: { createRun: vi.fn(), getRun: vi.fn() } }));
vi.mock('@/lib/agent-ops/agent-executor', () => ({ executeAgentRun: vi.fn() }));
vi.mock('@/lib/agent-ops/scheduled-notifier', () => ({ finalizeScheduledRun: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/agent-ops/scheduled-task-permission', () => ({
    checkScheduledTaskGrant: vi.fn(), PERMISSION_REVOKED: 'PERMISSION_REVOKED',
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/env', () => ({ env: { INTERNAL_API_KEY: undefined } }));

import {
    getScheduledTask, updateLastRun, tryAcquireExecutionLock,
} from '@/lib/agent-ops/scheduled-task-service';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';
import { checkScheduledTaskGrant, PERMISSION_REVOKED } from '@/lib/agent-ops/scheduled-task-permission';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { env } from '@/env';
import { POST } from './route';

const makeParams = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const makeRequest = (headers: Record<string, string> = {}) => ({
    headers: { get: (k: string) => headers[k] ?? null },
}) as any;
const ACTIVE_TASK = {
    taskId: 't1', tenantId: 'tenant-1', name: 'Nightly cleanup', taskStatus: 'active',
    description: 'Do the thing', mode: 'plan', autoApprove: false,
};

describe('POST /api/agent-ops/scheduled-tasks/[taskId]/trigger', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(tryAcquireExecutionLock).mockResolvedValue(true);
        (env as any).INTERNAL_API_KEY = undefined;
    });

    it('returns 403 when the task does not exist for the resolved tenant', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(null);
        const res = await POST(makeRequest(), makeParams('t-missing'));
        expect(res.status).toBe(403);
    });

    it('returns 409 (skipped) when the task is not active', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue({ ...ACTIVE_TASK, taskStatus: 'paused' } as any);
        const res = await POST(makeRequest(), makeParams('t1'));
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.skipped).toBe(true);
    });

    it('returns 409 (skipped) when the execution lock is already held', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(tryAcquireExecutionLock).mockResolvedValue(false);

        const res = await POST(makeRequest(), makeParams('t1'));
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.skipped).toBe(true);
        expect(agentOpsService.createRun).not.toHaveBeenCalled();
    });

    it('creates and executes a run on a session-driven manual trigger, without a stored-grant check', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(agentOpsService.createRun).mockResolvedValue({ runId: 'run-1', status: 'in_progress' } as any);
        vi.mocked(executeAgentRun).mockResolvedValue(undefined as any);

        const res = await POST(makeRequest(), makeParams('t1'));
        const body = await res.json();

        expect(checkScheduledTaskGrant).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1', source: 'scheduled', trigger: expect.objectContaining({ taskId: 't1' }),
        }));
        expect(res.status).toBe(200);
        expect(body).toEqual({ runId: 'run-1', status: 'in_progress' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.triggered' })
        );
    });

    it('re-checks the stored grant on the internal (worker) path and executes when it holds', async () => {
        (env as any).INTERNAL_API_KEY = 'secret-key';
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(checkScheduledTaskGrant).mockResolvedValue({ ok: true, verified: true } as any);
        vi.mocked(agentOpsService.createRun).mockResolvedValue({ runId: 'run-1', status: 'in_progress' } as any);
        vi.mocked(executeAgentRun).mockResolvedValue(undefined as any);

        const res = await POST(makeRequest({ 'x-internal-key': 'secret-key', 'x-tenant-id': 'tenant-1' }), makeParams('t1'));
        expect(checkScheduledTaskGrant).toHaveBeenCalledWith(ACTIVE_TASK);
        expect(res.status).toBe(200);
    });

    it('returns 403 with PERMISSION_REVOKED when the internal grant check fails', async () => {
        (env as any).INTERNAL_API_KEY = 'secret-key';
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(checkScheduledTaskGrant).mockResolvedValue({ ok: false, reason: 'creator lost access' } as any);

        const res = await POST(makeRequest({ 'x-internal-key': 'secret-key', 'x-tenant-id': 'tenant-1' }), makeParams('t1'));
        const body = await res.json();

        expect(res.status).toBe(403);
        expect(body.code).toBe(PERMISSION_REVOKED);
        expect(agentOpsService.createRun).not.toHaveBeenCalled();
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.permission_revoked', severity: 'high' })
        );
    });

    it('finalizes the scheduled run after execution completes', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(agentOpsService.createRun).mockResolvedValue({ runId: 'run-1', status: 'in_progress' } as any);
        vi.mocked(executeAgentRun).mockResolvedValue(undefined as any);
        vi.mocked(agentOpsService.getRun).mockResolvedValue({ runId: 'run-1', status: 'completed' } as any);

        await POST(makeRequest(), makeParams('t1'));
        await Promise.resolve();
        await Promise.resolve();

        expect(finalizeScheduledRun).toHaveBeenCalledWith({ runId: 'run-1', status: 'completed' });
    });

    it('falls back to updateLastRun when the fresh run cannot be re-fetched post-execution', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(agentOpsService.createRun).mockResolvedValue({ runId: 'run-1', status: 'in_progress' } as any);
        vi.mocked(executeAgentRun).mockResolvedValue(undefined as any);
        vi.mocked(agentOpsService.getRun).mockResolvedValue(null);

        await POST(makeRequest(), makeParams('t1'));
        await Promise.resolve();
        await Promise.resolve();

        expect(updateLastRun).toHaveBeenCalledWith('tenant-1', 't1', 'run-1', 'completed');
    });

    it('returns 500 when a dependency throws', async () => {
        vi.mocked(getScheduledTask).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(500);
    });

    it('returns 500 when an internal call is missing the x-tenant-id header', async () => {
        (env as any).INTERNAL_API_KEY = 'secret-key';
        const res = await POST(makeRequest({ 'x-internal-key': 'secret-key' }), makeParams('t1'));
        expect(res.status).toBe(500);
    });

    it('warns but still executes when the internal grant holds without a verifiable creator', async () => {
        (env as any).INTERNAL_API_KEY = 'secret-key';
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(checkScheduledTaskGrant).mockResolvedValue({ ok: true, verified: false, reason: 'creator unresolved' } as any);
        vi.mocked(agentOpsService.createRun).mockResolvedValue({ runId: 'run-1', status: 'in_progress' } as any);
        vi.mocked(executeAgentRun).mockResolvedValue(undefined as any);

        const res = await POST(makeRequest({ 'x-internal-key': 'secret-key', 'x-tenant-id': 'tenant-1' }), makeParams('t1'));
        expect(res.status).toBe(200);
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('logs but does not fail the request when the fire-and-forget run execution rejects', async () => {
        vi.mocked(getScheduledTask).mockResolvedValue(ACTIVE_TASK as any);
        vi.mocked(agentOpsService.createRun).mockResolvedValue({ runId: 'run-1', status: 'in_progress' } as any);
        vi.mocked(executeAgentRun).mockRejectedValue(new Error('execution crashed'));

        const res = await POST(makeRequest(), makeParams('t1'));
        await Promise.resolve();
        await Promise.resolve();

        expect(res.status).toBe(200);
    });
});
