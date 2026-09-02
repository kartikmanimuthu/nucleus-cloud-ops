# Resource Graph Canvas — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/app/resource-graph` page that opens on a real ~100-node graph of the estate — two transit-gateway hubs with 78 accounts hanging off them and 21 standalone — and grows by tapping, never holding more than a few hundred nodes at once.

**Architecture:** Pure functions turn Phase 1 API responses into Cytoscape elements; a zustand store holds canvas state; one Cytoscape instance renders it. No backend changes — every level is served by an existing Phase 1 route.

**Tech Stack:** Next.js 15 App Router, React 19, Cytoscape 3.34.1 + fcose 2.2.0, zustand, TanStack Query, Tailwind, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-resource-graph-canvas-phase-2-design.md`

## Global Constraints

- **No backend changes.** No new API route, repository method, migration, or worker change. If a task appears to need one, stop and report rather than adding it.
- **No comments unless the WHY is non-obvious.** Never multi-line docstrings or comment blocks.
- **Indentation:** 2 spaces in `components/`, 4 spaces in `lib/`. Match the file being edited.
- **Imports:** the `@/` alias for every cross-directory import.
- **Data fetching:** TanStack Query hooks in `lib/queries/resource-graph.ts`, keys via `lib/queries/query-keys.ts`. Never `useState` + `useEffect` + `fetch`.
- **Toasts:** import `toast` from `sonner` directly.
- **Both themes.** Every colour resolves through a CSS custom property with light and dark values. A palette legible only on dark is a defect.
- **Never silently truncate.** Phase 1 returns true totals; render them.
- **Do not commit unless the user explicitly asks.** Commit steps are written out; run them only on request.
- **Never** `git stash` (the stack is shared), push, force-push, merge, or rewrite history.

---

### Task 1: Dependencies and the graph palette

**Files:**
- Modify: `apps/web-ui/package.json`
- Create: `apps/web-ui/lib/resource-graph/graph-theme.ts`
- Test: `apps/web-ui/lib/resource-graph/__tests__/graph-theme.test.ts`

**Interfaces:**
- Produces: `NODE_KIND`, `type NodeKind`, `RESOURCE_TYPE_COLORS`, `colorForType(resourceType: string): string`.

- [ ] **Step 1: Install**

```bash
cd apps/web-ui && bun add cytoscape@3.34.1 cytoscape-fcose@2.2.0 && bun add -d @types/cytoscape
```

- [ ] **Step 2: Write the failing test**

Create `apps/web-ui/lib/resource-graph/__tests__/graph-theme.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { colorForType, RESOURCE_TYPE_COLORS, NODE_KIND } from '../graph-theme';

