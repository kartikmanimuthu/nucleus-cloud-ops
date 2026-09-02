import { getTenantClient } from '@/lib/db/pg-config';
import type { ResolvedRef, GraphEdge, GraphQueryArgs, IResourceGraphRepository, ResourceDependencies, DependencyDirection, ExpandResult, AccountSummary, GraphSummary, GraphNode, GraphEdgeLite, SeedResult, PathHop, PathResult, QueryResult } from './interface';
import { edgeFilterSql, nodeTypeFilterSql } from './filter-sql';
import { SEED_NODE_CAP, SEED_EDGE_CAP, STRUCTURAL_TYPES, EXPAND_CAP, DEFAULT_PATH_DEPTH, MONITORABLE_TYPES, DEFAULT_QUERY_LIMIT, HIDDEN_NODE_TYPES, type GraphFilters, type GraphPredicate } from '@/lib/resource-graph/graph-constants';
import { bfsPath } from '@/lib/resource-graph/bfs';

const MAX_DEPTH = 5;
const MAX_LIMIT = 500;
const DEFAULT_EDGE_LIMIT = 200;
const EXTERNAL_NODE_CAP = 200;
const EXTERNAL_EDGE_CAP = 1000;

const clamp = (value: number, max: number) => Math.max(1, Math.min(value, max));

interface RawEnrichedRow {
    relation: string;
    region: string;
    other_type: string;
    other_id: string;
    other_name: string | null;
    other_status: string | null;
    other_account_id: string | null;
    other_exists: boolean;
    total: bigint | number;
}

export class ResourceGraphPostgresRepository implements IResourceGraphRepository {
    async resolveResourceType(args: { tenantId: string; resourceId: string }): Promise<string | null> {
        // Model access, not $queryRawUnsafe, so the getTenantClient extension scopes this
        // for us. Ordered for determinism when an id somehow exists under two types.
        const row = await getTenantClient(args.tenantId).inventoryResource.findFirst({
            where: { resourceId: args.resourceId, isCurrent: true },
            select: { resourceType: true },
            orderBy: { resourceType: 'asc' },
        });
        return row?.resourceType ?? null;
    }

    async resolveResourceRef(args: { tenantId: string; ref: string }): Promise<ResolvedRef | null> {
        const db = getTenantClient(args.tenantId);

        // An id is unambiguous, so it always wins over a name that happens to collide with one.
        const byId = await db.inventoryResource.findFirst({
            where: { resourceId: args.ref, isCurrent: true },
            select: { resourceType: true, resourceId: true },
            orderBy: { resourceType: 'asc' },
        });
        if (byId) return { resourceType: byId.resourceType, resourceId: byId.resourceId };

        const byName = await db.inventoryResource.findMany({
            where: { name: args.ref, isCurrent: true },
            select: { resourceType: true, resourceId: true },
            orderBy: [{ resourceType: 'asc' }, { resourceId: 'asc' }],
            take: 6,
        });
        if (byName.length === 0) return null;
        if (byName.length === 1) {
            return { resourceType: byName[0].resourceType, resourceId: byName[0].resourceId };
        }
        return {
            resourceType: byName[0].resourceType,
            resourceId: byName[0].resourceId,
            ambiguous: byName.map((r) => ({ resourceType: r.resourceType, resourceId: r.resourceId })),
        };
    }

