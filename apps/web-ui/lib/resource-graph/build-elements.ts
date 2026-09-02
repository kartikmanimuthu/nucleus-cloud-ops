import type {
    AccountSummary,
    GraphNode,
    DependencyDirection,
    GraphEdgeLite,
} from '@/lib/db/repositories/resource-graph/interface';
import {
    NODE_KIND,
    colorForType,
    iconForType,
    accountIcon,
    hubIcon,
    hubColor,
    spokeColor,
    typeLabel,
} from './graph-theme';

export interface CyElement {
    data: Record<string, unknown>;
    classes?: string;
}

const NODE_SIZE = { hub: 74, resource: 38, accountMin: 26, accountMax: 62 } as const;

// Area, not diameter, scales with the count — doubling the resources should look like twice
// as much, and a radius-linear scale exaggerates the big accounts into blobs.
function accountSize(resourceCount: number, max: number): number {
    if (max <= 0) return NODE_SIZE.accountMin;
    const ratio = Math.sqrt(Math.max(0, resourceCount) / max);
    return NODE_SIZE.accountMin + ratio * (NODE_SIZE.accountMax - NODE_SIZE.accountMin);
}

const RELATION_LABEL: Record<string, string> = {
    in_vpc: 'IN VPC',
    in_subnet: 'IN SUBNET',
    in_cluster: 'IN CLUSTER',
    has_member: 'HAS MEMBER',
    member_of_cluster: 'MEMBER OF',
    attached_to: 'ATTACHED TO',
    attached_to_load_balancer: 'BEHIND LB',
    attached_to_tgw: 'ATTACHED TO',
    attaches_vpc: 'ATTACHES',
    routes_to_instance: 'ROUTES TO',
    registers_with_target_group: 'REGISTERS WITH',
    uses_security_group: 'USES SG',
    uses_instance_profile: 'USES PROFILE',
    uses_iam_role: 'ASSUMES',
    uses_certificate: 'USES CERT',
    encrypted_with: 'ENCRYPTED BY',
    has_volume: 'HAS VOLUME',
    has_network_interface: 'HAS ENI',
    allows_ingress_from: 'ALLOWS FROM',
    allows_egress_to: 'ALLOWS TO',
    peers_vpc: 'PEERS',
    monitors: 'MONITORS',
    notifies: 'NOTIFIES',
    origin_is: 'ORIGIN',
};

export function relationLabel(relation: string): string {
    return RELATION_LABEL[relation] ?? relation.replace(/_/g, ' ').toUpperCase();
}

export const accountNodeId = (accountId: string) => `account:${accountId}`;
export const hubNodeId = (resourceType: string, resourceId: string) => `hub:${resourceType}:${resourceId}`;
export const resourceNodeId = (resourceType: string, resourceId: string) => `res:${resourceType}:${resourceId}`;

export function buildOpeningElements(args: {
    accounts: AccountSummary[];
    transitGateways: GraphNode[];
    /** Account id -> human name. The summary carries only ids, and a field of 99 twelve-digit
     *  numbers is unreadable; falls back to the id where a name is unknown. */
    accountNames?: Map<string, string>;
}): CyElement[] {
    const seenBy = new Map<string, Set<string>>();
    for (const row of args.transitGateways) {
        const key = `${row.resourceType}\t${row.resourceId}`;
        if (!seenBy.has(key)) seenBy.set(key, new Set());
        seenBy.get(key)!.add(row.accountId);
    }

    // A gateway only one account can see connects nothing. Drawing it would add a
    // dead-end node and imply a relationship the data does not contain.
    const shared = [...seenBy.entries()].filter(([, accounts]) => accounts.size > 1);

    // Each hub gets its own hue and lends it to its spokes, so two disjoint networks read as
    // two visually distinct families rather than one undifferentiated mass of dots. An
    // account on no hub stays neutral grey — visibly "not part of either network".
    const groupOfAccount = new Map<string, number>();
    shared.forEach(([, accountIds], group) => {
        for (const accountId of accountIds) {
            if (!groupOfAccount.has(accountId)) groupOfAccount.set(accountId, group);
        }
    });

    const maxResources = args.accounts.reduce((m, a) => Math.max(m, a.resourceCount), 0);

    const elements: CyElement[] = args.accounts.map((account) => {
        const group = groupOfAccount.get(account.accountId) ?? null;
        const color = spokeColor(group);
        return {
            data: {
                id: accountNodeId(account.accountId),
                kind: NODE_KIND.account,
                label: args.accountNames?.get(account.accountId) ?? account.accountId,
                // The count doubles as the affordance: an account node opens into its VPCs on
                // double-click, which nothing else on the canvas signals. Single tap selects
                // and opens the detail panel, so the wording has to distinguish the two.
                sublabel: `${account.resourceCount} resources · double-click to expand`,
                accountId: account.accountId,
                resourceCount: account.resourceCount,
                edgeCount: account.edgeCount,
                hubGroup: group,
                color,
                icon: accountIcon(color),
                size: accountSize(account.resourceCount, maxResources),
            },
            classes: NODE_KIND.account,
        };
    });

    shared.forEach(([key, accountIds], group) => {
        const [resourceType, resourceId] = key.split('\t');
        const color = hubColor(group);
        elements.push({
            data: {
                id: hubNodeId(resourceType, resourceId),
                kind: NODE_KIND.hub,
                label: resourceId,
                sublabel: `${typeLabel(resourceType)} · ${accountIds.size} accounts`,
                resourceType,
                resourceId,
                spokeCount: accountIds.size,
                hubGroup: group,
                color,
                icon: hubIcon(color),
                size: NODE_SIZE.hub,
            },
            classes: NODE_KIND.hub,
        });

        for (const accountId of accountIds) {
            const source = accountNodeId(accountId);
            const target = hubNodeId(resourceType, resourceId);
            elements.push({
                data: {
                    id: `edge:${source}->${target}`,
                    source,
                    target,
                    relation: 'attached_to_tgw',
                    relationLabel: relationLabel('attached_to_tgw'),
                    color,
                },
                classes: 'spoke',
            });
        }
    });

    return elements;
}

