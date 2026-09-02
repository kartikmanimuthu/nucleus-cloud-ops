import type { Resource, ResourceEdge } from '../types.js';

// Edges that cannot come from a single describe response, because the fact lives in the
// relationship between two resources rather than inside either one. EDGE_SPECS and
// CUSTOM_DERIVERS both see one resource at a time, so anything requiring a lookup across
// the scan result set belongs here.

type Raw = Record<string, any>;

const rawOf = (r: Resource): Raw => (r.rawData && typeof r.rawData === 'object' ? (r.rawData as Raw) : {});

function ipToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        out = out * 256 + n;
    }
    return out;
}

// True when `inner` is fully contained in `outer`. IPv4 only — an IPv6 rule simply yields no
// edge rather than a wrong one.
function cidrContains(outer: string, inner: string): boolean {
    const [outerIp, outerBitsRaw] = outer.split('/');
    const [innerIp, innerBitsRaw] = inner.split('/');
    const outerBits = Number(outerBitsRaw);
    const innerBits = Number(innerBitsRaw);
    if (!Number.isInteger(outerBits) || !Number.isInteger(innerBits)) return false;
    if (innerBits < outerBits) return false;

    const a = ipToInt(outerIp);
    const b = ipToInt(innerIp);
    if (a === null || b === null) return false;

    if (outerBits === 0) return true;
    const mask = (0xffffffff << (32 - outerBits)) >>> 0;
    return (a & mask) >>> 0 === (b & mask) >>> 0;
}

