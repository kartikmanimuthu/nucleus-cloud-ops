import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn(), createDataSource: vi.fn(), updateDataSource: vi.fn(), updateDataSourceCount: vi.fn(),
    },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));
vi.mock('@/env', () => ({ env: { AWS_REGION: 'us-east-1', APP_BUCKET_NAME: 'nucleus-assets' } }));

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(function (this: unknown) { return { send: mockSend }; }),
    PutObjectCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getBoss } from '@/lib/boss-client';
import { POST } from './route';

const makeParams = (kbId: string) => ({ params: Promise.resolve({ kbId }) });
const makeFile = (name: string, content: string, type: string) => new File([content], name, { type });

const makeRequest = (file: File | null) => ({
    formData: vi.fn().mockResolvedValue({ get: () => file }),
}) as any;

describe('POST /api/knowledge-base/[kbId]/upload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1' } as any);
        mockSend.mockResolvedValue({});
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue('job-1') } as any);
        vi.mocked(KnowledgeBaseService.createDataSource).mockResolvedValue({ id: 'ds-1', name: 'doc.pdf' } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await POST(makeRequest(makeFile('doc.pdf', 'x', 'application/pdf')), makeParams('kb-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the caller does not own the knowledge base', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await POST(makeRequest(makeFile('doc.pdf', 'x', 'application/pdf')), makeParams('kb-other'));
        expect(res.status).toBe(403);
    });

    it('returns 400 when no file is provided', async () => {
        const res = await POST(makeRequest(null), makeParams('kb-1'));
        expect(res.status).toBe(400);
    });

    it('returns 400 for an unsupported file type', async () => {
        const res = await POST(makeRequest(makeFile('archive.zip', 'x', 'application/zip')), makeParams('kb-1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Unsupported file type');
    });

    it('stages the file to S3, creates a syncing data source, and enqueues the job', async () => {
        const file = makeFile('doc.pdf', 'PDF content', 'application/pdf');
        const send = vi.fn().mockResolvedValue('job-1');
        vi.mocked(getBoss).mockResolvedValue({ send } as any);

        const res = await POST(makeRequest(file), makeParams('kb-1'));
        const body = await res.json();

        expect(res.status).toBe(202);
        expect(body.dataSource.id).toBe('ds-1');
        expect(mockSend).toHaveBeenCalledOnce();
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith('kb-1', 'ds-1', { status: 'syncing' }, 'tenant-1');
        expect(send).toHaveBeenCalledWith('kb-sync', expect.objectContaining({ type: 'file-upload', kbId: 'kb-1', dsId: 'ds-1' }));
    });
});
