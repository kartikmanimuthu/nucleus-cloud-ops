export type NodeKey = string;

export interface BfsEdge {
    from: NodeKey;
    to: NodeKey;
    relation: string;
}

export async function bfsPath(args: {
    start: NodeKey;
    goal: NodeKey;
    maxDepth: number;
    frontierCap: number;
    neighbours: (frontier: NodeKey[]) => Promise<BfsEdge[]>;
}): Promise<{ path: BfsEdge[] | null; searchedDepth: number; frontierExhausted: boolean }> {
    if (args.start === args.goal) return { path: [], searchedDepth: 0, frontierExhausted: false };

    const cameFrom = new Map<NodeKey, BfsEdge>();
    const visited = new Set<NodeKey>([args.start]);
    let frontier: NodeKey[] = [args.start];
    let frontierExhausted = false;
    let depth = 0;

    const reconstruct = (): BfsEdge[] => {
        const chain: BfsEdge[] = [];
        let cursor = args.goal;
        while (cursor !== args.start) {
            const edge = cameFrom.get(cursor)!;
            chain.unshift(edge);
            cursor = edge.from === cursor ? edge.to : edge.from;
        }
        return chain;
    };

    while (frontier.length && depth < args.maxDepth) {
        depth += 1;
        const edges = await args.neighbours(frontier);
        const next: NodeKey[] = [];
        const inFrontierSet = new Set(frontier);

        for (const edge of edges) {
            const inFrontier = inFrontierSet.has(edge.from) ? edge.from : inFrontierSet.has(edge.to) ? edge.to : null;
            if (!inFrontier) continue;
            const other = inFrontier === edge.from ? edge.to : edge.from;
            if (visited.has(other)) continue;

            visited.add(other);
            cameFrom.set(other, edge);
            if (other === args.goal) return { path: reconstruct(), searchedDepth: depth, frontierExhausted };
            next.push(other);
        }

        if (next.length > args.frontierCap) {
            frontierExhausted = true;
            next.length = args.frontierCap;
        }
        frontier = next;
    }

    return { path: null, searchedDepth: depth, frontierExhausted };
}
