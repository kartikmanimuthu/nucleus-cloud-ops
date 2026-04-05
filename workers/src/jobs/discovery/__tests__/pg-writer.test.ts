import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Resource } from '../types.js';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import { writeResourcesToPg, saveSyncStatus, extractMetadata } from '../services/pg-writer.js';

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
  });

  describe('saveSyncStatus', () => {
    it('should upsert sync status row', async () => {
      await saveSyncStatus('scan-123', 'tenant-1', 500, 3);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('inventory_sync_status'),
        expect.arrayContaining(['scan-123', 'tenant-1', 500, 3]),
      );
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
