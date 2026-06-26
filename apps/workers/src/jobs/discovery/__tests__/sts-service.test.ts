import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  AssumeRoleCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

import { assumeRole } from '../services/sts-service.js';

describe('sts-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should assume role and return credentials', async () => {
    mockSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'AKID',
        SecretAccessKey: 'SECRET',
        SessionToken: 'TOKEN',
      },
    });

    const result = await assumeRole(
      'arn:aws:iam::123456789012:role/NucleusAccess',
      '123456789012',
      'us-east-1',
    );

    expect(result.credentials.accessKeyId).toBe('AKID');
    expect(result.credentials.secretAccessKey).toBe('SECRET');
    expect(result.credentials.sessionToken).toBe('TOKEN');
    expect(result.region).toBe('us-east-1');
  });

  it('should pass ExternalId when provided', async () => {
    mockSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'AKID',
        SecretAccessKey: 'SECRET',
        SessionToken: 'TOKEN',
      },
    });

    const { AssumeRoleCommand } = await import('@aws-sdk/client-sts');

    await assumeRole(
      'arn:aws:iam::123456789012:role/NucleusAccess',
      '123456789012',
      'us-east-1',
      'ext-id-123',
    );

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ExternalId: 'ext-id-123',
        RoleSessionName: expect.stringContaining('NucleusDiscovery'),
      }),
    );
  });

  it('should use NucleusDiscovery session name', async () => {
    mockSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'AKID',
        SecretAccessKey: 'SECRET',
        SessionToken: 'TOKEN',
      },
    });

    const { AssumeRoleCommand } = await import('@aws-sdk/client-sts');

    await assumeRole(
      'arn:aws:iam::123456789012:role/NucleusAccess',
      '123456789012',
      'ap-south-1',
    );

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleSessionName: expect.stringMatching(/^NucleusDiscovery-123456789012-ap-south-1$/),
        DurationSeconds: 3600,
      }),
    );
  });

  it('should throw when no credentials returned', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(
      assumeRole('arn:aws:iam::123456789012:role/NucleusAccess', '123456789012', 'us-east-1'),
    ).rejects.toThrow('No credentials returned from AssumeRole');
  });

  it('should propagate STS errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('Access denied'));

    await expect(
      assumeRole('arn:aws:iam::123456789012:role/NucleusAccess', '123456789012', 'us-east-1'),
    ).rejects.toThrow('Access denied');
  });
});
