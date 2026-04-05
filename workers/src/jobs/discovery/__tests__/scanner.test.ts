import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll build this test file incrementally across Tasks 6-9.
// Task 6 covers: toCommandName, SERVICE_REGISTRY, invokeService

describe('scanner — toCommandName', () => {
  let toCommandName: (fn: string) => string;

  beforeEach(async () => {
    const mod = await import('../services/scanner.js');
    toCommandName = mod.toCommandName;
  });

  it('should convert describe_instances to DescribeInstancesCommand', () => {
    expect(toCommandName('describe_instances')).toBe('DescribeInstancesCommand');
  });

  it('should convert list_buckets to ListBucketsCommand', () => {
    expect(toCommandName('list_buckets')).toBe('ListBucketsCommand');
  });

  it('should convert get_rest_apis to GetRestApisCommand', () => {
    expect(toCommandName('get_rest_apis')).toBe('GetRestApisCommand');
  });

  it('should convert describe_auto_scaling_groups to DescribeAutoScalingGroupsCommand', () => {
    expect(toCommandName('describe_auto_scaling_groups')).toBe('DescribeAutoScalingGroupsCommand');
  });

  it('should convert list_tags_for_resource to ListTagsForResourceCommand', () => {
    expect(toCommandName('list_tags_for_resource')).toBe('ListTagsForResourceCommand');
  });
});

describe('scanner — invokeService', () => {
  let invokeService: typeof import('../services/scanner.js').invokeService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/scanner.js');
    invokeService = mod.invokeService;
  });

  it('should call client.send with the correct command and extract result_key', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValueOnce({
        Vpcs: [{ VpcId: 'vpc-123' }, { VpcId: 'vpc-456' }],
        ResponseMetadata: {},
      }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'ec2',
      function: 'describe_vpcs',
      result_key: 'Vpcs',
    });

    expect(result).toHaveLength(2);
    expect(result[0].VpcId).toBe('vpc-123');
    expect(mockClient.send).toHaveBeenCalled();
  });

  it('should return empty array when result_key is missing from response', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValueOnce({ ResponseMetadata: {} }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'ec2',
      function: 'describe_vpcs',
      result_key: 'Vpcs',
    });

    expect(result).toEqual([]);
  });

  it('should retry on ThrottlingException with exponential backoff', async () => {
    const throttleError = new Error('Rate exceeded');
    (throttleError as any).name = 'ThrottlingException';

    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(throttleError)
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-123' }],
        }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'ec2',
      function: 'describe_vpcs',
      result_key: 'Vpcs',
    });

    expect(result).toHaveLength(1);
    expect(mockClient.send).toHaveBeenCalledTimes(2);
  });

  it('should retry on RequestLimitExceeded', async () => {
    const limitError = new Error('Request limit exceeded');
    (limitError as any).name = 'RequestLimitExceeded';

    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(limitError)
        .mockResolvedValueOnce({
          Functions: [{ FunctionName: 'my-func' }],
        }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'lambda',
      function: 'list_functions',
      result_key: 'Functions',
    });

    expect(result).toHaveLength(1);
    expect(mockClient.send).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries exhausted', async () => {
    vi.useFakeTimers();
    const throttleError = new Error('Rate exceeded');
    (throttleError as any).name = 'ThrottlingException';

    const mockClient = {
      send: vi.fn().mockRejectedValue(throttleError),
    };

    const promise = invokeService(mockClient as any, 'us-east-1', {
      service: 'ec2',
      function: 'describe_vpcs',
      result_key: 'Vpcs',
    });

    // Advance timers past all retry delays (2s + 4s + 8s)
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow('Rate exceeded');

    // 1 initial + 3 retries = 4 total calls
    expect(mockClient.send).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('should throw immediately on non-retryable errors', async () => {
    const authError = new Error('UnauthorizedAccess');
    (authError as any).name = 'UnauthorizedAccess';

    const mockClient = {
      send: vi.fn().mockRejectedValueOnce(authError),
    };

    await expect(
      invokeService(mockClient as any, 'us-east-1', {
        service: 'ec2',
        function: 'describe_vpcs',
        result_key: 'Vpcs',
      }),
    ).rejects.toThrow('UnauthorizedAccess');

    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });
});

