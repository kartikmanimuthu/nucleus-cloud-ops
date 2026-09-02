import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getInventoryRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/rbac/row-filter', () => ({ getReadRowFilter: vi.fn().mockResolvedValue(null) }));

import { getInventoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { GET } from './route';

const makeRequest = (url: string) => ({ url }) as any;

describe('GET /api/inventory/resources', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([]) },
        } as any);
    });

    it('returns resources enriched with account names', async () => {
        const listResources = vi.fn().mockResolvedValue({
            resources: [{ id: 'r1', accountId: 'acc-1' }],
            total: 1,
        });
        vi.mocked(getInventoryRepository).mockReturnValue({ listResources } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod' }]) },
        } as any);

        const res = await GET(makeRequest('http://localhost/api/inventory/resources'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.resources).toEqual([{ id: 'r1', accountId: 'acc-1', accountName: 'Prod' }]);
        expect(body.count).toBe(1);
        expect(body.total).toBe(1);
        expect(body.hasMore).toBe(false);
    });

    it('normalizes comma-separated accountIds into a single accountId when there is exactly one', async () => {
        const listResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
        vi.mocked(getInventoryRepository).mockReturnValue({ listResources } as any);

        await GET(makeRequest('http://localhost/api/inventory/resources?accountIds=acc-1'));

        expect(listResources).toHaveBeenCalledWith(
            expect.objectContaining({ accountId: 'acc-1', accountIds: undefined })
        );
    });

    it('passes multiple accountIds through as accountIds when there is more than one', async () => {
        const listResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
        vi.mocked(getInventoryRepository).mockReturnValue({ listResources } as any);

        await GET(makeRequest('http://localhost/api/inventory/resources?accountIds=acc-1,acc-2'));

        expect(listResources).toHaveBeenCalledWith(
            expect.objectContaining({ accountId: undefined, accountIds: ['acc-1', 'acc-2'] })
        );
    });

    it('sets hasMore true when more resources exist than were returned', async () => {
        const listResources = vi.fn().mockResolvedValue({ resources: [{ id: 'r1', accountId: 'a1' }], total: 100 });
        vi.mocked(getInventoryRepository).mockReturnValue({ listResources } as any);

        const res = await GET(makeRequest('http://localhost/api/inventory/resources'));
        const body = await res.json();

        expect(body.hasMore).toBe(true);
    });

    it('does not fail the request when the account-name lookup throws', async () => {
        const listResources = vi.fn().mockResolvedValue({ resources: [{ id: 'r1', accountId: 'acc-1' }], total: 1 });
        vi.mocked(getInventoryRepository).mockReturnValue({ listResources } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET(makeRequest('http://localhost/api/inventory/resources'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.resources[0].accountName).toBeUndefined();
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getInventoryRepository).mockReturnValue({
            listResources: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET(makeRequest('http://localhost/api/inventory/resources'));
        expect(res.status).toBe(500);
    });
});
