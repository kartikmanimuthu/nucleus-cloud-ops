import type { GraphFilters, GraphPredicate } from '@/lib/resource-graph/graph-constants';

export interface GraphEdge {
    fromType: string;
    fromId: string;
    relation: string;
    toType: string;
    toId: string;
    // Needed to disambiguate same-named resources discovered in different regions.
    region: string;
    depth: number;
}

export interface GraphQueryArgs {
    tenantId: string;
    resourceType: string;
    resourceId: string;
    depth?: number;
    limit?: number;
}

export interface EnrichedEdge {
    relation: string;
    region: string;
    other: {
        resourceType: string;
        resourceId: string;
        name: string | null;
        status: string | null;
        accountId: string | null;
        exists: boolean;
    };
}

export interface DependencyDirection {
    edges: EnrichedEdge[];
    total: number;
    truncated: boolean;
}

export interface ResourceDependencies {
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
    /** Distinct owning accounts across focus + every returned edge. */
    accountIds: string[];
}

export interface AccountSummary {
    accountId: string;
    resourceCount: number;
    edgeCount: number;
}

export interface GraphSummary {
    accounts: AccountSummary[];
    byResourceType: Array<{ resourceType: string; count: number }>;
    byRelation: Array<{ relation: string; count: number }>;
}

export interface GraphNode {
    resourceType: string;
    resourceId: string;
    name: string | null;
    status: string | null;
    accountId: string;
    region: string;
    // Set when the node was pulled in only because an edge from the seeded account points
    // at it — it belongs to a different account and is context, not part of this canvas.
    external?: boolean;
}

export interface GraphEdgeLite {
    fromType: string;
    fromId: string;
    relation: string;
    toType: string;
    toId: string;
    region: string;
}

export interface SeedResult {
    mode: 'full-account' | 'structural';
    nodes: GraphNode[];
    edges: GraphEdgeLite[];
    totalVisibleNodes: number;
    truncated: boolean;
}

export interface ExpandResult {
    resourceType: string;
    resourceId: string;
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
}

export interface QueryResult {
    nodes: GraphNode[];
    edges: GraphEdgeLite[];
    total: number;
    truncated: boolean;
}

export interface PathHop {
    resourceType: string;
    resourceId: string;
    relation: string;
}

export interface PathResult {
    found: boolean;
    from: { resourceType: string; resourceId: string };
    to: { resourceType: string; resourceId: string };
    hops: PathHop[];
    searchedDepth: number;
    frontierExhausted: boolean;
}

export interface ResolvedRef {
    resourceType: string;
    resourceId: string;
    // Present only when a name matched more than one resource, so the caller can say which.
    ambiguous?: Array<{ resourceType: string; resourceId: string }>;
}

export interface IResourceGraphRepository {
    getNeighbors(args: GraphQueryArgs): Promise<GraphEdge[]>;
    getBlastRadius(args: GraphQueryArgs): Promise<GraphEdge[]>;
    // Looks up discovery's internal resourceType for a resource id, so callers that
    // only know the id (or guessed the type wrong) still hit the graph.
    resolveResourceType(args: { tenantId: string; resourceId: string }): Promise<string | null>;
    // Resolves what a user typed — an id, or the name shown in the console and the graph UI —
    // to the canonical (type, id) the graph is keyed on. Callers that only ever pass an id can
    // keep using resolveResourceType.
    resolveResourceRef(args: { tenantId: string; ref: string }): Promise<ResolvedRef | null>;
    getResourceDependencies(args: {
        tenantId: string;
        resourceType: string;
        resourceId: string;
        limit?: number;
    }): Promise<ResourceDependencies>;
    summarise(args: {
        tenantId: string;
        accountId?: string;
        filters?: GraphFilters;
    }): Promise<GraphSummary>;
    getSeed(args: {
        tenantId: string;
        accountId: string;
        filters?: GraphFilters;
        limit?: number;
    }): Promise<SeedResult>;
    expand(args: {
        tenantId: string;
        resourceType: string;
        resourceId: string;
        filters?: GraphFilters;
    }): Promise<ExpandResult>;
    findPath(args: {
        tenantId: string;
        from: { resourceType: string; resourceId: string };
        to: { resourceType: string; resourceId: string };
        maxDepth?: number;
    }): Promise<PathResult>;
    queryGraph(args: {
        tenantId: string;
        predicate: GraphPredicate;
        filters?: GraphFilters;
        limit?: number;
    }): Promise<QueryResult>;
}
