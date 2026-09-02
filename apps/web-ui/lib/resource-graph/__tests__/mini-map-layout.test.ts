import { describe, it, expect } from 'vitest';
import { computeMiniMap, PER_SIDE_CAP } from '../mini-map-layout';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

const edge = (relation: string, resourceId: string): EnrichedEdge => ({
    relation, region: 'ap-south-1',
    other: { resourceType: 'ec2_vpcs', resourceId, name: `n-${resourceId}`,
             status: null, accountId: 'acc-1', exists: true },
});

const focus = { resourceType: 'ec2_instances', resourceId: 'i-1', label: 'i-1' };

describe('computeMiniMap', () => {
    it('places inbound left, focus centre, outbound right', () => {
        const l = computeMiniMap({ focus, dependents: [edge('in_vpc', 'a')], dependsOn: [edge('in_vpc', 'b')] });
        const left = l.nodes.find((n) => n.resourceId === 'a')!;
        const centre = l.nodes.find((n) => n.side === 'focus')!;
        const right = l.nodes.find((n) => n.resourceId === 'b')!;

        expect(left.x).toBeLessThan(centre.x);
        expect(right.x).toBeGreaterThan(centre.x);
    });

    // The whole point of a fixed layout: no drift between renders.
    it('is deterministic for identical input', () => {
        const args = { focus, dependents: [edge('in_vpc', 'a'), edge('monitors', 'b')], dependsOn: [] };
        expect(computeMiniMap(args)).toEqual(computeMiniMap(args));
    });

    it('caps each side and reports the overflow', () => {
        const many = Array.from({ length: PER_SIDE_CAP + 4 }, (_, i) => edge('in_vpc', `v-${i}`));
        const l = computeMiniMap({ focus, dependents: many, dependsOn: [] });

        expect(l.nodes.filter((n) => n.side === 'dependents')).toHaveLength(PER_SIDE_CAP);
        expect(l.overflow.dependents).toBe(4);
    });

    it('orders a side by kind, matching the list', () => {
        const l = computeMiniMap({
            focus,
            dependents: [edge('monitors', 'obs'), edge('routes_to_instance', 'tg')],
            dependsOn: [],
        });
        const side = l.nodes.filter((n) => n.side === 'dependents').sort((a, b) => a.y - b.y);
        expect(side[0].resourceId).toBe('tg');
    });

    it('suppresses inline edge labels once the graph gets busy', () => {
        const few = computeMiniMap({ focus, dependents: [edge('in_vpc', 'a')], dependsOn: [] });
        expect(few.showEdgeLabels).toBe(true);

        const many = Array.from({ length: 5 }, (_, i) => edge('in_vpc', `v-${i}`));
        const busy = computeMiniMap({ focus, dependents: many, dependsOn: many });
        expect(busy.showEdgeLabels).toBe(false);
    });

    it('emits one edge per node and never exceeds the height ceiling', () => {
        const many = Array.from({ length: PER_SIDE_CAP }, (_, i) => edge('in_vpc', `v-${i}`));
        const l = computeMiniMap({ focus, dependents: many, dependsOn: many });

        expect(l.edges).toHaveLength(PER_SIDE_CAP * 2);
        expect(l.height).toBeLessThanOrEqual(260);
    });
});
