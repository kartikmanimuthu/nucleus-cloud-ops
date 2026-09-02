import { describe, it, expect } from 'vitest';
import { buildOpeningElements, accountNodeId, hubNodeId } from '../build-elements';
import { NODE_KIND } from '../graph-theme';
import { buildExpansionElements, buildNodeElements, parentAssignment, resourceNodeId } from '../build-elements';

const accounts = [
    { accountId: '111', resourceCount: 400, edgeCount: 300 },
    { accountId: '222', resourceCount: 200, edgeCount: 150 },
    { accountId: '333', resourceCount: 10, edgeCount: 0 },
];

const tgwRow = (resourceId: string, accountId: string) => ({
    resourceType: 'ec2_transit_gateways',
    resourceId,
    name: null,
    status: null,
    accountId,
    region: 'ap-south-1',
});

const shared = [tgwRow('tgw-a', '111'), tgwRow('tgw-a', '222')];

describe('buildOpeningElements', () => {
    it('creates one node per account', () => {
        const els = buildOpeningElements({ accounts, transitGateways: [] });
        const nodes = els.filter((e) => e.data.kind === NODE_KIND.account);
        expect(nodes).toHaveLength(3);
        expect(nodes.map((n) => n.data.id)).toContain(accountNodeId('111'));
    });

    it('collapses a gateway seen by two accounts into ONE hub node', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        const hubs = els.filter((e) => e.data.kind === NODE_KIND.hub);
        expect(hubs).toHaveLength(1);
        expect(hubs[0].data.id).toBe(hubNodeId('ec2_transit_gateways', 'tgw-a'));
    });

    it('links every account that sees the hub to it', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        const edges = els.filter((e) => e.data.source);
        expect(edges).toHaveLength(2);
        expect(edges.map((e) => e.data.source).sort()).toEqual([accountNodeId('111'), accountNodeId('222')].sort());
    });

    it('leaves an account with no shared gateway unconnected rather than inventing a link', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        expect(els.filter((e) => e.data.source === accountNodeId('333'))).toHaveLength(0);
    });

    it('ignores a gateway seen by only one account, since it connects nothing', () => {
        const els = buildOpeningElements({ accounts, transitGateways: [tgwRow('tgw-solo', '333')] });
        expect(els.filter((e) => e.data.kind === NODE_KIND.hub)).toHaveLength(0);
        expect(els.filter((e) => e.data.source)).toHaveLength(0);
    });

    it('keeps the counts an account tile needs', () => {
        const els = buildOpeningElements({ accounts, transitGateways: [] });
        const big = els.find((e) => e.data.id === accountNodeId('111'));
        expect(big?.data.resourceCount).toBe(400);
        expect(big?.data.edgeCount).toBe(300);
    });

    it('produces no duplicate element ids', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        const ids = els.map((e) => e.data.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

const dir = (rows: Array<{ relation: string; type: string; id: string }>, total?: number) => ({
    edges: rows.map((r) => ({
        relation: r.relation,
        region: 'ap-south-1',
        other: { resourceType: r.type, resourceId: r.id, name: null, status: null, accountId: '111', exists: true },
    })),
    total: total ?? rows.length,
    truncated: (total ?? rows.length) > rows.length,
});

describe('buildExpansionElements', () => {
    it('adds a node and an edge per neighbour', () => {
        const { elements } = buildExpansionElements({
            expanded: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            dependents: dir([{ relation: 'attached_to', type: 'ec2_volumes', id: 'vol-1' }]),
            dependsOn: dir([{ relation: 'uses_security_group', type: 'ec2_security_groups', id: 'sg-1' }]),
            existingIds: new Set([resourceNodeId('ec2_instances', 'i-1')]),
        });

        expect(elements.filter((e) => !e.data.source)).toHaveLength(2);
        expect(elements.filter((e) => e.data.source)).toHaveLength(2);
    });

    it('never re-adds a node already on the canvas', () => {
        const { elements } = buildExpansionElements({
            expanded: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            dependents: dir([]),
            dependsOn: dir([{ relation: 'uses_security_group', type: 'ec2_security_groups', id: 'sg-1' }]),
            existingIds: new Set([resourceNodeId('ec2_instances', 'i-1'), resourceNodeId('ec2_security_groups', 'sg-1')]),
        });

        expect(elements.filter((e) => !e.data.source)).toHaveLength(0);
        expect(elements.filter((e) => e.data.source)).toHaveLength(1);
    });

    it('reports how many neighbours the cap withheld', () => {
        const { hiddenTotal } = buildExpansionElements({
            expanded: { resourceType: 'ec2_vpcs', resourceId: 'vpc-1' },
            dependents: dir([{ relation: 'in_vpc', type: 'ec2_instances', id: 'i-1' }], 237),
            dependsOn: dir([]),
            existingIds: new Set(),
        });

        expect(hiddenTotal).toBe(236);
    });

    it('reports zero withheld when nothing was truncated', () => {
        const { hiddenTotal } = buildExpansionElements({
            expanded: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            dependents: dir([{ relation: 'attached_to', type: 'ec2_volumes', id: 'vol-1' }]),
            dependsOn: dir([]),
            existingIds: new Set(),
        });

        expect(hiddenTotal).toBe(0);
    });
});

describe('parentAssignment', () => {
    const e = (fromType: string, fromId: string, relation: string, toType: string, toId: string) => ({
        fromType, fromId, relation, toType, toId, region: 'ap-south-1',
    });

    it('parents a resource to its subnet, not its vpc, when it has both', () => {
        const map = parentAssignment([
            e('ec2_instances', 'i-1', 'in_vpc', 'ec2_vpcs', 'vpc-1'),
            e('ec2_instances', 'i-1', 'in_subnet', 'ec2_subnets', 'sn-1'),
        ]);
        expect(map.get(resourceNodeId('ec2_instances', 'i-1'))).toBe(resourceNodeId('ec2_subnets', 'sn-1'));
    });

    it('parents to the vpc when there is no subnet', () => {
        const map = parentAssignment([e('elbv2_load_balancers', 'lb-1', 'in_vpc', 'ec2_vpcs', 'vpc-1')]);
        expect(map.get(resourceNodeId('elbv2_load_balancers', 'lb-1'))).toBe(resourceNodeId('ec2_vpcs', 'vpc-1'));
    });

    it('leaves a resource with no containment at top level', () => {
        const map = parentAssignment([e('ec2_volumes', 'vol-1', 'attached_to', 'ec2_instances', 'i-1')]);
        expect(map.has(resourceNodeId('ec2_volumes', 'vol-1'))).toBe(false);
    });
});

describe('buildNodeElements', () => {
    it('turns containment into parentage and does not also draw it as an edge', () => {
        const els = buildNodeElements({
            nodes: [
                { resourceType: 'ec2_vpcs', resourceId: 'vpc-1' },
                { resourceType: 'ec2_subnets', resourceId: 'sn-1' },
            ],
            edges: [{ fromType: 'ec2_subnets', fromId: 'sn-1', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1', region: 'ap-south-1' }],
            existingIds: new Set(),
        });

        expect(els.filter((e) => e.data.source)).toHaveLength(0);
        expect(els.find((e) => e.data.id === resourceNodeId('ec2_subnets', 'sn-1'))?.data.parent)
            .toBe(resourceNodeId('ec2_vpcs', 'vpc-1'));
    });

    it('draws a non-containment edge normally', () => {
        const els = buildNodeElements({
            nodes: [
                { resourceType: 'ec2_volumes', resourceId: 'vol-1' },
                { resourceType: 'ec2_instances', resourceId: 'i-1' },
            ],
            edges: [{ fromType: 'ec2_volumes', fromId: 'vol-1', relation: 'attached_to', toType: 'ec2_instances', toId: 'i-1', region: 'ap-south-1' }],
            existingIds: new Set(),
        });

        expect(els.filter((e) => e.data.source)).toHaveLength(1);
    });

    it('flags an external node in its data and classes, and carries its owning account', () => {
        const els = buildNodeElements({
            nodes: [
                { resourceType: 'ec2_instances', resourceId: 'i-1' },
                { resourceType: 'kms_keys', resourceId: 'kms-shared-1', accountId: '861276112345', external: true },
            ],
            edges: [{ fromType: 'ec2_instances', fromId: 'i-1', relation: 'encrypted_with', toType: 'kms_keys', toId: 'kms-shared-1', region: 'ap-south-1' }],
            existingIds: new Set(),
        });

        const externalNode = els.find((e) => e.data.id === resourceNodeId('kms_keys', 'kms-shared-1'));
        expect(externalNode?.data.external).toBe(true);
        expect(externalNode?.data.accountId).toBe('861276112345');
        expect(externalNode?.classes).toContain('external');
    });

    it('does not mark a local node external', () => {
        const els = buildNodeElements({
            nodes: [{ resourceType: 'ec2_instances', resourceId: 'i-1' }],
            edges: [],
            existingIds: new Set(),
        });

        const node = els.find((e) => e.data.id === resourceNodeId('ec2_instances', 'i-1'));
        expect(node?.data.external).toBe(false);
        expect(node?.classes).not.toContain('external');
    });
});
