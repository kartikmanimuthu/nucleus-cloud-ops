import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Resource } from '../types.js';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import { writeResourcesToPg, saveSyncStatus, extractMetadata, reconcileStaleResources } from '../services/pg-writer.js';

describe('pg-writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  describe('writeResourcesToPg', () => {
    it('should batch upsert resources in chunks of 500', async () => {
      const resources: Resource[] = Array.from({ length: 3 }, (_, i) => ({
        resourceType: 'ec2_instances',
        resourceId: `i-${i}`,
        region: 'us-east-1',
        service: 'ec2',
        name: `instance-${i}`,
        state: 'running',
        tags: { Name: `instance-${i}` },
        rawData: { InstanceId: `i-${i}` },
      }));

      const count = await writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1');

      expect(count).toBe(3);
      expect(mockConnect).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO inventory_resources'),
        expect.any(Array),
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        expect.any(Array),
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should deduplicate resources on (resourceType, resourceId)', async () => {
      const resources: Resource[] = [
        { resourceType: 'ec2_instances', resourceId: 'i-123', region: 'us-east-1', service: 'ec2', name: 'first', state: 'running', tags: {}, rawData: {} },
        { resourceType: 'ec2_instances', resourceId: 'i-123', region: 'us-east-1', service: 'ec2', name: 'duplicate', state: 'stopped', tags: {}, rawData: {} },
      ];

      const count = await writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1');

      expect(count).toBe(1);
    });

    it('should return 0 for empty resources array', async () => {
      const count = await writeResourcesToPg([], 'tenant-1', 'acc-123', 'job-1');
      expect(count).toBe(0);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('should include tenantId and accountId in every row', async () => {
      const resources: Resource[] = [
        { resourceType: 'ec2_vpcs', resourceId: 'vpc-123', region: 'us-east-1', service: 'ec2', name: 'main-vpc', state: 'available', tags: { Name: 'main-vpc' }, rawData: {} },
      ];

      await writeResourcesToPg(resources, 'tenant-abc', 'acc-456', 'job-1');

      const params = mockQuery.mock.calls[0][1];
      expect(params).toContain('tenant-abc');
      expect(params).toContain('acc-456');
    });

    it('should throw on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const resources: Resource[] = [
        { resourceType: 'ec2_instances', resourceId: 'i-123', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      ];

      await expect(
        writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1'),
      ).rejects.toThrow('connection refused');
    });

    it('reactivates previously-stale rows via isCurrent = true on conflict', async () => {
      const resources: Resource[] = [
        { resourceType: 'ec2_instances', resourceId: 'i-1', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      ];

      await writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('"isCurrent" = true');
    });
  });

  describe('saveSyncStatus', () => {
    it('should upsert sync status row', async () => {
      await saveSyncStatus('scan-123', 500, 3, 'tenant-1', 'completed', ['Account 123: timeout']);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('inventory_sync_status'),
        expect.arrayContaining(['scan-123', 'tenant-1', 500, 3, 'completed', ['Account 123: timeout']]),
      );
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('reconcileStaleResources', () => {
    it('marks rows stale when jobRunId differs from the current scan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 });

      const count = await reconcileStaleResources('tenant-1', 'acc-123', 'scan-999');

      expect(count).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SET "isCurrent" = false'),
        ['tenant-1', 'acc-123', 'scan-999'],
      );
    });

    it('scopes the UPDATE to tenantId, accountId, and a differing jobRunId', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await reconcileStaleResources('tenant-1', 'acc-123', 'scan-999');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('"tenantId" = $1');
      expect(sql).toContain('"accountId" = $2');
      expect(sql).toContain('IS DISTINCT FROM $3');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('returns 0 when rowCount is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null });

      const count = await reconcileStaleResources('tenant-1', 'acc-123', 'scan-999');

      expect(count).toBe(0);
    });

    it('releases the client and rethrows on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('db down'));

      await expect(
        reconcileStaleResources('tenant-1', 'acc-123', 'scan-999'),
      ).rejects.toThrow('db down');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('extractMetadata', () => {
    it('should extract EC2 instance metadata', () => {
      const resource: Resource = {
        resourceType: 'ec2_instances', resourceId: 'i-123', region: 'us-east-1', service: 'ec2', tags: {},
        rawData: { InstanceType: 't3.micro', Platform: 'Linux', PrivateIpAddress: '10.0.1.5', PublicIpAddress: '54.1.2.3', VpcId: 'vpc-123', SubnetId: 'subnet-456', LaunchTime: '2024-01-01T00:00:00Z', ImageId: 'ami-abc123' },
      };
      const metadata = extractMetadata(resource);
      expect(metadata.instanceType).toBe('t3.micro');
      expect(metadata.platform).toBe('Linux');
      expect(metadata.privateIpAddress).toBe('10.0.1.5');
      expect(metadata.publicIpAddress).toBe('54.1.2.3');
      expect(metadata.vpcId).toBe('vpc-123');
      expect(metadata.subnetId).toBe('subnet-456');
    });

    it('should extract RDS instance metadata', () => {
      const resource: Resource = {
        resourceType: 'rds_db_instances', resourceId: 'mydb', region: 'us-east-1', service: 'rds', tags: {},
        rawData: { Engine: 'postgres', EngineVersion: '15.4', DBInstanceClass: 'db.t3.micro', AllocatedStorage: 20, MultiAZ: false, StorageType: 'gp3', Endpoint: { Address: 'mydb.abc.us-east-1.rds.amazonaws.com', Port: 5432 } },
      };
      const metadata = extractMetadata(resource);
      expect(metadata.engine).toBe('postgres');
      expect(metadata.engineVersion).toBe('15.4');
      expect(metadata.dbInstanceClass).toBe('db.t3.micro');
      expect(metadata.allocatedStorage).toBe(20);
      expect(metadata.multiAZ).toBe(false);
      expect(metadata.endpoint).toBe('mydb.abc.us-east-1.rds.amazonaws.com');
    });

    it('should extract Lambda function metadata', () => {
      const resource: Resource = {
        resourceType: 'lambda_functions', resourceId: 'my-func', region: 'us-east-1', service: 'lambda', tags: {},
        rawData: { Runtime: 'nodejs20.x', MemorySize: 256, Timeout: 30, Handler: 'index.handler', CodeSize: 1024000, LastModified: '2024-01-01T00:00:00Z' },
      };
      const metadata = extractMetadata(resource);
      expect(metadata.runtime).toBe('nodejs20.x');
      expect(metadata.memorySize).toBe(256);
      expect(metadata.timeout).toBe(30);
      expect(metadata.handler).toBe('index.handler');
      expect(metadata.codeSize).toBe(1024000);
    });

    it('should extract ECS service metadata', () => {
      const resource: Resource = {
        resourceType: 'ecs_services', resourceId: 'arn:svc1', region: 'us-east-1', service: 'ecs', tags: {},
        rawData: { desiredCount: 2, runningCount: 2, pendingCount: 0, launchType: 'FARGATE', ClusterArn: 'arn:cluster1' },
      };
      const metadata = extractMetadata(resource);
      expect(metadata.desiredCount).toBe(2);
      expect(metadata.runningCount).toBe(2);
      expect(metadata.launchType).toBe('FARGATE');
      expect(metadata.clusterArn).toBe('arn:cluster1');
    });

    // ── SG-013: Fargate Spot Guard metadata ─────────────────────────────────
    //
    // These use the REAL AWS DescribeServices shape. Note the test above feeds
    // `ClusterArn` with a capital C, which is what the `clusterArn` mapping expects — but
    // ECS actually returns lower-case `clusterArn`, so that mapping never matches on real
    // data and metadata.clusterArn is absent on every live row. The fixture above encodes
    // the wrong shape, which is exactly why the discrepancy went unnoticed. It is
    // documented and worked around (ecsClusterArn) rather than changed, since fixing the
    // old mapping would make a value appear where consumers currently see undefined.
    it('should capture the capacity provider strategy for Spot Guard', () => {
        const resource: Resource = {
            resourceType: 'ecs_services', resourceId: 'arn:svc-spot', region: 'ap-south-1', service: 'ecs', tags: {},
            rawData: {
                serviceArn: 'arn:aws:ecs:ap-south-1:111111111111:service/cluster-a/api',
                // Real ECS casing.
                clusterArn: 'arn:aws:ecs:ap-south-1:111111111111:cluster/cluster-a',
                status: 'ACTIVE',
                desiredCount: 3,
                platformVersion: '1.4.0',
                capacityProviderStrategy: [
                    { capacityProvider: 'FARGATE', weight: 0, base: 0 },
                    { capacityProvider: 'FARGATE_SPOT', weight: 100, base: 1 },
                ],
                loadBalancers: [{ targetGroupArn: 'arn:tg/a', containerPort: 8080 }],
            },
        };
        const metadata = extractMetadata(resource);

        // Without this the Spot Guard eligible-services list cannot exist: there would be
        // no way to know which discovered services are already Spot-capable.
        expect(metadata.capacityProviderStrategy).toEqual([
            { capacityProvider: 'FARGATE', weight: 0, base: 0 },
            { capacityProvider: 'FARGATE_SPOT', weight: 100, base: 1 },
        ]);
        expect(metadata.serviceArn).toBe('arn:aws:ecs:ap-south-1:111111111111:service/cluster-a/api');
        expect(metadata.serviceStatus).toBe('ACTIVE');
        expect(metadata.platformVersion).toBe('1.4.0');
        expect(metadata.loadBalancerCount).toBe(1);
    });

    it('captures the cluster ARN under a correctly-cased key on real AWS data', () => {
        const resource: Resource = {
            resourceType: 'ecs_services', resourceId: 'arn:svc-2', region: 'ap-south-1', service: 'ecs', tags: {},
            rawData: { clusterArn: 'arn:aws:ecs:ap-south-1:111111111111:cluster/cluster-a' },
        };
        const metadata = extractMetadata(resource);

        expect(metadata.ecsClusterArn).toBe('arn:aws:ecs:ap-south-1:111111111111:cluster/cluster-a');
        // Documents the pre-existing bug: with the REAL lower-case field, the old
        // capital-C mapping produces nothing. Asserting it keeps the workaround honest —
        // if someone fixes the old mapping, this test tells them a behaviour change happened.
        expect(metadata.clusterArn).toBeUndefined();
    });

    it('omits loadBalancerCount for a service with no load balancer', () => {
        const metadata = extractMetadata({
            resourceType: 'ecs_services', resourceId: 'arn:svc-3', region: 'ap-south-1', service: 'ecs', tags: {},
            rawData: { desiredCount: 1 },
        });
        // pick() skips undefined mappings, so no spurious key appears.
        expect(metadata.loadBalancerCount).toBeUndefined();
    });

    it('captures cluster capacity providers so the UI can explain ineligibility', () => {
        const metadata = extractMetadata({
            resourceType: 'ecs_clusters', resourceId: 'arn:cluster-a', region: 'ap-south-1', service: 'ecs', tags: {},
            rawData: {
                status: 'ACTIVE',
                capacityProviders: ['FARGATE', 'FARGATE_SPOT'],
                defaultCapacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
            },
        });
        expect(metadata.capacityProviders).toEqual(['FARGATE', 'FARGATE_SPOT']);
        expect(metadata.defaultCapacityProviderStrategy).toEqual([{ capacityProvider: 'FARGATE', weight: 1 }]);
        // Existing keys untouched.
        expect(metadata.status).toBe('ACTIVE');
    });

    it('should extract S3 bucket metadata', () => {
      const resource: Resource = {
        resourceType: 's3_buckets', resourceId: 'my-bucket', region: 'us-east-1', service: 's3', tags: {},
        rawData: { CreationDate: '2024-01-01T00:00:00Z', LocationConstraint: 'us-east-1' },
      };
      const metadata = extractMetadata(resource);
      expect(metadata.creationDate).toBe('2024-01-01T00:00:00Z');
      expect(metadata.locationConstraint).toBe('us-east-1');
    });

    it('should extract ELBv2 load balancer metadata', () => {
      const resource: Resource = {
        resourceType: 'elbv2_load_balancers', resourceId: 'arn:lb1', region: 'us-east-1', service: 'elbv2', tags: {},
        rawData: { Type: 'application', Scheme: 'internet-facing', DNSName: 'my-lb-123.us-east-1.elb.amazonaws.com', VpcId: 'vpc-123', State: { Code: 'active' } },
      };
      const metadata = extractMetadata(resource);
      expect(metadata.type).toBe('application');
      expect(metadata.scheme).toBe('internet-facing');
      expect(metadata.dnsName).toBe('my-lb-123.us-east-1.elb.amazonaws.com');
      expect(metadata.vpcId).toBe('vpc-123');
    });

    it('should return empty object for unknown resource types', () => {
      const resource: Resource = {
        resourceType: 'unknown_service', resourceId: 'id-1', region: 'us-east-1', service: 'unknown', tags: {}, rawData: { foo: 'bar' },
      };
      const metadata = extractMetadata(resource);
      expect(metadata).toEqual({});
    });
  });
});