    async getNeighbors(args: GraphQueryArgs): Promise<GraphEdge[]> {
        const depth = clamp(args.depth ?? 1, MAX_DEPTH);
        const limit = clamp(args.limit ?? 100, MAX_LIMIT);

        // Walks reachable NODES, then attaches each edge once. Recursing over edges
        // instead only ever expands one end of an edge, so a resource found via an
        // inbound edge (an instance's target group) becomes a dead end — the load
        // balancer behind it is unreachable — and edges re-appear at every depth.
        const sql = `
            WITH RECURSIVE reach AS (
                SELECT $2::text AS node_type, $3::text AS node_id, 0 AS depth
                UNION
                SELECT
                    CASE WHEN e."fromType" = r.node_type AND e."fromId" = r.node_id
                         THEN e."toType" ELSE e."fromType" END,
                    CASE WHEN e."fromType" = r.node_type AND e."fromId" = r.node_id
                         THEN e."toId"   ELSE e."fromId"   END,
                    r.depth + 1
                FROM reach r
                JOIN resource_edges e
                  ON e."tenantId" = $1
                 AND e."isCurrent" = true
                 AND (("fromType" = r.node_type AND e."fromId" = r.node_id)
                   OR ("toType"   = r.node_type AND e."toId"   = r.node_id))
                WHERE r.depth < $4
            ),
            frontier AS (
                SELECT node_type, node_id, MIN(depth) AS depth
                FROM reach
                GROUP BY node_type, node_id
            )
            SELECT e."fromType", e."fromId", e.relation, e."toType", e."toId", e.region,
                   LEAST(f.depth, t.depth) + 1 AS depth
            FROM resource_edges e
            JOIN frontier f ON f.node_type = e."fromType" AND f.node_id = e."fromId"
            JOIN frontier t ON t.node_type = e."toType"   AND t.node_id = e."toId"
            WHERE e."tenantId" = $1
              AND e."isCurrent" = true
              AND LEAST(f.depth, t.depth) < $4
            ORDER BY depth, e."fromType", e."fromId"
            LIMIT $5
        `;

        return getTenantClient(args.tenantId).$queryRawUnsafe<GraphEdge[]>(
            sql,
            args.tenantId,
            args.resourceType,
            args.resourceId,
            depth,
            limit,
        );
    }

    async getBlastRadius(args: GraphQueryArgs): Promise<GraphEdge[]> {
        const depth = clamp(args.depth ?? 3, MAX_DEPTH);
        const limit = clamp(args.limit ?? 200, MAX_LIMIT);

        const sql = `
            WITH RECURSIVE walk AS (
                SELECT "fromType", "fromId", relation, "toType", "toId", region, 1 AS depth
                FROM resource_edges
                WHERE "tenantId" = $1 AND "isCurrent" = true
                  AND "toType" = $2 AND "toId" = $3
                UNION
                SELECT e."fromType", e."fromId", e.relation, e."toType", e."toId", e.region, w.depth + 1
                FROM resource_edges e
                JOIN walk w ON e."toType" = w."fromType" AND e."toId" = w."fromId"
                WHERE e."tenantId" = $1 AND e."isCurrent" = true AND w.depth < $4
            )
            SELECT "fromType", "fromId", relation, "toType", "toId", region, depth
            FROM walk
            ORDER BY depth, "fromType", "fromId"
            LIMIT $5
        `;

        return getTenantClient(args.tenantId).$queryRawUnsafe<GraphEdge[]>(
            sql,
            args.tenantId,
            args.resourceType,
            args.resourceId,
            depth,
            limit,
        );
    }

    // One query per direction, each hitting its own covering index. NOT combined with
    // OR: a shared LIMIT would let 5,000 inbound edges crowd out all 3 outbound ones
    // and render an empty section with no truncation signal. (A combined OR does plan
    // fine — BitmapOr across both indexes — so this split is about caps, not speed.)
    private dependencySql(direction: 'dependents' | 'dependsOn', filters: GraphFilters = {}): string {
        const inbound = direction === 'dependents';
        const farType = inbound ? 'fromType' : 'toType';
        const farId = inbound ? 'fromId' : 'toId';
        const nearType = inbound ? 'toType' : 'fromType';
        const nearId = inbound ? 'toId' : 'fromId';

        return `
            SELECT e.relation,
                   e.region,
                   e."${farType}"  AS other_type,
                   e."${farId}"    AS other_id,
                   i."name"        AS other_name,
                   i."status"      AS other_status,
                   i."accountId"   AS other_account_id,
                   (i.id IS NOT NULL) AS other_exists,
                   COUNT(*) OVER () AS total
            FROM resource_edges e
            LEFT JOIN inventory_resources i
                   ON i."tenantId" = $1
                  AND i."isCurrent" = true
                  AND i."resourceType" = e."${farType}"
                  AND i."resourceId"   = e."${farId}"
            WHERE e."tenantId" = $1
              AND e."isCurrent" = true
              AND e."${nearType}" = $2
              AND e."${nearId}"   = $3
              ${edgeFilterSql('e', filters)}
            ORDER BY e.relation, e."${farId}"
            LIMIT $4
        `;
    }

