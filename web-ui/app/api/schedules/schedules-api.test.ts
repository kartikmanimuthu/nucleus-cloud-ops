import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Mocks ---

vi.mock('@/lib/schedule-service', () => ({
    ScheduleService: {
        getSchedules: vi.fn(),
        getSchedule: vi.fn(),
        createSchedule: vi.fn(),
        updateSchedule: vi.fn(),
        deleteSchedule: vi.fn(),
        toggleScheduleStatus: vi.fn(),
    },
}));

vi.mock('@/lib/schedule-execution-service', () => ({
    ScheduleExecutionService: {
        logExecution: vi.fn(),
        getExecutionsForSchedule: vi.fn(),
        getExecutionById: vi.fn(),
    },
}));

vi.mock('@/lib/audit-service', () => ({
    AuditService: {
        logUserAction: vi.fn().mockResolvedValue(undefined),
        logResourceAction: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn().mockResolvedValue(null),
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { email: 'test@example.com' } }),
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { email: 'test@example.com' } }),
}));

vi.mock('../auth/[...nextauth]/route', () => ({
    authOptions: {},
}));

vi.mock('../../auth/[...nextauth]/route', () => ({
    authOptions: {},
}));

vi.mock('@/lib/auth-options', () => ({
    authOptions: {},
}));

const { mockLambdaSend } = vi.hoisted(() => ({
    mockLambdaSend: vi.fn(),
}));
vi.mock('@aws-sdk/client-lambda', () => {
    return {
        LambdaClient: class MockLambdaClient {
            send = mockLambdaSend;
        },
        InvokeCommand: class MockInvokeCommand {
            constructor(public input: any) {}
        },
    };
});

import { ScheduleService } from '@/lib/schedule-service';
import { ScheduleExecutionService } from '@/lib/schedule-execution-service';
import { authorize } from '@/lib/rbac/authorize';

const makeSchedule = (overrides: Record<string, unknown> = {}) => ({
    id: 'sched-1',
    name: 'Test Schedule',
    starttime: '08:00',
    endtime: '18:00',
    timezone: 'America/New_York',
    active: true,
    days: ['Monday', 'Tuesday'],
    accounts: ['acc-1'],
    resourceTypes: ['ec2'],
    executionCount: 5,
    ...overrides,
});

function makeRequest(url: string, options?: RequestInit) {
    return new NextRequest(new URL(url, 'http://localhost'), options);
}

// --- Route imports (after mocks) ---

import { GET as listGET, POST as listPOST } from './route';
import { GET as singleGET, PUT as singlePUT, DELETE as singleDELETE } from './[scheduleId]/route';
import { POST as togglePOST } from './[scheduleId]/toggle/route';
import { GET as historyGET } from './[scheduleId]/history/route';
import { GET as executionDetailGET } from './[scheduleId]/history/[executionId]/route';
import { POST as executePOST } from './[scheduleId]/execute/route';

const asyncParams = (obj: Record<string, string>) => ({ params: Promise.resolve(obj) });

describe('GET /api/schedules', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 200 with { success, data, count, meta }', async () => {
        vi.mocked(ScheduleService.getSchedules).mockResolvedValue({ schedules: [makeSchedule()], total: 1 });
        const req = makeRequest('http://localhost/api/schedules');
        const res = await listGET(req);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(body.count).toBe(1);
        expect(body.meta).toEqual({ total: 1, page: 1, limit: 10, totalPages: 1 });
    });

    it('returns 403 when authorize returns a response', async () => {
        const { NextResponse } = await import('next/server');
        vi.mocked(authorize).mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
        const req = makeRequest('http://localhost/api/schedules');
        const res = await listGET(req);
        expect(res.status).toBe(403);
    });

    it('parses query params into filters', async () => {
        vi.mocked(ScheduleService.getSchedules).mockResolvedValue({ schedules: [], total: 0 });
        const req = makeRequest('http://localhost/api/schedules?status=active&resource=ec2&search=prod&page=2&limit=5');
        await listGET(req);
        expect(ScheduleService.getSchedules).toHaveBeenCalledWith(expect.objectContaining({
            statusFilter: 'active', resourceFilter: 'ec2', searchTerm: 'prod', page: 2, limit: 5,
        }));
    });

    it('returns 500 on service error', async () => {
        vi.mocked(ScheduleService.getSchedules).mockRejectedValue(new Error('DB down'));
        const req = makeRequest('http://localhost/api/schedules');
        const res = await listGET(req);
        expect(res.status).toBe(500);
    });
});

