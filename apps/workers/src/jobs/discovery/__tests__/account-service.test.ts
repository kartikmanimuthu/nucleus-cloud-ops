import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import {
  getAllTenants,
  getTenantAccounts,
  updateAccountSyncStatus,
} from '../services/account-service.js';

describe('account-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  describe('getAllTenants', () => {
    it('should return active tenants ordered by createdAt', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'tenant-1', name: 'Acme Corp' },
          { id: 'tenant-2', name: 'Globex' },
        ],
      });

      const tenants = await getAllTenants();

      expect(tenants).toHaveLength(2);
      expect(tenants[0].id).toBe('tenant-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'active'"),
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should throw on error so pg-boss retries the fan-out job', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(getAllTenants()).rejects.toThrow('connection refused');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('getTenantAccounts', () => {
    it('should return active accounts for a tenant', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'acc-1',
            tenantId: 'tenant-1',
            accountId: '123456789012',
            name: 'Production',
            roleArn: 'arn:aws:iam::123456789012:role/NucleusAccess',
            externalId: null,
            regions: ['us-east-1', 'ap-south-1'],
            active: true,
          },
        ],
      });

      const accounts = await getTenantAccounts('tenant-1');

      expect(accounts).toHaveLength(1);
      expect(accounts[0].accountId).toBe('123456789012');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('"tenantId" = $1'),
        ['tenant-1'],
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should throw on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('query failed'));

      await expect(getTenantAccounts('tenant-1')).rejects.toThrow('query failed');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('updateAccountSyncStatus', () => {
    it('should update sync status fields on the account with derived connectionStatus', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await updateAccountSyncStatus('tenant-1', '123456789012', {
        lastSyncedAt: '2026-04-05T02:30:00Z',
        lastSyncStatus: 'success',
        lastSyncResourceCount: 150,
      });

      // updatedAt/lastSyncedAt are ISO strings (new Date().toISOString()), not
      // Date objects — the query binds them straight through to Postgres.
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE accounts'),
        [
          'tenant-1',
          '123456789012',
          'connected',  // derived from success → connected
          null,         // no error
          expect.any(String), // updatedAt
          '2026-04-05T02:30:00Z', // lastSyncedAt, passed through verbatim
          150,
        ],
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should set connectionStatus to error when sync fails', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await updateAccountSyncStatus('tenant-1', '123456789012', {
        lastSyncedAt: '2026-04-05T02:30:00Z',
        lastSyncStatus: 'error',
        lastSyncResourceCount: 0,
        lastSyncError: 'AssumeRole failed',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE accounts'),
        [
          'tenant-1',
          '123456789012',
          'error',           // derived from error → error
          'AssumeRole failed',
          expect.any(String), // updatedAt
          '2026-04-05T02:30:00Z', // lastSyncedAt, passed through verbatim
          0,
        ],
      );
    });

    it('should not throw on update error (non-fatal)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('update failed'));

      await expect(
        updateAccountSyncStatus('tenant-1', '123456789012', {
          lastSyncedAt: '2026-04-05T02:30:00Z',
          lastSyncStatus: 'failed',
          lastSyncResourceCount: 0,
        }),
      ).resolves.toBeUndefined();

      expect(mockRelease).toHaveBeenCalled();
    });
  });
});
