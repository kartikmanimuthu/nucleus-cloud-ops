import { describe, it, expectTypeOf } from 'vitest';
import type {
  DiscoveryFanOutJob,
  DiscoveryScanJob,
  Account,
  AssumedCredentials,
  EnrichmentStep,
  ScanConfig,
  Resource,
  ScanResult,
  SyncStatus,
} from '../types.js';

describe('Discovery types', () => {
  it('DiscoveryScanJob has required tenantId', () => {
    const job: DiscoveryScanJob = {
      tenantId: 'tenant-1',
      triggeredBy: 'cron',
    };
    expectTypeOf(job.tenantId).toBeString();
    expectTypeOf(job.accountId).toEqualTypeOf<string | undefined>();
  });

  it('Resource has all required fields', () => {
    const resource: Resource = {
      resourceType: 'ec2_instances',
      resourceId: 'i-123',
      resourceArn: 'arn:aws:ec2:us-east-1:123:instance/i-123',
      name: 'my-instance',
      region: 'us-east-1',
      service: 'ec2',
      state: 'running',
      tags: { Environment: 'prod' },
    };
    expectTypeOf(resource.tags).toEqualTypeOf<Record<string, string>>();
  });

  it('ScanConfig supports enrichments', () => {
    const config: ScanConfig = {
      service: 'rds',
      function: 'describe_db_instances',
      result_key: 'DBInstances',
      enrichments: [
        { type: 'tags', method: 'list_tags_for_resource', arnKey: 'DBInstanceArn' },
      ],
    };
    expectTypeOf(config.enrichments).toEqualTypeOf<EnrichmentStep[] | undefined>();
  });

  it('ScanResult has errors array', () => {
    const result: ScanResult = {
      resources: [],
      regionsScanned: 1,
      servicesScanned: 5,
      elapsedMs: 1200,
      errors: [],
    };
    expectTypeOf(result.errors).toEqualTypeOf<string[]>();
  });
});
