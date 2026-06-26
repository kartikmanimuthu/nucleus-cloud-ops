import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth session — controls which tenant the test impersonates
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
    getSessionUserId: vi.fn(),
}));

// Mock repository factory — inventory route calls repo directly (no service layer)
vi.mock('@/lib/db/repository-factory', () => ({
    getInventoryRepository: vi.fn(),
}));

import { getSessionTenantId } from '@/lib/auth-session';
import { getInventoryRepository } from '@/lib/db/repository-factory';
import { GET } from '@/app/api/inventory/resources/route';

describe('Inventory API — cross-tenant isolation', () => {
    let mockRepo: { listResources: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        mockRepo = {
            listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
        };
        vi.mocked(getInventoryRepository).mockReturnValue(mockRepo as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    });

    it('GET passes tenant-a to repository — tenant-b data never queried', async () => {
        const req = new NextRequest('http://localhost:3000/api/inventory/resources');
        await GET(req);

        expect(mockRepo.listResources).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-a' })
        );

        const calls = mockRepo.listResources.mock.calls;
        for (const [arg] of calls) {
            if (arg && typeof arg === 'object' && 'tenantId' in arg) {
                expect(arg.tenantId).not.toBe('tenant-b');
            }
        }
    });

    it('switching session to tenant-b queries tenant-b only', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-b');
        const req = new NextRequest('http://localhost:3000/api/inventory/resources');
        await GET(req);

        expect(mockRepo.listResources).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-b' })
        );
    });

    it('tenant-a session never triggers a tenant-b query', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
        const req = new NextRequest('http://localhost:3000/api/inventory/resources');
        await GET(req);

        const calls = mockRepo.listResources.mock.calls;
        const tenantIds = calls.map(([arg]) => (arg as { tenantId?: string })?.tenantId);
        expect(tenantIds).not.toContain('tenant-b');
    });
});
