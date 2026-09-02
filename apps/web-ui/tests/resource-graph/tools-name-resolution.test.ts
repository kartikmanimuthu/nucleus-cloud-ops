import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetNeighbors = vi.fn();
const mockGetBlastRadius = vi.fn();
const mockResolveResourceRef = vi.fn();

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({
        getNeighbors: mockGetNeighbors,
        getBlastRadius: mockGetBlastRadius,
        resolveResourceType: vi.fn(),
        resolveResourceRef: mockResolveResourceRef,
    }),
}));

import { createGetResourceNeighborsTool, createGetBlastRadiusTool } from '@/lib/agent/resource-graph-tool';

// A user types the name they see in the console; the graph is keyed on ids and ARNs. Before
// this resolution existed, find_path on an ECS service name returned "not found in inventory"
// while the service was sitting in the graph under its ARN.
describe('resource graph tools accept a name, not just an id', () => {
    beforeEach(() => {
        mockGetNeighbors.mockReset().mockResolvedValue([]);
        mockGetBlastRadius.mockReset().mockResolvedValue([]);
        mockResolveResourceRef.mockReset();
    });

    it('queries with the canonical id when given a name', async () => {
        mockResolveResourceRef.mockResolvedValue({
            resourceType: 'ecs_services',
            resourceId: 'arn:aws:ecs:ap-south-1:1:service/cluster/web-ui',
        });
        mockGetNeighbors.mockResolvedValue([
            { fromType: 'ecs_services', fromId: 'arn:aws:ecs:ap-south-1:1:service/cluster/web-ui', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1', depth: 1 },
        ]);

        const result = JSON.parse(await createGetResourceNeighborsTool('t1').invoke({ resourceId: 'web-ui' }));

        expect(mockGetNeighbors).toHaveBeenCalledWith(
            expect.objectContaining({ resourceId: 'arn:aws:ecs:ap-south-1:1:service/cluster/web-ui' }),
        );
        expect(result.resource).toBe('ecs_services/arn:aws:ecs:ap-south-1:1:service/cluster/web-ui');
        expect(result.count).toBe(1);
    });

    it('reports the alternatives when a name matches more than one resource', async () => {
        const ambiguous = [
            { resourceType: 'ec2_instances', resourceId: 'i-111' },
            { resourceType: 'rds_db_instances', resourceId: 'shared-name' },
        ];
        mockResolveResourceRef.mockResolvedValue({ ...ambiguous[0], ambiguous });

        const result = JSON.parse(await createGetResourceNeighborsTool('t1').invoke({ resourceId: 'shared-name' }));

        expect(result.ambiguous).toEqual(ambiguous);
        expect(result.ambiguityNote).toMatch(/more than one/i);
    });

    // The zero-result wording is load-bearing: an agent previously read "nothing depends on
    // this" as permission to recommend deleting a live database.
    it('never presents an empty blast radius as safe to delete', async () => {
        mockResolveResourceRef.mockResolvedValue({ resourceType: 'rds_db_instances', resourceId: 'prod-db' });
        mockGetBlastRadius.mockResolvedValue([]);

        const result = JSON.parse(await createGetBlastRadiusTool('t1').invoke({ resourceId: 'prod-db' }));

        expect(result.dependentCount).toBe(0);
        expect(result.note).toMatch(/not evidence/i);
        expect(result.note).toMatch(/application-level|CIDR/i);
        // The word "safe" may appear, but only inside the instruction not to conclude it.
        expect(result.note).toMatch(/do NOT conclude it is safe/i);
    });
});
