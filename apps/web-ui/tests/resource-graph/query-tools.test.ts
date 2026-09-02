import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindPath = vi.fn();
const mockQueryGraph = vi.fn();
const mockSummarise = vi.fn();
const mockResolveResourceType = vi.fn();

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({
        findPath: mockFindPath,
        queryGraph: mockQueryGraph,
        summarise: mockSummarise,
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

import {
    createFindPathTool,
    createQueryGraphTool,
    createDescribeEnvironmentTool,
} from '@/lib/agent/resource-graph-query-tool';

describe('resource graph query tools', () => {
    beforeEach(() => {
        mockFindPath.mockReset().mockResolvedValue({ found: false, from: {}, to: {}, hops: [], searchedDepth: 4, frontierExhausted: false });
        mockQueryGraph.mockReset().mockResolvedValue({ nodes: [], edges: [], total: 0, truncated: false });
        mockSummarise.mockReset().mockResolvedValue({ accounts: [], byResourceType: [], byRelation: [] });
        mockResolveResourceType.mockReset().mockResolvedValue('ec2_instances');
    });

    it('never exposes tenantId in any tool schema', () => {
        for (const tool of [createFindPathTool('t1'), createQueryGraphTool('t1'), createDescribeEnvironmentTool('t1')]) {
            expect(JSON.stringify(tool.schema)).not.toContain('tenantId');
        }
    });

    it('binds the tenant from construction', async () => {
        await createDescribeEnvironmentTool('tenant-1').invoke({});
        expect(mockSummarise).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('resolves both resource types from their ids before searching', async () => {
        await createFindPathTool('t1').invoke({ fromId: 'i-1', toId: 'vpc-1' });
        expect(mockResolveResourceType).toHaveBeenCalledTimes(2);
    });

    it('states plainly when a resource is not in inventory instead of returning an empty path', async () => {
        mockResolveResourceType.mockResolvedValue(null);
        const out = await createFindPathTool('t1').invoke({ fromId: 'i-nope', toId: 'vpc-1' });
        expect(out).toMatch(/not found in inventory/i);
        expect(mockFindPath).not.toHaveBeenCalled();
    });

    it('distinguishes "no path" from "no such resource"', async () => {
        const out = await createFindPathTool('t1').invoke({ fromId: 'i-1', toId: 'vpc-1' });
        expect(out).toMatch(/no connection/i);
        expect(out).not.toMatch(/not found in inventory/i);
    });

    it('reports truncation so the model does not treat a capped result as complete', async () => {
        mockQueryGraph.mockResolvedValue({ nodes: [], edges: [], total: 900, truncated: true });
        const out = await createQueryGraphTool('t1').invoke({ predicate: 'isolated' });
        expect(out).toMatch(/900/);
        expect(out).toMatch(/truncated|showing/i);
    });

    it('rejects an unknown predicate at the schema boundary', async () => {
        await expect(createQueryGraphTool('t1').invoke({ predicate: 'whatever' as never })).rejects.toThrow();
    });

    it('rejects by-type with no resourceType instead of silently returning nothing', async () => {
        const out = await createQueryGraphTool('t1').invoke({ predicate: 'by-type' });
        expect(out).toMatch(/resourceType.*required/i);
        expect(mockQueryGraph).not.toHaveBeenCalled();
    });

    it('rejects by-vpc with no vpcId instead of silently returning nothing', async () => {
        const out = await createQueryGraphTool('t1').invoke({ predicate: 'by-vpc' });
        expect(out).toMatch(/vpcId.*required/i);
        expect(mockQueryGraph).not.toHaveBeenCalled();
    });

    it('scopes the empty-result note to the account asked about, not the whole tenant', async () => {
        const out = await createDescribeEnvironmentTool('t1').invoke({ accountId: 'acc-empty' });
        const parsed = JSON.parse(out);
        expect(parsed.note).toContain('acc-empty');
        expect(parsed.note).not.toMatch(/tenant/i);
    });

    it('keeps the tenant-wide empty note when no account is given', async () => {
        const out = await createDescribeEnvironmentTool('t1').invoke({});
        const parsed = JSON.parse(out);
        expect(parsed.note).toMatch(/tenant/i);
    });

    it('names what the counts exclude', async () => {
        mockSummarise.mockResolvedValue({ accounts: [{ accountId: 'acc-1', resourceCount: 5, edgeCount: 2 }], byResourceType: [], byRelation: [] });
        const out = await createDescribeEnvironmentTool('t1').invoke({});
        const parsed = JSON.parse(out);
        expect(parsed.excludes.resourceTypes).toEqual(expect.arrayContaining(['ssm_parameters', 'iam_roles']));
        expect(JSON.stringify(parsed.excludes)).toMatch(/observation|kms/i);
    });
});
