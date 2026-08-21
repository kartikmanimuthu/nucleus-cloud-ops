import { describe, it, expect, vi, beforeEach } from 'vitest';

const dxSend = vi.fn();
const ec2Send = vi.fn();
vi.mock('@aws-sdk/client-direct-connect', () => ({
    DirectConnectClient: vi.fn().mockImplementation(() => ({ send: dxSend })),
    DescribeConnectionsCommand: vi.fn().mockImplementation((input: unknown) => ({ input, __cmd: 'connections' })),
    DescribeVirtualInterfacesCommand: vi.fn().mockImplementation((input: unknown) => ({ input, __cmd: 'vifs' })),
}));
vi.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: vi.fn().mockImplementation(() => ({ send: ec2Send })),
    DescribeVpnConnectionsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { parseDxBandwidth, fetchDirectConnectConnections, fetchVpnTunnels, AWS_VPN_TUNNEL_CEILING_MBPS } from './network-client.js';

const ASSUMED = { credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }, region: 'ap-south-1' };

describe('parseDxBandwidth', () => {
    it('parses Gbps into Mbps', () => {
        expect(parseDxBandwidth('1Gbps')).toBe(1000);
        expect(parseDxBandwidth('10Gbps')).toBe(10000);
    });

    it('parses Mbps as-is', () => {
        expect(parseDxBandwidth('400Mbps')).toBe(400);
    });

    it('is case-insensitive on the unit', () => {
        expect(parseDxBandwidth('1gbps')).toBe(1000);
    });

    it('returns undefined for missing or unrecognized formats — never guesses a denominator', () => {
        expect(parseDxBandwidth(undefined)).toBeUndefined();
        expect(parseDxBandwidth('fast')).toBeUndefined();
        expect(parseDxBandwidth('1 Gbit')).toBeUndefined();
    });
});

/** dxSend serves both DescribeConnectionsCommand and DescribeVirtualInterfacesCommand
 *  (same client, same `send`) — route each by the marker the mocked command
 *  constructors attach, so a test only needs to specify what it cares about. */
function mockDx(connections: unknown[], virtualInterfaces: unknown[] = []) {
    dxSend.mockImplementation(async (cmd: { __cmd: string }) =>
        cmd.__cmd === 'connections' ? { connections } : { virtualInterfaces }
    );
}

describe('fetchDirectConnectConnections', () => {
    beforeEach(() => vi.clearAllMocks());

    it('maps connections and drops one with no connectionId', async () => {
        mockDx([
            { connectionId: 'dxcon-1', connectionName: 'Primary', bandwidth: '1Gbps' },
            { connectionName: 'no id' },
        ]);
        const result = await fetchDirectConnectConnections(ASSUMED, 'ap-south-1');
        expect(result).toEqual([
            { resourceId: 'dxcon-1', name: 'Primary', installedBandwidthMbps: 1000, displayName: undefined, virtualInterfaceIds: [] },
        ]);
    });

    // ── displayName: sourced from the AWS Name TAG, distinct from connectionName ──
    it('captures the Name tag as displayName when present', async () => {
        mockDx([
            {
                connectionId: 'dxcon-1',
                connectionName: 'Primary',
                bandwidth: '1Gbps',
                tags: [{ key: 'Environment', value: 'prod' }, { key: 'Name', value: 'HQ Uplink' }],
            },
        ]);
        const result = await fetchDirectConnectConnections(ASSUMED, 'ap-south-1');
        expect(result[0].displayName).toBe('HQ Uplink');
    });

    it('leaves displayName undefined when no Name tag is present', async () => {
        mockDx([{ connectionId: 'dxcon-1', tags: [{ key: 'Environment', value: 'prod' }] }]);
        const result = await fetchDirectConnectConnections(ASSUMED, 'ap-south-1');
        expect(result[0].displayName).toBeUndefined();
    });

    it('leaves displayName undefined when the connection carries no tags at all', async () => {
        mockDx([{ connectionId: 'dxcon-1' }]);
        const result = await fetchDirectConnectConnections(ASSUMED, 'ap-south-1');
        expect(result[0].displayName).toBeUndefined();
    });

    // ── virtualInterfaceIds: see network-cloudwatch-client.ts for why the poll
    // needs these — Connection*-level CloudWatch metrics read as a plausible
    // zero for a connection whose real traffic rides a VIF. ──
    it('groups virtual interfaces onto their connection by connectionId', async () => {
        mockDx(
            [{ connectionId: 'dxcon-1' }, { connectionId: 'dxcon-2' }],
            [
                { connectionId: 'dxcon-1', virtualInterfaceId: 'dxvif-a' },
                { connectionId: 'dxcon-1', virtualInterfaceId: 'dxvif-b' },
                { connectionId: 'dxcon-2', virtualInterfaceId: 'dxvif-c' },
            ]
        );
        const result = await fetchDirectConnectConnections(ASSUMED, 'ap-south-1');
        expect(result.find((c) => c.resourceId === 'dxcon-1')!.virtualInterfaceIds).toEqual(['dxvif-a', 'dxvif-b']);
        expect(result.find((c) => c.resourceId === 'dxcon-2')!.virtualInterfaceIds).toEqual(['dxvif-c']);
    });

    it('leaves virtualInterfaceIds empty for a connection with no VIF discovered', async () => {
        mockDx([{ connectionId: 'dxcon-1' }], [{ connectionId: 'dxcon-2', virtualInterfaceId: 'dxvif-c' }]);
        const result = await fetchDirectConnectConnections(ASSUMED, 'ap-south-1');
        expect(result[0].virtualInterfaceIds).toEqual([]);
    });
});

