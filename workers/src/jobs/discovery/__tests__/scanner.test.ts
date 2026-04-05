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
