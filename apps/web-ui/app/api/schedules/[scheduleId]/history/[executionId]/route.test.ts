import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/schedule-execution-service', () => ({ ScheduleExecutionService: { getExecutionById: vi.fn() } }));
vi.mock('@/lib/schedule-service', () => ({ ScheduleService: { getSchedule: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));

import { ScheduleExecutionService } from '@/lib/schedule-execution-service';
import { ScheduleService } from '@/lib/schedule-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { GET } from './route';

const makeParams = (scheduleId: string, executionId: string) => ({ params: Promise.resolve({ scheduleId, executionId }) });
const makeRequest = () => ({} as any);

describe('GET /api/schedules/[scheduleId]/history/[executionId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 when scheduleId or executionId is missing', async () => {
        const res = await GET(makeRequest(), makeParams('s1', ''));
        expect(res.status).toBe(400);
    });

    it('returns 404 when the schedule does not exist for this tenant', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const res = await GET(makeRequest(), makeParams('s-missing', 'e1'));
        expect(res.status).toBe(404);
        expect(ScheduleExecutionService.getExecutionById).not.toHaveBeenCalled();
    });

    it('returns 404 when the execution does not exist', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1', name: 'x' } as any);
        vi.mocked(ScheduleExecutionService.getExecutionById).mockResolvedValue(null);

        const res = await GET(makeRequest(), makeParams('s1', 'e-missing'));
        expect(res.status).toBe(404);
    });

    it('returns the execution scoped by tenant with the schedule summary', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1', name: 'My Schedule' } as any);
        vi.mocked(ScheduleExecutionService.getExecutionById).mockResolvedValue({ id: 'e1', status: 'success' } as any);

        const res = await GET(makeRequest(), makeParams('s1', 'e1'));
        const body = await res.json();

        expect(ScheduleExecutionService.getExecutionById).toHaveBeenCalledWith('s1', 'e1', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({
            success: true, execution: { id: 'e1', status: 'success' }, schedule: { id: 's1', name: 'My Schedule' },
        });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScheduleService.getSchedule).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest(), makeParams('s1', 'e1'));
        expect(res.status).toBe(500);
    });
});