describe('fetchVpnTunnels', () => {
    beforeEach(() => vi.clearAllMocks());

    it('emits one resource per tunnel, keyed by vpnConnectionId:outsideIp, at the fixed AWS ceiling', async () => {
        ec2Send.mockResolvedValue({
            VpnConnections: [
                {
                    VpnConnectionId: 'vpn-1',
                    VgwTelemetry: [{ OutsideIpAddress: '1.2.3.4' }, { OutsideIpAddress: '5.6.7.8' }],
                },
            ],
        });
        const result = await fetchVpnTunnels(ASSUMED, 'ap-south-1');
        expect(result).toEqual([
            { resourceId: 'vpn-1:1.2.3.4', vpnConnectionId: 'vpn-1', outsideIpAddress: '1.2.3.4', installedBandwidthMbps: AWS_VPN_TUNNEL_CEILING_MBPS, displayName: undefined },
            { resourceId: 'vpn-1:5.6.7.8', vpnConnectionId: 'vpn-1', outsideIpAddress: '5.6.7.8', installedBandwidthMbps: AWS_VPN_TUNNEL_CEILING_MBPS, displayName: undefined },
        ]);
    });

    it('skips a telemetry entry with no outside IP', async () => {
        ec2Send.mockResolvedValue({ VpnConnections: [{ VpnConnectionId: 'vpn-1', VgwTelemetry: [{}] }] });
        expect(await fetchVpnTunnels(ASSUMED, 'ap-south-1')).toEqual([]);
    });

    // ── displayName: sourced from the AWS Name TAG on the VPN connection, shared
    // by every tunnel under it (EC2 tags the connection, not the tunnel). ──
    it('captures the Name tag as displayName on every tunnel under that connection', async () => {
        ec2Send.mockResolvedValue({
            VpnConnections: [
                {
                    VpnConnectionId: 'vpn-1',
                    Tags: [{ Key: 'Name', Value: 'DR Link' }],
                    VgwTelemetry: [{ OutsideIpAddress: '1.2.3.4' }, { OutsideIpAddress: '5.6.7.8' }],
                },
            ],
        });
        const result = await fetchVpnTunnels(ASSUMED, 'ap-south-1');
        expect(result.every((t) => t.displayName === 'DR Link')).toBe(true);
    });

    it('leaves displayName undefined when no Name tag is present', async () => {
        ec2Send.mockResolvedValue({
            VpnConnections: [{ VpnConnectionId: 'vpn-1', Tags: [{ Key: 'Team', Value: 'net' }], VgwTelemetry: [{ OutsideIpAddress: '1.2.3.4' }] }],
        });
        const result = await fetchVpnTunnels(ASSUMED, 'ap-south-1');
        expect(result[0].displayName).toBeUndefined();
    });
});