describe('POST /api/schedules', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    const validBody = {
        name: 'New Sched', starttime: '08:00', endtime: '18:00',
        timezone: 'America/New_York', days: ['Monday'], accountId: 'acc-1',
    };

    it('returns 201 with created schedule on success', async () => {
        vi.mocked(ScheduleService.createSchedule).mockResolvedValue(makeSchedule({ name: 'New Sched' }) as any);
        const req = makeRequest('http://localhost/api/schedules', {
            method: 'POST', body: JSON.stringify(validBody),
        });
        const res = await listPOST(req);
        const body = await res.json();
        expect(res.status).toBe(201);
        expect(body.success).toBe(true);
        expect(body.data.name).toBe('New Sched');
    });

    it('returns 403 when authorize returns a response', async () => {
        const { NextResponse } = await import('next/server');
        vi.mocked(authorize).mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
        const req = makeRequest('http://localhost/api/schedules', { method: 'POST', body: JSON.stringify(validBody) });
        const res = await listPOST(req);
        expect(res.status).toBe(403);
    });

    it('returns 400 when required fields missing', async () => {
        const req = makeRequest('http://localhost/api/schedules', {
            method: 'POST', body: JSON.stringify({ name: 'Only name' }),
        });
        const res = await listPOST(req);
        expect(res.status).toBe(400);
    });

    it('returns 400 when accountId missing', async () => {
        const { accountId, ...noAccount } = validBody;
        const req = makeRequest('http://localhost/api/schedules', {
            method: 'POST', body: JSON.stringify(noAccount),
        });
        const res = await listPOST(req);
        expect(res.status).toBe(400);
    });

    it('returns 400 when days is empty array', async () => {
        const req = makeRequest('http://localhost/api/schedules', {
            method: 'POST', body: JSON.stringify({ ...validBody, days: [] }),
        });
        const res = await listPOST(req);
        expect(res.status).toBe(400);
    });

    it('returns 400 when timezone is invalid', async () => {
        const req = makeRequest('http://localhost/api/schedules', {
            method: 'POST', body: JSON.stringify({ ...validBody, timezone: 'Invalid/Zone' }),
        });
        const res = await listPOST(req);
        expect(res.status).toBe(400);
    });

    it('returns 409 when schedule name already exists', async () => {
        vi.mocked(ScheduleService.createSchedule).mockRejectedValue(new Error('Schedule already exists'));
        const req = makeRequest('http://localhost/api/schedules', {
            method: 'POST', body: JSON.stringify(validBody),
        });
        const res = await listPOST(req);
        expect(res.status).toBe(409);
    });

    it('returns 500 on unexpected error', async () => {
        vi.mocked(ScheduleService.createSchedule).mockRejectedValue(new Error('Unexpected'));
        const req = makeRequest('http://localhost/api/schedules', {
            method: 'POST', body: JSON.stringify(validBody),
        });
        const res = await listPOST(req);
        expect(res.status).toBe(500);
    });
});