describe('graph theme', () => {
    it('gives the common AWS types distinct colours', () => {
        const types = ['ec2_instances', 'rds_db_instances', 's3_buckets', 'ec2_vpcs', 'lambda_functions'];
        expect(new Set(types.map(colorForType)).size).toBe(types.length);
    });

    it('falls back to a neutral colour for an unknown type rather than throwing', () => {
        expect(colorForType('some_future_service')).toBe(RESOURCE_TYPE_COLORS.__fallback);
    });

    it('marks synthetic nodes distinctly from discovered resources', () => {
        expect(NODE_KIND.account).not.toBe(NODE_KIND.resource);
        expect(NODE_KIND.hub).not.toBe(NODE_KIND.resource);
    });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/graph-theme.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 4: Write the module**

Create `apps/web-ui/lib/resource-graph/graph-theme.ts`. Every colour below must stay legible on both a white and a near-black background — check both before finishing.

```typescript
export const NODE_KIND = {
    account: 'account',
    hub: 'hub',
    resource: 'resource',
} as const;

export type NodeKind = (typeof NODE_KIND)[keyof typeof NODE_KIND];

export const RESOURCE_TYPE_COLORS: Record<string, string> = {
    ec2_instances: '#f59e0b',
    ec2_vpcs: '#6366f1',
    ec2_subnets: '#818cf8',
    ec2_security_groups: '#ef4444',
    ec2_volumes: '#a855f7',
    ec2_network_interfaces: '#c084fc',
    ec2_nat_gateways: '#8b5cf6',
    ec2_transit_gateways: '#4f46e5',
    elbv2_load_balancers: '#10b981',
    elbv2_targroups: '#34d399',
    rds_db_instances: '#0ea5e9',
    rds_db_clusters: '#0284c7',
    docdb_db_clusters: '#0369a1',
    elasticache_cache_clusters: '#06b6d4',
    ecs_clusters: '#f97316',
    ecs_services: '#fb923c',
    eks_clusters: '#ea580c',
    lambda_functions: '#eab308',
    s3_buckets: '#22c55e',
    dynamodb_tables: '#14b8a6',
    kms_keys: '#64748b',
    iam_roles: '#94a3b8',
    cloudfront_distributions: '#ec4899',
    acm_certificates: '#f472b6',
    autoscaling_auto_scaling_groups: '#d946ef',
    __account: '#0f766e',
    __fallback: '#71717a',
};

export function colorForType(resourceType: string): string {
    return RESOURCE_TYPE_COLORS[resourceType] ?? RESOURCE_TYPE_COLORS.__fallback;
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/graph-theme.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

Run git from the repo root — `bun.lock` is hoisted there, so `git add bun.lock` from
`apps/web-ui` fails with a pathspec error:

```bash
cd ../.. && git add apps/web-ui/package.json apps/web-ui/lib/resource-graph bun.lock
git commit -m "feat(resource-graph): add cytoscape and the graph palette"
```

---

### Task 2: Build the opening view

The opening screen: two transit-gateway hubs, 78 accounts attached, 21 standalone. Pure functions, no React, no network. Whether the page is impressive or wrong is decided here.

**Files:**
- Create: `apps/web-ui/lib/resource-graph/build-elements.ts`
- Test: `apps/web-ui/lib/resource-graph/__tests__/build-elements.test.ts`

**Interfaces:**
- Consumes: `AccountSummary`, `GraphNode` from `@/lib/db/repositories/resource-graph/interface`; `NODE_KIND`, `colorForType` from Task 1.
- Produces: `interface CyElement { data: Record<string, unknown>; classes?: string }`, `accountNodeId(accountId)`, `hubNodeId(resourceType, resourceId)`, `resourceNodeId(resourceType, resourceId)`, `buildOpeningElements({ accounts, transitGateways }): CyElement[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/resource-graph/__tests__/build-elements.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildOpeningElements, accountNodeId, hubNodeId } from '../build-elements';
import { NODE_KIND } from '../graph-theme';

const accounts = [
    { accountId: '111', resourceCount: 400, edgeCount: 300 },
    { accountId: '222', resourceCount: 200, edgeCount: 150 },
    { accountId: '333', resourceCount: 10, edgeCount: 0 },
];

const tgwRow = (resourceId: string, accountId: string) => ({
    resourceType: 'ec2_transit_gateways',
    resourceId,
    name: null,
    status: null,
    accountId,
    region: 'ap-south-1',
});

const shared = [tgwRow('tgw-a', '111'), tgwRow('tgw-a', '222')];

describe('buildOpeningElements', () => {
    it('creates one node per account', () => {
        const els = buildOpeningElements({ accounts, transitGateways: [] });
        const nodes = els.filter((e) => e.data.kind === NODE_KIND.account);
        expect(nodes).toHaveLength(3);
        expect(nodes.map((n) => n.data.id)).toContain(accountNodeId('111'));
    });

    it('collapses a gateway seen by two accounts into ONE hub node', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        const hubs = els.filter((e) => e.data.kind === NODE_KIND.hub);
        expect(hubs).toHaveLength(1);
        expect(hubs[0].data.id).toBe(hubNodeId('ec2_transit_gateways', 'tgw-a'));
    });

    it('links every account that sees the hub to it', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        const edges = els.filter((e) => e.data.source);
        expect(edges).toHaveLength(2);
        expect(edges.map((e) => e.data.source).sort()).toEqual([accountNodeId('111'), accountNodeId('222')].sort());
    });

    it('leaves an account with no shared gateway unconnected rather than inventing a link', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        expect(els.filter((e) => e.data.source === accountNodeId('333'))).toHaveLength(0);
    });

    it('ignores a gateway seen by only one account, since it connects nothing', () => {
        const els = buildOpeningElements({ accounts, transitGateways: [tgwRow('tgw-solo', '333')] });
        expect(els.filter((e) => e.data.kind === NODE_KIND.hub)).toHaveLength(0);
        expect(els.filter((e) => e.data.source)).toHaveLength(0);
    });

    it('keeps the counts an account tile needs', () => {
        const els = buildOpeningElements({ accounts, transitGateways: [] });
        const big = els.find((e) => e.data.id === accountNodeId('111'));
        expect(big?.data.resourceCount).toBe(400);
        expect(big?.data.edgeCount).toBe(300);
    });

    it('produces no duplicate element ids', () => {
        const els = buildOpeningElements({ accounts, transitGateways: shared });
        const ids = els.map((e) => e.data.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/build-elements.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `apps/web-ui/lib/resource-graph/build-elements.ts`:

```typescript
import type { AccountSummary, GraphNode } from '@/lib/db/repositories/resource-graph/interface';
import { NODE_KIND, colorForType } from './graph-theme';

export interface CyElement {
    data: Record<string, unknown>;
    classes?: string;
}

export const accountNodeId = (accountId: string) => `account:${accountId}`;
export const hubNodeId = (resourceType: string, resourceId: string) => `hub:${resourceType}:${resourceId}`;
export const resourceNodeId = (resourceType: string, resourceId: string) => `res:${resourceType}:${resourceId}`;

export function buildOpeningElements(args: {
    accounts: AccountSummary[];
    transitGateways: GraphNode[];
}): CyElement[] {
    const seenBy = new Map<string, Set<string>>();
    for (const row of args.transitGateways) {
        const key = `${row.resourceType}\t${row.resourceId}`;
        if (!seenBy.has(key)) seenBy.set(key, new Set());
        seenBy.get(key)!.add(row.accountId);
    }

    // A gateway only one account can see connects nothing. Drawing it would add a
    // dead-end node and imply a relationship the data does not contain.
    const shared = [...seenBy.entries()].filter(([, accounts]) => accounts.size > 1);

    const elements: CyElement[] = args.accounts.map((account) => ({
        data: {
            id: accountNodeId(account.accountId),
            kind: NODE_KIND.account,
            label: account.accountId,
            accountId: account.accountId,
            resourceCount: account.resourceCount,
            edgeCount: account.edgeCount,
            color: colorForType('__account'),
        },
        classes: NODE_KIND.account,
    }));

    for (const [key, accountIds] of shared) {
        const [resourceType, resourceId] = key.split('\t');
        elements.push({
            data: {
                id: hubNodeId(resourceType, resourceId),
                kind: NODE_KIND.hub,
                label: resourceId,
                resourceType,
                resourceId,
                spokeCount: accountIds.size,
                color: colorForType(resourceType),
            },
            classes: NODE_KIND.hub,
        });

        for (const accountId of accountIds) {
            const source = accountNodeId(accountId);
            const target = hubNodeId(resourceType, resourceId);
            elements.push({ data: { id: `edge:${source}->${target}`, source, target, relation: 'attached_to_tgw' } });
        }
    }

    return elements;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/build-elements.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the real inputs produce two hubs**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "SELECT \"resourceId\", count(DISTINCT \"accountId\") a FROM inventory_resources WHERE \"isCurrent\" AND \"resourceType\"='ec2_transit_gateways' GROUP BY 1 HAVING count(DISTINCT \"accountId\")>1 ORDER BY a DESC;"
```

Expected: two rows, 42 and 36. Report the numbers. More rows is correct behaviour, not a bug — note it, do not special-case.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/resource-graph
git commit -m "feat(resource-graph): build the opening account-and-hub graph"
```

---

### Task 3: Merge expansion responses into the canvas

Tapping adds elements. Given what is already on canvas plus an `expand` or `queryGraph` response, produce only the NEW elements, never a duplicate.

**Files:**
- Modify: `apps/web-ui/lib/resource-graph/build-elements.ts`
- Test: `apps/web-ui/lib/resource-graph/__tests__/build-elements.test.ts`

**Interfaces:**
- Consumes: `DependencyDirection`, `GraphEdgeLite` from `@/lib/db/repositories/resource-graph/interface`.
- Produces: `parentAssignment(edges): Map<string, string>`, `buildExpansionElements({ expanded, dependents, dependsOn, existingIds }): { elements: CyElement[]; hiddenTotal: number }`, `buildNodeElements({ nodes, edges, existingIds }): CyElement[]`.

- [ ] **Step 1: Write the failing tests**

Append to the same test file:

```typescript
import { buildExpansionElements, buildNodeElements, parentAssignment, resourceNodeId } from '../build-elements';

const dir = (rows: Array<{ relation: string; type: string; id: string }>, total?: number) => ({
    edges: rows.map((r) => ({
        relation: r.relation,
        region: 'ap-south-1',
        other: { resourceType: r.type, resourceId: r.id, name: null, status: null, accountId: '111', exists: true },
    })),
    total: total ?? rows.length,
    truncated: (total ?? rows.length) > rows.length,
});

describe('buildExpansionElements', () => {
    it('adds a node and an edge per neighbour', () => {
        const { elements } = buildExpansionElements({
            expanded: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            dependents: dir([{ relation: 'attached_to', type: 'ec2_volumes', id: 'vol-1' }]),
            dependsOn: dir([{ relation: 'uses_security_group', type: 'ec2_security_groups', id: 'sg-1' }]),
            existingIds: new Set([resourceNodeId('ec2_instances', 'i-1')]),
        });

        expect(elements.filter((e) => !e.data.source)).toHaveLength(2);
        expect(elements.filter((e) => e.data.source)).toHaveLength(2);
    });

    it('never re-adds a node already on the canvas', () => {
        const { elements } = buildExpansionElements({
            expanded: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            dependents: dir([]),
            dependsOn: dir([{ relation: 'uses_security_group', type: 'ec2_security_groups', id: 'sg-1' }]),
            existingIds: new Set([resourceNodeId('ec2_instances', 'i-1'), resourceNodeId('ec2_security_groups', 'sg-1')]),
        });

        expect(elements.filter((e) => !e.data.source)).toHaveLength(0);
        expect(elements.filter((e) => e.data.source)).toHaveLength(1);
    });

    it('reports how many neighbours the cap withheld', () => {
        const { hiddenTotal } = buildExpansionElements({
            expanded: { resourceType: 'ec2_vpcs', resourceId: 'vpc-1' },
            dependents: dir([{ relation: 'in_vpc', type: 'ec2_instances', id: 'i-1' }], 237),
            dependsOn: dir([]),
            existingIds: new Set(),
        });

        expect(hiddenTotal).toBe(236);
    });

    it('reports zero withheld when nothing was truncated', () => {
        const { hiddenTotal } = buildExpansionElements({
            expanded: { resourceType: 'ec2_instances', resourceId: 'i-1' },
            dependents: dir([{ relation: 'attached_to', type: 'ec2_volumes', id: 'vol-1' }]),
            dependsOn: dir([]),
            existingIds: new Set(),
        });

        expect(hiddenTotal).toBe(0);
    });
});

describe('parentAssignment', () => {
    const e = (fromType: string, fromId: string, relation: string, toType: string, toId: string) => ({
        fromType, fromId, relation, toType, toId, region: 'ap-south-1',
    });

    it('parents a resource to its subnet, not its vpc, when it has both', () => {
        const map = parentAssignment([
            e('ec2_instances', 'i-1', 'in_vpc', 'ec2_vpcs', 'vpc-1'),
            e('ec2_instances', 'i-1', 'in_subnet', 'ec2_subnets', 'sn-1'),
        ]);
        expect(map.get(resourceNodeId('ec2_instances', 'i-1'))).toBe(resourceNodeId('ec2_subnets', 'sn-1'));
    });

    it('parents to the vpc when there is no subnet', () => {
        const map = parentAssignment([e('elbv2_load_balancers', 'lb-1', 'in_vpc', 'ec2_vpcs', 'vpc-1')]);
        expect(map.get(resourceNodeId('elbv2_load_balancers', 'lb-1'))).toBe(resourceNodeId('ec2_vpcs', 'vpc-1'));
    });

    it('leaves a resource with no containment at top level', () => {
        const map = parentAssignment([e('ec2_volumes', 'vol-1', 'attached_to', 'ec2_instances', 'i-1')]);
        expect(map.has(resourceNodeId('ec2_volumes', 'vol-1'))).toBe(false);
    });
});

describe('buildNodeElements', () => {
    it('turns containment into parentage and does not also draw it as an edge', () => {
        const els = buildNodeElements({
            nodes: [
                { resourceType: 'ec2_vpcs', resourceId: 'vpc-1' },
                { resourceType: 'ec2_subnets', resourceId: 'sn-1' },
            ],
            edges: [{ fromType: 'ec2_subnets', fromId: 'sn-1', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1', region: 'ap-south-1' }],
            existingIds: new Set(),
        });

        expect(els.filter((e) => e.data.source)).toHaveLength(0);
        expect(els.find((e) => e.data.id === resourceNodeId('ec2_subnets', 'sn-1'))?.data.parent)
            .toBe(resourceNodeId('ec2_vpcs', 'vpc-1'));
    });

    it('draws a non-containment edge normally', () => {
        const els = buildNodeElements({
            nodes: [
                { resourceType: 'ec2_volumes', resourceId: 'vol-1' },
                { resourceType: 'ec2_instances', resourceId: 'i-1' },
            ],
            edges: [{ fromType: 'ec2_volumes', fromId: 'vol-1', relation: 'attached_to', toType: 'ec2_instances', toId: 'i-1', region: 'ap-south-1' }],
            existingIds: new Set(),
        });

        expect(els.filter((e) => e.data.source)).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/build-elements.test.ts
```

Expected: FAIL — the three new exports do not exist.

- [ ] **Step 3: Implement**

Append to `build-elements.ts`, adding `DependencyDirection` and `GraphEdgeLite` to the existing type import:

```typescript
const CONTAINMENT_RANK: Record<string, number> = { in_subnet: 0, in_cluster: 1, in_vpc: 2 };

export function parentAssignment(edges: GraphEdgeLite[]): Map<string, string> {
    const best = new Map<string, { rank: number; parent: string }>();

    for (const edge of edges) {
        const rank = CONTAINMENT_RANK[edge.relation];
        if (rank === undefined) continue;

        const child = resourceNodeId(edge.fromType, edge.fromId);
        const parent = resourceNodeId(edge.toType, edge.toId);
        if (child === parent) continue;

        const current = best.get(child);
        if (!current || rank < current.rank) best.set(child, { rank, parent });
    }

    return new Map([...best].map(([child, v]) => [child, v.parent]));
}

interface NodeLike {
    resourceType: string;
    resourceId: string;
    name?: string | null;
    status?: string | null;
    accountId?: string | null;
    region?: string | null;
}

function nodeElement(n: NodeLike, parent?: string): CyElement {
    return {
        data: {
            id: resourceNodeId(n.resourceType, n.resourceId),
            kind: NODE_KIND.resource,
            label: n.name ?? n.resourceId,
            resourceType: n.resourceType,
            resourceId: n.resourceId,
            status: n.status ?? null,
            accountId: n.accountId ?? null,
            region: n.region ?? null,
            color: colorForType(n.resourceType),
            ...(parent ? { parent } : {}),
        },
        classes: NODE_KIND.resource,
    };
}

export function buildExpansionElements(args: {
    expanded: { resourceType: string; resourceId: string };
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
    existingIds: Set<string>;
}): { elements: CyElement[]; hiddenTotal: number } {
    const focusId = resourceNodeId(args.expanded.resourceType, args.expanded.resourceId);
    const elements: CyElement[] = [];
    const seen = new Set(args.existingIds);

    const take = (direction: DependencyDirection, inbound: boolean) => {
        for (const edge of direction.edges) {
            const otherId = resourceNodeId(edge.other.resourceType, edge.other.resourceId);
            if (!seen.has(otherId)) {
                seen.add(otherId);
                // region lives on the edge, not on `other`; without this the detail panel
                // shows a blank region for every node that arrived by expansion.
                elements.push(nodeElement({ ...edge.other, region: edge.region }));
            }

            const source = inbound ? otherId : focusId;
            const target = inbound ? focusId : otherId;
            const id = `edge:${source}->${target}:${edge.relation}`;
            if (seen.has(id)) continue;
            seen.add(id);
            elements.push({ data: { id, source, target, relation: edge.relation } });
        }
    };

    take(args.dependents, true);
    take(args.dependsOn, false);

    const withheld = (d: DependencyDirection) => Math.max(0, d.total - d.edges.length);
    return { elements, hiddenTotal: withheld(args.dependents) + withheld(args.dependsOn) };
}

export function buildNodeElements(args: {
    nodes: NodeLike[];
    edges: GraphEdgeLite[];
    existingIds: Set<string>;
}): CyElement[] {
    const parents = parentAssignment(args.edges);
    const elements: CyElement[] = [];
    const seen = new Set(args.existingIds);

    for (const node of args.nodes) {
        const id = resourceNodeId(node.resourceType, node.resourceId);
        if (seen.has(id)) continue;
        seen.add(id);
        elements.push(nodeElement(node, parents.get(id)));
    }

    // Containment became parentage above; drawing it again would put a line inside every box.
    for (const edge of args.edges) {
        if (CONTAINMENT_RANK[edge.relation] !== undefined) continue;
        const source = resourceNodeId(edge.fromType, edge.fromId);
        const target = resourceNodeId(edge.toType, edge.toId);
        const id = `edge:${source}->${target}:${edge.relation}`;
        if (seen.has(id)) continue;
        seen.add(id);
        elements.push({ data: { id, source, target, relation: edge.relation } });
    }

    return elements;
}
```

- [ ] **Step 4: Run and watch pass**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/build-elements.test.ts
```

Expected: PASS, 16 tests in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/resource-graph
git commit -m "feat(resource-graph): merge expansion responses into canvas elements"
```

---

### Task 4: Query hooks for every level

**Files:**
- Modify: `apps/web-ui/lib/queries/query-keys.ts`
- Modify: `apps/web-ui/lib/queries/resource-graph.ts`
- Test: `apps/web-ui/tests/resource-graph/canvas-queries.test.ts`

**Interfaces:**
- Produces: `useGraphSummary()`, `useSharedTransitGateways()`, `useAccountVpcs(accountId | null)`, `expandResource(resourceId)` (a plain async fetcher, called imperatively on tap rather than as a hook), and `queryKeys.resourceGraph.{summary,byType,expand}`.

`expandResource` is deliberately not a hook: expansion is triggered by a user gesture on an arbitrary node, not by render state, so `useQuery` would need one hook instance per node.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/tests/resource-graph/canvas-queries.test.ts`. Mock `fetch` and assert URLs and error handling:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandResource, GRAPH_ENDPOINTS } from '@/lib/queries/resource-graph';

const okJson = (data: unknown) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
} as Response);

describe('graph canvas fetchers', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('calls the expand route with the resource id', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            okJson({ resourceType: 'ec2_instances', resourceId: 'i-1', dependents: { edges: [], total: 0, truncated: false }, dependsOn: { edges: [], total: 0, truncated: false } }));

        await expandResource('i-1');

        expect(spy).toHaveBeenCalledTimes(1);
        const url = String(spy.mock.calls[0][0]);
        expect(url).toContain(GRAPH_ENDPOINTS.expand);
        expect(url).toContain('resourceId=i-1');
    });

    it('url-encodes an ARN resource id rather than corrupting the query string', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            okJson({ resourceType: 'elbv2_load_balancers', resourceId: 'arn:aws:x/y', dependents: { edges: [], total: 0, truncated: false }, dependsOn: { edges: [], total: 0, truncated: false } }));

        await expandResource('arn:aws:x/y');

        const url = String(spy.mock.calls[0][0]);
        expect(url).toContain(encodeURIComponent('arn:aws:x/y'));
    });

    it('throws on an unsuccessful response instead of returning undefined', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ success: false, error: 'boom' }),
        } as Response);

        await expect(expandResource('i-1')).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/canvas-queries.test.ts
```

Expected: FAIL — `expandResource` / `GRAPH_ENDPOINTS` do not exist.

- [ ] **Step 3: Add the query keys**

In `apps/web-ui/lib/queries/query-keys.ts`, extend the existing `resourceGraph` block. Keep the existing `all`, `details` and `detail` entries untouched — the Dependencies tab uses them:

```typescript
    resourceGraph: {
        all: ['resourceGraph'] as const,
        details: () => [...queryKeys.resourceGraph.all, 'detail'] as const,
        detail: (resourceType: string, resourceId: string) =>
            [...queryKeys.resourceGraph.details(), resourceType, resourceId] as const,
        summary: (accountId?: string) =>
            [...queryKeys.resourceGraph.all, 'summary', accountId ?? 'all'] as const,
        byType: (resourceType: string, accountId?: string) =>
            [...queryKeys.resourceGraph.all, 'byType', resourceType, accountId ?? 'all'] as const,
    },
```

- [ ] **Step 4: Add the hooks and fetcher**

Append to `apps/web-ui/lib/queries/resource-graph.ts`:

```typescript
export const GRAPH_ENDPOINTS = {
    summary: '/api/resource-graph/summary',
    query: '/api/resource-graph/query',
    expand: '/api/resource-graph/expand',
    seed: '/api/resource-graph/seed',
} as const;

async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(body.error ?? `Request failed: ${res.status}`);
    return body.data as T;
}