const CONTAINMENT_RANK: Record<string, number> = { in_subnet: 0, in_cluster: 1, in_vpc: 2 };

export function parentAssignment(edges: GraphEdgeLite[]): Map<string, string> {
    const best = new Map<string, { rank: number; parent: string }>();

    for (const edge of edges) {
        const rank = CONTAINMENT_RANK[edge.relation];
        if (rank === undefined) continue;

        const child = resourceNodeId(edge.fromType, edge.fromId);
        const parent = resourceNodeId(edge.toType, edge.toId);
        if (child === parent) continue;

        const current = best.get(child);
        if (!current || rank < current.rank) best.set(child, { rank, parent });
    }

    return new Map([...best].map(([child, v]) => [child, v.parent]));
}

interface NodeLike {
    resourceType: string;
    resourceId: string;
    name?: string | null;
    status?: string | null;
    accountId?: string | null;
    region?: string | null;
    external?: boolean;
}

function nodeElement(n: NodeLike, parent?: string): CyElement {
    const color = colorForType(n.resourceType);
    return {
        data: {
            id: resourceNodeId(n.resourceType, n.resourceId),
            kind: NODE_KIND.resource,
            label: n.name ?? n.resourceId,
            sublabel: typeLabel(n.resourceType),
            resourceType: n.resourceType,
            resourceId: n.resourceId,
            status: n.status ?? null,
            accountId: n.accountId ?? null,
            region: n.region ?? null,
            external: n.external ?? false,
            color,
            icon: iconForType(n.resourceType, color),
            size: NODE_SIZE.resource,
            ...(parent ? { parent } : {}),
        },
        classes: n.external ? `${NODE_KIND.resource} external` : NODE_KIND.resource,
    };
}

function edgeElement(source: string, target: string, relation: string): CyElement {
    return {
        data: {
            id: `edge:${source}->${target}:${relation}`,
            source,
            target,
            relation,
            relationLabel: relationLabel(relation),
        },
    };
}

export function buildExpansionElements(args: {
    expanded: { resourceType: string; resourceId: string };
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
    existingIds: Set<string>;
}): { elements: CyElement[]; hiddenTotal: number } {
    const focusId = resourceNodeId(args.expanded.resourceType, args.expanded.resourceId);
    const elements: CyElement[] = [];
    const seen = new Set(args.existingIds);

    const take = (direction: DependencyDirection, inbound: boolean) => {
        for (const edge of direction.edges) {
            const otherId = resourceNodeId(edge.other.resourceType, edge.other.resourceId);
            if (!seen.has(otherId)) {
                seen.add(otherId);
                // region lives on the edge, not on `other`; without this the detail panel
                // shows a blank region for every node that arrived by expansion.
                elements.push(nodeElement({ ...edge.other, region: edge.region }));
            }

            const source = inbound ? otherId : focusId;
            const target = inbound ? focusId : otherId;
            const id = `edge:${source}->${target}:${edge.relation}`;
            if (seen.has(id)) continue;
            seen.add(id);
            elements.push(edgeElement(source, target, edge.relation));
        }
    };

    take(args.dependents, true);
    take(args.dependsOn, false);

    const withheld = (d: DependencyDirection) => Math.max(0, d.total - d.edges.length);
    return { elements, hiddenTotal: withheld(args.dependents) + withheld(args.dependsOn) };
}

export function buildNodeElements(args: {
    nodes: NodeLike[];
    edges: GraphEdgeLite[];
    existingIds: Set<string>;
}): CyElement[] {
    const parents = parentAssignment(args.edges);
    const elements: CyElement[] = [];
    const seen = new Set(args.existingIds);

    for (const node of args.nodes) {
        const id = resourceNodeId(node.resourceType, node.resourceId);
        if (seen.has(id)) continue;
        seen.add(id);
        elements.push(nodeElement(node, parents.get(id)));
    }

    // Containment became parentage above; drawing it again would put a line inside every box.
    for (const edge of args.edges) {
        if (CONTAINMENT_RANK[edge.relation] !== undefined) continue;
        const source = resourceNodeId(edge.fromType, edge.fromId);
        const target = resourceNodeId(edge.toType, edge.toId);
        const id = `edge:${source}->${target}:${edge.relation}`;
        if (seen.has(id)) continue;
        seen.add(id);
        elements.push(edgeElement(source, target, edge.relation));
    }

    return elements;
}
