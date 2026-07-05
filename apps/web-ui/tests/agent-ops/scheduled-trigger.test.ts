import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetScheduledTask,
    mockUpdateLastRun,
    mockTryAcquireLock,
    mockCreateRun,
    mockGetRun,
    mockExecuteAgentRun,
    mockFinalize,
} = vi.hoisted(() => ({
    mockGetScheduledTask: vi.fn(),
    mockUpdateLastRun: vi.fn(),
    mockTryAcquireLock: vi.fn(),
    mockCreateRun: vi.fn(),
    mockGetRun: vi.fn(),
    mockExecuteAgentRun: vi.fn(),
    mockFinalize: vi.fn(),
}));

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({
    getScheduledTask: mockGetScheduledTask,
    updateLastRun: mockUpdateLastRun,
    tryAcquireExecutionLock: mockTryAcquireLock,
}));
vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { createRun: mockCreateRun, getRun: mockGetRun },
}));
vi.mock('@/lib/agent-ops/agent-executor', () => ({ executeAgentRun: mockExecuteAgentRun }));
vi.mock('@/lib/agent-ops/scheduled-notifier', () => ({ finalizeScheduledRun: mockFinalize }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-1'),
    getAuthSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/env', () => ({ env: { INTERNAL_API_KEY: 'test-internal-key' } }));

import { POST } from '../../app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route';

const task = {
    taskId: 'task-1',
    tenantId: 'tenant-1',
    name: 'Daily Review',
    description: 'check costs',
    mode: 'fast',
    autoApprove: true,
    mcpServerIds: [],
    notification: { type: 'slack', channelId: 'C1' },
};

function makeRequest(): Request {
    return new Request('http://localhost/api/agent-ops/scheduled-tasks/task-1/trigger', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-internal-key': 'test-internal-key',
            'x-tenant-id': 'tenant-1',
        },
        body: JSON.stringify({ source: 'worker' }),
    });
}

const routeParams = { params: Promise.resolve({ taskId: 'task-1' }) };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetScheduledTask.mockResolvedValue(task);
    mockTryAcquireLock.mockResolvedValue(true);
    mockCreateRun.mockResolvedValue({ runId: 'run-1', status: 'queued', tenantId: 'tenant-1', source: 'scheduled' });
    mockGetRun.mockResolvedValue({ runId: 'run-1', status: 'completed', tenantId: 'tenant-1', source: 'scheduled', trigger: { taskId: 'task-1' } });
    mockExecuteAgentRun.mockResolvedValue(undefined);
    mockFinalize.mockResolvedValue(undefined);
});

describe('POST /scheduled-tasks/[taskId]/trigger', () => {
    it('creates and executes a run when the lock is acquired', async () => {
        const res = await POST(makeRequest(), routeParams);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runId).toBe('run-1');
        expect(mockCreateRun).toHaveBeenCalledTimes(1);
        expect(mockExecuteAgentRun).toHaveBeenCalledTimes(1);
    });

    it('acquires the lock on a minute-rounded window key', async () => {
        await POST(makeRequest(), routeParams);
        expect(mockTryAcquireLock).toHaveBeenCalledTimes(1);
        const [taskIdArg, windowArg] = mockTryAcquireLock.mock.calls[0];
        expect(taskIdArg).toBe('task-1');
        expect(windowArg).toMatch(/T\d{2}:\d{2}:00\.000Z$/);
    });

    it('returns 409 skipped without creating a run when the lock is held', async () => {
        mockTryAcquireLock.mockResolvedValue(false);
        const res = await POST(makeRequest(), routeParams);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.skipped).toBe(true);
        expect(mockCreateRun).not.toHaveBeenCalled();
        expect(mockExecuteAgentRun).not.toHaveBeenCalled();
    });

    it('finalizes the scheduled run after execution settles', async () => {
        await POST(makeRequest(), routeParams);
        // Drain the fire-and-forget promise chain
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        expect(mockFinalize).toHaveBeenCalledTimes(1);
        expect(mockFinalize.mock.calls[0][0].runId).toBe('run-1');
    });
});
