import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/schedule-service', () => ({ ScheduleService: { getSchedules: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { ScheduleService } from '@/lib/schedule-service';
import { GET } from './route';

const makeParams = (accountId: string) => ({ params: Promise.resolve({ accountId }) });
const makeRequest = () => ({ url: 'http://localhost/api/accounts/acc-1/schedules' }) as any;

describe('GET /api/accounts/[accountId]/schedules', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 when accountId is missing', async () => {
        const res = await GET(makeRequest(), makeParams(''));
        expect(res.status).toBe(400);
    });

    it('fetches schedules scoped by accountId and tenantId', async () => {
        vi.mocked(ScheduleService.getSchedules).mockResolvedValue({ schedules: [{ id: 's1' }], total: 1 } as any);

        const res = await GET(makeRequest(), makeParams('acc-1'));
        const body = await res.json();

        expect(ScheduleService.getSchedules).toHaveBeenCalledWith({ accountId: 'acc-1', tenantId: 'tenant-1' });
        expect(res.status).toBe(200);
        expect(body).toEqual({ schedules: [{ id: 's1' }], total: 1, accountId: 'acc-1' });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScheduleService.getSchedules).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest(), makeParams('acc-1'));
        expect(res.status).toBe(500);
    });
});
