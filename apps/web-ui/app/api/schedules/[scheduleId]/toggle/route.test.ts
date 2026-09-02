import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/schedule-service', () => ({ ScheduleService: { getSchedule: vi.fn(), toggleScheduleStatus: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('../../../auth/[...nextauth]/route', () => ({ authOptions: {} }));

import { ScheduleService } from '@/lib/schedule-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { POST } from './route';

const makeParams = (scheduleId: string) => ({ params: Promise.resolve({ scheduleId }) });
const makeRequest = () => ({} as any);

describe('POST /api/schedules/[scheduleId]/toggle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when the schedule does not exist for this tenant', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const res = await POST(makeRequest(), makeParams('s-missing'));
        expect(res.status).toBe(403);
        expect(ScheduleService.toggleScheduleStatus).not.toHaveBeenCalled();
    });

    it('toggles the schedule status scoped by tenant', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
        vi.mocked(ScheduleService.toggleScheduleStatus).mockResolvedValue({ id: 's1', active: false } as any);

        const res = await POST(makeRequest(), makeParams('s1'));
        const body = await res.json();

        expect(ScheduleService.toggleScheduleStatus).toHaveBeenCalledWith('s1', undefined, 'a@b.co', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: { id: 's1', active: false }, message: 'Schedule status toggled to inactive' });
    });

    it('maps a "Schedule not found" error to 404', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
        vi.mocked(ScheduleService.toggleScheduleStatus).mockRejectedValue(new Error('Schedule not found'));

        const res = await POST(makeRequest(), makeParams('s1'));
        expect(res.status).toBe(404);
    });

    it('returns 500 for other errors', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
        vi.mocked(ScheduleService.toggleScheduleStatus).mockRejectedValue(new Error('DB down'));

        const res = await POST(makeRequest(), makeParams('s1'));
        expect(res.status).toBe(500);
    });
});
