import { describe, it, expect } from 'vitest';
import { createResourceText, computeContentHash } from '../services/vector-processor.js';
import type { Resource } from '../types.js';

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