    async getResourceDependencies(args: {
        tenantId: string;
        resourceType: string;
        resourceId: string;
        limit?: number;
    }): Promise<ResourceDependencies> {
        const limit = clamp(args.limit ?? DEFAULT_EDGE_LIMIT, MAX_LIMIT);
        const db = getTenantClient(args.tenantId);

        const run = async (direction: 'dependents' | 'dependsOn'): Promise<DependencyDirection> => {
            const rows = await db.$queryRawUnsafe<RawEnrichedRow[]>(
                this.dependencySql(direction, { includeAwsManagedKeys: true, includeObservation: true }),
                args.tenantId,
                args.resourceType,
                args.resourceId,
                limit,
            );

            const total = rows.length ? Number(rows[0].total) : 0;
            return {
                edges: rows.map((r) => ({
                    relation: r.relation,
                    region: r.region,
                    other: {
                        resourceType: r.other_type,
                        resourceId: r.other_id,
                        name: r.other_name,
                        status: r.other_status,
                        accountId: r.other_account_id,
                        exists: r.other_exists,
                    },
                })),
                total,
                truncated: total > rows.length,
            };
        };

        const [dependents, dependsOn] = await Promise.all([run('dependents'), run('dependsOn')]);

        const focusRow = await db.inventoryResource.findFirst({
            where: { tenantId: args.tenantId, resourceType: args.resourceType, resourceId: args.resourceId, isCurrent: true },
            select: { accountId: true },
        });
        const focusAccountId = focusRow?.accountId ?? null;

        const accountIds = [...new Set(
            [
                focusAccountId,
                ...dependents.edges.flatMap((e) => e.other.accountId),
                ...dependsOn.edges.flatMap((e) => e.other.accountId),
            ].filter((a): a is string => Boolean(a)),
        )];

        return { dependents, dependsOn, accountIds };
    }

    async expand(args: {
        tenantId: string;
        resourceType: string;
        resourceId: string;
        filters?: GraphFilters;
    }): Promise<ExpandResult> {
        const filters = args.filters ?? {};
        const db = getTenantClient(args.tenantId);

        const run = async (direction: 'dependents' | 'dependsOn'): Promise<DependencyDirection> => {
            const rows = await db.$queryRawUnsafe<RawEnrichedRow[]>(
                this.dependencySql(direction, filters),
                args.tenantId,
                args.resourceType,
                args.resourceId,
                EXPAND_CAP,
            );

            const total = rows.length ? Number(rows[0].total) : 0;
            return {
                edges: rows.map((r) => ({
                    relation: r.relation,
                    region: r.region,
                    other: {
                        resourceType: r.other_type,
                        resourceId: r.other_id,
                        name: r.other_name,
                        status: r.other_status,
                        accountId: r.other_account_id,
                        exists: r.other_exists,
                    },
                })),
                total,
                truncated: total > rows.length,
            };
        };

        const [dependents, dependsOn] = await Promise.all([run('dependents'), run('dependsOn')]);
        return { resourceType: args.resourceType, resourceId: args.resourceId, dependents, dependsOn };
    }

