import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: { listKnowledgeBases: vi.fn(), createKnowledgeBase: vi.fn() },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/row-filter', () => ({ getReadRowFilter: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import { AuditService } from '@/lib/audit-service';
import { GET, POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/knowledge-base', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await GET();
        expect(res.status).toBe(401);
    });

    it('lists knowledge bases scoped by tenant and the read row filter', async () => {
        vi.mocked(getReadRowFilter).mockResolvedValue({ x: 1 } as any);
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([{ id: 'kb1' }] as any);

        const res = await GET();
        const body = await res.json();

        expect(KnowledgeBaseService.listKnowledgeBases).toHaveBeenCalledWith('tenant-1', { x: 1 });
        expect(res.status).toBe(200);
        expect(body.knowledgeBases).toEqual([{ id: 'kb1' }]);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('POST /api/knowledge-base', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await POST(makeRequest({ name: 'KB' }));
        expect(res.status).toBe(401);
    });

    it('returns 400 when name is blank', async () => {
        const res = await POST(makeRequest({ name: '  ' }));
        expect(res.status).toBe(400);
    });

    it('creates the knowledge base scoped by tenant and logs an audit event', async () => {
        vi.mocked(KnowledgeBaseService.createKnowledgeBase).mockResolvedValue({ id: 'kb1', name: 'KB' } as any);

        const res = await POST(makeRequest({ name: 'KB', description: 'desc' }));
        const body = await res.json();

        expect(KnowledgeBaseService.createKnowledgeBase).toHaveBeenCalledWith(
            { name: 'KB', description: 'desc' }, 'tenant-1', 'a@b.co',
        );
        expect(res.status).toBe(201);
        expect(body.knowledgeBase).toEqual({ id: 'kb1', name: 'KB' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'kb.knowledgebase.created', status: 'success' })
        );
    });

    it('returns 500 and logs a failure audit event when creation throws', async () => {
        vi.mocked(KnowledgeBaseService.createKnowledgeBase).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest({ name: 'KB' }));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