describe('GET /api/schedules/[scheduleId]', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 200 with schedule object', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(makeSchedule() as any);
        const req = makeRequest('http://localhost/api/schedules/sched-1');
        const res = await singleGET(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.id).toBe('sched-1');
    });

    it('returns 404 when schedule not found', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const req = makeRequest('http://localhost/api/schedules/sched-missing');
        const res = await singleGET(req, asyncParams({ scheduleId: 'sched-missing' }) as any);
        expect(res.status).toBe(404);
    });

    it('returns 500 on error', async () => {
        vi.mocked(ScheduleService.getSchedule).mockRejectedValue(new Error('fail'));
        const req = makeRequest('http://localhost/api/schedules/sched-1');
        const res = await singleGET(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/schedules/[scheduleId]', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 200 with updated schedule', async () => {
        vi.mocked(ScheduleService.updateSchedule).mockResolvedValue(makeSchedule({ name: 'Updated' }) as any);
        const req = makeRequest('http://localhost/api/schedules/sched-1', {
            method: 'PUT', body: JSON.stringify({ name: 'Updated' }),
        });
        const res = await singlePUT(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.name).toBe('Updated');
    });

    it('returns 500 on error', async () => {
        vi.mocked(ScheduleService.updateSchedule).mockRejectedValue(new Error('fail'));
        const req = makeRequest('http://localhost/api/schedules/sched-1', {
            method: 'PUT', body: JSON.stringify({ name: 'X' }),
        });
        const res = await singlePUT(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/schedules/[scheduleId]', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 200 with { success: true }', async () => {
        vi.mocked(ScheduleService.deleteSchedule).mockResolvedValue(undefined);
        const req = makeRequest('http://localhost/api/schedules/sched-1', { method: 'DELETE' });
        const res = await singleDELETE(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
    });

    it('returns 500 on error', async () => {
        vi.mocked(ScheduleService.deleteSchedule).mockRejectedValue(new Error('fail'));
        const req = makeRequest('http://localhost/api/schedules/sched-1', { method: 'DELETE' });
        const res = await singleDELETE(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(500);
    });
});

describe('POST /api/schedules/[scheduleId]/toggle', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 200 with { success, data, message }', async () => {
        vi.mocked(ScheduleService.toggleScheduleStatus).mockResolvedValue(makeSchedule({ active: false }) as any);
        const req = makeRequest('http://localhost/api/schedules/sched-1/toggle', { method: 'POST' });
        const res = await togglePOST(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.active).toBe(false);
    });

    it('returns 404 when schedule not found', async () => {
        vi.mocked(ScheduleService.toggleScheduleStatus).mockRejectedValue(new Error('Schedule not found'));
        const req = makeRequest('http://localhost/api/schedules/sched-1/toggle', { method: 'POST' });
        const res = await togglePOST(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(404);
    });

    it('returns 500 on unexpected error', async () => {
        vi.mocked(ScheduleService.toggleScheduleStatus).mockRejectedValue(new Error('Unexpected'));
        const req = makeRequest('http://localhost/api/schedules/sched-1/toggle', { method: 'POST' });
        const res = await togglePOST(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(500);
    });
});

describe('GET /api/schedules/[scheduleId]/history', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 200 with execution history', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(makeSchedule() as any);
        vi.mocked(ScheduleExecutionService.getExecutionsForSchedule).mockResolvedValue([]);
        const req = makeRequest('http://localhost/api/schedules/sched-1/history');
        const res = await historyGET(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.scheduleId).toBe('sched-1');
        expect(body.scheduleName).toBe('Test Schedule');
    });

    it('returns 404 when schedule not found', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const req = makeRequest('http://localhost/api/schedules/sched-1/history');
        const res = await historyGET(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(404);
    });

    it('returns 500 on error', async () => {
        vi.mocked(ScheduleService.getSchedule).mockRejectedValue(new Error('fail'));
        const req = makeRequest('http://localhost/api/schedules/sched-1/history');
        const res = await historyGET(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(500);
    });
});

describe('GET /api/schedules/[scheduleId]/history/[executionId]', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 200 with { success, execution, schedule }', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(makeSchedule() as any);
        vi.mocked(ScheduleExecutionService.getExecutionById).mockResolvedValue({ executionId: 'exec-1' } as any);
        const req = makeRequest('http://localhost/api/schedules/sched-1/history/exec-1');
        const res = await executionDetailGET(req, asyncParams({ scheduleId: 'sched-1', executionId: 'exec-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.execution.executionId).toBe('exec-1');
        expect(body.schedule.id).toBe('sched-1');
    });

    it('returns 404 when schedule not found', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const req = makeRequest('http://localhost/api/schedules/sched-1/history/exec-1');
        const res = await executionDetailGET(req, asyncParams({ scheduleId: 'sched-1', executionId: 'exec-1' }) as any);
        expect(res.status).toBe(404);
    });

    it('returns 404 when execution not found', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(makeSchedule() as any);
        vi.mocked(ScheduleExecutionService.getExecutionById).mockResolvedValue(null);
        const req = makeRequest('http://localhost/api/schedules/sched-1/history/exec-missing');
        const res = await executionDetailGET(req, asyncParams({ scheduleId: 'sched-1', executionId: 'exec-missing' }) as any);
        expect(res.status).toBe(404);
    });
});

describe('POST /api/schedules/[scheduleId]/execute', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 403 when authorize returns a response', async () => {
        const { NextResponse } = await import('next/server');
        vi.mocked(authorize).mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
        const req = makeRequest('http://localhost/api/schedules/sched-1/execute', { method: 'POST' });
        const res = await executePOST(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(403);
    });

    it('returns 404 when schedule not found', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const req = makeRequest('http://localhost/api/schedules/sched-1/execute', { method: 'POST' });
        const res = await executePOST(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        expect(res.status).toBe(404);
    });

    it('returns 200 on successful Lambda invocation', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(makeSchedule() as any);
        vi.mocked(ScheduleService.updateSchedule).mockResolvedValue(makeSchedule() as any);
        mockLambdaSend.mockResolvedValue({
            Payload: Buffer.from(JSON.stringify({ resourcesFailed: 0 })),
            FunctionError: undefined,
        });
        const req = makeRequest('http://localhost/api/schedules/sched-1/execute', { method: 'POST' });
        const res = await executePOST(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.executionStatus).toBe('success');
    });

    it('returns 200 with failed status when Lambda invocation throws', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(makeSchedule() as any);
        vi.mocked(ScheduleService.updateSchedule).mockResolvedValue(makeSchedule() as any);
        vi.mocked(ScheduleExecutionService.logExecution).mockResolvedValue({} as any);
        mockLambdaSend.mockRejectedValue(new Error('Lambda timeout'));
        const req = makeRequest('http://localhost/api/schedules/sched-1/execute', { method: 'POST' });
        const res = await executePOST(req, asyncParams({ scheduleId: 'sched-1' }) as any);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.success).toBe(false);
        expect(body.executionStatus).toBe('failed');
    });
});
