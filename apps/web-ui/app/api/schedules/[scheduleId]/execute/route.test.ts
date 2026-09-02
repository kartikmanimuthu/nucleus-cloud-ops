import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/schedule-service', () => ({ ScheduleService: { getSchedule: vi.fn(), executeSchedule: vi.fn() } }));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScheduleService } from '@/lib/schedule-service';
import { getServerSession } from 'next-auth/next';
import { POST } from './route';

const makeParams = (scheduleId: string) => ({ params: Promise.resolve({ scheduleId }) });
const makeRequest = () => ({} as any);

describe('POST /api/schedules/[scheduleId]/execute', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest(), makeParams('s1'));
        expect(res).toBe(authError);
        expect(ScheduleService.getSchedule).not.toHaveBeenCalled();
    });

    it('returns 404 when the schedule does not exist for this tenant', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue(null);
        const res = await POST(makeRequest(), makeParams('s-missing'));
        expect(res.status).toBe(404);
        expect(ScheduleService.executeSchedule).not.toHaveBeenCalled();
    });

    it('triggers execution scoped by tenant and the resolved user email', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
        vi.mocked(ScheduleService.executeSchedule).mockResolvedValue({ executionTime: '2026-01-01T00:00:00Z' } as any);

        const res = await POST(makeRequest(), makeParams('s1'));
        const body = await res.json();

        expect(ScheduleService.executeSchedule).toHaveBeenCalledWith('s1', 'a@b.co', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({
            success: true, message: 'Schedule execution triggered successfully (Background)',
            executionTime: '2026-01-01T00:00:00Z', executionStatus: 'success', isAsync: true,
        });
    });

    it('falls back to "unknown-web-user" when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
        vi.mocked(ScheduleService.executeSchedule).mockResolvedValue({ executionTime: 'x' } as any);

        await POST(makeRequest(), makeParams('s1'));
        expect(ScheduleService.executeSchedule).toHaveBeenCalledWith('s1', 'unknown-web-user', 'tenant-1');
    });

    it('maps a "Schedule not found" error to 404', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
        vi.mocked(ScheduleService.executeSchedule).mockRejectedValue(new Error('Schedule not found'));

        const res = await POST(makeRequest(), makeParams('s1'));
        expect(res.status).toBe(404);
    });

    it('returns 500 for other execution errors', async () => {
        vi.mocked(ScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
        vi.mocked(ScheduleService.executeSchedule).mockRejectedValue(new Error('pg-boss down'));

        const res = await POST(makeRequest(), makeParams('s1'));
        expect(res.status).toBe(500);
    });
});
