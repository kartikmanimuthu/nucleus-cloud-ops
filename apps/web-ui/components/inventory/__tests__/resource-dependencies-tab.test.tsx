// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockUseResourceGraph = vi.fn();
vi.mock('@/lib/queries/resource-graph', () => ({
    useResourceGraph: (...args: unknown[]) => mockUseResourceGraph(...args),
}));

import { ResourceDependenciesTab } from '../resource-dependencies-tab';

const edge = (relation: string, resourceId: string, resourceType = 'ec2_vpcs') => ({
    relation, region: 'ap-south-1',
    other: { resourceType, resourceId, name: `name-${resourceId}`, status: 'available',
             accountId: 'acc-1', exists: true },
});

const ok = (over: Record<string, unknown> = {}) => ({
    isLoading: false, isError: false, error: null,
    data: {
        focus: { resourceType: 'ec2_instances', resourceId: 'i-1', exists: true },
        asOf: { oldestSyncedAt: '2026-08-11T00:00:00.000Z', accountsRepresented: 1, neverScanned: false },
        dependents: { edges: [], total: 0, truncated: false },
        dependsOn: { edges: [], total: 0, truncated: false },
        ...over,
    },
});

const props = { resourceType: 'ec2_instances', resourceId: 'i-1', active: true, onPivot: vi.fn() };

describe('ResourceDependenciesTab', () => {
    beforeEach(() => { vi.clearAllMocks(); mockUseResourceGraph.mockReturnValue(ok()); });

    it('orders dependents with traffic first', () => {
        mockUseResourceGraph.mockReturnValue(ok({
            dependents: {
                edges: [edge('in_vpc', 'vpc-1'), edge('routes_to_instance', 'arn:tg', 'elbv2_targroups')],
                total: 2, truncated: false,
            },
        }));
        render(<ResourceDependenciesTab {...props} />);

        const groups = screen.getAllByTestId('kind-heading').map((n) => n.textContent);
        expect(groups[0]).toContain('Serves traffic');
    });

    it('renders an unmapped relation under Other rather than dropping it', () => {
        mockUseResourceGraph.mockReturnValue(ok({
            dependsOn: { edges: [edge('teleports_to', 'x-1')], total: 1, truncated: false },
        }));
        render(<ResourceDependenciesTab {...props} />);

        expect(screen.getByText(/Other/)).toBeTruthy();
        expect(screen.getAllByText('name-x-1').length).toBeGreaterThanOrEqual(1);
    });

    it('distinguishes not-in-inventory from no-relationships', () => {
        mockUseResourceGraph.mockReturnValue(ok({
            focus: { resourceType: 'ec2_instances', resourceId: 'i-1', exists: false },
        }));
        const { unmount } = render(<ResourceDependenciesTab {...props} />);
        expect(screen.getByText(/not in inventory/i)).toBeTruthy();
        unmount();

        mockUseResourceGraph.mockReturnValue(ok());
        render(<ResourceDependenciesTab {...props} />);
        expect(screen.getByText(/no recorded relationships/i)).toBeTruthy();
    });

    it('shows an error state rather than an empty list', () => {
        mockUseResourceGraph.mockReturnValue({
            isLoading: false, isError: true, error: new Error('boom'), data: undefined,
        });
        render(<ResourceDependenciesTab {...props} />);

        expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
        expect(screen.queryByText(/no recorded relationships/i)).toBeNull();
    });

    it('warns instead of showing a relative time when an account was never scanned', () => {
        mockUseResourceGraph.mockReturnValue(ok({
            asOf: { oldestSyncedAt: null, accountsRepresented: 1, neverScanned: true },
        }));
        render(<ResourceDependenciesTab {...props} />);

        expect(screen.getByText(/never been scanned/i)).toBeTruthy();
    });

    it('reveals remaining rows via +N more', () => {
        const edges = Array.from({ length: 11 }, (_, i) => edge('in_vpc', `vpc-${String(i).padStart(2, '0')}`));
        mockUseResourceGraph.mockReturnValue(ok({
            dependsOn: { edges, total: 11, truncated: false },
        }));
        render(<ResourceDependenciesTab {...props} />);

        expect(screen.queryByText('name-vpc-10')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /3 more/i }));
        expect(screen.getAllByText('name-vpc-10').length).toBeGreaterThanOrEqual(1);
    });

    it('says so when a direction was truncated', () => {
        mockUseResourceGraph.mockReturnValue(ok({
            dependents: { edges: [edge('in_vpc', 'vpc-1')], total: 500, truncated: true },
        }));
        render(<ResourceDependenciesTab {...props} />);

        expect(screen.getByText(/showing first 1 of 500/i)).toBeTruthy();
    });

    it('pivots on a row click', () => {
        mockUseResourceGraph.mockReturnValue(ok({
            dependsOn: { edges: [edge('in_vpc', 'vpc-1')], total: 1, truncated: false },
        }));
        render(<ResourceDependenciesTab {...props} />);

        fireEvent.click(screen.getAllByRole('button', { name: /name-vpc-1/ }).at(-1)!);
        expect(props.onPivot).toHaveBeenCalledWith('ec2_vpcs', 'vpc-1');
    });

    it('does not make a non-existent target pivotable', () => {
        mockUseResourceGraph.mockReturnValue(ok({
            dependsOn: {
                edges: [{ ...edge('in_vpc', 'vpc-gone'), other: {
                    resourceType: 'ec2_vpcs', resourceId: 'vpc-gone', name: null,
                    status: null, accountId: null, exists: false } }],
                total: 1, truncated: false,
            },
        }));
        render(<ResourceDependenciesTab {...props} />);

        expect(screen.queryByRole('button', { name: /vpc-gone/ })).toBeNull();
        expect(screen.getByText(/not in inventory/i)).toBeTruthy();
    });
});
