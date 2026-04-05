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

    it('should return empty array on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const tenants = await getAllTenants();

      expect(tenants).toEqual([]);
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
    it('should update sync status fields on the account', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await updateAccountSyncStatus('tenant-1', '123456789012', {
        lastSyncedAt: '2026-04-05T02:30:00Z',
        lastSyncStatus: 'success',
        lastSyncResourceCount: 150,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE accounts'),
        expect.arrayContaining([
          'tenant-1',
          '123456789012',
          expect.any(Date),
          'success',
          150,
        ]),
      );
      expect(mockRelease).toHaveBeenCalled();
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