export function deriveCrossResourceEdges(resources: Resource[]): ResourceEdge[] {
    const edges: ResourceEdge[] = [];
    const byType = new Map<string, Resource[]>();
    for (const r of resources) {
        if (!r.resourceId) continue;
        const bucket = byType.get(r.resourceType);
        if (bucket) bucket.push(r);
        else byType.set(r.resourceType, [r]);
    }
    const of = (t: string) => byType.get(t) ?? [];

    // subnet -> vpc, used to give subnet-placed resources a VPC they never state themselves.
    const vpcBySubnet = new Map<string, string>();
    for (const subnet of of('ec2_subnets')) {
        const vpcId = rawOf(subnet).VpcId;
        if (typeof vpcId === 'string' && vpcId) vpcBySubnet.set(subnet.resourceId, vpcId);
    }

    // 1. ecs_services -> in_vpc.
    // An ECS service names its subnets but never its VPC, so "what is in this VPC" used to omit
    // every service actually running there.
    for (const svc of of('ecs_services')) {
        const subnets: unknown = rawOf(svc).networkConfiguration?.awsvpcConfiguration?.subnets;
        if (!Array.isArray(subnets)) continue;
        const vpcIds = new Set<string>();
        for (const subnetId of subnets) {
            const vpcId = typeof subnetId === 'string' ? vpcBySubnet.get(subnetId) : undefined;
            if (vpcId) vpcIds.add(vpcId);
        }
        for (const vpcId of vpcIds) {
            edges.push({
                fromType: 'ecs_services',
                fromId: svc.resourceId,
                relation: 'in_vpc',
                toType: 'ec2_vpcs',
                toId: vpcId,
                region: svc.region,
            });
        }
    }

    // 2. Security group ingress expressed as a CIDR.
    // EDGE_SPECS only reads UserIdGroupPairs, so a rule written as a CIDR — the common form for
    // "anything in this VPC may reach the database" — produced no edge at all, and blast radius
    // reported such a database as having zero dependents.
    const vpcTargets: Array<{ cidr: string; id: string }> = [];
    for (const vpc of of('ec2_vpcs')) {
        const cidr = rawOf(vpc).CidrBlock;
        if (typeof cidr === 'string' && cidr) vpcTargets.push({ cidr, id: vpc.resourceId });
    }
    const subnetTargets: Array<{ cidr: string; id: string; vpcId?: string }> = [];
    for (const subnet of of('ec2_subnets')) {
        const raw = rawOf(subnet);
        if (typeof raw.CidrBlock === 'string' && raw.CidrBlock) {
            subnetTargets.push({ cidr: raw.CidrBlock, id: subnet.resourceId, vpcId: raw.VpcId });
        }
    }

    for (const sg of of('ec2_security_groups')) {
        for (const permission of rawOf(sg).IpPermissions || []) {
            for (const range of permission?.IpRanges || []) {
                const cidr = range?.CidrIp;
                if (typeof cidr !== 'string' || !cidr) continue;
                // 0.0.0.0/0 means "the internet", not a relationship to every resource we know
                // about. Emitting it would link every network to every other one.
                if (cidr === '0.0.0.0/0') continue;

                // A rule that covers a whole VPC is one fact, not one fact per subnet in it.
                // Emitting both would multiply a single "anything in this VPC may connect" rule
                // into a dozen edges saying the same thing.
                const matchedVpcs = vpcTargets.filter((v) => cidrContains(cidr, v.cidr));
                const covered = new Set(matchedVpcs.map((v) => v.id));

                for (const vpc of matchedVpcs) {
                    edges.push({
                        fromType: 'ec2_security_groups',
                        fromId: sg.resourceId,
                        relation: 'allows_ingress_from',
                        toType: 'ec2_vpcs',
                        toId: vpc.id,
                        region: sg.region,
                    });
                }

                for (const subnet of subnetTargets) {
                    if (subnet.vpcId && covered.has(subnet.vpcId)) continue;
                    if (!cidrContains(cidr, subnet.cidr)) continue;
                    edges.push({
                        fromType: 'ec2_security_groups',
                        fromId: sg.resourceId,
                        relation: 'allows_ingress_from',
                        toType: 'ec2_subnets',
                        toId: subnet.id,
                        region: sg.region,
                    });
                }
            }
        }
    }

    // 3. ECS service -> the resources its task definition is configured to reach.
    // This is the only signal for an application-level dependency: the connection is a hostname
    // in an environment variable, which appears in no describe response for either end.
    const rdsByHost = new Map<string, string>();
    for (const db of of('rds_db_instances')) {
        const address = rawOf(db).Endpoint?.Address;
        if (typeof address === 'string' && address) rdsByHost.set(address.toLowerCase(), db.resourceId);
    }
    const secretByArn = new Map<string, string>();
    for (const secret of of('secretsmanager_secrets')) {
        const arn = rawOf(secret).ARN;
        if (typeof arn === 'string' && arn) secretByArn.set(arn, secret.resourceId);
    }
    const queueByUrl = new Map<string, string>();
    for (const queue of of('sqs_queues')) {
        const url = rawOf(queue).QueueUrl;
        if (typeof url === 'string' && url) queueByUrl.set(url, queue.resourceId);
    }

    for (const svc of of('ecs_services')) {
        const refs: unknown = rawOf(svc)._endpointRefs;
        if (!Array.isArray(refs)) continue;

        for (const ref of refs) {
            if (typeof ref !== 'string' || !ref) continue;

            const dbId = rdsByHost.get(ref.toLowerCase());
            if (dbId) {
                edges.push({
                    fromType: 'ecs_services',
                    fromId: svc.resourceId,
                    relation: 'connects_to',
                    toType: 'rds_db_instances',
                    toId: dbId,
                    region: svc.region,
                });
                continue;
            }

            const queueId = queueByUrl.get(ref);
            if (queueId) {
                edges.push({
                    fromType: 'ecs_services',
                    fromId: svc.resourceId,
                    relation: 'connects_to',
                    toType: 'sqs_queues',
                    toId: queueId,
                    region: svc.region,
                });
                continue;
            }

            // Secret ARNs in a task definition may carry a `:key::` suffix naming one JSON field.
            const secretId = secretByArn.get(ref) ?? secretByArn.get(ref.split(/:(?=[^:]*::?$)/)[0]);
            if (secretId) {
                edges.push({
                    fromType: 'ecs_services',
                    fromId: svc.resourceId,
                    relation: 'reads_secret',
                    toType: 'secretsmanager_secrets',
                    toId: secretId,
                    region: svc.region,
                });
            }
        }
    }

    return edges;
}