import type { EnrichmentStep } from '../types.js';

describe('scanner — applyEnrichments', () => {
  let applyEnrichments: typeof import('../services/scanner.js').applyEnrichments;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/scanner.js');
    applyEnrichments = mod.applyEnrichments;
  });

  it('should apply tag enrichment per resource using arnKey', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        TagList: [{ Key: 'Environment', Value: 'prod' }],
      }),
    };

    const resources = [
      { DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:mydb', DBInstanceIdentifier: 'mydb' },
    ];

    const enrichments: EnrichmentStep[] = [
      { type: 'tags', method: 'list_tags_for_resource', arnKey: 'DBInstanceArn' },
    ];

    const enriched = await applyEnrichments(mockClient as any, 'rds', resources, enrichments);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    expect(enriched[0].Tags).toBeDefined();
  });

  it('should apply tag enrichment in batches using batchSize', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        TagDescriptions: [
          { ResourceArn: 'arn:lb1', Tags: [{ Key: 'Name', Value: 'lb1' }] },
          { ResourceArn: 'arn:lb2', Tags: [{ Key: 'Name', Value: 'lb2' }] },
        ],
      }),
    };

    const resources = [
      { LoadBalancerArn: 'arn:lb1' },
      { LoadBalancerArn: 'arn:lb2' },
    ];

    const enrichments: EnrichmentStep[] = [
      { type: 'tags', method: 'describe_tags', arnKey: 'LoadBalancerArn', inputKey: 'ResourceArns', batchSize: 20 },
    ];

    const enriched = await applyEnrichments(mockClient as any, 'elbv2', resources, enrichments);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    expect(enriched).toHaveLength(2);
  });

  it('should apply describe enrichment and replace items', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        clusters: [
          { clusterArn: 'arn:cluster1', clusterName: 'cluster1', status: 'ACTIVE' },
        ],
      }),
    };

    const resources = ['arn:cluster1'];

    const enrichments: EnrichmentStep[] = [
      { type: 'describe', method: 'describe_clusters', inputKey: 'clusters', resultKey: 'clusters', batchSize: 100 },
    ];

    const enriched = await applyEnrichments(mockClient as any, 'ecs', resources, enrichments);

    expect(enriched[0]).toHaveProperty('clusterName', 'cluster1');
  });

  it('should apply detail enrichment per resource', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        LocationConstraint: 'us-west-2',
      }),
    };

    const resources = [{ Name: 'my-bucket' }];

    const enrichments: EnrichmentStep[] = [
      { type: 'detail', method: 'get_bucket_location', nameKey: 'Name', inputKey: 'Bucket' },
    ];

    const enriched = await applyEnrichments(mockClient as any, 's3', resources, enrichments);

    expect(enriched[0]).toHaveProperty('LocationConstraint', 'us-west-2');
  });

  it('should continue on enrichment error for individual resources', async () => {
    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('NoSuchTagSet'))
        .mockResolvedValueOnce({
          TagSet: [{ Key: 'Name', Value: 'bucket2' }],
        }),
    };

    const resources = [{ Name: 'bucket1' }, { Name: 'bucket2' }];

    const enrichments: EnrichmentStep[] = [
      { type: 'tags', method: 'get_bucket_tagging', nameKey: 'Name', inputKey: 'Bucket' },
    ];

    const enriched = await applyEnrichments(mockClient as any, 's3', resources, enrichments);

    expect(enriched).toHaveLength(2);
    expect(enriched[0].Name).toBe('bucket1');
  });
});

