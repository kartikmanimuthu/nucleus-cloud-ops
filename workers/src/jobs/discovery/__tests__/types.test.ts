import { describe, it, expect } from 'vitest';
import type {
  DiscoveryFanOutJob,
  DiscoveryScanJob,
  DiscoveryJob,
  Account,
  Resource,
  ScanConfig,
  EnrichmentStep,
  ScanResult,
  SyncStatus,
  AssumedCredentials,
} from '../types.js';

describe('discovery types', () => {
  it('should create a valid DiscoveryFanOutJob', () => {
    const job: DiscoveryFanOutJob = { type: 'fan-out' };
    expect(job.type).toBe('fan-out');
  });

  it('should create a valid DiscoveryScanJob with minimal fields', () => {
    const job: DiscoveryScanJob = {
      type: 'scan',
      tenantId: 'tenant-123',
      triggeredBy: 'cron',
    };
    expect(job.type).toBe('scan');
    expect(job.tenantId).toBe('tenant-123');
    expect(job.triggeredBy).toBe('cron');
  });

  it('should create a valid DiscoveryScanJob with all fields', () => {
    const job: DiscoveryScanJob = {
      type: 'scan',
      tenantId: 'tenant-123',
      accountId: '123456789012',
      triggeredBy: 'web-ui',
      userEmail: 'user@example.com',
      correlationId: 'corr-abc',
    };
    expect(job.accountId).toBe('123456789012');
    expect(job.userEmail).toBe('user@example.com');
  });

  it('should discriminate DiscoveryJob union by type field', () => {
    const fanOut: DiscoveryJob = { type: 'fan-out' };
    const scan: DiscoveryJob = { type: 'scan', tenantId: 't1', triggeredBy: 'cron' };

    if (fanOut.type === 'fan-out') {
      expect(fanOut.type).toBe('fan-out');
    }
    if (scan.type === 'scan') {
      expect(scan.tenantId).toBe('t1');
    }
  });

  it('should create a valid Account', () => {
    const account: Account = {
      id: 'cuid-123',
      tenantId: 'tenant-123',
      accountId: '123456789012',
      name: 'Production',
      roleArn: 'arn:aws:iam::123456789012:role/NucleusAccess',
      regions: ['us-east-1', 'ap-south-1'],
      active: true,
    };
    expect(account.accountId).toBe('123456789012');
    expect(account.regions).toHaveLength(2);
  });

  it('should create a valid Resource', () => {
    const resource: Resource = {
      resourceType: 'ec2_instances',
      resourceId: 'i-0abc123def456',
      region: 'us-east-1',
      service: 'ec2',
      name: 'my-instance',
      state: 'running',
      resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456',
      tags: { Name: 'my-instance', Environment: 'prod' },
      rawData: {},
    };
    expect(resource.resourceType).toBe('ec2_instances');
  });

  it('should create a valid ScanConfig with enrichments', () => {
    const config: ScanConfig = {
      service: 'rds',
      function: 'describe_db_instances',
      result_key: 'DBInstances',
      enrichments: [
        { type: 'tags', method: 'list_tags_for_resource', arnKey: 'DBInstanceArn' },
      ],
    };
    expect(config.enrichments).toHaveLength(1);
    expect(config.enrichments![0].type).toBe('tags');
  });

  it('should create a valid ScanConfig with constraints', () => {
    const config: ScanConfig = {
      service: 'cloudfront',
      function: 'list_distributions',
      result_key: 'DistributionList',
      constraints: { regionOverride: 'us-east-1' },
    };
    expect(config.constraints?.regionOverride).toBe('us-east-1');
  });

  it('should create a valid ScanResult', () => {
    const result: ScanResult = {
      resources: [],
      regionsScanned: 3,
      servicesScanned: 40,
      elapsedMs: 12345,
    };
    expect(result.regionsScanned).toBe(3);
  });

  it('should create a valid SyncStatus', () => {
    const status: SyncStatus = {
      scanId: 'scan-123',
      tenantId: 'tenant-123',
      totalResources: 500,
      accountsSynced: 3,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    expect(status.status).toBe('completed');
  });
});
