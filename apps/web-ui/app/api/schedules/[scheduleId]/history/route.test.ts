import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/schedule-execution-service', () => ({ ScheduleExecutionService: { getExecutionsPageForSchedule: vi.fn() } }));
vi.mock('@/lib/schedule-service', () => ({ ScheduleService: { getSchedule: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));

import { ScheduleExecutionService } from '@/lib/schedule-execution-service';
import { ScheduleService } from '@/lib/schedule-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { GET } from './route';

const makeParams = (scheduleId: string) => ({ params: Promise.resolve({ scheduleId }) });
const makeRequest = (search = '') => ({
    nextUrl: { searchParams: new URLSearchParams(search) },
}) as any;

describe('GET /api/schedules/[scheduleId]/history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 when scheduleId is missing', async () => {
        const res = await GET(makeRequest(), makeParams(''));
        expect(res.status).toBe(400);
    });

    it('returns 404 when the schedule does not exist for this tenant', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const res = await GET(makeRequest(), makeParams('s-missing'));
        expect(res.status).toBe(404);
    });

    it('returns a page of executions with defaults', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1', name: 'My Schedule' } as any);
        vi.mocked(ScheduleExecutionService.getExecutionsPageForSchedule).mockResolvedValue({
            executions: [{ id: 'e1' }], total: 1,
        } as any);

        const res = await GET(makeRequest(), makeParams('s1'));
        const body = await res.json();

        expect(ScheduleExecutionService.getExecutionsPageForSchedule).toHaveBeenCalledWith('s1', 'tenant-1', { page: 1, limit: 10 });
        expect(res.status).toBe(200);
        expect(body).toEqual({
            success: true, scheduleId: 's1', scheduleName: 'My Schedule',
            executions: [{ id: 'e1' }], total: 1, page: 1, limit: 10,
        });
    });

    it('clamps limit to a maximum of 100 and floors page at 1', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1', name: 'x' } as any);
        vi.mocked(ScheduleExecutionService.getExecutionsPageForSchedule).mockResolvedValue({ executions: [], total: 0 } as any);

        await GET(makeRequest('?page=0&limit=500'), makeParams('s1'));
        expect(ScheduleExecutionService.getExecutionsPageForSchedule).toHaveBeenCalledWith('s1', 'tenant-1', { page: 1, limit: 100 });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1', name: 'x' } as any);
        vi.mocked(ScheduleExecutionService.getExecutionsPageForSchedule).mockRejectedValue(new Error('DB down'));

        const res = await GET(makeRequest(), makeParams('s1'));
        expect(res.status).toBe(500);
    });
});
