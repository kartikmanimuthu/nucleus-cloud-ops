import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/scaling-audit-service', () => ({
    ScalingAuditService: { getExportData: vi.fn(), logExport: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/network-links-service', () => ({ NetworkLinksService: { listSamples: vi.fn() } }));
vi.mock('@/lib/scaling-audit-export', () => ({
    buildCoverageStatement: vi.fn().mockReturnValue('coverage statement'),
    buildNetworkCoverageStatement: vi.fn().mockReturnValue('network coverage statement'),
    buildNetworkPdf: vi.fn().mockResolvedValue(Buffer.from('pdf')),
    buildNetworkWorkbook: vi.fn().mockResolvedValue(Buffer.from('xlsx')),
    buildPdf: vi.fn().mockResolvedValue(Buffer.from('pdf')),
    buildWorkbook: vi.fn().mockResolvedValue(Buffer.from('xlsx')),
    exportTitle: vi.fn().mockReturnValue('Scaling Audit'),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import { NetworkLinksService } from '@/lib/network-links-service';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/scaling-audit/export', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
        vi.mocked(ScalingAuditService.getExportData).mockResolvedValue({
            events: [{ id: 'e1' }], gaps: [], seal: null, truncated: false,
        } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest({}));
        expect(res).toBe(authError);
    });

    it('exports xlsx by default with the correct content type and filename', async () => {
        const res = await POST(makeRequest({}));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(res.headers.get('Content-Disposition')).toContain('scaling-audit-all-scopes-');
        expect(ScalingAuditService.logExport).toHaveBeenCalledWith(
            'tenant-1', 'u1', 'xlsx', expect.any(Object), 1, null
        );
    });

    it('exports pdf when format=pdf', async () => {
        const res = await POST(makeRequest({ format: 'pdf' }));
        expect(res.headers.get('Content-Type')).toBe('application/pdf');
    });

    it('routes scope=network to the network report path', async () => {
        vi.mocked(NetworkLinksService.listSamples).mockResolvedValue([]);

        const res = await POST(makeRequest({ scope: 'network', dateFrom: '2024-06-01', dateTo: '2024-06-02' }));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Disposition')).toContain('network-availability-');
        expect(NetworkLinksService.listSamples).toHaveBeenCalled();
    });

    it('exports the network report as pdf when format=pdf', async () => {
        vi.mocked(NetworkLinksService.listSamples).mockResolvedValue([]);

        const res = await POST(makeRequest({ scope: 'network', format: 'pdf', dateFrom: '2024-06-01', dateTo: '2024-06-02' }));

        expect(res.headers.get('Content-Type')).toBe('application/pdf');
    });

    it('treats an unparsable request body as empty filters', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('bad json')) } as any;
        const res = await POST(req);
        expect(res.status).toBe(200);
    });

    it('returns 400 for a network export missing dateFrom/dateTo', async () => {
        const res = await POST(makeRequest({ scope: 'network' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('required for a network export');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScalingAuditService.getExportData).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest({}));
        expect(res.status).toBe(500);
    });
});
