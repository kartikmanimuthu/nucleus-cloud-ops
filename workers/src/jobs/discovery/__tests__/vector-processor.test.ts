import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Resource } from '../types.js';

// ---------------------------------------------------------------------------
// Hoisted mock variables
// ---------------------------------------------------------------------------
const { mockInvokeModel, mockQuery, mockRelease, mockConnect } =
  vi.hoisted(() => ({
    mockInvokeModel: vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ embedding: Array(1024).fill(0.1) })),
    }),
    mockQuery: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    mockRelease: vi.fn(),
    mockConnect: vi.fn(),
  }));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockInvokeModel })),
  InvokeModelCommand: vi.fn().mockImplementation((input) => input),
}));

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
  })),
}));

import {
  createResourceText,
  computeContentHash,
  processAccountVectors,
} from '../services/vector-processor.js';

// ---------------------------------------------------------------------------
// createResourceText
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

// ---------------------------------------------------------------------------
// computeContentHash
// ---------------------------------------------------------------------------

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
// processAccountVectors
// ---------------------------------------------------------------------------

describe('processAccountVectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    // pool.query is used directly (not via connect) for UPDATE
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('returns 0 for empty resources array', async () => {
    const count = await processAccountVectors([], 'acc-123', 'tenant-1');
    expect(count).toBe(0);
    expect(mockInvokeModel).not.toHaveBeenCalled();
  });

  it('embeds resources and updates inventory_resources', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-001', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      { resourceType: 'ec2_instances', resourceId: 'i-002', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    const count = await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(count).toBe(2);
    expect(mockInvokeModel).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE inventory_resources'),
      expect.any(Array),
    );
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

  it('passes tenantId, accountId, resourceType, resourceId to UPDATE', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_vpcs', resourceId: 'vpc-abc', region: 'ap-south-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE inventory_resources'),
      expect.arrayContaining(['tenant-1', 'acc-123', 'ec2_vpcs', 'vpc-abc']),
    );
  });

  it('returns 0 when no rows are updated (resource not yet in DB)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-missing', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    const count = await processAccountVectors(resources, 'acc-123', 'tenant-1');
    expect(count).toBe(0);
  });
});