export function useGraphSummary() {
    return useQuery({
        queryKey: queryKeys.resourceGraph.summary(),
        queryFn: () => getJson<GraphSummary>(GRAPH_ENDPOINTS.summary),
    });
}

export function useSharedTransitGateways() {
    return useQuery({
        queryKey: queryKeys.resourceGraph.byType('ec2_transit_gateways'),
        queryFn: () => getJson<QueryResult>(
            `${GRAPH_ENDPOINTS.query}?predicate=by-type&resourceType=ec2_transit_gateways`,
        ),
    });
}

export function useAccountVpcs(accountId: string | null) {
    return useQuery({
        queryKey: queryKeys.resourceGraph.byType('ec2_vpcs', accountId ?? undefined),
        queryFn: () => getJson<QueryResult>(
            `${GRAPH_ENDPOINTS.query}?predicate=by-type&resourceType=ec2_vpcs&accountId=${encodeURIComponent(accountId!)}`,
        ),
        enabled: Boolean(accountId),
    });
}

export function expandResource(resourceId: string) {
    return getJson<ExpandResult>(`${GRAPH_ENDPOINTS.expand}?resourceId=${encodeURIComponent(resourceId)}`);
}
```

Import `GraphSummary`, `QueryResult` and `ExpandResult` from `@/lib/db/repositories/resource-graph/interface`.

- [ ] **Step 5: Run and watch pass**

```bash
cd apps/web-ui && bunx vitest run tests/resource-graph/
```

Expected: PASS, including every pre-existing test in that directory.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/queries apps/web-ui/tests/resource-graph
git commit -m "feat(resource-graph): add canvas query hooks and the expand fetcher"
```

