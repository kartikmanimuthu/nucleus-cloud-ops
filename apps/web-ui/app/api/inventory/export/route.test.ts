import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/env', () => ({ env: { AWS_REGION: 'ap-south-1', APP_BUCKET_NAME: 'nucleus-assets' } }));

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(function (this: unknown) { return { send: mockSend }; }),
    PutObjectCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    GetObjectCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

const RESOURCE_ROW = {
    name: 'web-1', status: 'running', region: 'us-east-1', accountId: 'acc-1',
    resourceType: 'ec2_instances', resourceId: 'i-123', tags: {}, metadata: {},
    discoveredAt: new Date('2024-01-01T00:00:00Z'),
};

describe('POST /api/inventory/export', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSignedUrl).mockResolvedValue('https://s3.amazonaws.com/presigned-download');
        mockSend.mockResolvedValue({});
        vi.mocked(getTenantClient).mockReturnValue({
            inventoryResource: { findMany: vi.fn().mockResolvedValue([RESOURCE_ROW]) },
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod' }]) },
        } as any);
    });

    it('returns 404 when no resources match the filters', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            inventoryResource: { findMany: vi.fn().mockResolvedValue([]) },
            account: { findMany: vi.fn() },
        } as any);

        const res = await POST(makeRequest({}));
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(body.error).toContain('No resources found');
    });

    it('uploads the workbook to S3 and returns a presigned download URL', async () => {
        const res = await POST(makeRequest({}));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.resourceCount).toBe(1);
        expect(body.downloadUrl).toBe('https://s3.amazonaws.com/presigned-download');
        expect(body.fileName).toMatch(/^inventory-exports\/tenants\/tenant-1\/inventory-.*\.xlsx$/);
        expect(mockSend).toHaveBeenCalledOnce();
    });

    it('filters by a single accountId', async () => {
        const findMany = vi.fn().mockResolvedValue([RESOURCE_ROW]);
        vi.mocked(getTenantClient).mockReturnValue({
            inventoryResource: { findMany },
            account: { findMany: vi.fn().mockResolvedValue([]) },
        } as any);

        await POST(makeRequest({ accountId: 'acc-1' }));

        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ accountId: 'acc-1' }) })
        );
    });

    it('filters by multiple accountIds via an `in` clause', async () => {
        const findMany = vi.fn().mockResolvedValue([RESOURCE_ROW]);
        vi.mocked(getTenantClient).mockReturnValue({
            inventoryResource: { findMany },
            account: { findMany: vi.fn().mockResolvedValue([]) },
        } as any);

        await POST(makeRequest({ accountIds: ['acc-1', 'acc-2'] }));

        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ accountId: { in: ['acc-1', 'acc-2'] } }) })
        );
    });

    it('treats an unparsable request body as empty filters', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('bad json')) } as any;
        const res = await POST(req);
        expect(res.status).toBe(200);
    });

    it('tolerates a failed account-name lookup, still exporting with blank account names', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            inventoryResource: { findMany: vi.fn().mockResolvedValue([RESOURCE_ROW]) },
            account: { findMany: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await POST(makeRequest({}));
        expect(res.status).toBe(200);
    });

    it('generates a .csv fileName when format=csv', async () => {
        const res = await POST(makeRequest({ format: 'csv' }));
        const body = await res.json();
        expect(body.fileName).toMatch(/\.csv$/);
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            inventoryResource: { findMany: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await POST(makeRequest({}));
        expect(res.status).toBe(500);
    });
});

describe('POST /api/inventory/export — no app bucket configured', () => {
    it('returns 500 without touching the database when APP_BUCKET_NAME is unset', async () => {
        vi.resetModules();
        vi.doMock('@/env', () => ({ env: { AWS_REGION: 'ap-south-1', APP_BUCKET_NAME: '' } }));
        vi.doMock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
        const dbMock = { getTenantClient: vi.fn() };
        vi.doMock('@/lib/db/pg-config', () => dbMock);

        const { POST: postNoBucket } = await import('./route');
        const res = await postNoBucket(makeRequest({}));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('App bucket not configured');
        expect(dbMock.getTenantClient).not.toHaveBeenCalled();

        vi.doUnmock('@/env');
        vi.doUnmock('@/lib/auth-session');
        vi.doUnmock('@/lib/db/pg-config');
    });
});