    async summarise(args: {
        tenantId: string;
        accountId?: string;
        filters?: GraphFilters;
    }): Promise<GraphSummary> {
        const filters = args.filters ?? {};
        const db = getTenantClient(args.tenantId);
        const scoped = Boolean(args.accountId);
        const accountPredicate = scoped ? 'AND "accountId" = $2' : '';
        const params = scoped ? [args.tenantId, args.accountId] : [args.tenantId];

        const resourceRows = await db.$queryRawUnsafe<Array<{ accountId: string; count: bigint }>>(
            `SELECT "accountId", count(*) AS count
             FROM inventory_resources i
             WHERE "tenantId" = $1 AND "isCurrent" = true
               ${accountPredicate}
               ${nodeTypeFilterSql('i', filters)}
             GROUP BY 1
             ORDER BY 1`,
            ...params,
        );

        const edgeRows = await db.$queryRawUnsafe<Array<{ accountId: string; count: bigint }>>(
            `SELECT "accountId", count(*) AS count
             FROM resource_edges e
             WHERE "tenantId" = $1 AND "isCurrent" = true
               ${accountPredicate}
               ${edgeFilterSql('e', filters)}
             GROUP BY 1
             ORDER BY 1`,
            ...params,
        );

        const edgeCounts = new Map(edgeRows.map((r) => [r.accountId, Number(r.count)]));
        const accountIds = new Set([...resourceRows.map((r) => r.accountId), ...edgeCounts.keys()]);
        const resourceCounts = new Map(resourceRows.map((r) => [r.accountId, Number(r.count)]));

        const accounts: AccountSummary[] = [...accountIds].sort().map((accountId) => ({
            accountId,
            resourceCount: resourceCounts.get(accountId) ?? 0,
            edgeCount: edgeCounts.get(accountId) ?? 0,
        }));

        if (!scoped) return { accounts, byResourceType: [], byRelation: [] };

        const byResourceType = await db.$queryRawUnsafe<Array<{ resourceType: string; count: bigint }>>(
            `SELECT "resourceType", count(*) AS count
             FROM inventory_resources i
             WHERE "tenantId" = $1 AND "isCurrent" = true AND "accountId" = $2
               ${nodeTypeFilterSql('i', filters)}
             GROUP BY 1 ORDER BY 2 DESC`,
            args.tenantId,
            args.accountId,
        );

        const byRelation = await db.$queryRawUnsafe<Array<{ relation: string; count: bigint }>>(
            `SELECT relation, count(*) AS count
             FROM resource_edges e
             WHERE "tenantId" = $1 AND "isCurrent" = true AND "accountId" = $2
               ${edgeFilterSql('e', filters)}
             GROUP BY 1 ORDER BY 2 DESC`,
            args.tenantId,
            args.accountId,
        );

        return {
            accounts,
            byResourceType: byResourceType.map((r) => ({ resourceType: r.resourceType, count: Number(r.count) })),
            byRelation: byRelation.map((r) => ({ relation: r.relation, count: Number(r.count) })),
        };
    }

    private async edgesAmong(
        tenantId: string,
        nodes: GraphNode[],
        filters: GraphFilters,
        limit: number,
    ): Promise<GraphEdgeLite[]> {
        if (!nodes.length) return [];

        const keys = [...new Set(nodes.map((n) => `${n.resourceType}\u0000${n.resourceId}`))];
        const types = keys.map((k) => k.split('\u0000')[0]);
        const ids = keys.map((k) => k.split('\u0000')[1]);

        return getTenantClient(tenantId).$queryRawUnsafe<GraphEdgeLite[]>(
            `WITH canvas AS (
                 SELECT * FROM unnest($2::text[], $3::text[]) AS n(node_type, node_id)
             )
             SELECT DISTINCT e."fromType", e."fromId", e.relation, e."toType", e."toId", e.region
             FROM resource_edges e
             JOIN canvas f ON f.node_type = e."fromType" AND f.node_id = e."fromId"
             JOIN canvas t ON t.node_type = e."toType"   AND t.node_id = e."toId"
             WHERE e."tenantId" = $1 AND e."isCurrent" = true
               ${edgeFilterSql('e', filters)}
             ORDER BY e."fromType", e."fromId", e.relation
             LIMIT $4`,
            tenantId,
            types,
            ids,
            limit,
        );
    }