---

### Task 5: Canvas state store

**Files:**
- Create: `apps/web-ui/lib/stores/graph-canvas-store.ts`
- Test: `apps/web-ui/lib/stores/__tests__/graph-canvas-store.test.ts`

Follow `apps/web-ui/lib/stores/theme-config-store.ts` for style. This store is NOT persisted — a canvas is a working view, not a preference.

**Interfaces:**
- Produces: `useGraphCanvasStore` with state `{ elements: CyElement[]; expanded: Set<string>; selectedId: string | null; hiddenCounts: Record<string, number> }` and actions `reset(elements)`, `addElements(elements)`, `markExpanded(id, hiddenTotal)`, `collapse(id)`, `select(id | null)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphCanvasStore } from '../graph-canvas-store';

const el = (id: string) => ({ data: { id } });

describe('graph canvas store', () => {
    beforeEach(() => { useGraphCanvasStore.getState().reset([]); });

    it('reset replaces everything and clears expansion state', () => {
        const s = useGraphCanvasStore.getState();
        s.addElements([el('a')]);
        s.markExpanded('a', 5);
        s.reset([el('b')]);

        const next = useGraphCanvasStore.getState();
        expect(next.elements.map((e) => e.data.id)).toEqual(['b']);
        expect(next.expanded.size).toBe(0);
        expect(next.hiddenCounts).toEqual({});
    });

    it('addElements ignores an element whose id is already present', () => {
        const s = useGraphCanvasStore.getState();
        s.addElements([el('a')]);
        s.addElements([el('a'), el('b')]);
        expect(useGraphCanvasStore.getState().elements.map((e) => e.data.id)).toEqual(['a', 'b']);
    });

    it('records how many neighbours an expansion withheld', () => {
        const s = useGraphCanvasStore.getState();
        s.markExpanded('vpc-1', 236);
        const next = useGraphCanvasStore.getState();
        expect(next.expanded.has('vpc-1')).toBe(true);
        expect(next.hiddenCounts['vpc-1']).toBe(236);
    });

    it('collapse removes the node from the expanded set so it can be expanded again', () => {
        const s = useGraphCanvasStore.getState();
        s.markExpanded('vpc-1', 0);
        s.collapse('vpc-1');
        expect(useGraphCanvasStore.getState().expanded.has('vpc-1')).toBe(false);
    });

    it('selecting a node does not change what is on the canvas', () => {
        const s = useGraphCanvasStore.getState();
        s.addElements([el('a')]);
        s.select('a');
        const next = useGraphCanvasStore.getState();
        expect(next.selectedId).toBe('a');
        expect(next.elements).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
cd apps/web-ui && bunx vitest run lib/stores/__tests__/graph-canvas-store.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the store**

Create `apps/web-ui/lib/stores/graph-canvas-store.ts` using `create` from `zustand`, no `persist`. `addElements` must de-duplicate on `data.id`. `collapse(id)` removes the id from `expanded` and drops its `hiddenCounts` entry; removing the node's descendants from the canvas is the canvas component's job in Task 6, not the store's.

- [ ] **Step 4: Run and watch pass**

```bash
cd apps/web-ui && bunx vitest run lib/stores/__tests__/graph-canvas-store.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/stores
git commit -m "feat(resource-graph): add the canvas state store"
```

---

### Task 6: The Cytoscape canvas component

> **Why this task and Task 7 carry requirements instead of a full code listing.** Every
> earlier task is a pure function whose exact code belongs in the plan. These two are React
> plus a third-party imperative API, where a blind 400-line listing would be guesswork the
> implementer has to unpick. The requirements below are binding and testable — the exact
> `data-testid` values, the layout options, the interaction contract — and Task 8's E2E
> checks them. Deviating from a numbered requirement is a defect; choosing different JSX to
> satisfy it is not.

**Files:**
- Create: `apps/web-ui/components/resource-graph/graph-canvas.tsx`
- Create: `apps/web-ui/components/resource-graph/graph-styles.ts`
- Test: `apps/web-ui/components/resource-graph/__tests__/graph-styles.test.ts`

**Interfaces:**
- Consumes: the store from Task 5, `CyElement` from Task 3, `colorForType`/`NODE_KIND` from Task 1.
- Produces: `<GraphCanvas onSelect={(id) => void} onExpand={(id) => void} />`, and `buildStylesheet(): cytoscape.StylesheetJson`.

**Requirements — the component is judged against these, not against a code listing:**

1. **One Cytoscape instance**, created in a `useEffect` on mount against a `ref` div, destroyed on unmount. Never recreated when elements change — elements are added with `cy.add()` and removed with `cy.remove()`.
2. **Layout runs incrementally.** On expansion, run `fcose` with `{ animate: false, fit: false, randomize: false }` and lock existing node positions, so the graph does not jump under the user's cursor. Only the initial load may `fit`.
3. **Compound nodes.** An element whose `data.parent` is set nests inside that parent. Parents are styled as translucent rounded rectangles using the CSS custom properties, never as filled circles.
4. **Theme.** All colours come from `getComputedStyle` on the container reading the app's CSS custom properties (`--background`, `--foreground`, `--border`, `--muted-foreground`, `--primary`, `--ring`), except the per-type node colours from `colorForType`. Re-read and restyle when the theme changes.
5. **Edge styling by relation kind**, reusing `kindOf` from `@/lib/resource-graph/relation-kinds`: `traffic` thick with an arrow, `reachability` dashed, `attachment` thin, `observation` hidden by default.
6. **Interaction.** `tap` on a node calls `onSelect`; `dbltap` calls `onExpand`. Tapping the background clears selection.
7. **Withheld neighbours are visible.** A node with a `hiddenCounts` entry renders a badge reading `+N more`. This is a hard requirement — silent truncation is forbidden by the Global Constraints.
8. **`data-testid="resource-graph-canvas"`** on the container, and `data-node-count` reflecting the current node count, so E2E can assert growth without pixel comparisons.

Only `graph-styles.ts` is unit-tested; the component is covered by the E2E in Task 8.

- [ ] **Step 1: Write the failing stylesheet test**

Assert that `buildStylesheet()` returns a selector for each of: `node`, `node.account`, `node.hub`, `$node > node` (compound parent), `edge`, and one per relation kind; that observation edges have `display: none`; and that no colour value in the returned stylesheet is a hardcoded hex outside `RESOURCE_TYPE_COLORS` (every other colour must be a `var(--…)` reference).

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement `graph-styles.ts`, then `graph-canvas.tsx` against requirements 1-8**
- [ ] **Step 4: Run and watch pass**

```bash
cd apps/web-ui && bunx vitest run components/resource-graph/
```

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/resource-graph
git commit -m "feat(resource-graph): add the cytoscape canvas component"
```

