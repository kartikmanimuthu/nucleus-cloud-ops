// workers/src/jobs/scaling-audit/services/network-client.ts
//
// Resource discovery for Scale Sentinel's Network Pulse capability — Direct
// Connect connections and VPN tunnels. This only enumerates WHAT exists;
// hourly utilization comes from CloudWatch via network-cloudwatch-client.ts's
// fetchNetworkUtilization(), same split as the compute scopes (installed
// capacity here vs. the CloudWatch fetch for usage).
import { DirectConnectClient, DescribeConnectionsCommand, DescribeVirtualInterfacesCommand } from '@aws-sdk/client-direct-connect';
import { EC2Client, DescribeVpnConnectionsCommand } from '@aws-sdk/client-ec2';
import { createLogger } from '../../../lib/logger.js';
import type { AssumedCredentials } from '../../discovery/types.js';

const log = createLogger('scaling-audit-network-client');

// AWS's documented, fixed per-tunnel throughput ceiling — not reported by any
// API, because it's the same for every VPN tunnel on every account.
export const AWS_VPN_TUNNEL_CEILING_MBPS = 1250;

export interface DxConnectionResource {
    resourceId: string; // Direct Connect connectionId
    name?: string;
    /** AWS Name tag, if present — distinct from `name` (the connectionName
     *  attribute above), which is a separate, non-tag field. Undefined when
     *  no Name tag is set. */
    displayName?: string;
    installedBandwidthMbps?: number;
    /**
     * Virtual interfaces riding this connection. AWS/DX only publishes
     * Connection*-level metrics for traffic that isn't routed through a
     * virtual interface — a connection carrying a transit/private/public VIF
     * (the common case, and the only way to reach a Direct Connect Gateway)
     * reports real traffic under VirtualInterface*-level metrics instead, and
     * ConnectionBpsIngress/Egress for that same connection reads a
     * misleadingly-real-looking but wrong zero. Empty when the connection has
     * no VIF attached yet.
     */
    virtualInterfaceIds: string[];
}

export interface VpnTunnelResource {
    resourceId: string; // `${vpnConnectionId}:${outsideIpAddress}` — CloudWatch's own tunnel dimension pair
    vpnConnectionId: string;
    outsideIpAddress: string;
    /** AWS Name tag on the parent VPN connection — EC2 tags the connection,
     *  not the individual tunnel, so every tunnel under one connection shares
     *  the same displayName. Undefined when no Name tag is set. */
    displayName?: string;
    installedBandwidthMbps: number;
}

function buildCredentials(assumed: AssumedCredentials) {
    return assumed.credentials?.accessKeyId
        ? {
              accessKeyId: assumed.credentials.accessKeyId,
              secretAccessKey: assumed.credentials.secretAccessKey,
              sessionToken: assumed.credentials.sessionToken,
          }
        : undefined;
}

/** Direct Connect's Tag shape is lower-camelCase ({ key, value }) — matches
 *  connectionId/connectionName's own casing convention for this API. */
function dxNameTag(tags: Array<{ key?: string; value?: string }> | undefined): string | undefined {
    return tags?.find((t) => t.key === 'Name')?.value;
}

/** EC2's Tag shape is PascalCase ({ Key, Value }) — matches VpnConnectionId/
 *  VgwTelemetry's own casing convention for this API. */
function ec2NameTag(tags: Array<{ Key?: string; Value?: string }> | undefined): string | undefined {
    return tags?.find((t) => t.Key === 'Name')?.Value;
}

/** DX reports bandwidth as a string like "1Gbps"/"10Gbps"/"400Mbps" — there is
 *  no numeric field. Unparseable/unexpected formats leave it unset rather than
 *  guessing, since a wrong denominator would silently corrupt every
 *  throughput-percent reading for that connection. */
export function parseDxBandwidth(bandwidth?: string): number | undefined {
    if (!bandwidth) return undefined;
    const m = bandwidth.match(/^(\d+(?:\.\d+)?)\s*(Gbps|Mbps)$/i);
    if (!m) {
        log.warn('Unparseable Direct Connect bandwidth string — installed capacity left unset', { bandwidth });
        return undefined;
    }
    const value = Number(m[1]);
    return m[2].toLowerCase() === 'gbps' ? value * 1000 : value;
}

export async function fetchDirectConnectConnections(assumed: AssumedCredentials, region: string): Promise<DxConnectionResource[]> {
    const client = new DirectConnectClient({ region, credentials: buildCredentials(assumed) });
    const [connRes, vifRes] = await Promise.all([
        client.send(new DescribeConnectionsCommand({})),
        client.send(new DescribeVirtualInterfacesCommand({})),
    ]);

    const vifsByConnectionId = new Map<string, string[]>();
    for (const vif of vifRes.virtualInterfaces ?? []) {
        if (!vif.connectionId || !vif.virtualInterfaceId) continue;
        const bucket = vifsByConnectionId.get(vif.connectionId);
        if (bucket) bucket.push(vif.virtualInterfaceId);
        else vifsByConnectionId.set(vif.connectionId, [vif.virtualInterfaceId]);
    }

    return (connRes.connections ?? [])
        .filter((c): c is typeof c & { connectionId: string } => !!c.connectionId)
        .map((c) => ({
            resourceId: c.connectionId,
            name: c.connectionName,
            displayName: dxNameTag(c.tags),
            installedBandwidthMbps: parseDxBandwidth(c.bandwidth),
            virtualInterfaceIds: vifsByConnectionId.get(c.connectionId) ?? [],
        }));
}

/** One row per tunnel, not per VPN connection — CloudWatch's AWS/VPN metrics
 *  are dimensioned by (VpnId, TunnelIpAddress), and a connection normally has
 *  two tunnels (primary/backup) with independent availability. */
export async function fetchVpnTunnels(assumed: AssumedCredentials, region: string): Promise<VpnTunnelResource[]> {
    const client = new EC2Client({ region, credentials: buildCredentials(assumed) });
    const res = await client.send(new DescribeVpnConnectionsCommand({}));
    const tunnels: VpnTunnelResource[] = [];
    for (const vpn of res.VpnConnections ?? []) {
        if (!vpn.VpnConnectionId) continue;
        const displayName = ec2NameTag(vpn.Tags);
        for (const t of vpn.VgwTelemetry ?? []) {
            if (!t.OutsideIpAddress) continue;
            tunnels.push({
                resourceId: `${vpn.VpnConnectionId}:${t.OutsideIpAddress}`,
                vpnConnectionId: vpn.VpnConnectionId,
                outsideIpAddress: t.OutsideIpAddress,
                displayName,
                installedBandwidthMbps: AWS_VPN_TUNNEL_CEILING_MBPS,
            });
        }
    }
    return tunnels;
}
