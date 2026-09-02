import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn(), getPrismaClient: vi.fn() }));

import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient, getPrismaClient } from '@/lib/db/pg-config';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/inventory/status') => ({ url }) as any;

function makeTenantClient(overrides: Record<string, unknown> = {}) {
    return {
        inventoryResource: {
            count: vi.fn().mockResolvedValue(0),
            groupBy: vi.fn().mockResolvedValue([]),
            findFirst: vi.fn().mockResolvedValue(null),
        },
        account: {
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
        },
        ...overrides,
    };
}

describe('GET /api/inventory/status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getPrismaClient).mockReturnValue({
            inventorySyncStatus: { findFirst: vi.fn().mockResolvedValue(null) },
        } as any);
        vi.mocked(getTenantClient).mockReturnValue(makeTenantClient() as any);
    });

    it('returns latestSync: null when there is no sync status row', async () => {
        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.latestSync).toBeNull();
        expect(body.accounts).toEqual([]);
    });

    it('returns the latest sync row when present', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            inventorySyncStatus: {
                findFirst: vi.fn().mockResolvedValue({
                    scanId: 'scan-1', totalResources: 50, accountsSynced: 2,
                    syncedAt: new Date('2024-01-01T00:00:00Z'), status: 'success',
                }),
            },
        } as any);

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(body.latestSync).toEqual({
            scanId: 'scan-1', totalResources: 50, accountsSynced: 2,
            syncedAt: '2024-01-01T00:00:00.000Z', status: 'success',
        });
    });

    it('returns a single account status when accountId is provided', async () => {
        vi.mocked(getTenantClient).mockReturnValue(makeTenantClient({
            account: {
                findFirst: vi.fn().mockResolvedValue({
                    accountId: 'acc-1', name: 'Prod', lastSyncedAt: new Date('2024-01-01T00:00:00Z'),
                    lastSyncResourceCount: 10, active: true,
                }),
            },
        }) as any);

        const res = await GET(makeRequest('http://localhost/api/inventory/status?accountId=acc-1'));
        const body = await res.json();

        expect(body.accounts).toEqual([{
            accountId: 'acc-1', accountName: 'Prod', lastSyncedAt: '2024-01-01T00:00:00.000Z',
            lastSyncStatus: 'success', lastSyncResourceCount: 10, syncEnabled: true,
        }]);
    });

    it('lists all accounts as never-synced when no accountId filter is given', async () => {
        vi.mocked(getTenantClient).mockReturnValue(makeTenantClient({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod', active: true }]) },
        }) as any);

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(body.accounts).toEqual([{
            accountId: 'acc-1', accountName: 'Prod', lastSyncStatus: 'never', syncEnabled: true,
        }]);
        expect(body.accountCount).toBe(1);
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            inventorySyncStatus: { findFirst: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
