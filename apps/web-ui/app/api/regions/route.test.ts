import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: vi.fn().mockImplementation(function (this: unknown) {
        return { send: mockSend };
    }),
    DescribeRegionsCommand: vi.fn().mockImplementation(function (this: any, input: unknown) {
        this.input = input;
        this._type = 'DescribeRegions';
    }),
}));

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
}));

import { getSessionTenantId } from '@/lib/auth-session';
import { GET } from './route';

const makeRequest = () => ({ url: 'http://localhost/api/regions' }) as any;

describe('GET /api/regions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 200 with regions sorted by label', async () => {
        mockSend.mockResolvedValue({
            Regions: [
                { RegionName: 'us-west-2', Endpoint: 'ec2.us-west-2.amazonaws.com' },
                { RegionName: 'ap-south-1', Endpoint: 'ec2.ap-south-1.amazonaws.com' },
            ],
        });

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data).toEqual([
            { value: 'ap-south-1', label: 'ap-south-1', endpoint: 'ec2.ap-south-1.amazonaws.com' },
            { value: 'us-west-2', label: 'us-west-2', endpoint: 'ec2.us-west-2.amazonaws.com' },
        ]);
    });

    it('filters out regions with no RegionName', async () => {
        mockSend.mockResolvedValue({
            Regions: [{ RegionName: undefined }, { RegionName: 'us-east-1' }],
        });

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(body.data).toHaveLength(1);
        expect(body.data[0].value).toBe('us-east-1');
    });

    it('returns 200 with an empty array when no regions are returned', async () => {
        mockSend.mockResolvedValue({});

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([]);
    });

    it('returns 500 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated: no valid session'));

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.success).toBe(false);
        expect(body.error).toBe('Unauthenticated: no valid session');
    });

    it('returns 500 when the EC2 call throws', async () => {
        mockSend.mockRejectedValue(new Error('AWS throttled'));

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.success).toBe(false);
        expect(body.error).toBe('AWS throttled');
    });
});
