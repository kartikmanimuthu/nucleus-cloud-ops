import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientAuditService } from './client-audit-service-api';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as any;
}

describe('ClientAuditService.getAuditLogs', () => {
    it('builds a query string from filters, dropping empty values', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: [{ id: 'l1' }], nextPageToken: 'next' }));

        const result = await ClientAuditService.getAuditLogs({ status: 'success', user: '', limit: 10 });

        const url = vi.mocked(fetch).mock.calls[0][0] as string;
        expect(url).toContain('status=success');
        expect(url).not.toContain('user=');
        expect(result).toEqual({ logs: [{ id: 'l1' }], nextPageToken: 'next' });
    });

    it('omits the query string entirely with no filters', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: [] }));
        await ClientAuditService.getAuditLogs();
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/audit');
    });

    it('throws on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientAuditService.getAuditLogs()).rejects.toThrow('boom');
    });

    it('throws when success is false', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'denied' }));
        await expect(ClientAuditService.getAuditLogs()).rejects.toThrow('denied');
    });
});

describe('ClientAuditService.getAuditLogStats', () => {
    it('fetches from the stats URL and returns the data payload', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: { totalLogs: 5 } }));
        const result = await ClientAuditService.getAuditLogStats({ severity: 'high' });
        expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/api/audit/stats?severity=high');
        expect(result).toEqual({ totalLogs: 5 });
    });

    it('throws on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientAuditService.getAuditLogStats()).rejects.toThrow('boom');
    });

    it('throws when success is false', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'stats unavailable' }));
        await expect(ClientAuditService.getAuditLogStats()).rejects.toThrow('stats unavailable');
    });
});

describe('ClientAuditService.getAuditLogsByCorrelationId', () => {
    it('fetches the correlation-scoped endpoint', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: [{ id: 'l1' }] }));
        const result = await ClientAuditService.getAuditLogsByCorrelationId('corr 1');
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/audit/correlation/corr%201');
        expect(result).toEqual([{ id: 'l1' }]);
    });

    it('throws when success is false', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'not found' }));
        await expect(ClientAuditService.getAuditLogsByCorrelationId('corr1')).rejects.toThrow('not found');
    });

    it('throws on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientAuditService.getAuditLogsByCorrelationId('corr1')).rejects.toThrow('boom');
    });
});

describe('ClientAuditService.logUserAction', () => {
    it('POSTs the audit payload', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true }));
        await ClientAuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', user: 'a@b.co', userType: 'user', status: 'success',
        });
        expect(fetch).toHaveBeenCalledWith('/api/audit', expect.objectContaining({ method: 'POST' }));
    });

    it('throws on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        await expect(ClientAuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', user: 'a@b.co', userType: 'user', status: 'success',
        })).rejects.toThrow('boom');
    });

    it('throws when success is false', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false, error: 'validation failed' }));
        await expect(ClientAuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', user: 'a@b.co', userType: 'user', status: 'success',
        })).rejects.toThrow('validation failed');
    });
});
