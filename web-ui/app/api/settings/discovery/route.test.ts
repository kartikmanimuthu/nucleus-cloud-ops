import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
        })),
    },
}));

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn().mockResolvedValue('tenant-1') }));
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn(),
        saveConfig: vi.fn().mockResolvedValue(undefined),
    },
}));

import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { GET, PUT } from '@/app/api/settings/discovery/route';

const makeRequest = (body?: unknown) =>
    ({ json: vi.fn().mockResolvedValue(body ?? {}) }) as any;

describe('GET /api/settings/discovery', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns stored period', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ period: 'weekly' });
        const res = await GET();
        expect((res as any)._data).toEqual({ success: true, data: { period: 'weekly' } });
    });

    it('returns default period when no config stored', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce(null);
        const res = await GET();
        expect((res as any)._data).toEqual({ success: true, data: { period: 'daily' } });
    });

    it('returns 403 when unauthorized', async () => {
        vi.mocked(authorize).mockResolvedValueOnce({ status: 403 } as any);
        const res = await GET();
        expect(res).toEqual({ status: 403 });
    });

    it('returns 500 on service error', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValueOnce(new Error('db error'));
        const res = await GET();
        expect((res as any)._status).toBe(500);
        expect((res as any)._data.success).toBe(false);
    });
});

describe('PUT /api/settings/discovery', () => {
    beforeEach(() => vi.clearAllMocks());

    it('saves valid period and returns it', async () => {
        const res = await PUT(makeRequest({ period: 'weekly' }));
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith('discovery-cron', { period: 'weekly' }, 'tenant-1', 'user');
        expect((res as any)._data).toEqual({ success: true, data: { period: 'weekly' } });
    });

    it('accepts daily period', async () => {
        const res = await PUT(makeRequest({ period: 'daily' }));
        expect((res as any)._data).toEqual({ success: true, data: { period: 'daily' } });
    });

    it('rejects invalid period', async () => {
        const res = await PUT(makeRequest({ period: 'hourly' }));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.success).toBe(false);
    });

    it('rejects missing period', async () => {
        const res = await PUT(makeRequest({}));
        expect((res as any)._status).toBe(400);
    });

    it('returns 403 when unauthorized', async () => {
        vi.mocked(authorize).mockResolvedValueOnce({ status: 403 } as any);
        const res = await PUT(makeRequest({ period: 'daily' }));
        expect(res).toEqual({ status: 403 });
    });

    it('returns 500 on service error', async () => {
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValueOnce(new Error('db error'));
        const res = await PUT(makeRequest({ period: 'daily' }));
        expect((res as any)._status).toBe(500);
        expect((res as any)._data.success).toBe(false);
    });
});
