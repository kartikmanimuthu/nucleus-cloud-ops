// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { computeMiniMap } from '@/lib/resource-graph/mini-map-layout';
import { DependencyMiniMap } from '../dependency-mini-map';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

const edge = (relation: string, resourceId: string, exists = true): EnrichedEdge => ({
    relation, region: 'ap-south-1',
    other: { resourceType: 'ec2_vpcs', resourceId, name: `n-${resourceId}`,
             status: null, accountId: 'acc-1', exists },
});

const focus = { resourceType: 'ec2_instances', resourceId: 'i-1', label: 'i-1' };

describe('DependencyMiniMap', () => {
    it('renders a node per layout node and pivots on click', () => {
        const onPivot = vi.fn();
        const layout = computeMiniMap({ focus, dependents: [], dependsOn: [edge('in_vpc', 'vpc-1')] });
        render(<DependencyMiniMap layout={layout} onPivot={onPivot} />);

        fireEvent.click(screen.getByRole('button', { name: /n-vpc-1/ }));
        expect(onPivot).toHaveBeenCalledWith('ec2_vpcs', 'vpc-1');
    });

    it('shows the relation on the edge when the graph is small', () => {
        const layout = computeMiniMap({ focus, dependents: [], dependsOn: [edge('in_vpc', 'vpc-1')] });
        render(<DependencyMiniMap layout={layout} onPivot={vi.fn()} />);

        expect(screen.getByText('in_vpc')).toBeTruthy();
    });

    it('does not make a missing resource pivotable', () => {
        const layout = computeMiniMap({ focus, dependents: [], dependsOn: [edge('in_vpc', 'gone', false)] });
        render(<DependencyMiniMap layout={layout} onPivot={vi.fn()} />);

        expect(screen.queryByRole('button', { name: /gone/ })).toBeNull();
    });

    it('renders an overflow affordance when a side is capped', () => {
        const many = Array.from({ length: 10 }, (_, i) => edge('in_vpc', `v-${i}`));
        const layout = computeMiniMap({ focus, dependents: many, dependsOn: [] });
        render(<DependencyMiniMap layout={layout} onPivot={vi.fn()} />);

        expect(screen.getByText(/\+4/)).toBeTruthy();
    });
});
