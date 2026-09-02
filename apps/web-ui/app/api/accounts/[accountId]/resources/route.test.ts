import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/schedule-service', () => ({ ScheduleService: { getSchedules: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { ScheduleService } from '@/lib/schedule-service';
import { GET } from './route';

const makeParams = (accountId: string) => ({ params: Promise.resolve({ accountId }) });
const makeRequest = () => ({ url: 'http://localhost/api/accounts/acc-1/resources' }) as any;

describe('GET /api/accounts/[accountId]/resources', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 when accountId is missing', async () => {
        const res = await GET(makeRequest(), makeParams(''));
        expect(res.status).toBe(400);
    });

    it('scopes the query by tenantId and aggregates unique resources across schedules', async () => {
        vi.mocked(ScheduleService.getSchedules).mockResolvedValue({
            schedules: [
                { name: 'sched-a', resources: [{ id: 'r1', type: 'ec2', name: 'R1' }] },
                { name: 'sched-b', resources: [{ id: 'r1', type: 'ec2', name: 'R1' }, { id: 'r2', type: 'rds', name: 'R2' }] },
            ],
        } as any);

        const res = await GET(makeRequest(), makeParams('acc-1'));
        const body = await res.json();

        expect(ScheduleService.getSchedules).toHaveBeenCalledWith({ accountId: 'acc-1', tenantId: 'tenant-1' });
        expect(res.status).toBe(200);
        expect(body.total).toBe(2);
        expect(body.resources.find((r: any) => r.id === 'r1').schedules).toEqual(['sched-a', 'sched-b']);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScheduleService.getSchedules).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest(), makeParams('acc-1'));
        expect(res.status).toBe(500);
    });
});
