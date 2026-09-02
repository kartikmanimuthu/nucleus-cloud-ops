import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth session — controls which tenant the test impersonates
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
    getSessionUserId: vi.fn(),
}));

// Mock next-auth (KB route uses getServerSession)
vi.mock('next-auth', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { email: 'test@example.com' } }),
}));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

// Mock KnowledgeBaseService — route calls KnowledgeBaseService.listKnowledgeBases(tenantId)
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        listKnowledgeBases: vi.fn(),
    },
}));

import { getSessionTenantId } from '@/lib/auth-session';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { GET } from '@/app/api/knowledge-base/route';

describe('Knowledge Base API — cross-tenant isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([]);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    });

    it('GET passes tenant-a to KnowledgeBaseService — tenant-b data never queried', async () => {
        await GET();

        // Second arg is the Gate 3 row filter (getReadRowFilter) — null here since
        // the mocked session has no ability, meaning "no narrowing" per its own
        // contract, not "unscoped": tenantId is still the first, load-bearing arg.
        expect(KnowledgeBaseService.listKnowledgeBases).toHaveBeenCalledWith('tenant-a', null);

        const calls = vi.mocked(KnowledgeBaseService.listKnowledgeBases).mock.calls;
        for (const [tenantId] of calls) {
            expect(tenantId).not.toBe('tenant-b');
        }
    });

    it('switching session to tenant-b queries tenant-b only', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-b');
        await GET();

        expect(KnowledgeBaseService.listKnowledgeBases).toHaveBeenCalledWith('tenant-b', null);
    });

    it('tenant-a session never triggers a tenant-b query', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
        await GET();

        const calls = vi.mocked(KnowledgeBaseService.listKnowledgeBases).mock.calls;
        const tenantIds = calls.map(([id]) => id);
        expect(tenantIds).not.toContain('tenant-b');
    });
});
