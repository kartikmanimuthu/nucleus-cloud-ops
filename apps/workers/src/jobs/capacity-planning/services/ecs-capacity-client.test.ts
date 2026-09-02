import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn().mockImplementation(function (this: any) { this.send = mockSend; }),
    DescribeTaskDefinitionCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));

import { fetchInstalledCapacity } from './ecs-capacity-client.js';
import type { AssumedCredentials } from '../../discovery/types.js';

const credentials: AssumedCredentials = { credentials: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }, region: 'us-east-1' };

beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
});

describe('fetchInstalledCapacity', () => {
    it('returns an empty map without calling AWS for an empty ARN list', async () => {
        const result = await fetchInstalledCapacity([], credentials, 'us-east-1');
        expect(result.size).toBe(0);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('converts CPU units (1024 = 1 vCPU) and MiB memory to vCPU/GiB', async () => {
        mockSend.mockResolvedValueOnce({ taskDefinition: { cpu: '2048', memory: '4096' } });
        const result = await fetchInstalledCapacity(['arn:td:1'], credentials, 'us-east-1');
        expect(result.get('arn:td:1')).toEqual({ vcpu: 2, memGiB: 4 });
    });

    it('dedupes repeated ARNs into a single DescribeTaskDefinition call', async () => {
        mockSend.mockResolvedValue({ taskDefinition: { cpu: '1024', memory: '2048' } });
        await fetchInstalledCapacity(['arn:td:1', 'arn:td:1', 'arn:td:1'], credentials, 'us-east-1');
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('resolves each unique ARN independently and in parallel', async () => {
        mockSend
            .mockResolvedValueOnce({ taskDefinition: { cpu: '1024', memory: '2048' } })
            .mockResolvedValueOnce({ taskDefinition: { cpu: '2048', memory: '4096' } });
        const result = await fetchInstalledCapacity(['arn:td:1', 'arn:td:2'], credentials, 'us-east-1');
        expect(result.get('arn:td:1')).toEqual({ vcpu: 1, memGiB: 2 });
        expect(result.get('arn:td:2')).toEqual({ vcpu: 2, memGiB: 4 });
    });

    it('leaves vcpu/memGiB undefined when cpu/memory are missing or non-numeric', async () => {
        mockSend.mockResolvedValueOnce({ taskDefinition: { cpu: undefined, memory: 'not-a-number' } });
        const result = await fetchInstalledCapacity(['arn:td:1'], credentials, 'us-east-1');
        expect(result.get('arn:td:1')).toEqual({ vcpu: undefined, memGiB: undefined });
    });

    it('leaves the ARN unset (not zeroed) when DescribeTaskDefinition fails, rather than failing the whole batch', async () => {
        mockSend
            .mockRejectedValueOnce(new Error('AccessDenied'))
            .mockResolvedValueOnce({ taskDefinition: { cpu: '1024', memory: '2048' } });
        const result = await fetchInstalledCapacity(['arn:td:bad', 'arn:td:good'], credentials, 'us-east-1');
        expect(result.has('arn:td:bad')).toBe(false);
        expect(result.get('arn:td:good')).toEqual({ vcpu: 1, memGiB: 2 });
    });

    it('constructs the client without static credentials when none are provided', async () => {
        mockSend.mockResolvedValueOnce({ taskDefinition: { cpu: '1024', memory: '2048' } });
        const noCreds: AssumedCredentials = { credentials: { accessKeyId: '', secretAccessKey: '', sessionToken: '' }, region: 'us-east-1' };
        await expect(fetchInstalledCapacity(['arn:td:1'], noCreds, 'us-east-1')).resolves.toBeInstanceOf(Map);
    });
});
