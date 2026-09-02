import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { getAuditLogs: vi.fn() } }));
vi.mock('@/lib/schedule-execution-service', () => ({ ScheduleExecutionService: { getRecentExecutions: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { ScheduleExecutionService } from '@/lib/schedule-execution-service';
import { GET } from './route';

const makeParams = (accountId: string) => ({ params: Promise.resolve({ accountId }) });
const makeRequest = () => ({ url: 'http://localhost/api/accounts/acc-1/activity' }) as any;

describe('GET /api/accounts/[accountId]/activity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 when accountId is missing', async () => {
        const res = await GET(makeRequest(), makeParams(''));
        expect(res.status).toBe(400);
    });

    it('merges and sorts audit logs and schedule executions filtered to this account', async () => {
        vi.mocked(AuditService.getAuditLogs).mockResolvedValue({
            logs: [
                { id: 'l1', accountId: 'acc-1', timestamp: '2026-01-01T00:00:00Z', action: 'a', details: 'd', status: 'success', resourceType: 'Account', resource: 'r' },
                { id: 'l2', accountId: 'other', timestamp: '2026-01-02T00:00:00Z', action: 'a', status: 'success' },
            ],
        } as any);
        vi.mocked(ScheduleExecutionService.getRecentExecutions).mockResolvedValue([
            { executionId: 'e1', accountId: 'acc-1', executionTime: '2026-01-03T00:00:00Z', status: 'success', resourcesStarted: 2, resourcesStopped: 1, resourcesFailed: 0, scheduleId: 'sched-1', duration: 10 },
            { executionId: 'e2', accountId: 'other', executionTime: '2026-01-04T00:00:00Z', status: 'success' },
        ] as any);

        const res = await GET(makeRequest(), makeParams('acc-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.accountId).toBe('acc-1');
        expect(body.total).toBe(2);
        expect(body.activity[0].id).toBe('e1');
        expect(body.activity[1].id).toBe('l1');
    });

    it('matches logs by metadata.accountId and by resourceId containing the accountId', async () => {
        vi.mocked(AuditService.getAuditLogs).mockResolvedValue({
            logs: [
                { id: 'l1', timestamp: '2026-01-01T00:00:00Z', action: 'a', status: 'success', metadata: { accountId: 'acc-1' } },
                { id: 'l2', timestamp: '2026-01-02T00:00:00Z', action: 'a', status: 'success', resourceId: 'account/acc-1/thing' },
                { id: 'l3', timestamp: '2026-01-03T00:00:00Z', action: 'a', status: 'success' },
            ],
        } as any);
        vi.mocked(ScheduleExecutionService.getRecentExecutions).mockResolvedValue([]);

        const res = await GET(makeRequest(), makeParams('acc-1'));
        const body = await res.json();

        expect(body.total).toBe(2);
        expect(body.activity.map((a: any) => a.id).sort()).toEqual(['l1', 'l2']);
    });

    it('returns 500 when a dependency throws', async () => {
        vi.mocked(AuditService.getAuditLogs).mockRejectedValue(new Error('DB down'));
        vi.mocked(ScheduleExecutionService.getRecentExecutions).mockResolvedValue([]);
        const res = await GET(makeRequest(), makeParams('acc-1'));
        expect(res.status).toBe(500);
    });
});
