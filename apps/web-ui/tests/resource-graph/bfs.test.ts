import { describe, it, expect, vi } from 'vitest';
import { bfsPath, type BfsEdge, type NodeKey } from '@/lib/resource-graph/bfs';

// a -> b -> c -> d, plus a decoy branch a -> x
const GRAPH: BfsEdge[] = [
    { from: 'ec2_instances|a', to: 'ec2_subnets|b', relation: 'in_subnet' },
    { from: 'ec2_subnets|b', to: 'ec2_vpcs|c', relation: 'in_vpc' },
    { from: 'elbv2_load_balancers|d', to: 'ec2_vpcs|c', relation: 'in_vpc' },
    { from: 'ec2_instances|a', to: 'ec2_volumes|x', relation: 'has_volume' },
];

const neighbours = (frontier: NodeKey[]) =>
    Promise.resolve(GRAPH.filter((e) => frontier.includes(e.from) || frontier.includes(e.to)));

describe('bfsPath', () => {
    it('finds the shortest undirected chain between two nodes', async () => {
        const result = await bfsPath({
            start: 'ec2_instances|a',
            goal: 'elbv2_load_balancers|d',
            maxDepth: 5,
            frontierCap: 100,
            neighbours,
        });

        expect(result.path).not.toBeNull();
        expect(result.path!.map((e) => e.relation)).toEqual(['in_subnet', 'in_vpc', 'in_vpc']);
    });

    it('returns null rather than a wrong answer when the goal is out of range', async () => {
        const result = await bfsPath({
            start: 'ec2_instances|a',
            goal: 'elbv2_load_balancers|d',
            maxDepth: 1,
            frontierCap: 100,
            neighbours,
        });

        expect(result.path).toBeNull();
        expect(result.searchedDepth).toBe(1);
    });

    it('returns an empty path when start and goal are the same node', async () => {
        const result = await bfsPath({
            start: 'ec2_instances|a',
            goal: 'ec2_instances|a',
            maxDepth: 5,
            frontierCap: 100,
            neighbours,
        });

        expect(result.path).toEqual([]);
    });

    it('never revisits a node', async () => {
        const spy = vi.fn(neighbours);
        await bfsPath({
            start: 'ec2_instances|a',
            goal: 'nothing|here',
            maxDepth: 5,
            frontierCap: 100,
            neighbours: spy,
        });

        const asked = spy.mock.calls.flatMap((c) => c[0]);
        expect(new Set(asked).size).toBe(asked.length);
    });

    it('reports frontierExhausted when the cap bites', async () => {
        const result = await bfsPath({
            start: 'ec2_instances|a',
            goal: 'nothing|here',
            maxDepth: 5,
            frontierCap: 1,
            neighbours,
        });

        expect(result.frontierExhausted).toBe(true);
    });
});