describe('scanner — extractResourceIdentifiers', () => {
  let extractResourceIdentifiers: typeof import('../services/scanner.js').extractResourceIdentifiers;

  beforeEach(async () => {
    const mod = await import('../services/scanner.js');
    extractResourceIdentifiers = mod.extractResourceIdentifiers;
  });

  it('should extract EC2 instance identifiers', () => {
    const resource = {
      InstanceId: 'i-0abc123def456',
      State: { Name: 'running' },
      Tags: [{ Key: 'Name', Value: 'my-instance' }],
    };
    const ids = extractResourceIdentifiers(resource, 'ec2');
    expect(ids.resourceId).toBe('i-0abc123def456');
    expect(ids.state).toBe('running');
    expect(ids.name).toBe('my-instance');
    expect(ids.tags).toEqual({ Name: 'my-instance' });
  });

  it('should extract RDS instance identifiers', () => {
    const resource = {
      DBInstanceIdentifier: 'mydb',
      DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:mydb',
      DBInstanceStatus: 'available',
      TagList: [{ Key: 'Environment', Value: 'prod' }],
    };
    const ids = extractResourceIdentifiers(resource, 'rds');
    expect(ids.resourceId).toBe('mydb');
    expect(ids.resourceArn).toBe('arn:aws:rds:us-east-1:123:db:mydb');
    expect(ids.state).toBe('available');
    expect(ids.name).toBe('mydb');
    expect(ids.tags).toEqual({ Environment: 'prod' });
  });

  it('should extract Lambda function identifiers', () => {
    const resource = {
      FunctionName: 'my-func',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-func',
      Tags: [{ Key: 'Team', Value: 'platform' }],
    };
    const ids = extractResourceIdentifiers(resource, 'lambda');
    expect(ids.resourceId).toBe('my-func');
    expect(ids.resourceArn).toBe('arn:aws:lambda:us-east-1:123:function:my-func');
    expect(ids.name).toBe('my-func');
  });

  it('should extract ECS cluster identifiers (camelCase)', () => {
    const resource = {
      clusterArn: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
      clusterName: 'my-cluster',
      status: 'ACTIVE',
    };
    const ids = extractResourceIdentifiers(resource, 'ecs');
    expect(ids.resourceId).toBe('arn:aws:ecs:us-east-1:123:cluster/my-cluster');
    expect(ids.resourceArn).toBe('arn:aws:ecs:us-east-1:123:cluster/my-cluster');
    expect(ids.name).toBe('my-cluster');
    expect(ids.state).toBe('ACTIVE');
  });

  it('should extract S3 bucket identifiers', () => {
    const resource = { Name: 'my-bucket', CreationDate: '2024-01-01T00:00:00Z' };
    const ids = extractResourceIdentifiers(resource, 's3');
    expect(ids.resourceId).toBe('my-bucket');
    expect(ids.name).toBe('my-bucket');
  });

  it('should extract VPC identifiers', () => {
    const resource = {
      VpcId: 'vpc-123abc',
      State: 'available',
      Tags: [{ Key: 'Name', Value: 'main-vpc' }],
    };
    const ids = extractResourceIdentifiers(resource, 'ec2');
    expect(ids.resourceId).toBe('vpc-123abc');
    expect(ids.state).toBe('available');
    expect(ids.name).toBe('main-vpc');
  });

  it('should extract CloudFront distribution identifiers', () => {
    const resource = { Id: 'E1234567890', DomainName: 'd111111abcdef8.cloudfront.net', Status: 'Deployed' };
    const ids = extractResourceIdentifiers(resource, 'cloudfront');
    expect(ids.resourceId).toBe('E1234567890');
    expect(ids.name).toBe('d111111abcdef8.cloudfront.net');
    expect(ids.state).toBe('Deployed');
  });

  it('should extract ECR repository identifiers', () => {
    const resource = {
      repositoryName: 'my-repo',
      repositoryArn: 'arn:aws:ecr:us-east-1:123:repository/my-repo',
    };
    const ids = extractResourceIdentifiers(resource, 'ecr');
    expect(ids.resourceId).toBe('my-repo');
    expect(ids.resourceArn).toBe('arn:aws:ecr:us-east-1:123:repository/my-repo');
    expect(ids.name).toBe('my-repo');
  });

  it('should extract IAM role identifiers', () => {
    const resource = {
      RoleName: 'AdminRole',
      RoleId: 'AROA1234567890',
      Arn: 'arn:aws:iam::123:role/AdminRole',
    };
    const ids = extractResourceIdentifiers(resource, 'iam');
    expect(ids.resourceId).toBe('AdminRole');
    expect(ids.resourceArn).toBe('arn:aws:iam::123:role/AdminRole');
    expect(ids.name).toBe('AdminRole');
  });

  it('should extract ACM certificate identifiers', () => {
    const resource = {
      CertificateArn: 'arn:aws:acm:us-east-1:123:certificate/abc-123',
      DomainName: 'example.com',
      CertificateId: 'abc-123',
    };
    const ids = extractResourceIdentifiers(resource, 'acm');
    expect(ids.resourceId).toBe('abc-123');
    expect(ids.resourceArn).toBe('arn:aws:acm:us-east-1:123:certificate/abc-123');
    expect(ids.name).toBe('example.com');
  });

  it('should handle dict-style tags', () => {
    const resource = { FunctionName: 'my-func', tags: { Team: 'platform', Env: 'prod' } };
    const ids = extractResourceIdentifiers(resource, 'lambda');
    expect(ids.tags).toEqual({ Team: 'platform', Env: 'prod' });
  });

  it('should default name to resourceId when no name key found', () => {
    const resource = { KeyId: 'key-abc-123', KeyArn: 'arn:aws:kms:us-east-1:123:key/key-abc-123' };
    const ids = extractResourceIdentifiers(resource, 'kms');
    expect(ids.resourceId).toBe('key-abc-123');
    expect(ids.name).toBe('key-abc-123');
  });

  it('should handle State as dict with Name key', () => {
    const resource = { InstanceId: 'i-123', State: { Name: 'stopped', Code: 80 } };
    const ids = extractResourceIdentifiers(resource, 'ec2');
    expect(ids.state).toBe('stopped');
  });
});