    // A local node's edge can point at a resource inventory places under a different
    // account of the SAME tenant — a shared KMS key, a shared transit gateway. edgesAmong
    // drops that edge because its far endpoint is outside the node set. This resolves those
    // far endpoints against inventory (tenant-scoped, same as every other query here) and
    // returns them separately so callers can render them as external context rather than
    // silently losing the edge.
    private async externalContext(
        tenantId: string,
        ownAccountId: string,
        localNodes: GraphNode[],
        filters: GraphFilters,
        nodeCap: number,
        edgeCap: number,
    ): Promise<{ nodes: GraphNode[]; edges: GraphEdgeLite[]; truncated: boolean }> {
        if (!localNodes.length) return { nodes: [], edges: [], truncated: false };

        const keys = [...new Set(localNodes.map((n) => `${n.resourceType}\0${n.resourceId}`))];
        const nodeTypes = keys.map((k) => k.split('\0')[0]);
        const nodeIds = keys.map((k) => k.split('\0')[1]);
        const db = getTenantClient(tenantId);

        const farRows = await db.$queryRawUnsafe<Array<{
            resourceType: string;
            resourceId: string;
            name: string | null;
            status: string | null;
            accountId: string;
            region: string;
            total: bigint;
        }>>(
            `WITH canvas AS (
                 SELECT * FROM unnest($2::text[], $3::text[]) AS n(node_type, node_id)
             ),
             cross_far AS (
                 SELECT DISTINCT i."resourceType", i."resourceId", i."name", i."status", i."accountId", i.region
                 FROM resource_edges e
                 JOIN canvas c ON c.node_type = e."fromType" AND c.node_id = e."fromId"
                 JOIN inventory_resources i
                   ON i."tenantId" = $1 AND i."isCurrent" = true
                  AND i."resourceType" = e."toType" AND i."resourceId" = e."toId"
                  AND i."accountId" <> $4
                 WHERE e."tenantId" = $1 AND e."isCurrent" = true
                   -- The same resourceId can be inventoried under more than one account
                   -- (a lambda visible from every member account). If the far endpoint is
                   -- already in the local node set, edgesAmong already drew it — it is not
                   -- external just because some OTHER account also happens to have the id.
                   AND NOT EXISTS (SELECT 1 FROM canvas c2 WHERE c2.node_type = e."toType" AND c2.node_id = e."toId")
                   -- Nor is it external when the own account genuinely owns it too and the
                   -- structural cap simply left it out of the fetched node set.
                   AND NOT EXISTS (
                       SELECT 1 FROM inventory_resources own
                       WHERE own."tenantId" = $1 AND own."isCurrent" = true
                         AND own."resourceType" = e."toType" AND own."resourceId" = e."toId"
                         AND own."accountId" = $4
                   )
                   ${edgeFilterSql('e', filters)}
                 UNION
                 SELECT DISTINCT i."resourceType", i."resourceId", i."name", i."status", i."accountId", i.region
                 FROM resource_edges e
                 JOIN canvas c ON c.node_type = e."toType" AND c.node_id = e."toId"
                 JOIN inventory_resources i
                   ON i."tenantId" = $1 AND i."isCurrent" = true
                  AND i."resourceType" = e."fromType" AND i."resourceId" = e."fromId"
                  AND i."accountId" <> $4
                 WHERE e."tenantId" = $1 AND e."isCurrent" = true
                   AND NOT EXISTS (SELECT 1 FROM canvas c2 WHERE c2.node_type = e."fromType" AND c2.node_id = e."fromId")
                   AND NOT EXISTS (
                       SELECT 1 FROM inventory_resources own
                       WHERE own."tenantId" = $1 AND own."isCurrent" = true
                         AND own."resourceType" = e."fromType" AND own."resourceId" = e."fromId"
                         AND own."accountId" = $4
                   )
                   ${edgeFilterSql('e', filters)}
             )
             SELECT *, count(*) OVER () AS total FROM cross_far
             ORDER BY "resourceType", "resourceId"
             LIMIT $5`,
            tenantId,
            nodeTypes,
            nodeIds,
            ownAccountId,
            nodeCap,
        );

        if (!farRows.length) return { nodes: [], edges: [], truncated: false };

        const nodesTotal = Number(farRows[0].total);
        const nodes: GraphNode[] = farRows.map((r) => ({
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            name: r.name,
            status: r.status,
            accountId: r.accountId,
            region: r.region,
            external: true,
        }));

        const farTypes = farRows.map((r) => r.resourceType);
        const farIds = farRows.map((r) => r.resourceId);

        const edgeRows = await db.$queryRawUnsafe<Array<GraphEdgeLite & { total: bigint }>>(
            `WITH canvas AS (
                 SELECT * FROM unnest($2::text[], $3::text[]) AS n(node_type, node_id)
             ), external AS (
                 SELECT * FROM unnest($4::text[], $5::text[]) AS n(node_type, node_id)
             ),
             cross_edges AS (
                 SELECT DISTINCT e."fromType", e."fromId", e.relation, e."toType", e."toId", e.region
                 FROM resource_edges e
                 JOIN canvas c ON c.node_type = e."fromType" AND c.node_id = e."fromId"
                 JOIN external x ON x.node_type = e."toType" AND x.node_id = e."toId"
                 WHERE e."tenantId" = $1 AND e."isCurrent" = true
                   ${edgeFilterSql('e', filters)}
                 UNION
                 SELECT DISTINCT e."fromType", e."fromId", e.relation, e."toType", e."toId", e.region
                 FROM resource_edges e
                 JOIN canvas c ON c.node_type = e."toType" AND c.node_id = e."toId"
                 JOIN external x ON x.node_type = e."fromType" AND x.node_id = e."fromId"
                 WHERE e."tenantId" = $1 AND e."isCurrent" = true
                   ${edgeFilterSql('e', filters)}
             )
             SELECT *, count(*) OVER () AS total FROM cross_edges
             ORDER BY "fromType", "fromId", relation
             LIMIT $6`,
            tenantId,
            nodeTypes,
            nodeIds,
            farTypes,
            farIds,
            edgeCap,
        );

        const edgesTotal = edgeRows.length ? Number(edgeRows[0].total) : 0;

        return {
            nodes,
            edges: edgeRows.map(({ total: _total, ...e }) => e),
            truncated: nodesTotal > farRows.length || edgesTotal > edgeRows.length,
        };
    }

