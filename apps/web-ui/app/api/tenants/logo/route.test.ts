import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn(), getSessionTenantId: vi.fn() }));
vi.mock('@/lib/tenant-settings-service', () => ({ TenantSettingsService: { saveLogo: vi.fn() } }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(function (this: unknown) { return {}; }),
    PutObjectCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));
vi.mock('@/env', () => ({
    env: {
        APP_BUCKET_NAME: 'nucleus-assets',
        AWS_REGION: 'us-east-1',
        ASSETS_CDN_URL: undefined,
    },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getAuthSession, getSessionTenantId } from '@/lib/auth-session';
import { TenantSettingsService } from '@/lib/tenant-settings-service';
import { AuditService } from '@/lib/audit-service';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/env';
import { POST, PUT } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/tenants/logo (presign)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        (env as any).APP_BUCKET_NAME = 'nucleus-assets';
        (env as any).ASSETS_CDN_URL = undefined;
    });

    it('returns 500 when APP_BUCKET_NAME is not configured', async () => {
        (env as any).APP_BUCKET_NAME = undefined;

        const res = await POST(makeRequest({ contentType: 'image/png', size: 1000, ext: 'png' }));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toContain('APP_BUCKET_NAME');
        expect(authorize).not.toHaveBeenCalled();
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest({ contentType: 'image/png', size: 1000, ext: 'png' }));
        expect(res).toBe(authError);
    });

    it('returns 400 for a disallowed content type', async () => {
        const res = await POST(makeRequest({ contentType: 'application/pdf', size: 1000, ext: 'pdf' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Allowed formats');
    });

    it('returns 400 when the file exceeds the 2MB limit', async () => {
        const res = await POST(makeRequest({ contentType: 'image/png', size: 3 * 1024 * 1024, ext: 'png' }));
        expect(res.status).toBe(400);
    });

    it('returns a presigned URL and public URL built from the S3 bucket domain', async () => {
        vi.mocked(getSignedUrl).mockResolvedValue('https://s3.amazonaws.com/presigned?sig=abc');

        const res = await POST(makeRequest({ contentType: 'image/png', size: 1000, ext: 'png' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.url).toBe('https://s3.amazonaws.com/presigned?sig=abc');
        expect(body.key).toMatch(/^assets\/tenants\/tenant-1\/logos\/\d+\.png$/);
        expect(body.publicUrl).toContain('nucleus-assets.s3.us-east-1.amazonaws.com');
    });

    it('builds the public URL from ASSETS_CDN_URL when configured', async () => {
        (env as any).ASSETS_CDN_URL = 'https://cdn.example.com';
        vi.mocked(getSignedUrl).mockResolvedValue('https://s3.amazonaws.com/presigned');

        const res = await POST(makeRequest({ contentType: 'image/png', size: 1000, ext: 'png' }));
        const body = await res.json();

        expect(body.publicUrl).toContain('https://cdn.example.com/assets/tenants/tenant-1/logos/');
    });

    it('returns 500 when presigning throws', async () => {
        vi.mocked(getSignedUrl).mockRejectedValue(new Error('S3 error'));

        const res = await POST(makeRequest({ contentType: 'image/png', size: 1000, ext: 'png' }));
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/tenants/logo (save)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        (env as any).APP_BUCKET_NAME = 'nucleus-assets';
        (env as any).ASSETS_CDN_URL = undefined;
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PUT(makeRequest({ key: 'assets/tenants/tenant-1/logos/1.png' }));
        expect(res).toBe(authError);
    });

    it('returns 400 when key is missing', async () => {
        const res = await PUT(makeRequest({}));
        expect(res.status).toBe(400);
    });

    it('saves the logo and returns the public URL', async () => {
        vi.mocked(TenantSettingsService.saveLogo).mockResolvedValue(undefined as any);

        const res = await PUT(makeRequest({ key: 'assets/tenants/tenant-1/logos/1.png' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.logoUrl).toContain('assets/tenants/tenant-1/logos/1.png');
        expect(TenantSettingsService.saveLogo).toHaveBeenCalledWith(
            'tenant-1',
            expect.objectContaining({ key: 'assets/tenants/tenant-1/logos/1.png' }),
            'u1'
        );
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'tenant.logo.updated', status: 'success' })
        );
    });

    it('returns 500 and logs a failure audit event when the service throws', async () => {
        vi.mocked(TenantSettingsService.saveLogo).mockRejectedValue(new Error('DB down'));

        const res = await PUT(makeRequest({ key: 'assets/tenants/tenant-1/logos/1.png' }));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
