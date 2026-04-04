import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth session — controls which tenant the test impersonates
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
    getSessionUserId: vi.fn(),
}));

// Mock RBAC — always allow (testing data isolation, not permissions)
vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn().mockResolvedValue(null),
}));

// Mock AccountService — intercept at service layer where tenantId is passed
vi.mock('@/lib/account-service', () => ({
    AccountService: {
        getAccounts: vi.fn(),
    },
}));

// Mock next-auth (imported by route but not used in GET)
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

import { getSessionTenantId } from '@/lib/auth-session';
import { AccountService } from '@/lib/account-service';
import { GET } from '@/app/api/accounts/route';

describe('Accounts API — cross-tenant isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(AccountService.getAccounts).mockResolvedValue({ accounts: [], totalCount: 0 });
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    });

    it('GET passes tenant-a to AccountService — tenant-b data never queried', async () => {
        const req = new NextRequest('http://localhost:3000/api/accounts');
        await GET(req);

        expect(AccountService.getAccounts).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-a' })
        );

        const calls = vi.mocked(AccountService.getAccounts).mock.calls;
        for (const [arg] of calls) {
            if (arg && typeof arg === 'object' && 'tenantId' in arg) {
                expect(arg.tenantId).not.toBe('tenant-b');
            }
        }
    });

    it('switching session to tenant-b queries tenant-b only', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-b');
        const req = new NextRequest('http://localhost:3000/api/accounts');
        await GET(req);

        expect(AccountService.getAccounts).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-b' })
        );
    });

    it('tenant-a session never triggers a tenant-b query', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
        const req = new NextRequest('http://localhost:3000/api/accounts');
        await GET(req);

        const calls = vi.mocked(AccountService.getAccounts).mock.calls;
        const tenantIds = calls.map(([arg]) => (arg as { tenantId?: string })?.tenantId);
        expect(tenantIds).not.toContain('tenant-b');
    });
});
