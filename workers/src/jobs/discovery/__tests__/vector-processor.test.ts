import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Resource } from '../types.js';

// ---------------------------------------------------------------------------
// Hoisted mock variables — must use vi.hoisted() so they are available when
// vi.mock() factory functions run (vi.mock is hoisted above all imports).
// ---------------------------------------------------------------------------
const { mockInvokeModel, mockPutVectors, mockDeleteVectors, mockFindUnique, mockUpsert } =
  vi.hoisted(() => ({
    mockInvokeModel: vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ embedding: Array(1024).fill(0.1) })),
    }),
    mockPutVectors: vi.fn().mockResolvedValue({}),
    mockDeleteVectors: vi.fn().mockResolvedValue({}),
    mockFindUnique: vi.fn().mockResolvedValue(null),
    mockUpsert: vi.fn().mockResolvedValue({}),
  }));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockInvokeModel })),
  InvokeModelCommand: vi.fn().mockImplementation((input) => input),
}));

vi.mock('@aws-sdk/client-s3vectors', () => ({
  S3VectorsClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((cmd) => {
      if (cmd.__type === 'put') return mockPutVectors(cmd);
      return mockDeleteVectors(cmd);
    }),
  })),
  PutVectorsCommand: vi.fn().mockImplementation((input) => ({ ...input, __type: 'put' })),
  DeleteVectorsCommand: vi.fn().mockImplementation((input) => ({ ...input, __type: 'delete' })),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    inventoryVectorKey: { findUnique: mockFindUnique, upsert: mockUpsert },
  })),
}));

import {
  createResourceText,
  computeContentHash,
  processAccountVectors,
} from '../services/vector-processor.js';

// ---------------------------------------------------------------------------
// Existing tests
// ---------------------------------------------------------------------------

describe('createResourceText', () => {
  it('produces pipe-delimited text with core fields', () => {
    const resource: Resource = {
      resourceType: 'ec2_instances',
      resourceId: 'i-abc123',
      region: 'us-east-1',
      service: 'ec2',
      name: 'my-instance',
      state: 'running',
      resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
      tags: { Environment: 'prod', Team: 'platform' },
      rawData: {},
    };

    const text = createResourceText(resource);

    expect(text).toContain('Name: my-instance');
    expect(text).toContain('Type: ec2_instances');
    expect(text).toContain('Service: ec2');
    expect(text).toContain('Region: us-east-1');
    expect(text).toContain('State: running');
    expect(text).toContain('ARN: arn:aws:ec2:us-east-1:123456789012:instance/i-abc123');
    expect(text).toContain('Tags: Environment=prod, Team=platform');
    expect(text.split(' | ').length).toBeGreaterThanOrEqual(6);
  });

  it('falls back to resourceId when name is absent', () => {
    const resource: Resource = {
      resourceType: 'ec2_vpcs',
      resourceId: 'vpc-xyz',
      region: 'ap-south-1',
      service: 'ec2',
      tags: {},
      rawData: {},
    };
    expect(createResourceText(resource)).toContain('Name: vpc-xyz');
  });

  it('omits State field when state is absent', () => {
    const resource: Resource = {
      resourceType: 'ec2_vpcs',
      resourceId: 'vpc-xyz',
      region: 'ap-south-1',
      service: 'ec2',
      tags: {},
      rawData: {},
    };
    expect(createResourceText(resource)).not.toContain('State:');
  });

  it('includes CIDR block for ec2_vpcs', () => {
    const resource: Resource = {
      resourceType: 'ec2_vpcs',
      resourceId: 'vpc-xyz',
      region: 'ap-south-1',
      service: 'ec2',
      tags: {},
      rawData: { CidrBlock: '10.0.0.0/16' },
    };
    const text = createResourceText(resource);
    expect(text).toContain('CIDR: 10.0.0.0/16');
  });
});

describe('computeContentHash', () => {
  it('returns a 16-char hex string', () => {
    const hash = computeContentHash('some text');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(computeContentHash('hello')).toBe(computeContentHash('hello'));
  });

  it('differs for different inputs', () => {
    expect(computeContentHash('hello')).not.toBe(computeContentHash('world'));
  });
});

// ---------------------------------------------------------------------------
// New tests — processAccountVectors
// ---------------------------------------------------------------------------

describe('processAccountVectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    process.env.VECTOR_BUCKET_NAME = 'test-bucket';
    process.env.VECTOR_INDEX_NAME = 'test-index';
    process.env.USE_PG_INVENTORY = 'true';
  });

  it('returns 0 for empty resources array', async () => {
    const count = await processAccountVectors([], 'acc-123', 'tenant-1');
    expect(count).toBe(0);
    expect(mockInvokeModel).not.toHaveBeenCalled();
  });

  it('embeds resources and calls PutVectors', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-001', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      { resourceType: 'ec2_instances', resourceId: 'i-002', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    const count = await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(count).toBe(2);
    expect(mockInvokeModel).toHaveBeenCalledTimes(2);
    expect(mockPutVectors).toHaveBeenCalled();
  });

  it('deduplicates resources with the same resourceId', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-dup', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      { resourceType: 'ec2_instances', resourceId: 'i-dup', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    const count = await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(count).toBe(1);
    expect(mockInvokeModel).toHaveBeenCalledTimes(1);
  });

  it('deletes stale keys when previous keys exist', async () => {
    mockFindUnique.mockResolvedValueOnce({ vectorKeys: ['stale-key-1', 'stale-key-2'] });

    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-new', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(mockDeleteVectors).toHaveBeenCalledWith(
      expect.objectContaining({ keys: expect.arrayContaining(['stale-key-1', 'stale-key-2']) }),
    );
  });

  it('saves new vector keys to PostgreSQL when USE_PG_INVENTORY=true', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-001', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'acc-123' },
        update: expect.objectContaining({ vectorKeys: expect.any(Array) }),
        create: expect.objectContaining({ accountId: 'acc-123' }),
      }),
    );
  });

  it('skips key tracking when USE_PG_INVENTORY=false', async () => {
    process.env.USE_PG_INVENTORY = 'false';

    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-001', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
