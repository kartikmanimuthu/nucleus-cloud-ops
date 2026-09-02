# Tenant Resource Graph — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI Ops agent three questions it cannot answer today — "how is A connected to B", "show me everything matching X", "what does this account look like" — by adding a multi-resource graph query service on top of the existing `resource_edges` table, and fix the `toAccountId` extraction gap that leaves every cross-account edge unlabelled.

**Architecture:** One query service in the existing resource-graph repository answers five operations over `resource_edges` and `inventory_resources`. Three thin agent tools and five thin `GET` routes wrap it. No UI in this phase. No new tables, no new infrastructure, no LLM involvement.

**Tech Stack:** TypeScript, PostgreSQL via Prisma (`$queryRawUnsafe` for traversal), LangChain `tool()` for agent tools, Next.js App Router API routes, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-tenant-resource-graph-design.md`

## Global Constraints

- **Multi-tenancy:** `$queryRawUnsafe` is NOT intercepted by the `getTenantClient` extension. Every raw statement must bind `tenantId` explicitly as a parameter. This is the only tenant guard.
- **Never interpolate user input into SQL.** Constants defined in code may be interpolated; anything reaching the code from a request or a model must be a bound parameter.
- **Depth cap:** `MAX_DEPTH = 5`, already defined in `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`. Reuse it; do not redefine.
- **Every query carries a `LIMIT`,** and every truncated result reports its true total. Silent truncation is a defect.
- **Display filters are not traversal filters.** `findPath` walks the full graph; hidden nodes come back marked, never omitted.
- **No comments unless the WHY is non-obvious.** No multi-line docstrings or comment blocks. Repo convention, enforced in review.
- **Indentation:** 4 spaces in `lib/` and service files, matching the surrounding resource-graph code.
- **Do not commit unless the user explicitly asks.** Each task's commit step is written out, but run it only on request.

---

### Task 1: Populate `toAccountId` for cross-account edges

`toAccountId` exists on `ResourceEdge`, is written by `edge-writer.ts`, and has a test — but `EdgeSpec` has no field to populate it and no deriver sets it, so the column is permanently null. All 194 peering/TGW edges in the measured database are unlabelled.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/types.ts` (add `accountPath` to `EdgeSpec`)
- Modify: `apps/workers/src/jobs/discovery/services/edge-extractor.ts` (resolve it)
- Modify: `apps/workers/src/jobs/discovery/services/edge-spec.ts` (3 entries)
- Modify: `apps/workers/src/jobs/discovery/index.ts:138` (pass the scanning account id)
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-extractor.test.ts`

**Interfaces:**
- Consumes: `resolvePath` from `./edge-path.js`, already exported.
- Produces: `extractEdges(resources: Resource[], scanningAccountId: string): ResourceEdge[]` — note the new second parameter; Task 1 is the only task that touches the workers package.

- [ ] **Step 1: Write the failing tests**

Append to `apps/workers/src/jobs/discovery/__tests__/edge-extractor.test.ts`, inside the existing `describe('extractEdges', ...)` block:

```typescript
    it('stamps toAccountId when the peer VPC is owned by another account', () => {
        const edges = extractEdges([
            r('ec2_vpc_peering_connections', 'pcx-1', {
                RequesterVpcInfo: { VpcId: 'vpc-req', OwnerId: '111111111111' },
                AccepterVpcInfo: { VpcId: 'vpc-acc', OwnerId: '222222222222' },
            }),
        ], '111111111111');

        const accepter = edges.find((e) => e.toId === 'vpc-acc');
        const requester = edges.find((e) => e.toId === 'vpc-req');
        expect(accepter?.toAccountId).toBe('222222222222');
        expect(requester?.toAccountId).toBeUndefined();
    });

    it('stamps toAccountId on a shared transit gateway attachment', () => {
        const edges = extractEdges([
            r('ec2_transit_gateway_attachments', 'tgw-attach-1', {
                TransitGatewayId: 'tgw-1',
                ResourceType: 'vpc',
                ResourceId: 'vpc-9',
                ResourceOwnerId: '333333333333',
            }),
        ], '111111111111');

        expect(edges.find((e) => e.toId === 'vpc-9')?.toAccountId).toBe('333333333333');
    });

    it('leaves toAccountId unset when the spec declares no accountPath', () => {
        const edges = extractEdges([
            r('ec2_instances', 'i-9', { VpcId: 'vpc-1' }),
        ], '111111111111');

        expect(edges[0].toAccountId).toBeUndefined();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-extractor.test.ts
```

Expected: FAIL — `extractEdges` currently takes one argument and never sets `toAccountId`.

- [ ] **Step 3: Add `accountPath` to the spec type**

In `apps/workers/src/jobs/discovery/types.ts`, add one field to `EdgeSpec`:

```typescript
export interface EdgeSpec {
  path: string;
  relation: string;
  toType: string;
  transform?: EdgeTransform;
  when?: { path: string; equals: string };
  // Where the far side's owning account sits in the describe response. Only set on
  // relations that genuinely cross accounts; resolved values equal to the scanning
  // account are dropped so `toAccountId` keeps meaning "cross-account".
  accountPath?: string;
}
```

- [ ] **Step 4: Resolve it in the extractor**

In `apps/workers/src/jobs/discovery/services/edge-extractor.ts`, change the signature and the spec loop. The `add` helper and everything else stays as it is:

```typescript
export function extractEdges(resources: Resource[], scanningAccountId: string): ResourceEdge[] {
```

Inside the `for (const spec of EDGE_SPECS[resource.resourceType] || [])` loop, immediately after the `spec.when` guard and before the value loop:

```typescript
            const owner = spec.accountPath
                ? resolvePath(rawObj, spec.accountPath).map(String).find((o) => o && o !== scanningAccountId)
                : undefined;
```

Then add it to the `add(...)` call in that loop:

```typescript
                    add({
                        fromType: resource.resourceType,
                        fromId: resource.resourceId,
                        relation: spec.relation,
                        toType: spec.toType,
                        toId,
                        ...(owner ? { toAccountId: owner } : {}),
                    }, resource.region);
```

- [ ] **Step 5: Declare the three account paths**

In `apps/workers/src/jobs/discovery/services/edge-spec.ts`, replace the two existing blocks:

```typescript
    ec2_vpc_peering_connections: [
        { path: 'RequesterVpcInfo.VpcId', relation: 'peers_vpc', toType: 'ec2_vpcs', accountPath: 'RequesterVpcInfo.OwnerId' },
        { path: 'AccepterVpcInfo.VpcId', relation: 'peers_vpc', toType: 'ec2_vpcs', accountPath: 'AccepterVpcInfo.OwnerId' },
    ],

    ec2_transit_gateway_attachments: [
        { path: 'TransitGatewayId', relation: 'attached_to_tgw', toType: 'ec2_transit_gateways' },
        { path: 'ResourceId', relation: 'attaches_vpc', toType: 'ec2_vpcs', when: { path: 'ResourceType', equals: 'vpc' }, accountPath: 'ResourceOwnerId' },
    ],
```

- [ ] **Step 6: Update the call site**

In `apps/workers/src/jobs/discovery/index.ts`, the `extractEdges` call inside `handleDiscoveryScan`:

```typescript
            const edges = extractEdges(result.resources, account.accountId);
```

- [ ] **Step 7: Run the whole discovery test suite**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery
```

Expected: PASS, including the pre-existing extractor, spec, path, writer and scan tests. If `edge-extractor.test.ts` reports arity errors on older tests, they call `extractEdges(resources)` with one argument — add `, 'test-account'` to each.

- [ ] **Step 8: Commit**

```bash
git add apps/workers/src/jobs/discovery
git commit -m "fix(discovery): stamp toAccountId on peering and transit gateway edges"
```

---

### Task 2: Graph query constants and shared types

Establishes the vocabulary every later task uses: the caps, the display filters, and the structural type list. Nothing else in Phase 1 compiles without it.

**Files:**
- Create: `apps/web-ui/lib/resource-graph/graph-constants.ts`
- Create: `apps/web-ui/lib/resource-graph/__tests__/graph-constants.test.ts`

**Interfaces:**
- Produces: `SEED_NODE_CAP`, `EXPAND_CAP`, `DEFAULT_PATH_DEPTH`, `STRUCTURAL_TYPES`, `HIDDEN_NODE_TYPES`, `OBSERVATION_RELATIONS`, `type GraphFilters`, `isHiddenType(resourceType, filters)`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/resource-graph/__tests__/graph-constants.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
    SEED_NODE_CAP,
    SEED_EDGE_CAP,
    STRUCTURAL_TYPES,
    HIDDEN_NODE_TYPES,
    OBSERVATION_RELATIONS,
    isHiddenType,
} from '../graph-constants';

describe('graph constants', () => {
    it('hides the two types that make up 59% of inventory', () => {
        expect(HIDDEN_NODE_TYPES).toContain('ssm_parameters');
        expect(HIDDEN_NODE_TYPES).toContain('iam_roles');
    });

    it('treats a hidden type as visible once the caller opts in', () => {
        expect(isHiddenType('iam_roles', {})).toBe(true);
        expect(isHiddenType('iam_roles', { includeHiddenTypes: true })).toBe(false);
        expect(isHiddenType('ec2_instances', {})).toBe(false);
    });

    it('lists only structural types, never leaf types', () => {
        expect(STRUCTURAL_TYPES).toContain('ec2_vpcs');
        expect(STRUCTURAL_TYPES).toContain('elbv2_load_balancers');
        expect(STRUCTURAL_TYPES).not.toContain('ec2_instances');
        expect(STRUCTURAL_TYPES).not.toContain('ec2_volumes');
    });

    it('caps the seed below the measured p90 account size with headroom', () => {
        expect(SEED_NODE_CAP).toBeGreaterThan(970);
    });

    it('caps seed edges above the largest measured account', () => {
        expect(SEED_EDGE_CAP).toBeGreaterThan(1725);
    });

    it('classes both observation relations together', () => {
        expect([...OBSERVATION_RELATIONS].sort()).toEqual(['monitors', 'notifies']);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/graph-constants.test.ts
```

Expected: FAIL — `Cannot find module '../graph-constants'`.

- [ ] **Step 3: Write the constants**

Create `apps/web-ui/lib/resource-graph/graph-constants.ts`:

```typescript
export const SEED_NODE_CAP = 1500;
// Deliberately not MAX_LIMIT: the measured p90 account carries 970 edges and the largest
// 1,725, so a 500-edge cap would silently drop edges from real accounts.
export const SEED_EDGE_CAP = 4000;
export const EXPAND_CAP = 50;
export const DEFAULT_PATH_DEPTH = 4;
export const DEFAULT_QUERY_LIMIT = 500;

// Measured 2026-08-25: 3,017 rows tenant-wide, roughly 30 per account. Leaf types
// (instances, volumes, network interfaces) are deliberately absent — they arrive by
// expansion, not by seeding.
export const STRUCTURAL_TYPES = [
    'ec2_vpcs',
    'ec2_subnets',
    'ec2_nat_gateways',
    'ec2_transit_gateways',
    'elbv2_load_balancers',
    'elbv2_targroups',
    'rds_db_instances',
    'rds_db_clusters',
    'docdb_db_clusters',
    'elasticache_cache_clusters',
    'ecs_clusters',
    'ecs_services',
    'eks_clusters',
    'autoscaling_auto_scaling_groups',
    'cloudfront_distributions',
] as const;

// 29,403 of 49,975 measured resources, almost none of them connected to anything a
// human would put on a canvas.
export const HIDDEN_NODE_TYPES = ['ssm_parameters', 'iam_roles'] as const;

export const OBSERVATION_RELATIONS = ['monitors', 'notifies'] as const;

// One node, alias/aws/ssm, carried 9,294 of 34,815 edges. Excluding AWS-managed key
// aliases drops the maximum degree in the graph from 9,294 to 237.
export const AWS_MANAGED_KEY_PREFIX = 'alias/aws/';

export interface GraphFilters {
    accountId?: string;
    region?: string;
    includeAwsManagedKeys?: boolean;
    includeHiddenTypes?: boolean;
    includeObservation?: boolean;
}

export function isHiddenType(resourceType: string, filters: GraphFilters): boolean {
    if (filters.includeHiddenTypes) return false;
    return (HIDDEN_NODE_TYPES as readonly string[]).includes(resourceType);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/graph-constants.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/resource-graph/graph-constants.ts apps/web-ui/lib/resource-graph/__tests__/graph-constants.test.ts
git commit -m "feat(resource-graph): add graph query constants and display filters"
```

---

### Task 3: SQL fragment builder for display filters

Every later operation needs the same three predicates. Building them once, tested in isolation, is what stops five copies drifting apart.

**Files:**
- Create: `apps/web-ui/lib/db/repositories/resource-graph/filter-sql.ts`
- Test: `apps/web-ui/tests/resource-graph/filter-sql.test.ts`

**Interfaces:**
- Consumes: `GraphFilters`, `HIDDEN_NODE_TYPES`, `OBSERVATION_RELATIONS`, `AWS_MANAGED_KEY_PREFIX` from `@/lib/resource-graph/graph-constants`.
- Produces:
  - `edgeFilterSql(alias: string, filters: GraphFilters): string` — predicates on a `resource_edges` alias, each prefixed with `AND`, or `''` when nothing applies.
  - `nodeTypeFilterSql(alias: string, filters: GraphFilters): string` — predicate on an `inventory_resources` alias.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/tests/resource-graph/filter-sql.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { edgeFilterSql, nodeTypeFilterSql } from '@/lib/db/repositories/resource-graph/filter-sql';

describe('edgeFilterSql', () => {
    it('excludes AWS-managed key aliases by default', () => {
        expect(edgeFilterSql('e', {})).toContain(`'alias/aws/%'`);
    });

    it('drops the key predicate when the caller opts in', () => {
        expect(edgeFilterSql('e', { includeAwsManagedKeys: true })).not.toContain(`'alias/aws/%'`);
    });

    it('excludes observation relations by default and includes them on request', () => {
        expect(edgeFilterSql('e', {})).toContain('monitors');
        expect(edgeFilterSql('e', { includeObservation: true })).not.toContain('monitors');
    });

    it('qualifies every predicate with the given alias', () => {
        const sql = edgeFilterSql('xyz', {});
        expect(sql).toContain('xyz."toType"');
        expect(sql).not.toContain('e."toType"');
    });

    it('returns an empty string when every filter is disabled', () => {
        expect(edgeFilterSql('e', {
            includeAwsManagedKeys: true,
            includeObservation: true,
        })).toBe('');
    });
});

describe('nodeTypeFilterSql', () => {
    it('excludes hidden types by default', () => {
        const sql = nodeTypeFilterSql('i', {});
        expect(sql).toContain('ssm_parameters');
        expect(sql).toContain('iam_roles');
        expect(sql).toContain('i."resourceType"');
    });

    it('returns an empty string when hidden types are included', () => {
        expect(nodeTypeFilterSql('i', { includeHiddenTypes: true })).toBe('');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/filter-sql.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the builder**

Create `apps/web-ui/lib/db/repositories/resource-graph/filter-sql.ts`:

```typescript
import {
    AWS_MANAGED_KEY_PREFIX,
    HIDDEN_NODE_TYPES,
    OBSERVATION_RELATIONS,
    type GraphFilters,
} from '@/lib/resource-graph/graph-constants';

// Every value interpolated here is a module constant, never caller input. Aliases are
// supplied by this repository's own SQL, not by a request.
const quoteList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

export function edgeFilterSql(alias: string, filters: GraphFilters): string {
    const parts: string[] = [];

    if (!filters.includeAwsManagedKeys) {
        parts.push(`AND NOT (${alias}."toType" = 'kms_keys' AND ${alias}."toId" LIKE '${AWS_MANAGED_KEY_PREFIX}%')`);
    }

    if (!filters.includeObservation) {
        parts.push(`AND ${alias}.relation NOT IN (${quoteList(OBSERVATION_RELATIONS)})`);
    }

    return parts.join('\n              ');
}

export function nodeTypeFilterSql(alias: string, filters: GraphFilters): string {
    if (filters.includeHiddenTypes) return '';
    return `AND ${alias}."resourceType" NOT IN (${quoteList(HIDDEN_NODE_TYPES)})`;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/filter-sql.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/db/repositories/resource-graph/filter-sql.ts apps/web-ui/tests/resource-graph/filter-sql.test.ts
git commit -m "feat(resource-graph): add reusable display-filter SQL fragments"
```

---

### Task 4: `summarise` — counts for the agent and the account grid

The simplest operation, and the one that proves the service shape before the traversal work lands.

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts` (add types + method)
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts` (implement)
- Test: `apps/web-ui/tests/resource-graph/repository.integration.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `edgeFilterSql`, `nodeTypeFilterSql` from Task 3; `GraphFilters` from Task 2.
- Produces:

```typescript
export interface AccountSummary { accountId: string; resourceCount: number; edgeCount: number; }
export interface GraphSummary {
    accounts: AccountSummary[];
    byResourceType: Array<{ resourceType: string; count: number }>;
    byRelation: Array<{ relation: string; count: number }>;
}
summarise(args: { tenantId: string; accountId?: string; filters?: GraphFilters }): Promise<GraphSummary>
```

`byResourceType` and `byRelation` are empty arrays unless `accountId` is given.

- [ ] **Step 1: Write the failing test**

Append to `apps/web-ui/tests/resource-graph/repository.integration.test.ts`, after the existing describe blocks. It reuses the fixture graph and `TENANT` already defined at the top of that file:

```typescript
describe.skipIf(!HAS_DB)('summarise', () => {
    it('returns one row per account with resource and edge counts', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.summarise({ tenantId: TENANT });

        expect(result.accounts.length).toBeGreaterThan(0);
        for (const account of result.accounts) {
            expect(typeof account.accountId).toBe('string');
            expect(account.edgeCount).toBeGreaterThanOrEqual(0);
        }
        expect(result.byResourceType).toEqual([]);
        expect(result.byRelation).toEqual([]);
    });

    it('breaks down by type and relation when scoped to one account', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const all = await repo.summarise({ tenantId: TENANT });
        const accountId = all.accounts[0].accountId;

        const scoped = await repo.summarise({ tenantId: TENANT, accountId });

        expect(scoped.accounts).toHaveLength(1);
        expect(scoped.accounts[0].accountId).toBe(accountId);
        expect(scoped.byRelation.length).toBeGreaterThan(0);
        expect(scoped.byRelation.every((r) => r.count > 0)).toBe(true);
    });

    it('never counts another tenant', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const mine = await repo.summarise({ tenantId: TENANT });
        const theirs = await repo.summarise({ tenantId: OTHER_TENANT });

        const myIds = mine.accounts.map((a) => a.accountId);
        const theirEdges = theirs.accounts.reduce((n, a) => n + a.edgeCount, 0);
        const myEdges = mine.accounts.reduce((n, a) => n + a.edgeCount, 0);
        expect(myEdges).toBeGreaterThan(0);
        expect(myIds.length).toBeGreaterThan(0);
        expect(theirEdges).not.toBe(myEdges);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/repository.integration.test.ts -t summarise
```

Expected: FAIL — `repo.summarise is not a function`. If every test reports as skipped, the local Postgres container is not running: `docker compose up -d postgres`.

- [ ] **Step 3: Add the types and the method to the interface**

Append to `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`, and add the method to `IResourceGraphRepository`:

```typescript
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
```

```typescript
    summarise(args: {
        tenantId: string;
        accountId?: string;
        filters?: GraphFilters;
    }): Promise<GraphSummary>;
```

Add the import at the top of the file:

```typescript
import type { GraphFilters } from '@/lib/resource-graph/graph-constants';
```

- [ ] **Step 5: Implement it**

In `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`, add the imports:

```typescript
import { edgeFilterSql, nodeTypeFilterSql } from './filter-sql';
import type { GraphFilters } from '@/lib/resource-graph/graph-constants';
```

and add the method to the class:

```typescript
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
```

Add `AccountSummary` and `GraphSummary` to the existing type import from `./interface`.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/repository.integration.test.ts
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/db/repositories/resource-graph apps/web-ui/tests/resource-graph
git commit -m "feat(resource-graph): add summarise for per-account graph counts"
```

---

### Task 5: `edgesAmong` and `getSeed` — the opening canvas for one account

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`
- Test: `apps/web-ui/tests/resource-graph/repository.integration.test.ts`

**Interfaces:**
- Consumes: Task 3's fragments, Task 2's `SEED_NODE_CAP` and `STRUCTURAL_TYPES`.
- Produces:

```typescript
export interface GraphNode {
    resourceType: string;
    resourceId: string;
    name: string | null;
    status: string | null;
    accountId: string;
    region: string;
}
export interface GraphEdgeLite {
    fromType: string; fromId: string; relation: string;
    toType: string; toId: string; region: string;
}
export interface SeedResult {
    mode: 'full-account' | 'structural';
    nodes: GraphNode[];
    edges: GraphEdgeLite[];
    totalVisibleNodes: number;
    truncated: boolean;
}
getSeed(args: { tenantId: string; accountId: string; filters?: GraphFilters; limit?: number }): Promise<SeedResult>
```

`edgesAmong` is a private method on the class, reused by Task 7.

- [ ] **Step 1: Add a canvas fixture under a second account**

The existing fixture deliberately seeds `resource_edges` for `acc-1` while leaving those
resources OUT of `inventory_resources` — two existing tests assert `exists === false` on
them, because dangling edges are a documented property of this schema. Adding inventory
rows for `i-1`/`vpc-1` would break those tests and delete the property they protect.

So `getSeed` and `queryGraph` get their own account instead. Add this helper next to
`seedInventory`, and call it from `beforeAll` immediately after `await seedInventory();`.
`afterAll` already deletes by `tenantId`, so it needs no change.

```typescript
// getSeed and queryGraph read inventory_resources and resource_edges together, so they
// need an account whose nodes exist in BOTH. acc-1 must stay half-seeded: its dangling
// edges are what the exists:false tests assert.
const CANVAS_ACCOUNT = 'acc-2';

async function seedCanvas() {
    const db = getPrismaClient();
    const nodes: Array<[string, string]> = [
        ['ec2_vpcs', 'canvas-vpc-1'],
        ['ec2_subnets', 'canvas-subnet-1'],
        ['ec2_instances', 'canvas-i-1'],
        ['elbv2_load_balancers', 'canvas-lb-1'],
        ['ec2_volumes', 'canvas-vol-1'],
        ['iam_roles', 'canvas-role-1'],
    ];
    for (const [resourceType, resourceId] of nodes) {
        await db.$executeRawUnsafe(
            `INSERT INTO inventory_resources
               (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
             VALUES ($1, $2, '${CANVAS_ACCOUNT}', 'us-east-1', $3, $4, true, NOW())`,
            `${TENANT}-canvas-${resourceId}`,
            TENANT,
            resourceType,
            resourceId,
        );
    }

    const edges: Array<[string, string, string, string, string]> = [
        ['ec2_instances', 'canvas-i-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1'],
        ['ec2_instances', 'canvas-i-1', 'in_subnet', 'ec2_subnets', 'canvas-subnet-1'],
        ['ec2_subnets', 'canvas-subnet-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1'],
        ['elbv2_load_balancers', 'canvas-lb-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1'],
        ['ec2_volumes', 'canvas-vol-1', 'attached_to', 'ec2_instances', 'canvas-i-1'],
        ['ec2_instances', 'canvas-i-1', 'uses_iam_role', 'iam_roles', 'canvas-role-1'],
    ];
    for (const [i, [fromType, fromId, relation, toType, toId]] of edges.entries()) {
        await db.$executeRawUnsafe(
            `INSERT INTO resource_edges
               (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
                "toType", "toId", "isCurrent", "updatedAt")
             VALUES ($1, $2, '${CANVAS_ACCOUNT}', 'us-east-1', $3, $4, $5, $6, $7, true, NOW())`,
            `${TENANT}-canvas-edge-${i}`,
            TENANT,
            fromType,
            fromId,
            relation,
            toType,
            toId,
        );
    }
}
```

Five of the six nodes are visible (`iam_roles` is hidden by default), and five of the six
edges have both endpoints among those five — the `uses_iam_role` edge drops out because its
target is hidden. Those two facts are what the tests below actually assert.

- [ ] **Step 2: Write the failing test**

Append to `apps/web-ui/tests/resource-graph/repository.integration.test.ts`:

```typescript
describe.skipIf(!HAS_DB)('getSeed', () => {
    it('returns the whole account when it is under the cap, and says so', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });

        expect(seed.mode).toBe('full-account');
        expect(seed.nodes).toHaveLength(5);
        expect(seed.totalVisibleNodes).toBe(5);
        expect(seed.truncated).toBe(false);
    });

    it('returns only structural types once the account exceeds the cap', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT, limit: 1 });

        expect(seed.mode).toBe('structural');
        expect(seed.nodes).toHaveLength(1);
        expect(STRUCTURAL_TYPES).toContain(seed.nodes[0].resourceType);
        expect(seed.truncated).toBe(true);
    });

    it('drops the edge whose far endpoint is a hidden node', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });
        const present = new Set(seed.nodes.map((n) => `${n.resourceType}|${n.resourceId}`));

        expect(seed.edges).toHaveLength(5);
        expect(seed.edges.some((e) => e.relation === 'uses_iam_role')).toBe(false);
        for (const edge of seed.edges) {
            expect(present.has(`${edge.fromType}|${edge.fromId}`)).toBe(true);
            expect(present.has(`${edge.toType}|${edge.toId}`)).toBe(true);
        }
    });

    it('excludes hidden node types unless asked', async () => {
        const repo = new ResourceGraphPostgresRepository();

        const hidden = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });
        expect(hidden.nodes.some((n) => n.resourceType === 'iam_roles')).toBe(false);

        const shown = await repo.getSeed({
            tenantId: TENANT,
            accountId: CANVAS_ACCOUNT,
            filters: { includeHiddenTypes: true },
        });
        expect(shown.nodes.some((n) => n.resourceId === 'canvas-role-1')).toBe(true);
        expect(shown.edges.some((e) => e.relation === 'uses_iam_role')).toBe(true);
    });
});

Add `STRUCTURAL_TYPES` to the test file's imports from `@/lib/resource-graph/graph-constants`.
```

- [ ] **Step 4: Run it to verify it fails**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/repository.integration.test.ts -t getSeed
```

Expected: FAIL — `repo.getSeed is not a function`.

- [ ] **Step 4: Add the types to the interface**

Append to `apps/web-ui/lib/db/repositories/resource-graph/interface.ts` and add the method to `IResourceGraphRepository`:

```typescript
export interface GraphNode {
    resourceType: string;
    resourceId: string;
    name: string | null;
    status: string | null;
    accountId: string;
    region: string;
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
```

```typescript
    getSeed(args: {
        tenantId: string;
        accountId: string;
        filters?: GraphFilters;
        limit?: number;
    }): Promise<SeedResult>;
```

- [ ] **Step 5: Implement `edgesAmong` and `getSeed`**

Add to `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`. Import `SEED_NODE_CAP` and `STRUCTURAL_TYPES` from `@/lib/resource-graph/graph-constants`, and the new types from `./interface`:

```typescript
    private async edgesAmong(
        tenantId: string,
        nodes: GraphNode[],
        filters: GraphFilters,
        limit: number,
    ): Promise<GraphEdgeLite[]> {
        if (!nodes.length) return [];

        const types = nodes.map((n) => n.resourceType);
        const ids = nodes.map((n) => n.resourceId);

        return getTenantClient(tenantId).$queryRawUnsafe<GraphEdgeLite[]>(
            `WITH canvas AS (
                 SELECT * FROM unnest($2::text[], $3::text[]) AS n(node_type, node_id)
             )
             SELECT e."fromType", e."fromId", e.relation, e."toType", e."toId", e.region
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

        return {
            mode,
            nodes,
            edges,
            totalVisibleNodes,
            truncated:
                mode === 'structural'
                || nodes.length < totalVisibleNodes
                || edges.length >= SEED_EDGE_CAP,
        };
    }
```

- [ ] **Step 6: Run it to verify it passes**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/repository.integration.test.ts
```

Expected: PASS, all tests in the file. The two pre-existing `exists === false` tests must
still pass — they are what the separate canvas account exists to protect.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/db/repositories/resource-graph apps/web-ui/tests/resource-graph
git commit -m "feat(resource-graph): add getSeed with full-account and structural modes"
```

---

### Task 6: `expand` — one node's neighbours, capped with a true total

Reuses the `dependencySql` builder that already serves `getResourceDependencies`, rather than writing a fourth near-identical query. `getResourceDependencies` keeps its current unfiltered behaviour so the Dependencies tab is untouched.

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts:123` (`dependencySql` gains a filters parameter)
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`
- Test: `apps/web-ui/tests/resource-graph/repository.integration.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface ExpandResult {
    resourceType: string;
    resourceId: string;
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
}
expand(args: { tenantId: string; resourceType: string; resourceId: string; filters?: GraphFilters }): Promise<ExpandResult>
```

`DependencyDirection` already exists and already carries `{ edges, total, truncated }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web-ui/tests/resource-graph/repository.integration.test.ts`:

```typescript
describe.skipIf(!HAS_DB)('expand', () => {
    it('returns both directions for the fixture instance', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.expand({
            tenantId: TENANT,
            resourceType: 'ec2_instances',
            resourceId: 'i-1',
        });

        expect(result.dependsOn.edges.some((e) => e.other.resourceId === 'vpc-1')).toBe(true);
        expect(result.dependents.edges.some((e) => e.other.resourceId === 'vol-1')).toBe(true);
    });

    it('reports the true total even when the cap truncates', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.expand({
            tenantId: TENANT,
            resourceType: 'ec2_vpcs',
            resourceId: 'vpc-1',
        });

        expect(result.dependents.total).toBeGreaterThanOrEqual(result.dependents.edges.length);
        if (result.dependents.truncated) {
            expect(result.dependents.total).toBeGreaterThan(result.dependents.edges.length);
        }
    });

    it('leaves getResourceDependencies unfiltered', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const deps = await repo.getResourceDependencies({
            tenantId: TENANT,
            resourceType: 'ec2_instances',
            resourceId: 'i-1',
        });

        expect(deps.dependsOn.edges.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/repository.integration.test.ts -t expand
```

Expected: FAIL — `repo.expand is not a function`.

- [ ] **Step 3: Give `dependencySql` a filters parameter**

In `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`, change the signature and inject the fragment. Everything else in the method body is unchanged:

```typescript
    private dependencySql(direction: 'dependents' | 'dependsOn', filters: GraphFilters = {}): string {
```

and add the fragment to the `WHERE` clause, immediately after the `AND e."${nearId}"   = $3` line:

```
              ${edgeFilterSql('e', filters)}
```

`edgeFilterSql` is restrictive-by-default — each clause is guarded by `if (!filters.includeX)`,
so `edgeFilterSql('e', {})` emits BOTH exclusions rather than an empty string. `dependencySql`
never called it before this task, so `getResourceDependencies` was genuinely unfiltered; letting
it inherit the `{}` default would silently drop 12,997 of 34,815 measured edges (37%) from the
shipped Dependencies tab. It must therefore pass explicit permissive filters:

```typescript
                this.dependencySql(direction, { includeAwsManagedKeys: true, includeObservation: true }),
```

The `filters: GraphFilters = {}` default stays, because the restrictive default is the correct
one for `expand`. The two behaviours are pinned apart by a regression test that seeds a `monitors`
edge and an AWS-managed `encrypted_with` edge, then asserts `getResourceDependencies` returns them
and `expand` does not — the shared fixture contains neither, which is why 52 tests passed while
the behaviour changed.

- [ ] **Step 4: Add the type and implement `expand`**

Append to `interface.ts` and add the method to `IResourceGraphRepository`:

```typescript
export interface ExpandResult {
    resourceType: string;
    resourceId: string;
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
}
```

```typescript
    expand(args: {
        tenantId: string;
        resourceType: string;
        resourceId: string;
        filters?: GraphFilters;
    }): Promise<ExpandResult>;
```

Then in `postgres.ts`, importing `EXPAND_CAP`:

```typescript
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
```

- [ ] **Step 5: Run it to verify it passes**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/
```

Expected: PASS. The `getResourceDependencies` tests must still pass unchanged — that is what proves the shared builder did not regress the Dependencies tab.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/db/repositories/resource-graph apps/web-ui/tests/resource-graph
git commit -m "feat(resource-graph): add capped single-node expand sharing the dependency query"
```

---

### Task 7: `findPath` — the chain between two resources

Breadth-first search in TypeScript over a batched neighbour query, not a recursive CTE. A recursive CTE that carries a path array fans out exponentially and cannot be bounded cleanly; a level-by-level BFS with an explicit frontier cap is predictable, and it is the only operation whose correctness is worth unit-testing without a database.

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`
- Create: `apps/web-ui/lib/resource-graph/bfs.ts` (the pure search, database-free)
- Test: `apps/web-ui/tests/resource-graph/bfs.test.ts`
- Test: `apps/web-ui/tests/resource-graph/repository.integration.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface PathHop { resourceType: string; resourceId: string; relation: string; }
export interface PathResult {
    found: boolean;
    from: { resourceType: string; resourceId: string };
    to: { resourceType: string; resourceId: string };
    hops: PathHop[];
    searchedDepth: number;
    frontierExhausted: boolean;
}
findPath(args: { tenantId: string; from: {...}; to: {...}; maxDepth?: number }): Promise<PathResult>
```

- Produces from `bfs.ts`:

```typescript
export type NodeKey = string;                       // `${resourceType}|${resourceId}`
export interface BfsEdge { from: NodeKey; to: NodeKey; relation: string; }
export async function bfsPath(args: {
    start: NodeKey;
    goal: NodeKey;
    maxDepth: number;
    frontierCap: number;
    neighbours: (frontier: NodeKey[]) => Promise<BfsEdge[]>;
}): Promise<{ path: BfsEdge[] | null; searchedDepth: number; frontierExhausted: boolean }>
```

- [ ] **Step 1: Write the failing test for the pure search**

Create `apps/web-ui/tests/resource-graph/bfs.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/bfs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure search**

Create `apps/web-ui/lib/resource-graph/bfs.ts`:

```typescript
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

        for (const edge of edges) {
            const inFrontier = frontier.includes(edge.from) ? edge.from : frontier.includes(edge.to) ? edge.to : null;
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
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/bfs.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing integration test**

Append to `apps/web-ui/tests/resource-graph/repository.integration.test.ts`:

```typescript
describe.skipIf(!HAS_DB)('findPath', () => {
    it('finds the chain from the instance to the load balancer', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.findPath({
            tenantId: TENANT,
            from: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            to: { resourceType: 'elbv2_load_balancers', resourceId: 'arn:lb' },
        });

        expect(result.found).toBe(true);
        expect(result.hops.length).toBeGreaterThan(0);
        expect(result.hops[result.hops.length - 1].resourceId).toBe('arn:lb');
    });

    it('says plainly that there is no path rather than inventing one', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.findPath({
            tenantId: TENANT,
            from: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            to: { resourceType: 's3_buckets', resourceId: 'no-such-bucket' },
        });

        expect(result.found).toBe(false);
        expect(result.hops).toEqual([]);
    });

    it('does not cross the tenant boundary', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.findPath({
            tenantId: OTHER_TENANT,
            from: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            to: { resourceType: 'elbv2_load_balancers', resourceId: 'arn:lb' },
        });

        expect(result.found).toBe(false);
    });
});
```

- [ ] **Step 6: Implement `findPath` on the repository**

Add the types to `interface.ts` and the method to `IResourceGraphRepository`:

```typescript
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
```

```typescript
    findPath(args: {
        tenantId: string;
        from: { resourceType: string; resourceId: string };
        to: { resourceType: string; resourceId: string };
        maxDepth?: number;
    }): Promise<PathResult>;
```

Then in `postgres.ts`, importing `bfsPath` and `DEFAULT_PATH_DEPTH`:

```typescript
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
```

Note `rest.join('|')`: load balancer and target group ids are ARNs, which contain no `|`, but joining rather than taking `[1]` keeps the split lossless if one ever does.

- [ ] **Step 7: Run everything**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/resource-graph/bfs.ts apps/web-ui/lib/db/repositories/resource-graph apps/web-ui/tests/resource-graph
git commit -m "feat(resource-graph): add findPath via bounded breadth-first search"
```

---

### Task 8: `queryGraph` — five fixed predicates

Not a query language. Five named predicates, each a hand-written SQL body, chosen because they are the five questions that came up while designing this and each maps to a real column or edge.

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts` (fix `edgesAmong`, then add `queryGraph`)
- Modify: `apps/web-ui/lib/resource-graph/graph-constants.ts` (add `MONITORABLE_TYPES`, `GraphPredicate`)
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`
- Test: `apps/web-ui/tests/resource-graph/repository.integration.test.ts`

**Interfaces:**
- Produces:

```typescript
export type GraphPredicate =
    | { kind: 'by-type'; resourceType: string }
    | { kind: 'by-vpc'; vpcId: string }
    | { kind: 'internet-facing' }
    | { kind: 'unmonitored' }
    | { kind: 'isolated' };

export interface QueryResult {
    nodes: GraphNode[];
    edges: GraphEdgeLite[];
    total: number;
    truncated: boolean;
}
queryGraph(args: { tenantId: string; predicate: GraphPredicate; filters?: GraphFilters; limit?: number }): Promise<QueryResult>
```

- [ ] **Step 1: Fix `edgesAmong` for multi-account node sets**

`getSeed` calls `edgesAmong` with a single account's nodes, where
`inventory_resources` is unique on `(tenantId, accountId, resourceType, resourceId)` and
duplicate `(resourceType, resourceId)` pairs are therefore impossible. `queryGraph` is the
first caller whose node set can span accounts, and there the same pair repeats constantly.
Measured on the real estate: `lambda_functions/aws-controltower-NotificationForwarder`
exists in 95 accounts, `ec2_transit_gateways/tgw-0aacc12b5ee138da9` in 42.

Left unfixed, a node set containing one pair 95 times makes each matching edge join
95 x 95 = 9,025 times. That blows the 4,000-edge cap on a single pair, fills the canvas
with duplicates, and reports `truncated: true` for a query that was never large.

Two changes to the existing `edgesAmong`. First, de-duplicate the node keys before building
the arrays — this is what stops the join exploding rather than just hiding the result:

```typescript
        const keys = [...new Set(nodes.map((n) => `${n.resourceType}\u0000${n.resourceId}`))];
        const types = keys.map((k) => k.split('\u0000')[0]);
        const ids = keys.map((k) => k.split('\u0000')[1]);
```

replacing the two existing `nodes.map(...)` lines. A NUL separator is used because AWS
resource ids contain every printable character including `|` and `/`.

Second, add `DISTINCT` to that query's SELECT, because one logical relationship can legitimately
hold a row under more than one account — a shared transit gateway attachment does:

```sql
             SELECT DISTINCT e."fromType", e."fromId", e.relation, e."toType", e."toId", e.region
```

- [ ] **Step 2: Add the constants**

Append to `apps/web-ui/lib/resource-graph/graph-constants.ts`:

```typescript
// The types CloudWatch alarms can name in a Dimension, mirroring DIMENSION_TO_TYPE in
// the workers' edge-derivers. A type absent here cannot be "unmonitored", it is simply
// not monitorable, and reporting it as a gap would be noise.
export const MONITORABLE_TYPES = [
    'ec2_instances',
    'rds_db_instances',
    'rds_db_clusters',
    'autoscaling_auto_scaling_groups',
    'lambda_functions',
    'dynamodb_tables',
    'elasticache_cache_clusters',
    's3_buckets',
    'efs_file_systems',
    'sqs_queues',
    'ecs_clusters',
] as const;

export type GraphPredicate =
    | { kind: 'by-type'; resourceType: string }
    | { kind: 'by-vpc'; vpcId: string }
    | { kind: 'internet-facing' }
    | { kind: 'unmonitored' }
    | { kind: 'isolated' };
```

- [ ] **Step 3: Write the failing test**

First extend the fixture, next to `seedCanvas`, and call it from `beforeAll` immediately
after `await seedCanvas();`. It deliberately reuses `canvas-i-1` and `canvas-vpc-1` under a
different account, which is exactly the shape Step 1 fixes:

```typescript
// The same resourceType+resourceId under a second account: real estates do this constantly
// (one Control Tower lambda spans 95 accounts). Without deduped node keys the joins in
// edgesAmong multiply instead of matching.
const DUPLICATE_ACCOUNT = 'acc-3';

async function seedDuplicateAccount() {
    const db = getPrismaClient();
    for (const [resourceType, resourceId] of [['ec2_vpcs', 'canvas-vpc-1'], ['ec2_instances', 'canvas-i-1']]) {
        await db.$executeRawUnsafe(
            `INSERT INTO inventory_resources
               (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
             VALUES ($1, $2, '${DUPLICATE_ACCOUNT}', 'us-east-1', $3, $4, true, NOW())`,
            `${TENANT}-dup-${resourceId}`,
            TENANT,
            resourceType,
            resourceId,
        );
    }
    await db.$executeRawUnsafe(
        `INSERT INTO resource_edges
           (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
            "toType", "toId", "isCurrent", "updatedAt")
         VALUES ($1, $2, '${DUPLICATE_ACCOUNT}', 'us-east-1',
                 'ec2_instances', 'canvas-i-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1', true, NOW())`,
        `${TENANT}-dup-edge-0`,
        TENANT,
    );
}
```

Then append the tests. NEST this describe INSIDE the outer
`describe.skipIf(!HAS_DB)('ResourceGraphPostgresRepository (real Postgres)')` block, beside
the existing `summarise` / `getSeed` / `expand` blocks — a top-level sibling runs after that
suite's `afterAll` has wiped the fixture and disconnected Prisma, so every assertion fails:

```typescript
    describe.skipIf(!HAS_DB)('queryGraph', () => {
    it('returns nodes of one type plus the edges among them', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.queryGraph({
            tenantId: TENANT,
            predicate: { kind: 'by-type', resourceType: 'ec2_instances' },
        });

        expect(result.nodes.every((n) => n.resourceType === 'ec2_instances')).toBe(true);
        const present = new Set(result.nodes.map((n) => `${n.resourceType}|${n.resourceId}`));
        for (const e of result.edges) {
            expect(present.has(`${e.fromType}|${e.fromId}`)).toBe(true);
        }
    });

    it('returns everything sitting in one vpc, including the vpc itself', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.queryGraph({
            tenantId: TENANT,
            predicate: { kind: 'by-vpc', vpcId: 'canvas-vpc-1' },
        });

        const ids = result.nodes.map((n) => n.resourceId);
        expect(ids).toContain('canvas-vpc-1');
        expect(ids).toContain('canvas-i-1');
        expect(ids).toContain('canvas-subnet-1');
        expect(ids).toContain('canvas-lb-1');
        // vpc-1 exists in resource_edges but never in inventory_resources, so a resource
        // whose only vpc is acc-1's dangling vpc must not appear here.
        expect(ids).not.toContain('i-1');
    });

    it('reports the true total when the limit truncates', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.queryGraph({
            tenantId: TENANT,
            predicate: { kind: 'by-type', resourceType: 'ec2_instances' },
            limit: 1,
        });

        expect(result.nodes.length).toBeLessThanOrEqual(1);
        if (result.total > 1) expect(result.truncated).toBe(true);
    });

    it('returns each edge once when a resource id repeats across accounts', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const result = await repo.queryGraph({
            tenantId: TENANT,
            predicate: { kind: 'by-vpc', vpcId: 'canvas-vpc-1' },
        });

        const seen = result.edges.map((e) => `${e.fromType}|${e.fromId}|${e.relation}|${e.toType}|${e.toId}`);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.filter((k) => k.startsWith('ec2_instances|canvas-i-1|in_vpc'))).toHaveLength(1);
    });

    it('still returns getSeed unchanged for a single-account node set', async () => {
        const repo = new ResourceGraphPostgresRepository();
        const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });

        expect(seed.nodes).toHaveLength(5);
        expect(seed.edges).toHaveLength(5);
    });

    it('rejects an unknown predicate rather than returning everything', async () => {
        const repo = new ResourceGraphPostgresRepository();
        await expect(
            repo.queryGraph({ tenantId: TENANT, predicate: { kind: 'nonsense' } as never }),
        ).rejects.toThrow(/unknown predicate/i);
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/repository.integration.test.ts -t queryGraph
```

Expected: FAIL — `repo.queryGraph is not a function`.

- [ ] **Step 4: Implement it**

Add `QueryResult` to `interface.ts` and the method to `IResourceGraphRepository`:

```typescript
export interface QueryResult {
    nodes: GraphNode[];
    edges: GraphEdgeLite[];
    total: number;
    truncated: boolean;
}
```

```typescript
    queryGraph(args: {
        tenantId: string;
        predicate: GraphPredicate;
        filters?: GraphFilters;
        limit?: number;
    }): Promise<QueryResult>;
```

Then in `postgres.ts`, importing `GraphPredicate`, `MONITORABLE_TYPES`, `DEFAULT_QUERY_LIMIT` and `SEED_EDGE_CAP`:

```typescript
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

        const rows = await db.$queryRawUnsafe<Array<GraphNode & { total: bigint }>>(
            `SELECT i."resourceType", i."resourceId", i."name", i."status", i."accountId", i.region,
                    count(*) OVER () AS total
             FROM inventory_resources i
             WHERE i."tenantId" = $1 AND i."isCurrent" = true
               ${nodeTypeFilterSql('i', filters)}
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
```

- [ ] **Step 6: Run it to verify it passes**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
  bunx vitest run tests/resource-graph/
```

Expected: PASS, including every getSeed test — Step 1 changed a helper getSeed depends on.

- [ ] **Step 7: Sanity-check the predicates against real data**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus \
  -c "SELECT count(*) FROM inventory_resources WHERE \"isCurrent\" AND \"resourceType\"='elbv2_load_balancers' AND metadata->>'scheme'='internet-facing';"
```

Expected: a non-zero count. A zero here means `scheme` is not in `metadata` for this tenant and the `internet-facing` predicate needs a different source — report it rather than shipping a predicate that silently returns nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/resource-graph apps/web-ui/lib/db/repositories/resource-graph apps/web-ui/tests/resource-graph
git commit -m "feat(resource-graph): add queryGraph with five fixed predicates"
```

---

### Task 9: HTTP routes

Five thin `GET` handlers. Each one parses its query string, calls the repository, and returns the house response shape. No business logic.

**Files:**
- Create: `apps/web-ui/app/api/resource-graph/seed/route.ts`
- Create: `apps/web-ui/app/api/resource-graph/expand/route.ts`
- Create: `apps/web-ui/app/api/resource-graph/path/route.ts`
- Create: `apps/web-ui/app/api/resource-graph/query/route.ts`
- Create: `apps/web-ui/app/api/resource-graph/summary/route.ts`
- Create: `apps/web-ui/app/api/resource-graph/graph-request.ts` (shared parsing)
- Test: `apps/web-ui/app/api/resource-graph/graph-routes.test.ts`

**Interfaces:**
- Consumes: `getResourceGraphRepository` from `@/lib/db/repository-factory`, `authorize` from `@/lib/rbac/authorize`, `getSessionTenantId` from `@/lib/auth-session`.
- Produces: `parseFilters(searchParams: URLSearchParams): GraphFilters` from `graph-request.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/app/api/resource-graph/graph-routes.test.ts`. It MUST follow the mocking
style of the existing `apps/web-ui/app/api/resource-graph/route.test.ts`, which is not
stylistic preference — that file mocks `next/server` wholesale, so `NextResponse.json`
returns a plain `{ _data, _status }` object rather than a real Response, and requests are
plain `{ url }` objects. It also uses `vi.hoisted` for every mock function, because
`vi.mock` is hoisted above plain `const` declarations and a factory referencing a bare
`const mockX` hits a temporal dead zone at import time. Read that file before writing this one.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
        })),
    },
}));

const mockAuthorize = vi.hoisted(() => vi.fn());
const mockSummarise = vi.hoisted(() => vi.fn());
const mockGetSeed = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({ summarise: mockSummarise, getSeed: mockGetSeed }),
}));

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: () => 'tenant-1' }));

