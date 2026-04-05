import { describe, it, expect } from 'vitest';

// Integration test: verifies the full normalization + metadata extraction pipeline
// without requiring real AWS calls or complex mock setup.

describe('Discovery integration — normalization pipeline', () => {
  it('normalizes EC2 VPC raw data to Resource and extracts metadata', async () => {
    const { normalizeResources } = await import('../services/scanner.js');
    const { extractMetadata } = await import('../services/pg-writer.js');

    const rawItems = [
      { VpcId: 'vpc-123', State: 'available', CidrBlock: '10.0.0.0/16', IsDefault: false, Tags: [{ Key: 'Name', Value: 'main-vpc' }] },
    ];

    const resources = normalizeResources(rawItems, 'ec2', 'describe_vpcs', 'us-east-1');

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      service: 'ec2',
      resourceType: 'ec2_vpcs',
      resourceId: 'vpc-123',
      region: 'us-east-1',
      state: 'available',
      name: 'main-vpc',
    });

    const metadata = extractMetadata(resources[0]);
    expect(metadata.cidrBlock).toBe('10.0.0.0/16');
    expect(metadata.isDefault).toBe(false);
  });

  it('normalizes RDS instance raw data to Resource and extracts metadata', async () => {
    const { normalizeResources } = await import('../services/scanner.js');
    const { extractMetadata } = await import('../services/pg-writer.js');

    const rawItems = [
      {
        DBInstanceIdentifier: 'db-1',
        DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:db-1',
        DBInstanceStatus: 'available',
        DBInstanceClass: 'db.t3.micro',
        Engine: 'postgres',
        EngineVersion: '15.4',
        AllocatedStorage: 20,
        MultiAZ: false,
        Endpoint: { Address: 'db-1.abc.us-east-1.rds.amazonaws.com', Port: 5432 },
        TagList: [{ Key: 'Environment', Value: 'prod' }],
      },
    ];

    const resources = normalizeResources(rawItems, 'rds', 'describe_db_instances', 'us-east-1');

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      service: 'rds',
      resourceType: 'rds_db_instances',
      resourceId: 'db-1',
      resourceArn: 'arn:aws:rds:us-east-1:123:db:db-1',
      state: 'available',
    });
    expect(resources[0].tags).toEqual({ Environment: 'prod' });

    const metadata = extractMetadata(resources[0]);
    expect(metadata.engine).toBe('postgres');
    expect(metadata.engineVersion).toBe('15.4');
    expect(metadata.dbInstanceClass).toBe('db.t3.micro');
    expect(metadata.allocatedStorage).toBe(20);
    expect(metadata.endpoint).toBe('db-1.abc.us-east-1.rds.amazonaws.com');
  });

  it('normalizes Lambda function raw data to Resource and extracts metadata', async () => {
    const { normalizeResources } = await import('../services/scanner.js');
    const { extractMetadata } = await import('../services/pg-writer.js');

    const rawItems = [
      {
        FunctionName: 'my-func',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-func',
        Runtime: 'nodejs20.x',
        MemorySize: 256,
        Timeout: 30,
        Handler: 'index.handler',
        CodeSize: 1024000,
        Tags: [{ Key: 'Team', Value: 'platform' }],
      },
    ];

    const resources = normalizeResources(rawItems, 'lambda', 'list_functions', 'us-east-1');

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('lambda_functions');
    expect(resources[0].resourceId).toBe('my-func');
    expect(resources[0].tags).toEqual({ Team: 'platform' });

    const metadata = extractMetadata(resources[0]);
    expect(metadata.runtime).toBe('nodejs20.x');
    expect(metadata.memorySize).toBe(256);
    expect(metadata.timeout).toBe(30);
  });

  it('normalizes ECS cluster ARN strings to Resource[]', async () => {
    const { normalizeResources } = await import('../services/scanner.js');

    const rawItems = ['arn:aws:ecs:us-east-1:123:cluster/my-cluster'];

    const resources = normalizeResources(rawItems, 'ecs', 'list_clusters', 'us-east-1');

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('ecs_clusters');
    expect(resources[0].resourceId).toBe('my-cluster');
    expect(resources[0].resourceArn).toBe('arn:aws:ecs:us-east-1:123:cluster/my-cluster');
  });
});