describe('scanner — normalizeResources', () => {
  let normalizeResources: typeof import('../services/scanner.js').normalizeResources;

  beforeEach(async () => {
    const mod = await import('../services/scanner.js');
    normalizeResources = mod.normalizeResources;
  });

  it('should normalize object items into Resource[]', () => {
    const rawItems = [
      { InstanceId: 'i-123', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'web' }] },
    ];
    const resources = normalizeResources(rawItems, 'ec2', 'describe_instances', 'us-east-1');
    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('ec2_instances');
    expect(resources[0].resourceId).toBe('i-123');
    expect(resources[0].region).toBe('us-east-1');
    expect(resources[0].service).toBe('ec2');
    expect(resources[0].state).toBe('running');
    expect(resources[0].name).toBe('web');
  });

  it('should normalize string items (ARNs)', () => {
    const rawItems = ['arn:aws:ecs:us-east-1:123:cluster/my-cluster'];
    const resources = normalizeResources(rawItems, 'ecs', 'list_clusters', 'us-east-1');
    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('ecs_clusters');
    expect(resources[0].resourceId).toBe('my-cluster');
    expect(resources[0].resourceArn).toBe('arn:aws:ecs:us-east-1:123:cluster/my-cluster');
  });

  it('should normalize string items (names/URLs)', () => {
    const rawItems = ['https://sqs.us-east-1.amazonaws.com/123/my-queue'];
    const resources = normalizeResources(rawItems, 'sqs', 'list_queues', 'us-east-1');
    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('sqs_queues');
    expect(resources[0].resourceId).toBe('my-queue');
  });

  it('should strip describe_/list_/get_ prefix from resourceType', () => {
    expect(
      normalizeResources([{ VpcId: 'vpc-1' }], 'ec2', 'describe_vpcs', 'us-east-1')[0].resourceType,
    ).toBe('ec2_vpcs');
    expect(
      normalizeResources(['fn1'], 'lambda', 'list_functions', 'us-east-1')[0].resourceType,
    ).toBe('lambda_functions');
    expect(
      normalizeResources([{ id: 'api1' }], 'apigateway', 'get_rest_apis', 'us-east-1')[0].resourceType,
    ).toBe('apigateway_rest_apis');
  });

  it('should return empty array for null/undefined input', () => {
    expect(normalizeResources(null as any, 'ec2', 'describe_vpcs', 'us-east-1')).toEqual([]);
    expect(normalizeResources(undefined as any, 'ec2', 'describe_vpcs', 'us-east-1')).toEqual([]);
    expect(normalizeResources([], 'ec2', 'describe_vpcs', 'us-east-1')).toEqual([]);
  });
});
