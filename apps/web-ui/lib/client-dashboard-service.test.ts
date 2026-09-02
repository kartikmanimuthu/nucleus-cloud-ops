import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientDashboardService } from '@/lib/client-dashboard-service';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as any;
}

describe('ClientDashboardService.fetchZone', () => {
    it('builds the request URL from the zone and range, defaulting range to 24h', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: { kpis: [] } }));

        const result = await ClientDashboardService.fetchZone('hero');

        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('/api/dashboard?zone=hero&range=24h');
        expect(init).toMatchObject({ method: 'GET', cache: 'no-store' });
        expect(result).toEqual({ kpis: [] });
    });

    it('passes through an explicit range', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: {} }));
        await ClientDashboardService.fetchZone('coverage', '7d');
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/dashboard?zone=coverage&range=7d');
    });

    it('throws with the API error message on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'DB unreachable' }, 500));
        await expect(ClientDashboardService.fetchZone('hero')).rejects.toThrow('DB unreachable');
    });

    it('throws a generic HTTP error when the response has no error message', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }, 503));
        await expect(ClientDashboardService.fetchZone('hero')).rejects.toThrow('HTTP error! status: 503');
    });

    it('throws when success is true but data is missing', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true }));
        await expect(ClientDashboardService.fetchZone('hero')).rejects.toThrow('Dashboard API returned empty data');
    });
});
