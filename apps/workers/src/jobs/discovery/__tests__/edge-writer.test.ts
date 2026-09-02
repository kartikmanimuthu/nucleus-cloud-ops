import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResourceEdge } from '../types.js';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn(function () { return { connect: mockConnect }; }),
}));

import { writeEdgesToPg, reconcileStaleEdges } from '../services/edge-writer.js';

describe('edge-writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  describe('writeEdgesToPg', () => {
    it('upserts edges with ON CONFLICT', async () => {
      const edges: ResourceEdge[] = [
        { fromType: 'ec2_instances', fromId: 'i-123', relation: 'belongs_to', toType: 'ec2_vpcs', toId: 'vpc-456' },
      ];

      await writeEdgesToPg(edges, 'tenant-1', 'acc-123', 'us-east-1', 'job-1');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('INSERT INTO resource_edges');
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('"isCurrent" = true');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('passes tenantId as a bound parameter', async () => {
      const edges: ResourceEdge[] = [
        { fromType: 'ec2_instances', fromId: 'i-123', relation: 'belongs_to', toType: 'ec2_vpcs', toId: 'vpc-456' },
      ];

      await writeEdgesToPg(edges, 'tenant-abc', 'acc-456', 'us-east-1', 'job-1');

      const params = mockQuery.mock.calls[0][1];
      expect(params).toContain('tenant-abc');
      expect(params).toContain('acc-456');
    });

    it('returns 0 and issues no query for an empty array', async () => {
      const count = await writeEdgesToPg([], 'tenant-1', 'acc-123', 'us-east-1', 'job-1');
      expect(count).toBe(0);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('batches in chunks of 500', async () => {
      const edges: ResourceEdge[] = Array.from({ length: 600 }, (_, i) => ({
        fromType: 'ec2_instances',
        fromId: `i-${i}`,
        relation: 'belongs_to',
        toType: 'ec2_vpcs',
        toId: `vpc-${i}`,
      }));

      await writeEdgesToPg(edges, 'tenant-1', 'acc-123', 'us-east-1', 'job-1');

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('includes toAccountId when present and null when absent', async () => {
      const edges: ResourceEdge[] = [
        { fromType: 'ec2_instances', fromId: 'i-1', relation: 'belongs_to', toType: 'ec2_vpcs', toId: 'vpc-1', toAccountId: 'acc-999' },
        { fromType: 'ec2_instances', fromId: 'i-2', relation: 'belongs_to', toType: 'ec2_vpcs', toId: 'vpc-2' },
      ];

      await writeEdgesToPg(edges, 'tenant-1', 'acc-123', 'us-east-1', 'job-1');

      const params = mockQuery.mock.calls[0][1];
      expect(params).toContain('acc-999');
      expect(params).toContain(null);
    });

    // One scan covers every region in the account, so a single region argument
    // cannot describe the whole batch.
    it('writes each edge with its own region rather than one region for the batch', async () => {
      const edges: ResourceEdge[] = [
        { fromType: 'ec2_instances', fromId: 'i-east', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-east', region: 'us-east-1' },
        { fromType: 'ec2_instances', fromId: 'i-west', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-west', region: 'eu-west-1' },
      ];

      await writeEdgesToPg(edges, 'tenant-1', 'acc-123', 'us-east-1', 'job-1');

      // 11 bound params per row; region is the 4th.
      const params = mockQuery.mock.calls[0][1];
      expect(params[3]).toBe('us-east-1');
      expect(params[14]).toBe('eu-west-1');
    });

    it('falls back to the region argument for an edge carrying no region', async () => {
      const edges: ResourceEdge[] = [
        { fromType: 'ec2_instances', fromId: 'i-1', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1' },
      ];

      await writeEdgesToPg(edges, 'tenant-1', 'acc-123', 'ap-south-1', 'job-1');

      expect(mockQuery.mock.calls[0][1][3]).toBe('ap-south-1');
    });

    it('releases the client and rethrows on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const edges: ResourceEdge[] = [
        { fromType: 'ec2_instances', fromId: 'i-123', relation: 'belongs_to', toType: 'ec2_vpcs', toId: 'vpc-456' },
      ];

      await expect(
        writeEdgesToPg(edges, 'tenant-1', 'acc-123', 'us-east-1', 'job-1'),
      ).rejects.toThrow('connection refused');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('reconcileStaleEdges', () => {
    it('scopes to tenant and account and never deletes', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });

      await reconcileStaleEdges('tenant-1', 'acc-123', 'job-999');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('UPDATE resource_edges');
      expect(sql).toContain('SET "isCurrent" = false');
      expect(sql).toContain('"tenantId" = $1');
      expect(sql).toContain('"accountId" = $2');
      expect(sql).not.toContain('DELETE');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('uses IS DISTINCT FROM for jobRunId comparison', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await reconcileStaleEdges('tenant-1', 'acc-123', 'job-999');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('IS DISTINCT FROM $3');
    });

    it('returns rowCount', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 });

      const count = await reconcileStaleEdges('tenant-1', 'acc-123', 'job-999');

      expect(count).toBe(5);
    });

    it('returns 0 when rowCount is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null });

      const count = await reconcileStaleEdges('tenant-1', 'acc-123', 'job-999');

      expect(count).toBe(0);
    });

    it('releases the client and rethrows on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('db down'));

      await expect(
        reconcileStaleEdges('tenant-1', 'acc-123', 'job-999'),
      ).rejects.toThrow('db down');
      expect(mockRelease).toHaveBeenCalled();
    });
  });
});
