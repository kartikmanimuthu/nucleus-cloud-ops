import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScanConfig } from '../types.js';

describe('custom-scanners', () => {
  let CUSTOM_SCANNERS: typeof import('../services/custom-scanners.js').CUSTOM_SCANNERS;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/custom-scanners.js');
    CUSTOM_SCANNERS = mod.CUSTOM_SCANNERS;
  });

  it('should export dispatch map with 4 custom handlers', () => {
    expect(CUSTOM_SCANNERS).toBeDefined();
    expect(Object.keys(CUSTOM_SCANNERS)).toHaveLength(4);
    expect(CUSTOM_SCANNERS['ec2:describe_instances']).toBeTypeOf('function');
    expect(CUSTOM_SCANNERS['ecs:list_services']).toBeTypeOf('function');
    expect(CUSTOM_SCANNERS['wafv2:list_web_acls']).toBeTypeOf('function');
    expect(CUSTOM_SCANNERS['cloudfront:list_distributions']).toBeTypeOf('function');
  });

  describe('ec2:describe_instances — flattenEC2Reservations', () => {
    it('should flatten Reservations[].Instances[] into flat instance list', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          Reservations: [
            { Instances: [{ InstanceId: 'i-111', State: { Name: 'running' } }, { InstanceId: 'i-222', State: { Name: 'stopped' } }] },
            { Instances: [{ InstanceId: 'i-333', State: { Name: 'running' } }] },
          ],
        }),
      };
      const config: ScanConfig = { service: 'ec2', function: 'describe_instances', result_key: 'Reservations' };
      const result = await CUSTOM_SCANNERS['ec2:describe_instances'](mockClient as any, 'us-east-1', config);
      expect(result).toHaveLength(3);
      expect(result[0].InstanceId).toBe('i-111');
      expect(result[1].InstanceId).toBe('i-222');
      expect(result[2].InstanceId).toBe('i-333');
    });

    it('should handle paginated responses', async () => {
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-111' }] }], NextToken: 'token1' })
          .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-222' }] }] }),
      };
      const config: ScanConfig = { service: 'ec2', function: 'describe_instances', result_key: 'Reservations' };
      const result = await CUSTOM_SCANNERS['ec2:describe_instances'](mockClient as any, 'us-east-1', config);
      expect(result).toHaveLength(2);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no reservations', async () => {
      const mockClient = { send: vi.fn().mockResolvedValueOnce({ Reservations: [] }) };
      const config: ScanConfig = { service: 'ec2', function: 'describe_instances', result_key: 'Reservations' };
      const result = await CUSTOM_SCANNERS['ec2:describe_instances'](mockClient as any, 'us-east-1', config);
      expect(result).toEqual([]);
    });
  });

  describe('ecs:list_services — ecsServicesDeep', () => {
    it('should list clusters → list services per cluster → describe services', async () => {
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ clusterArns: ['arn:cluster1'] })
          .mockResolvedValueOnce({ serviceArns: ['arn:svc1', 'arn:svc2'] })
          .mockResolvedValueOnce({
            services: [
              { serviceArn: 'arn:svc1', serviceName: 'svc1', status: 'ACTIVE' },
              { serviceArn: 'arn:svc2', serviceName: 'svc2', status: 'ACTIVE' },
            ],
          }),
      };
      const config: ScanConfig = { service: 'ecs', function: 'list_services', result_key: 'serviceArns' };
      const result = await CUSTOM_SCANNERS['ecs:list_services'](mockClient as any, 'us-east-1', config);
      expect(result).toHaveLength(2);
      expect(result[0].serviceName).toBe('svc1');
      expect(result[0].ClusterArn).toBe('arn:cluster1');
    });

    it('should batch describe_services in groups of 10', async () => {
      const serviceArns = Array.from({ length: 15 }, (_, i) => `arn:svc${i}`);
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ clusterArns: ['arn:cluster1'] })
          .mockResolvedValueOnce({ serviceArns })
          .mockResolvedValueOnce({ services: serviceArns.slice(0, 10).map((arn) => ({ serviceArn: arn, serviceName: arn.split(':').pop() })) })
          .mockResolvedValueOnce({ services: serviceArns.slice(10).map((arn) => ({ serviceArn: arn, serviceName: arn.split(':').pop() })) }),
      };
      const config: ScanConfig = { service: 'ecs', function: 'list_services', result_key: 'serviceArns' };
      const result = await CUSTOM_SCANNERS['ecs:list_services'](mockClient as any, 'us-east-1', config);
      expect(result).toHaveLength(15);
      expect(mockClient.send).toHaveBeenCalledTimes(4);
    });
  });

  describe('wafv2:list_web_acls — wafv2Deep', () => {
    it('should scan REGIONAL scope in non-us-east-1 regions', async () => {
      const mockClient = { send: vi.fn().mockResolvedValueOnce({ WebACLs: [{ Name: 'regional-acl', Id: 'acl-1' }] }) };
      const config: ScanConfig = { service: 'wafv2', function: 'list_web_acls', result_key: 'WebACLs', constraints: { scopes: ['REGIONAL', 'CLOUDFRONT'] } };
      const result = await CUSTOM_SCANNERS['wafv2:list_web_acls'](mockClient as any, 'ap-south-1', config);
      expect(result).toHaveLength(1);
      expect(result[0]._scope).toBe('REGIONAL');
      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it('should scan both REGIONAL and CLOUDFRONT scopes in us-east-1', async () => {
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ WebACLs: [{ Name: 'regional-acl', Id: 'acl-1' }] })
          .mockResolvedValueOnce({ WebACLs: [{ Name: 'cf-acl', Id: 'acl-2' }] }),
      };
      const config: ScanConfig = { service: 'wafv2', function: 'list_web_acls', result_key: 'WebACLs', constraints: { scopes: ['REGIONAL', 'CLOUDFRONT'] } };
      const result = await CUSTOM_SCANNERS['wafv2:list_web_acls'](mockClient as any, 'us-east-1', config);
      expect(result).toHaveLength(2);
      expect(result[0]._scope).toBe('REGIONAL');
      expect(result[1]._scope).toBe('CLOUDFRONT');
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('cloudfront:list_distributions — cloudfrontDeep', () => {
    it('should unwrap DistributionList.Items in us-east-1', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          DistributionList: {
            Items: [{ Id: 'E123', DomainName: 'd123.cloudfront.net', Status: 'Deployed' }, { Id: 'E456', DomainName: 'd456.cloudfront.net', Status: 'Deployed' }],
            Quantity: 2,
          },
        }),
      };
      const config: ScanConfig = { service: 'cloudfront', function: 'list_distributions', result_key: 'DistributionList', constraints: { regionOverride: 'us-east-1' } };
      const result = await CUSTOM_SCANNERS['cloudfront:list_distributions'](mockClient as any, 'us-east-1', config);
      expect(result).toHaveLength(2);
      expect(result[0].Id).toBe('E123');
    });

    it('should return empty array for non-us-east-1 regions', async () => {
      const mockClient = { send: vi.fn() };
      const config: ScanConfig = { service: 'cloudfront', function: 'list_distributions', result_key: 'DistributionList', constraints: { regionOverride: 'us-east-1' } };
      const result = await CUSTOM_SCANNERS['cloudfront:list_distributions'](mockClient as any, 'ap-south-1', config);
      expect(result).toEqual([]);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('should handle paginated distribution lists', async () => {
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ DistributionList: { Items: [{ Id: 'E123' }], NextMarker: 'marker1', IsTruncated: true } })
          .mockResolvedValueOnce({ DistributionList: { Items: [{ Id: 'E456' }], IsTruncated: false } }),
      };
      const config: ScanConfig = { service: 'cloudfront', function: 'list_distributions', result_key: 'DistributionList', constraints: { regionOverride: 'us-east-1' } };
      const result = await CUSTOM_SCANNERS['cloudfront:list_distributions'](mockClient as any, 'us-east-1', config);
      expect(result).toHaveLength(2);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });
  });
});
