import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetNeighbors = vi.fn().mockResolvedValue([]);
const mockGetBlastRadius = vi.fn().mockResolvedValue([]);
const mockResolveResourceType = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({
        getNeighbors: mockGetNeighbors,
        getBlastRadius: mockGetBlastRadius,
        resolveResourceType: mockResolveResourceType,
        // resolveResourceRef is what the tools call now. Deriving it from the existing
        // resolveResourceType mock keeps these cases exercising id-only resolution, which is
        // what they were written to cover; name resolution has its own test.
        resolveResourceRef: async ({ ref }: { ref: string }) => {
            const resourceType = await mockResolveResourceType({ resourceId: ref });
            return resourceType ? { resourceType, resourceId: ref } : null;
        },
    }),
}));

import { createGetResourceNeighborsTool, createGetBlastRadiusTool } from '@/lib/agent/resource-graph-tool';

describe('resource graph agent tools', () => {
    // mockReset, not clearAllMocks: the latter keeps queued mockResolvedValueOnce
    // values, so an unconsumed queue leaks into whichever test runs next.
    beforeEach(() => {
        mockGetNeighbors.mockReset().mockResolvedValue([]);
        mockGetBlastRadius.mockReset().mockResolvedValue([]);
        mockResolveResourceType.mockReset().mockResolvedValue(null);
    });

    it('binds the tenantId from construction, not from model input', async () => {
        const tool = createGetResourceNeighborsTool('tenant-1');
        await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-1' });

        expect(mockGetNeighbors).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('does not expose tenantId in the tool schema', () => {
        const tool = createGetResourceNeighborsTool('tenant-1');
        expect(JSON.stringify(tool.schema)).not.toContain('tenantId');
    });

    it('returns a JSON string with a count and the edges', async () => {
        mockGetNeighbors.mockResolvedValueOnce([
            { fromType: 'ec2_instances', fromId: 'i-1', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1', depth: 1 },
        ]);

        const tool = createGetResourceNeighborsTool('tenant-1');
        const parsed = JSON.parse(await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-1' }));

        expect(parsed.count).toBe(1);
        expect(parsed.edges[0].relation).toBe('in_vpc');
    });

    it('distinguishes "in inventory but no relationships" from "never discovered"', async () => {
        // In inventory, genuinely no edges.
        mockResolveResourceType.mockResolvedValue('ec2_instances');
        const tool = createGetResourceNeighborsTool('tenant-1');
        const known = JSON.parse(await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-isolated' }));

        expect(known.count).toBe(0);
        expect(known.note).toContain('no recorded relationships');

        // Not in inventory at all — the agent must not read this as "safe to delete".
        mockResolveResourceType.mockResolvedValue(null);
        const unknown = JSON.parse(await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-unknown' }));

        expect(unknown.count).toBe(0);
        expect(unknown.note).toContain('not found in inventory');
    });

    // The model does not reliably know discovery's internal type names — observed in a
    // real run passing "ec2" for an instance, which matched nothing while six edges
    // existed. The resource id is unambiguous, so the tool resolves the type itself.
    describe('resource type resolution', () => {
        const edge = { fromType: 'ec2_instances', fromId: 'i-1', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1', region: 'ap-south-1', depth: 1 };

        it('retries with the real type when the model passes a wrong one', async () => {
            mockGetNeighbors.mockResolvedValueOnce([]).mockResolvedValueOnce([edge]);
            mockResolveResourceType.mockResolvedValueOnce('ec2_instances');

            const tool = createGetResourceNeighborsTool('tenant-1');
            const parsed = JSON.parse(await tool.invoke({ resourceType: 'ec2', resourceId: 'i-1' }));

            expect(parsed.count).toBe(1);
            expect(parsed.resourceType).toBe('ec2_instances');
            expect(mockGetNeighbors).toHaveBeenLastCalledWith(expect.objectContaining({ resourceType: 'ec2_instances' }));
        });

        it('looks the type up when the model omits it entirely', async () => {
            mockResolveResourceType.mockResolvedValueOnce('ec2_instances');
            mockGetNeighbors.mockResolvedValueOnce([edge]);

            const tool = createGetResourceNeighborsTool('tenant-1');
            const parsed = JSON.parse(await tool.invoke({ resourceId: 'i-1' }));

            expect(parsed.count).toBe(1);
            expect(mockGetNeighbors).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'ec2_instances' }));
        });

        it('does not re-query when the given type already returned edges', async () => {
            mockGetNeighbors.mockResolvedValueOnce([edge]);

            const tool = createGetResourceNeighborsTool('tenant-1');
            await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-1' });

            expect(mockResolveResourceType).not.toHaveBeenCalled();
            expect(mockGetNeighbors).toHaveBeenCalledTimes(1);
        });

        it('says the id is not in inventory when it cannot be resolved', async () => {
            mockResolveResourceType.mockResolvedValueOnce(null);

            const tool = createGetResourceNeighborsTool('tenant-1');
            const parsed = JSON.parse(await tool.invoke({ resourceId: 'i-nope' }));

            expect(parsed.count).toBe(0);
            expect(parsed.note).toContain('not found in inventory');
        });

        it('applies the same resolution to blast radius', async () => {
            mockGetBlastRadius.mockResolvedValueOnce([]).mockResolvedValueOnce([edge]);
            mockResolveResourceType.mockResolvedValueOnce('ec2_instances');

            const tool = createGetBlastRadiusTool('tenant-1');
            const parsed = JSON.parse(await tool.invoke({ resourceType: 'ec2', resourceId: 'i-1' }));

            expect(parsed.dependentCount).toBe(1);
            expect(mockGetBlastRadius).toHaveBeenLastCalledWith(expect.objectContaining({ resourceType: 'ec2_instances' }));
        });
    });

    it('blast radius groups dependents by depth', async () => {
        mockGetBlastRadius.mockResolvedValueOnce([
            { fromType: 'elbv2_target_groups', fromId: 'arn:tg/1', relation: 'routes_to_instance', toType: 'ec2_instances', toId: 'i-1', depth: 1 },
            { fromType: 'elbv2_load_balancers', fromId: 'arn:lb/1', relation: 'attached_to_load_balancer', toType: 'elbv2_target_groups', toId: 'arn:tg/1', depth: 2 },
        ]);

        const tool = createGetBlastRadiusTool('tenant-1');
        const parsed = JSON.parse(await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-1' }));

        expect(parsed.dependentCount).toBe(2);
        expect(parsed.byDepth['1']).toHaveLength(1);
        expect(parsed.byDepth['2']).toHaveLength(1);
    });
});