    async getSeed(args: {
        tenantId: string;
        accountId: string;
        filters?: GraphFilters;
        limit?: number;
    }): Promise<SeedResult> {
        const filters = { ...(args.filters ?? {}), accountId: args.accountId };
        const cap = clamp(args.limit ?? SEED_NODE_CAP, SEED_NODE_CAP);
        const db = getTenantClient(args.tenantId);

        const [{ count }] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT count(*) AS count
             FROM inventory_resources i
             WHERE "tenantId" = $1 AND "isCurrent" = true AND "accountId" = $2
               ${nodeTypeFilterSql('i', filters)}`,
            args.tenantId,
            args.accountId,
        );

        const totalVisibleNodes = Number(count);
        const mode: SeedResult['mode'] = totalVisibleNodes <= cap ? 'full-account' : 'structural';
        const structuralOnly = mode === 'structural' ? `AND i."resourceType" = ANY($3::text[])` : '';
        const params: unknown[] = [args.tenantId, args.accountId];
        if (mode === 'structural') params.push([...STRUCTURAL_TYPES]);
        params.push(cap);

        const nodes = await db.$queryRawUnsafe<GraphNode[]>(
            `SELECT "resourceType", "resourceId", "name", "status", "accountId", region
             FROM inventory_resources i
             WHERE "tenantId" = $1 AND "isCurrent" = true AND "accountId" = $2
               ${nodeTypeFilterSql('i', filters)}
               ${structuralOnly}
             ORDER BY "resourceType", "resourceId"
             LIMIT $${params.length}`,
            ...params,
        );

        // edgesAmong needs no account predicate: both endpoints are joined against a node
        // set that is already account-scoped, so a cross-account edge simply finds no
        // matching second endpoint and drops out.
        const edges = await this.edgesAmong(args.tenantId, nodes, filters, SEED_EDGE_CAP);

        // A dropped edge's far endpoint may still exist in this tenant's inventory under a
        // different account — a shared KMS key, a shared transit gateway. Resolve those and
        // add them back as external context rather than leaving the local node isolated.
        const external = await this.externalContext(
            args.tenantId,
            args.accountId,
            nodes,
            filters,
            EXTERNAL_NODE_CAP,
            EXTERNAL_EDGE_CAP,
        );

        return {
            mode,
            nodes: [...nodes, ...external.nodes],
            edges: [...edges, ...external.edges],
            totalVisibleNodes,
            truncated:
                mode === 'structural'
                || nodes.length < totalVisibleNodes
                || edges.length >= SEED_EDGE_CAP
                || external.truncated,
        };
    }

    async findPath(args: {
        tenantId: string;
        from: { resourceType: string; resourceId: string };
        to: { resourceType: string; resourceId: string };
        maxDepth?: number;
    }): Promise<PathResult> {
        // Hidden node types stay traversable — two Lambdas really are connected through a
        // shared IAM role. AWS-managed key aliases do not: one of them sits between 9,294
        // unrelated resources, so a path through it is an artefact, not a relationship.
        const filters: GraphFilters = { includeHiddenTypes: true, includeObservation: true };
        const db = getTenantClient(args.tenantId);

        // A neighbour fetch that hits its own cap would make a reachable goal look
        // unreachable. Record it so the caller learns the search was capped instead of
        // being told, confidently and wrongly, that nothing connects the two.
        const NEIGHBOUR_LIMIT = 50000;
        let neighbourTruncated = false;

        const neighbours = async (frontier: string[]) => {
            const types = frontier.map((k) => k.split('|')[0]);
            const ids = frontier.map((k) => k.slice(k.indexOf('|') + 1));

            const rows = await db.$queryRawUnsafe<Array<{ fromType: string; fromId: string; relation: string; toType: string; toId: string }>>(
                `WITH frontier AS (
                     SELECT * FROM unnest($2::text[], $3::text[]) AS n(node_type, node_id)
                 )
                 SELECT DISTINCT e."fromType", e."fromId", e.relation, e."toType", e."toId"
                 FROM resource_edges e
                 JOIN frontier f
                   ON (f.node_type = e."fromType" AND f.node_id = e."fromId")
                   OR (f.node_type = e."toType"   AND f.node_id = e."toId")
                 WHERE e."tenantId" = $1 AND e."isCurrent" = true
                   ${edgeFilterSql('e', filters)}
                 LIMIT $4`,
                args.tenantId,
                types,
                ids,
                NEIGHBOUR_LIMIT,
            );

            if (rows.length >= NEIGHBOUR_LIMIT) neighbourTruncated = true;

            return rows.map((r) => ({
                from: `${r.fromType}|${r.fromId}`,
                to: `${r.toType}|${r.toId}`,
                relation: r.relation,
            }));
        };

        const start = `${args.from.resourceType}|${args.from.resourceId}`;
        const goal = `${args.to.resourceType}|${args.to.resourceId}`;

        const { path, searchedDepth, frontierExhausted } = await bfsPath({
            start,
            goal,
            maxDepth: clamp(args.maxDepth ?? DEFAULT_PATH_DEPTH, MAX_DEPTH),
            frontierCap: 5000,
            neighbours,
        });

        const hops: PathHop[] = [];
        let cursor = start;
        for (const edge of path ?? []) {
            const next = edge.from === cursor ? edge.to : edge.from;
            const [resourceType, ...rest] = next.split('|');
            hops.push({ resourceType, resourceId: rest.join('|'), relation: edge.relation });
            cursor = next;
        }

        return {
            found: path !== null,
            from: args.from,
            to: args.to,
            hops,
            searchedDepth,
            frontierExhausted: frontierExhausted || neighbourTruncated,
        };
    }

    private predicateSql(predicate: GraphPredicate): { where: string; params: unknown[] } {
        switch (predicate.kind) {
            case 'by-type':
                return { where: `AND i."resourceType" = $2`, params: [predicate.resourceType] };
            case 'by-vpc':
                return {
                    where: `AND (
                        (i."resourceType" = 'ec2_vpcs' AND i."resourceId" = $2)
                        OR EXISTS (
                            SELECT 1 FROM resource_edges v
                            WHERE v."tenantId" = $1 AND v."isCurrent" = true
                              AND v.relation = 'in_vpc'
                              AND v."toType" = 'ec2_vpcs' AND v."toId" = $2
                              AND v."fromType" = i."resourceType" AND v."fromId" = i."resourceId"
                        )
                    )`,
                    params: [predicate.vpcId],
                };
            case 'internet-facing':
                return {
                    where: `AND (
                        (i."resourceType" = 'elbv2_load_balancers' AND i.metadata->>'scheme' = 'internet-facing')
                        OR i."resourceType" = 'cloudfront_distributions'
                    )`,
                    params: [],
                };
            case 'unmonitored':
                return {
                    where: `AND i."resourceType" = ANY($2::text[])
                            AND NOT EXISTS (
                                SELECT 1 FROM resource_edges m
                                WHERE m."tenantId" = $1 AND m."isCurrent" = true
                                  AND m.relation = 'monitors'
                                  AND m."toType" = i."resourceType" AND m."toId" = i."resourceId"
                            )`,
                    params: [[...MONITORABLE_TYPES]],
                };
            case 'isolated':
                return {
                    where: `AND NOT EXISTS (
                                SELECT 1 FROM resource_edges x
                                WHERE x."tenantId" = $1 AND x."isCurrent" = true
                                  AND ((x."fromType" = i."resourceType" AND x."fromId" = i."resourceId")
                                    OR (x."toType"   = i."resourceType" AND x."toId"   = i."resourceId"))
                            )`,
                    params: [],
                };
            default:
                throw new Error(`Unknown predicate: ${JSON.stringify(predicate)}`);
        }
    }

    async queryGraph(args: {
        tenantId: string;
        predicate: GraphPredicate;
        filters?: GraphFilters;
        limit?: number;
    }): Promise<QueryResult> {
        const filters = args.filters ?? {};
        const limit = clamp(args.limit ?? DEFAULT_QUERY_LIMIT, MAX_LIMIT);
        const db = getTenantClient(args.tenantId);
        const { where, params } = this.predicateSql(args.predicate);

        const accountClause = filters.accountId ? `AND i."accountId" = $${params.length + 2}` : '';
        if (filters.accountId) params.push(filters.accountId);

        // An explicit "give me iam_roles" must not be silenced by the display filter
        // that hides iam_roles/ssm_parameters from an unfiltered canvas.
        const namesHiddenType = args.predicate.kind === 'by-type'
            && (HIDDEN_NODE_TYPES as readonly string[]).includes(args.predicate.resourceType);
        const nodeFilters: GraphFilters = namesHiddenType ? { ...filters, includeHiddenTypes: true } : filters;

        const rows = await db.$queryRawUnsafe<Array<GraphNode & { total: bigint }>>(
            `SELECT i."resourceType", i."resourceId", i."name", i."status", i."accountId", i.region,
                    count(*) OVER () AS total
             FROM inventory_resources i
             WHERE i."tenantId" = $1 AND i."isCurrent" = true
               ${nodeTypeFilterSql('i', nodeFilters)}
               ${where}
               ${accountClause}
             ORDER BY i."resourceType", i."resourceId"
             LIMIT $${params.length + 2}`,
            args.tenantId,
            ...params,
            limit,
        );

        const nodes: GraphNode[] = rows.map(({ total, ...node }) => node);
        const total = rows.length ? Number(rows[0].total) : 0;
        const edges = await this.edgesAmong(args.tenantId, nodes, filters, SEED_EDGE_CAP);

        return {
            nodes,
            edges,
            total,
            truncated: total > nodes.length || edges.length >= SEED_EDGE_CAP,
        };
    }
}