import { GET as summaryGet } from './summary/route';
import { GET as seedGet } from './seed/route';
import { parseFilters } from './graph-request';

const req = (qs: string) => ({ url: `http://localhost/api/resource-graph?${qs}` }) as never;

describe('resource graph routes', () => {
    beforeEach(() => {
        mockAuthorize.mockReset().mockResolvedValue(null);
        mockSummarise.mockReset().mockResolvedValue({ accounts: [], byResourceType: [], byRelation: [] });
        mockGetSeed.mockReset().mockResolvedValue({
            mode: 'full-account', nodes: [], edges: [], totalVisibleNodes: 0, truncated: false,
        });
    });

    it('guards the route with the ResourceGraph read permission', async () => {
        await summaryGet(req(''));
        expect(mockAuthorize).toHaveBeenCalledWith('read', 'ResourceGraph');
    });

    it('returns the authorize response untouched when it denies', async () => {
        const denied = { _data: { success: false }, _status: 403 };
        mockAuthorize.mockResolvedValue(denied);

        const res = await summaryGet(req(''));

        expect(res).toBe(denied);
        expect(mockSummarise).not.toHaveBeenCalled();
    });

    it('binds the tenant from the session, never from the query string', async () => {
        await summaryGet(req('tenantId=someone-else'));
        expect(mockSummarise).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('rejects a seed request with no accountId', async () => {
        const res = await seedGet(req('')) as unknown as { _status: number };
        expect(res._status).toBe(400);
        expect(mockGetSeed).not.toHaveBeenCalled();
    });

    it('parses the opt-in filter flags', () => {
        const filters = parseFilters(new URL('http://x/?includeHiddenTypes=true&region=ap-south-1').searchParams);
        expect(filters.includeHiddenTypes).toBe(true);
        expect(filters.includeObservation).toBeUndefined();
        expect(filters.region).toBe('ap-south-1');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web-ui && bunx vitest run app/api/resource-graph/graph-routes.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Write the shared parser**

Create `apps/web-ui/app/api/resource-graph/graph-request.ts`:

```typescript
import type { GraphFilters } from '@/lib/resource-graph/graph-constants';

export function parseFilters(searchParams: URLSearchParams): GraphFilters {
    const flag = (name: string) => (searchParams.get(name) === 'true' ? true : undefined);

    return {
        accountId: searchParams.get('accountId') ?? undefined,
        region: searchParams.get('region') ?? undefined,
        includeAwsManagedKeys: flag('includeAwsManagedKeys'),
        includeHiddenTypes: flag('includeHiddenTypes'),
        includeObservation: flag('includeObservation'),
    };
}
```

- [ ] **Step 4: Write the five routes**

Create `apps/web-ui/app/api/resource-graph/summary/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';
import { parseFilters } from '../graph-request';

export async function GET(req: NextRequest) {
    const authError = await authorize('read', 'ResourceGraph');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });

        const { searchParams } = new URL(req.url);
        const data = await getResourceGraphRepository().summarise({
            tenantId,
            accountId: searchParams.get('accountId') ?? undefined,
            filters: parseFilters(searchParams),
        });

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - Error summarising resource graph:', error);
        return NextResponse.json({ success: false, error: 'Failed to summarise resource graph' }, { status: 500 });
    }
}
```

Create `apps/web-ui/app/api/resource-graph/seed/route.ts` with the same skeleton, replacing the body between the tenant guard and the response with:

```typescript
        const { searchParams } = new URL(req.url);
        const accountId = searchParams.get('accountId');
        if (!accountId) return NextResponse.json({ success: false, error: 'accountId is required' }, { status: 400 });

        const data = await getResourceGraphRepository().getSeed({
            tenantId,
            accountId,
            filters: parseFilters(searchParams),
        });
```

Create `apps/web-ui/app/api/resource-graph/expand/route.ts` the same way with:

```typescript
        const { searchParams } = new URL(req.url);
        const resourceId = searchParams.get('resourceId');
        if (!resourceId) return NextResponse.json({ success: false, error: 'resourceId is required' }, { status: 400 });

        const repo = getResourceGraphRepository();
        const resourceType = (await repo.resolveResourceType({ tenantId, resourceId }))
            ?? searchParams.get('resourceType');
        if (!resourceType) {
            return NextResponse.json({ success: false, error: 'resourceType is required when the resource is not in inventory' }, { status: 400 });
        }

        const data = await repo.expand({ tenantId, resourceType, resourceId, filters: parseFilters(searchParams) });
```

Create `apps/web-ui/app/api/resource-graph/path/route.ts` with:

```typescript
        const { searchParams } = new URL(req.url);
        const fromId = searchParams.get('fromId');
        const toId = searchParams.get('toId');
        if (!fromId || !toId) return NextResponse.json({ success: false, error: 'fromId and toId are required' }, { status: 400 });

        const repo = getResourceGraphRepository();
        const [fromType, toType] = await Promise.all([
            repo.resolveResourceType({ tenantId, resourceId: fromId }),
            repo.resolveResourceType({ tenantId, resourceId: toId }),
        ]);
        if (!fromType || !toType) {
            return NextResponse.json({ success: false, error: 'Both resources must exist in inventory' }, { status: 404 });
        }

        const data = await repo.findPath({
            tenantId,
            from: { resourceType: fromType, resourceId: fromId },
            to: { resourceType: toType, resourceId: toId },
            maxDepth: Number(searchParams.get('maxDepth')) || undefined,
        });
```

Create `apps/web-ui/app/api/resource-graph/query/route.ts` with:

```typescript
        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('predicate');
        const predicate = kind === 'by-type'
            ? { kind, resourceType: searchParams.get('resourceType') ?? '' }
            : kind === 'by-vpc'
                ? { kind, vpcId: searchParams.get('vpcId') ?? '' }
                : kind === 'internet-facing' || kind === 'unmonitored' || kind === 'isolated'
                    ? { kind }
                    : null;

        if (!predicate) {
            return NextResponse.json({ success: false, error: 'predicate must be one of by-type, by-vpc, internet-facing, unmonitored, isolated' }, { status: 400 });
        }

        const data = await getResourceGraphRepository().queryGraph({
            tenantId,
            predicate: predicate as GraphPredicate,
            filters: parseFilters(searchParams),
            limit: Number(searchParams.get('limit')) || undefined,
        });
```

with `import type { GraphPredicate } from '@/lib/resource-graph/graph-constants';` at the top.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd apps/web-ui && bunx vitest run app/api/resource-graph/
```

Expected: PASS, including the pre-existing `route.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/app/api/resource-graph
git commit -m "feat(resource-graph): add seed, expand, path, query and summary routes"
```

---

### Task 10: The three agent tools

**Files:**
- Create: `apps/web-ui/lib/agent/resource-graph-query-tool.ts`
- Modify: `apps/web-ui/lib/agent/model-factory.ts:273` (register them)
- Modify: `apps/web-ui/lib/agent/prompt-templates.ts` (extend principle 10)
- Test: `apps/web-ui/tests/resource-graph/query-tools.test.ts`

**Interfaces:**
- Consumes: `findPath`, `queryGraph`, `summarise` from Task 4, 7 and 8; `resolveResourceType`, which already exists.
- Produces: `createFindPathTool(tenantId)`, `createQueryGraphTool(tenantId)`, `createDescribeEnvironmentTool(tenantId)`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/tests/resource-graph/query-tools.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/query-tools.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the tools**

Create `apps/web-ui/lib/agent/resource-graph-query-tool.ts`:

```typescript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';
import type { GraphPredicate } from '@/lib/resource-graph/graph-constants';

export function createFindPathTool(tenantId: string) {
    return tool(
        async ({ fromId, toId, maxDepth }: { fromId: string; toId: string; maxDepth?: number }) => {
            const repo = getResourceGraphRepository();
            const [fromType, toType] = await Promise.all([
                repo.resolveResourceType({ tenantId, resourceId: fromId }),
                repo.resolveResourceType({ tenantId, resourceId: toId }),
            ]);

            const missing = [!fromType && fromId, !toType && toId].filter(Boolean);
            if (missing.length) {
                return JSON.stringify({
                    found: false,
                    note: `Not found in inventory for this tenant: ${missing.join(', ')}. They may not be discovered yet.`,
                });
            }

            const result = await repo.findPath({
                tenantId,
                from: { resourceType: fromType!, resourceId: fromId },
                to: { resourceType: toType!, resourceId: toId },
                maxDepth,
            });

            return JSON.stringify({
                found: result.found,
                from: `${fromType}/${fromId}`,
                to: `${toType}/${toId}`,
                hops: result.hops,
                ...(result.found
                    ? {}
                    : {
                        note: result.frontierExhausted
                            ? `No connection found within ${result.searchedDepth} hops, and the search was capped before exhausting the graph. A longer path may exist.`
                            : `No connection between these two resources within ${result.searchedDepth} hops.`,
                    }),
            });
        },
        {
            name: 'find_path',
            description:
                'Find how two discovered AWS resources are connected — the actual chain of relationships between them, hop by hop. ' +
                'Use this for "is X connected to Y", "how does this instance reach that database", and when tracing an incident between two components. ' +
                'Prefer this over calling get_resource_neighbors repeatedly. Read-only.',
            schema: z.object({
                fromId: z.string().describe('Resource id to start from, e.g. i-0abc123 or a full ARN'),
                toId: z.string().describe('Resource id to reach'),
                maxDepth: z.number().optional().describe('Maximum hops to search (1-5, default 4)'),
            }),
        },
    );
}

export function createQueryGraphTool(tenantId: string) {
    return tool(
        async (input: { predicate: string; resourceType?: string; vpcId?: string; accountId?: string; limit?: number }) => {
            const predicate = (input.predicate === 'by-type'
                ? { kind: 'by-type', resourceType: input.resourceType ?? '' }
                : input.predicate === 'by-vpc'
                    ? { kind: 'by-vpc', vpcId: input.vpcId ?? '' }
                    : { kind: input.predicate }) as GraphPredicate;

            const result = await getResourceGraphRepository().queryGraph({
                tenantId,
                predicate,
                filters: { accountId: input.accountId },
                limit: input.limit,
            });

            return JSON.stringify({
                predicate: input.predicate,
                total: result.total,
                showing: result.nodes.length,
                truncated: result.truncated,
                nodes: result.nodes,
                edges: result.edges,
                ...(result.total === 0 ? { note: 'Nothing in the discovered graph matches this query.' } : {}),
            });
        },
        {
            name: 'query_graph',
            description:
                'Find every discovered AWS resource matching one of a fixed set of questions, together with how those resources connect to each other. ' +
                'Predicates: by-type (all resources of a type), by-vpc (everything in one VPC), internet-facing (public load balancers and CloudFront), ' +
                'unmonitored (no CloudWatch alarm watching it), isolated (no recorded relationships at all). Read-only.',
            schema: z.object({
                predicate: z.enum(['by-type', 'by-vpc', 'internet-facing', 'unmonitored', 'isolated']),
                resourceType: z.string().optional().describe('Required for by-type, e.g. ec2_instances'),
                vpcId: z.string().optional().describe('Required for by-vpc, e.g. vpc-0abc123'),
                accountId: z.string().optional().describe('Restrict to one AWS account'),
                limit: z.number().optional().describe('Maximum nodes to return (default 500)'),
            }),
        },
    );
}

export function createDescribeEnvironmentTool(tenantId: string) {
    return tool(
        async ({ accountId }: { accountId?: string }) => {
            const summary = await getResourceGraphRepository().summarise({ tenantId, accountId });

            return JSON.stringify({
                scope: accountId ?? 'all accounts',
                accounts: summary.accounts,
                ...(accountId
                    ? { byResourceType: summary.byResourceType, byRelation: summary.byRelation }
                    : {}),
                ...(summary.accounts.length === 0
                    ? { note: 'No discovered resources for this tenant. A discovery scan may not have run yet.' }
                    : {}),
            });
        },
        {
            name: 'describe_environment',
            description:
                'Get the shape of the estate in one call — resource and relationship counts per AWS account, and with an accountId, the breakdown by resource type and relationship for that account. ' +
                'Call this before reasoning about an account you have not looked at yet, instead of guessing its size or composition. Read-only.',
            schema: z.object({
                accountId: z.string().optional().describe('Restrict to one AWS account; omit for every account'),
            }),
        },
    );
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/query-tools.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Register the tools**

In `apps/web-ui/lib/agent/model-factory.ts`, add the import beside the existing resource-graph import:

```typescript
import { createFindPathTool, createQueryGraphTool, createDescribeEnvironmentTool } from "./resource-graph-query-tool";
```

and add three entries in `assembleTools`, immediately after `createGetBlastRadiusTool(effectiveTenantId),`:

```typescript
        createFindPathTool(effectiveTenantId),
        createQueryGraphTool(effectiveTenantId),
        createDescribeEnvironmentTool(effectiveTenantId),
```

- [ ] **Step 6: Extend the prompt principle**

In `apps/web-ui/lib/agent/prompt-templates.ts`, append to the end of principle 10 (do not add an eleventh):

```
 For questions spanning more than one resource, use the zoomed-out tools instead of repeated single-resource lookups: find_path to establish whether and how two resources are connected, query_graph for "everything that matches X", and describe_environment before reasoning about an account you have not examined yet. State the count a query returned, and say so explicitly when a result reports itself truncated.
```

- [ ] **Step 7: Run the full web-ui suite**

```bash
cd apps/web-ui && bun run test
```

Expected: PASS. Note this runs the integration tests against whatever `DATABASE_URL` the root `.env` names, which on this team is a shared dev Postgres — the resource-graph integration tests namespace every row to their two test tenants and clean up in `afterAll`.

- [ ] **Step 8: Lint and typecheck**

```bash
cd apps/web-ui && bun run lint && bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web-ui/lib/agent apps/web-ui/tests/resource-graph
git commit -m "feat(agent): add find_path, query_graph and describe_environment tools"
```

---

## Phase 1 done when

- `bun run test` passes in both `apps/web-ui` and `apps/workers`.
- `toAccountId` is non-null for at least one peering or TGW edge after a discovery scan:
  ```bash
  docker exec nucleus-postgres psql -U nucleus -d nucleus \
    -c "SELECT count(*) FROM resource_edges WHERE \"isCurrent\" AND \"toAccountId\" IS NOT NULL;"
  ```
  Measured before this phase: 0. A scan must run for this to change — the existing rows are not backfilled.
- The agent can answer "how is <instance> connected to <load balancer>", "show me every isolated resource", and "describe account <id>" in chat without falling back to AWS CLI calls.