---

### Task 7: Page, navigation, and the detail panel

**Files:**
- Create: `apps/web-ui/app/app/resource-graph/page.tsx`
- Create: `apps/web-ui/components/resource-graph/graph-detail-panel.tsx`
- Create: `apps/web-ui/components/resource-graph/graph-toolbar.tsx`
- Modify: `apps/web-ui/lib/nav-config.ts`

**Requirements:**

1. **Nav entry** under Cloud Operations, after Inventory: `{ title: "Resource Graph", href: "/app/resource-graph", module: "Inventory" }`. The `module` annotation is mandatory — `nav-config.ts` documents that an entry no subject claims by `navPath`, carrying no `module`, fails **OPEN** and renders for every role.
2. **Page** is a client component that loads the opening view from `useGraphSummary()` + `useSharedTransitGateways()`, then calls:

```typescript
buildOpeningElements({
    accounts: summary.accounts,
    transitGateways: gateways.nodes,
})
```

Note the unwrapping: `useGraphSummary` resolves to `GraphSummary` (whose `accounts` field is the array) and `useSharedTransitGateways` to `QueryResult` (whose `nodes` field is `GraphNode[]`). Passing either wrapper object straight in is a type error, and passing `gateways` instead of `gateways.nodes` would silently yield zero hubs. Then `reset()` the store with the result.
3. **Tap handling.** Selecting sets `selectedId`. Expanding: an account node loads its VPCs via `useAccountVpcs`; any other node calls `expandResource` then `buildExpansionElements` and `addElements`, and `markExpanded` with the returned `hiddenTotal`.
4. **Detail panel** overlays the right edge, ~320px, `data-testid="graph-detail-panel"`. Shows label, resource type, status, account, region, an **Expand** button (same action as double-tap) and a link to the resource in Inventory. Closes on Escape and on a close button. It must NOT resize the canvas.
5. **Toolbar** across the top: a search input (`data-testid="graph-search"`) that focuses a node by id or name, a count reading "N resources · M accounts", and a relation-kind filter toggle group.
6. **Loading and error states** use the existing `Spinner` primitive and `toast` from sonner. An empty graph shows an explicit message, never a blank canvas.
7. **Both themes** verified by eye in light and dark before finishing.

