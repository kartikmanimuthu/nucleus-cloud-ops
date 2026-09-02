import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientScheduleService } from './client-schedule-service';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as any;
}

describe('ClientScheduleService.getSchedules', () => {
    it('builds query params from filters and returns schedules + total', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: [{ id: 's1' }], meta: { total: 5 } }));

        const result = await ClientScheduleService.getSchedules({ statusFilter: 'active', page: 2, limit: 10 });

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/schedules?status=active&page=2&limit=10'),
            expect.objectContaining({ method: 'GET' }),
        );
        expect(result).toEqual({ schedules: [{ id: 's1' }], total: 5 });
    });

    it('falls back to data.length when meta.total is absent', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: [{ id: 's1' }, { id: 's2' }] }));
        const result = await ClientScheduleService.getSchedules();
        expect(result.total).toBe(2);
    });

    it('includes resourceFilter and searchTerm in the query string', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: [] }));
        await ClientScheduleService.getSchedules({ resourceFilter: 'ec2', searchTerm: 'prod' });
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('resource=ec2'),
            expect.anything(),
        );
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('search=prod'),
            expect.anything(),
        );
    });

    it('throws on a non-ok HTTP response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientScheduleService.getSchedules()).rejects.toThrow('boom');
    });

    it('throws when success is false', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'no access' }));
        await expect(ClientScheduleService.getSchedules()).rejects.toThrow('no access');
    });
});

describe('ClientScheduleService.getSchedule', () => {
    it('returns null on 404', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
        expect(await ClientScheduleService.getSchedule('s-missing')).toBeNull();
    });

    it('returns the schedule object directly on success', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 's1', name: 'x' }));
        expect(await ClientScheduleService.getSchedule('s1')).toEqual({ id: 's1', name: 'x' });
    });

    it('throws on other non-ok responses', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientScheduleService.getSchedule('s1')).rejects.toThrow('boom');
    });
});

describe('ClientScheduleService.createSchedule', () => {
    it('unwraps a success/data envelope response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: { id: 's1' } }));
        const result = await ClientScheduleService.createSchedule({ name: 'x' } as any);
        expect(result).toEqual({ id: 's1' });
    });

    it('returns the raw object when there is no envelope', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 's1' }));
        const result = await ClientScheduleService.createSchedule({ name: 'x' } as any);
        expect(result).toEqual({ id: 's1' });
    });

    it('throws when success is explicitly false', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'invalid' }));
        await expect(ClientScheduleService.createSchedule({ name: 'x' } as any)).rejects.toThrow('invalid');
    });

    it('throws on a non-ok HTTP response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientScheduleService.createSchedule({ name: 'x' } as any)).rejects.toThrow('boom');
    });
});

describe('ClientScheduleService.updateSchedule', () => {
    it('returns the updated schedule directly', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 's1', name: 'Renamed' }));
        const result = await ClientScheduleService.updateSchedule('s1', { name: 'Renamed' });
        expect(result).toEqual({ id: 's1', name: 'Renamed' });
    });

    it('throws on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientScheduleService.updateSchedule('s1', {})).rejects.toThrow('boom');
    });
});

describe('ClientScheduleService.deleteSchedule', () => {
    it('resolves on success', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true }));
        await expect(ClientScheduleService.deleteSchedule('s1')).resolves.toBeUndefined();
    });

    it('throws on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientScheduleService.deleteSchedule('s1')).rejects.toThrow('boom');
    });
});

describe('ClientScheduleService.toggleScheduleStatus', () => {
    it('unwraps a success/data envelope response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: { id: 's1', active: false } }));
        const result = await ClientScheduleService.toggleScheduleStatus('s1');
        expect(result).toEqual({ id: 's1', active: false });
    });

    it('throws when success is explicitly false', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'not found' }));
        await expect(ClientScheduleService.toggleScheduleStatus('s1')).rejects.toThrow('not found');
    });

    it('throws on a non-ok HTTP response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientScheduleService.toggleScheduleStatus('s1')).rejects.toThrow('boom');
    });
});