- [ ] **Step 1: Add the nav entry and confirm the module annotation is present**
- [ ] **Step 2: Build the page, panel and toolbar against requirements 1-7**
- [ ] **Step 3: Verify it runs**

```bash
cd apps/web-ui && bun run dev
```

Open `http://localhost:3001/app/resource-graph`. Confirm: the opening graph renders with two hub nodes; tapping an account adds its VPCs; tapping a VPC adds its contents; the panel opens on single tap and does not move the graph. Report what you saw.

- [ ] **Step 4: Lint and typecheck**

```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "resource-graph|graph-canvas|graph-detail" || echo "clean"
cd apps/web-ui && bunx next lint --dir components/resource-graph --dir app/app/resource-graph --dir lib/resource-graph
```

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/app/resource-graph apps/web-ui/components/resource-graph apps/web-ui/lib/nav-config.ts
git commit -m "feat(resource-graph): add the graph page, detail panel and toolbar"
```

---

### Task 8: E2E coverage — CANCELLED

> **Dropped at the user's instruction (2026-08-25): no Playwright testing.** The task below is
> left in place for the record, not to be executed. Consequence to be aware of: the canvas
> component has no automated coverage of its live behaviour — incremental layout, tap-to-expand,
> tap-to-collapse and the detail panel are verified only by the manual check in Task 7 Step 3.
> Unit tests still cover the pure builders, the store, and the stylesheet.

### Task 8 (not to be run): E2E coverage

**Files:**
- Create: `apps/web-ui-e2e/resource-graph.spec.ts`

Follow the conventions in `apps/web-ui-e2e/` — `getByRole` / `getByTestId`, never `waitForTimeout`, one assertion focus per test.

**Tests:**

1. The page loads and the canvas is present with a non-zero `data-node-count`.
2. Tapping an account node increases `data-node-count`.
3. Tapping the same node again decreases it (collapse).
4. Single-tapping a node opens `graph-detail-panel`; Escape closes it.
5. Typing a known resource id into `graph-search` selects that node.

Never assert pixel positions — the layout is force-directed and non-deterministic.

- [ ] **Step 1: Write the spec file**
- [ ] **Step 2: Run it**

```bash
cd apps/web-ui-e2e && bunx playwright test resource-graph.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui-e2e/resource-graph.spec.ts
git commit -m "test(resource-graph): add canvas e2e coverage"
```

---

## Phase 2 done when

- `cd apps/web-ui && bun run test` passes.
- `bunx tsc --noEmit` reports nothing new in the resource-graph files.
- `/app/resource-graph` opens on the two-hub graph, tapping grows and collapses it, and the panel opens without moving the canvas.
- The page is legible in both light and dark.
- The nav entry carries `module: "Inventory"`.
