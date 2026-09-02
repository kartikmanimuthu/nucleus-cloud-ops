# Resource Graph Dependencies Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Dependencies tab to the inventory resource dialog that shows what depends on a resource and what it depends on, backed by the existing `resource_edges` graph, with a capped depth-1 mini-map above the list.

**Architecture:** One new API route reads both edge directions through a new repository method (two index-targeted queries, each with its own `LIMIT` and a `COUNT(*) OVER ()` total, enriched by a left join to `inventory_resources`). A pure relation-kind module groups rows. A pure layout module computes deterministic mini-map geometry. The tab is presentational; the dialog owns the focus stack; the URL owns the focused resource.

**Tech Stack:** Next.js 15 App Router, React 19, TanStack Query v5, Prisma (`$queryRawUnsafe`), Radix/shadcn primitives, Tailwind, Vitest (jsdom for `.tsx` under `__tests__/`), hand-rolled SVG.

**Spec:** [2026-08-11-resource-graph-ui-design.md](../specs/2026-08-11-resource-graph-ui-design.md)

## Global Constraints

- **Manual tenant scoping.** `$queryRawUnsafe` is **not** intercepted by the `getTenantClient` extension. Every statement carries an explicit `"tenantId" = $1`, including the `LEFT JOIN` predicate — a join that omits it is a cross-tenant read.
- **Repository pattern.** API routes never touch Prisma. Data access goes through `@/lib/db/repository-factory`.
- **RBAC on every route:** `authorize(action, Subject)` from `@/lib/rbac/authorize`, returns `null` (ok) or a `NextResponse` (403).
- **Response shape:** `NextResponse.json({ success: true, data })` or `{ success: false, error: string }`.
- **Do not modify `components/ui/*`** — compose from those primitives.
- **Indentation: 4 spaces** in `apps/web-ui` (matches `resource-detail-dialog.tsx`, `tools.test.ts`).
- **No new dependencies.** The mini-map is hand-rolled SVG; no react-flow, no d3.
- **Colour via Tailwind theme tokens only** (`muted-foreground`, `border`, `destructive`, and the new kind tokens). Never hard-coded hex — light and dark must both work without a second code path.
- **Verify component APIs against installed `.d.ts`** rather than from memory (TanStack Query, Radix). This feature has already produced three bugs from confident-but-wrong assumptions.
- **Run tests from `apps/web-ui`**: `bunx vitest run <path>`. Integration tests need `DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus'` and `docker compose up -d postgres`.
- **Never commit unless asked.** Steps show the commit command; the executing agent runs them, but no pushing.

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/resource-graph/relation-kinds.ts` | relation → kind, kind ordering per direction. Pure. |
| `lib/resource-graph/mini-map-layout.ts` | edges → node/edge geometry. Pure, no React. |
| `lib/db/repositories/resource-graph/interface.ts` | add `getResourceDependencies` + types |
| `lib/db/repositories/resource-graph/postgres.ts` | the two queries + enrichment + freshness |
| `app/api/resource-graph/route.ts` | GET, RBAC, repository call, `asOf` assembly |
| `app/api/inventory/resources/[type]/[id]/route.ts` | single resource with tags + metadata (for pivot) |
| `lib/queries/resource-graph.ts` | `useResourceGraph` hook |
| `lib/queries/query-keys.ts` | `resourceGraph` key factory |
| `lib/rbac/types.ts` | `ResourceGraph: 'Inventory'` subject |
| `components/inventory/resource-dependencies-tab.tsx` | grouped list, states, "+N more" |
| `components/inventory/dependency-mini-map.tsx` | SVG rendering of the layout |
| `components/inventory/resource-detail-dialog.tsx` | 4th tab, focus stack, breadcrumb |
| `app/app/inventory/page.tsx` (+ its client component) | URL ↔ dialog state |

**Mergeable milestone: end of Task 6.** The tab works and is useful. Tasks 7–9 are additive.

---

### Task 1: Relation kinds module

**Files:**
- Create: `apps/web-ui/lib/resource-graph/relation-kinds.ts`
- Test: `apps/web-ui/lib/resource-graph/__tests__/relation-kinds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type RelationKind = 'traffic'|'reachability'|'containment'|'attachment'|'observation'|'other'`; `kindOf(relation: string): RelationKind`; `KIND_LABEL: Record<RelationKind, string>`; `kindOrder(direction: 'dependents'|'dependsOn'): RelationKind[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/lib/resource-graph/__tests__/relation-kinds.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { kindOf, kindOrder, KIND_LABEL } from '../relation-kinds';

describe('kindOf', () => {
    it('classifies traffic-bearing relations', () => {
        expect(kindOf('routes_to_instance')).toBe('traffic');
        expect(kindOf('attached_to_load_balancer')).toBe('traffic');
        expect(kindOf('registers_with_target_group')).toBe('traffic');
        expect(kindOf('origin_is')).toBe('traffic');
    });

    it('classifies containment, attachment, reachability and observation', () => {
        expect(kindOf('in_vpc')).toBe('containment');
        expect(kindOf('has_volume')).toBe('attachment');
        expect(kindOf('allows_ingress_from')).toBe('reachability');
        expect(kindOf('monitors')).toBe('observation');
    });

    // Version skew: a deployed UI may read edges written by a newer worker.
    it('falls back to other for an unknown relation rather than dropping it', () => {
        expect(kindOf('teleports_to')).toBe('other');
    });
});

describe('kindOrder', () => {
    it('leads with traffic for dependents — the question is what breaks', () => {
        expect(kindOrder('dependents')[0]).toBe('traffic');
    });

    it('leads with containment for dependsOn — requirements read foundation-upward', () => {
        expect(kindOrder('dependsOn')[0]).toBe('containment');
    });

    it('ends both orders with other so unknowns sort last', () => {
        expect(kindOrder('dependents').at(-1)).toBe('other');
        expect(kindOrder('dependsOn').at(-1)).toBe('other');
    });

    it('includes every kind exactly once in both directions', () => {
        for (const dir of ['dependents', 'dependsOn'] as const) {
            const order = kindOrder(dir);
            expect(new Set(order).size).toBe(order.length);
            expect(new Set(order)).toEqual(new Set(Object.keys(KIND_LABEL)));
        }
    });
});

// Guard: EDGE_SPECS lives in apps/workers and there is no shared TS lib, so the
// completeness check reads the worker sources as text. See spec §9.
describe('coverage of the discovery relation vocabulary', () => {
    const WORKERS = join(__dirname, '../../../../workers/src/jobs/discovery/services');

    function relationsInSource(): string[] {
        const files = ['edge-spec.ts', 'edge-derivers.ts'];
        const found = new Set<string>();
        for (const file of files) {
            const src = readFileSync(join(WORKERS, file), 'utf-8');
            for (const m of src.matchAll(/relation:\s*'([a-z_]+)'/g)) found.add(m[1]);
        }
        return [...found].sort();
    }

    it('finds the vocabulary (guards the regex itself)', () => {
        const relations = relationsInSource();
        expect(relations.length).toBeGreaterThan(20);
        expect(relations).toContain('in_vpc');
    });

    it('classifies every relation discovery can emit', () => {
        const unmapped = relationsInSource().filter((r) => kindOf(r) === 'other');
        expect(unmapped, `unclassified relations: ${unmapped.join(', ')}`).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/relation-kinds.test.ts`
Expected: FAIL — `Failed to resolve import "../relation-kinds"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web-ui/lib/resource-graph/relation-kinds.ts

/**
 * Discovery's relations are not equivalent: routes_to_instance means live traffic
 * breaks, monitors means an alarm goes stale. Grouping by kind stops the UI from
 * presenting them as interchangeable rows.
 */
export type RelationKind =
    | 'traffic'
    | 'reachability'
    | 'containment'
    | 'attachment'
    | 'observation'
    | 'other';

export const KIND_LABEL: Record<RelationKind, string> = {
    traffic: 'Serves traffic',
    reachability: 'Network reachability',
    containment: 'Runs in / contains',
    attachment: 'Attached / uses',
    observation: 'Observed by',
    other: 'Other',
};

const RELATION_KIND: Record<string, RelationKind> = {
    routes_to_instance: 'traffic',
    attached_to_load_balancer: 'traffic',
    registers_with_target_group: 'traffic',
    origin_is: 'traffic',

    allows_ingress_from: 'reachability',
    allows_egress_to: 'reachability',
    peers_vpc: 'reachability',
    attached_to_tgw: 'reachability',
    attaches_vpc: 'reachability',

    in_vpc: 'containment',
    in_subnet: 'containment',
    in_cluster: 'containment',
    member_of_cluster: 'containment',
    has_member: 'containment',

    has_volume: 'attachment',
    has_network_interface: 'attachment',
    attached_to: 'attachment',
    uses_security_group: 'attachment',
    uses_instance_profile: 'attachment',
    uses_iam_role: 'attachment',
    encrypted_with: 'attachment',
    uses_certificate: 'attachment',

    monitors: 'observation',
    notifies: 'observation',
};

/**
 * Unknown relations return 'other' rather than being dropped. A guard test keeps
 * this unreachable in development; its real job is version skew — a deployed UI
 * reading edges written by a newer worker.
 */
export function kindOf(relation: string): RelationKind {
    return RELATION_KIND[relation] ?? 'other';
}

const DEPENDENTS_ORDER: RelationKind[] = [
    'traffic', 'reachability', 'containment', 'attachment', 'observation', 'other',
];

const DEPENDS_ON_ORDER: RelationKind[] = [
    'containment', 'attachment', 'reachability', 'traffic', 'observation', 'other',
];

/**
 * "What breaks" leads with traffic. "What this needs" reads foundation-upward, so
 * it leads with containment — the VPC it lives in before the certificate it uses.
 */
export function kindOrder(direction: 'dependents' | 'dependsOn'): RelationKind[] {
    return direction === 'dependents' ? DEPENDENTS_ORDER : DEPENDS_ON_ORDER;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/relation-kinds.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/resource-graph/relation-kinds.ts apps/web-ui/lib/resource-graph/__tests__/relation-kinds.test.ts
git commit -m "feat(resource-graph): classify discovery relations by kind"
```

---

### Task 2: Repository `getResourceDependencies`

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`
- Test: `apps/web-ui/tests/resource-graph/repository.integration.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `EnrichedEdge`, `DependencyDirection`, `ResourceDependencies`, and `getResourceDependencies(args: { tenantId: string; resourceType: string; resourceId: string; limit?: number }): Promise<ResourceDependencies>`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe.skipIf(!HAS_DB)('ResourceGraphPostgresRepository (real Postgres)', ...)` block in `apps/web-ui/tests/resource-graph/repository.integration.test.ts`:

```typescript
    describe('getResourceDependencies', () => {
        it('splits inbound and outbound at depth 1', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });

            expect(r.dependents.edges.map((e) => e.relation).sort())
                .toEqual(['attached_to', 'routes_to_instance']);
            expect(r.dependsOn.edges.map((e) => e.relation).sort())
                .toEqual(['in_subnet', 'in_vpc', 'uses_security_group']);
        });

        it('enriches the far endpoint from inventory', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-resolve-me',
            });
            const all = [...r.dependents.edges, ...r.dependsOn.edges];
            // i-resolve-me has an inventory row; its edges' far ends do not.
            expect(all.every((e) => e.other.exists === false)).toBe(true);
        });

        it('marks a far endpoint absent from inventory as exists:false', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });
            const vpc = r.dependsOn.edges.find((e) => e.other.resourceId === 'vpc-1');
            expect(vpc?.other.exists).toBe(false);
            expect(vpc?.other.name).toBeNull();
        });

        it('reports pre-limit totals, not row counts', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1', limit: 1,
            });

            expect(r.dependsOn.edges).toHaveLength(1);
            expect(r.dependsOn.total).toBe(3);
            expect(r.dependsOn.truncated).toBe(true);
        });

        it('caps each direction independently so one cannot starve the other', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1', limit: 1,
            });

            expect(r.dependents.edges).toHaveLength(1);
            expect(r.dependsOn.edges).toHaveLength(1);
        });

        it('does not return another tenant\'s edges', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: OTHER_TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });
            expect(r.dependsOn.edges.map((e) => e.other.resourceId)).toEqual(['vpc-leaked']);
        });

        it('does not enrich from another tenant\'s inventory', async () => {
            // OTHER_TENANT has inventory row i-other-tenant-only; TENANT must not see it.
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });
            expect(r.dependents.edges.every((e) => e.other.accountId === null
                || e.other.accountId === 'acc-1')).toBe(true);
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' bunx vitest run tests/resource-graph/repository.integration.test.ts`
Expected: FAIL — `repo.getResourceDependencies is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `interface.ts`:

```typescript
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
```

and to the interface body:

```typescript
    getResourceDependencies(args: {
        tenantId: string;
        resourceType: string;
        resourceId: string;
        limit?: number;
    }): Promise<ResourceDependencies>;
```

Add to `postgres.ts` (import the new types alongside the existing ones):

```typescript
const DEFAULT_EDGE_LIMIT = 200;

interface RawEnrichedRow {
    relation: string;
    region: string;
    other_type: string;
    other_id: string;
    other_name: string | null;
    other_status: string | null;
    other_account_id: string | null;
    other_exists: boolean;
    owner_account_id: string;
    total: bigint | number;
}

/**
 * One query per direction, each hitting its own covering index. NOT combined with
 * OR: a shared LIMIT would let 5,000 inbound edges crowd out all 3 outbound ones
 * and render an empty section with no truncation signal. (A combined OR does plan
 * fine — BitmapOr across both indexes — so this split is about caps, not speed.)
 */
private dependencySql(direction: 'dependents' | 'dependsOn'): string {
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
               e."accountId"   AS owner_account_id,
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
            this.dependencySql(direction),
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

    const accountIds = [...new Set(
        [...dependents.edges, ...dependsOn.edges]
            .flatMap((e) => [e.other.accountId])
            .filter((a): a is string => Boolean(a)),
    )];

    return { dependents, dependsOn, accountIds };
}
```

> `COUNT(*) OVER ()` is evaluated before `LIMIT`, so `total` is the true pre-limit
> count. Postgres returns it as `bigint`; `Number()` is required or JSON serialisation
> throws.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' bunx vitest run tests/resource-graph/repository.integration.test.ts`
Expected: PASS, all cases including the 7 new ones.

- [ ] **Step 5: Verify no regression in the mocked unit test**

Run: `cd apps/web-ui && bunx vitest run tests/resource-graph/`
Expected: PASS. If `repository.test.ts` mocks the repository shape, add `getResourceDependencies` to its mock.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/db/repositories/resource-graph/ apps/web-ui/tests/resource-graph/repository.integration.test.ts
git commit -m "feat(resource-graph): read both edge directions with enrichment and true totals"
```

---

### Task 3: RBAC subject and API route

**Files:**
- Modify: `apps/web-ui/lib/rbac/types.ts`
- Create: `apps/web-ui/app/api/resource-graph/route.ts`
- Test: `apps/web-ui/app/api/resource-graph/route.test.ts`

**Interfaces:**
- Consumes: `getResourceDependencies` (Task 2).
- Produces: `GET /api/resource-graph?resourceType=&resourceId=` returning `{ success, data: { focus, asOf, dependents, dependsOn } }`.

- [ ] **Step 1: Add the RBAC subject**

In `apps/web-ui/lib/rbac/types.ts`, beside `RightSizing: 'Inventory'`:

```typescript
    // Read-only view of discovered inventory relationships. No update/delete action
    // exists for this subject, so it cannot become a privilege escalation.
    ResourceGraph: 'Inventory',
```

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web-ui/app/api/resource-graph/route.test.ts
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

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

// vi.hoisted is required, not stylistic: vi.mock is hoisted above plain const
// declarations, so a factory that evaluates a bare `mockX` at import time hits a
// temporal dead zone. Matches app/api/accounts/bulk/route.test.ts.
const mockAuthorize = vi.hoisted(() => vi.fn());
const mockGetResourceDependencies = vi.hoisted(() => vi.fn());
const mockResolveResourceType = vi.hoisted(() => vi.fn());
const mockListAccounts = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({
        getResourceDependencies: mockGetResourceDependencies,
        resolveResourceType: mockResolveResourceType,
    }),
    getAccountRepository: () => ({ listByTenant: mockListAccounts }),
}));

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: () => 'tenant-1' }));

import { GET } from './route';

const req = (qs: string) => ({ url: `http://localhost/api/resource-graph?${qs}` }) as never;

const EMPTY = { dependents: { edges: [], total: 0, truncated: false },
                dependsOn: { edges: [], total: 0, truncated: false }, accountIds: [] };

describe('GET /api/resource-graph', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthorize.mockResolvedValue(null);
        mockGetResourceDependencies.mockResolvedValue(EMPTY);
        mockResolveResourceType.mockResolvedValue('ec2_instances');
        mockListAccounts.mockResolvedValue([
            { accountId: 'acc-1', lastSyncedAt: '2026-08-11T00:00:00.000Z' },
        ]);
    });

    it('rejects when RBAC denies', async () => {
        mockAuthorize.mockResolvedValue({ _data: { error: 'forbidden' }, _status: 403 });
        const res = await GET(req('resourceType=ec2_instances&resourceId=i-1'));
        expect((res as never as { _status: number })._status).toBe(403);
        expect(mockGetResourceDependencies).not.toHaveBeenCalled();
    });

    it('400s without resourceId', async () => {
        const res = await GET(req('resourceType=ec2_instances'));
        expect((res as never as { _status: number })._status).toBe(400);
    });

    // Not 404: the UI must still render asOf for an undiscovered resource.
    it('returns 200 with focus.exists false when the resource is not in inventory', async () => {
        mockResolveResourceType.mockResolvedValue(null);
        const res = await GET(req('resourceType=ec2_instances&resourceId=i-nope'));
        const body = (res as never as { _data: { data: { focus: { exists: boolean } } } })._data;
        expect((res as never as { _status: number })._status).toBe(200);
        expect(body.data.focus.exists).toBe(false);
    });

    it('reports the oldest lastSyncedAt across the accounts represented', async () => {
        mockGetResourceDependencies.mockResolvedValue({ ...EMPTY, accountIds: ['acc-1', 'acc-2'] });
        mockListAccounts.mockResolvedValue([
            { accountId: 'acc-1', lastSyncedAt: '2026-08-11T00:00:00.000Z' },
            { accountId: 'acc-2', lastSyncedAt: '2026-08-04T00:00:00.000Z' },
        ]);

        const res = await GET(req('resourceType=ec2_instances&resourceId=i-1'));
        const { asOf } = (res as never as { _data: { data: { asOf: {
            oldestSyncedAt: string | null; accountsRepresented: number; neverScanned: boolean } } } })._data.data;

        expect(asOf.oldestSyncedAt).toBe('2026-08-04T00:00:00.000Z');
        expect(asOf.accountsRepresented).toBe(2);
        expect(asOf.neverScanned).toBe(false);
    });

    it('flags neverScanned when any represented account has no sync time', async () => {
        mockGetResourceDependencies.mockResolvedValue({ ...EMPTY, accountIds: ['acc-1', 'acc-3'] });
        mockListAccounts.mockResolvedValue([
            { accountId: 'acc-1', lastSyncedAt: '2026-08-11T00:00:00.000Z' },
            { accountId: 'acc-3', lastSyncedAt: null },
        ]);

        const res = await GET(req('resourceType=ec2_instances&resourceId=i-1'));
        const { asOf } = (res as never as { _data: { data: { asOf: { neverScanned: boolean } } } })._data.data;
        expect(asOf.neverScanned).toBe(true);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run app/api/resource-graph/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// apps/web-ui/app/api/resource-graph/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getResourceGraphRepository, getAccountRepository } from '@/lib/db/repository-factory';

export async function GET(req: NextRequest) {
    const authError = await authorize('read', 'ResourceGraph');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const { searchParams } = new URL(req.url);
        const resourceId = searchParams.get('resourceId');
        const requestedType = searchParams.get('resourceType');
        if (!resourceId) {
            return NextResponse.json({ success: false, error: 'resourceId is required' }, { status: 400 });
        }

        const repo = getResourceGraphRepository();

        // The id is the authority: a caller-supplied type may be wrong or absent.
        const resolvedType = await repo.resolveResourceType({ tenantId, resourceId });
        const resourceType = resolvedType ?? requestedType;
        if (!resourceType) {
            return NextResponse.json({ success: false, error: 'resourceType is required when the resource is not in inventory' }, { status: 400 });
        }

        const deps = await repo.getResourceDependencies({ tenantId, resourceType, resourceId });

        // Freshness is worst-case across every account in the answer: edges cross
        // accounts, so one account's timestamp would overstate how fresh this is.
        const represented = new Set(deps.accountIds);
        const accounts = await getAccountRepository().listByTenant(tenantId);
        const relevant = accounts.filter((a) => represented.size === 0 || represented.has(a.accountId));
        const times = relevant.map((a) => a.lastSyncedAt).filter(Boolean) as string[];
        const neverScanned = relevant.some((a) => !a.lastSyncedAt);

        return NextResponse.json({
            success: true,
            data: {
                focus: { resourceType, resourceId, exists: resolvedType !== null },
                asOf: {
                    oldestSyncedAt: times.length ? times.slice().sort()[0] : null,
                    accountsRepresented: relevant.length,
                    neverScanned,
                },
                dependents: deps.dependents,
                dependsOn: deps.dependsOn,
            },
        });
    } catch (error) {
        console.error('API - Error fetching resource graph:', error);
        return NextResponse.json({ success: false, error: 'Failed to fetch resource graph' }, { status: 500 });
    }
}
```

- [ ] **Step 5: Verify `getSessionTenantId` and `listByTenant` exist with these signatures**

Run: `cd apps/web-ui && grep -n "export async function getSessionTenantId\|export function getSessionTenantId" lib/auth-session.ts && grep -n "listByTenant" lib/db/repositories/account/interface.ts`
If either differs, adapt the route and the test mock to the real signature — do not invent one.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run app/api/resource-graph/route.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/rbac/types.ts apps/web-ui/app/api/resource-graph/
git commit -m "feat(resource-graph): add read-only dependencies API route"
```

---

### Task 4: Query key and hook

**Files:**
- Modify: `apps/web-ui/lib/queries/query-keys.ts`
- Create: `apps/web-ui/lib/queries/resource-graph.ts`

**Interfaces:**
- Consumes: the route from Task 3.
- Produces: `useResourceGraph({ resourceType, resourceId, enabled })` returning TanStack Query state over `ResourceGraphResponse`; `queryKeys.resourceGraph.detail(type, id)`.

- [ ] **Step 1: Add the query key**

In `apps/web-ui/lib/queries/query-keys.ts`, inside the `queryKeys` object:

```typescript
    resourceGraph: {
        all: ['resourceGraph'] as const,
        details: () => [...queryKeys.resourceGraph.all, 'detail'] as const,
        detail: (resourceType: string, resourceId: string) =>
            [...queryKeys.resourceGraph.details(), resourceType, resourceId] as const,
    },
```

- [ ] **Step 2: Write the hook**

```typescript
// apps/web-ui/lib/queries/resource-graph.ts
'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type { DependencyDirection } from '@/lib/db/repositories/resource-graph/interface';

export interface ResourceGraphAsOf {
    oldestSyncedAt: string | null;
    accountsRepresented: number;
    neverScanned: boolean;
}

export interface ResourceGraphResponse {
    focus: { resourceType: string; resourceId: string; exists: boolean };
    asOf: ResourceGraphAsOf;
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
}

/**
 * `enabled` is driven by tab activation, so opening the dialog costs nothing for
 * users who never look at Dependencies.
 */
export function useResourceGraph(args: {
    resourceType: string;
    resourceId: string;
    enabled: boolean;
}) {
    return useQuery<ResourceGraphResponse>({
        queryKey: queryKeys.resourceGraph.detail(args.resourceType, args.resourceId),
        enabled: args.enabled && Boolean(args.resourceId),
        queryFn: async () => {
            const params = new URLSearchParams({
                resourceType: args.resourceType,
                resourceId: args.resourceId,
            });
            const res = await fetch(`/api/resource-graph?${params.toString()}`);
            const body = await res.json();
            if (!res.ok || !body.success) {
                throw new Error(body.error ?? 'Failed to load dependencies');
            }
            return body.data as ResourceGraphResponse;
        },
    });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: the count matches the pre-existing baseline (181 at time of writing). Any increase is yours to fix.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/queries/query-keys.ts apps/web-ui/lib/queries/resource-graph.ts
git commit -m "feat(resource-graph): add useResourceGraph query hook"
```

---

### Task 5: Dependencies list component

**Files:**
- Create: `apps/web-ui/components/inventory/resource-dependencies-tab.tsx`
- Test: `apps/web-ui/components/inventory/__tests__/resource-dependencies-tab.test.tsx`

**Interfaces:**
- Consumes: `kindOf`, `kindOrder`, `KIND_LABEL` (Task 1); `useResourceGraph`, `ResourceGraphResponse` (Task 4).
- Produces: `<ResourceDependenciesTab resourceType resourceId active onPivot />`.

**Note:** the test path must be under `__tests__/` with a `.tsx` extension to pick up jsdom via the existing `environmentMatchGlobs`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web-ui/components/inventory/__tests__/resource-dependencies-tab.test.tsx
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
        expect(screen.getByText('name-x-1')).toBeTruthy();
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
        const edges = Array.from({ length: 11 }, (_, i) => edge('in_vpc', `vpc-${i}`));
        mockUseResourceGraph.mockReturnValue(ok({
            dependsOn: { edges, total: 11, truncated: false },
        }));
        render(<ResourceDependenciesTab {...props} />);

        expect(screen.queryByText('name-vpc-10')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /3 more/i }));
        expect(screen.getByText('name-vpc-10')).toBeTruthy();
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

        fireEvent.click(screen.getByRole('button', { name: /name-vpc-1/ }));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/inventory/__tests__/resource-dependencies-tab.test.tsx`
Expected: FAIL — cannot resolve `../resource-dependencies-tab`.

- [ ] **Step 3: Confirm the test library is available**

Run: `cd apps/web-ui && ls node_modules/@testing-library/react/package.json`
If missing, find how existing `.test.tsx` files render components (`grep -rl "@testing-library/react" components/`) and follow that. Do not add a dependency.

- [ ] **Step 4: Write minimal implementation**

```tsx
// apps/web-ui/components/inventory/resource-dependencies-tab.tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { useResourceGraph } from '@/lib/queries/resource-graph';
import { kindOf, kindOrder, KIND_LABEL, type RelationKind } from '@/lib/resource-graph/relation-kinds';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

const COLLAPSED_ROWS = 8;

function relativeTime(iso: string): string {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
}

/** Keeps both ends of an ARN visible — the tail is the distinguishing part. */
function middleTruncate(value: string, max = 44): string {
    if (value.length <= max) return value;
    const keep = Math.floor((max - 1) / 2);
    return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function EdgeRow({ edge, onPivot }: { edge: EnrichedEdge; onPivot: (t: string, i: string) => void }) {
    const label = edge.other.name ?? middleTruncate(edge.other.resourceId);
    const subtitle = `${edge.other.resourceType} · ${edge.relation}`;

    if (!edge.other.exists) {
        return (
            <div className="flex flex-col gap-0.5 rounded-md border border-dashed px-3 py-2 opacity-70">
                <span className="font-mono text-sm">{middleTruncate(edge.other.resourceId)}</span>
                <span className="text-xs text-muted-foreground">{subtitle} · not in inventory</span>
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={() => onPivot(edge.other.resourceType, edge.other.resourceId)}
            aria-label={`${label}, ${edge.relation}`}
            className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left hover:bg-muted/60"
        >
            <span className="truncate text-sm font-medium">{label}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{subtitle}</span>
        </button>
    );
}

function Direction({
    title, direction, edges, total, truncated, onPivot,
}: {
    title: string;
    direction: 'dependents' | 'dependsOn';
    edges: EnrichedEdge[];
    total: number;
    truncated: boolean;
    onPivot: (t: string, i: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const shown = expanded ? edges : edges.slice(0, COLLAPSED_ROWS);
    const hidden = edges.length - shown.length;

    const byKind = new Map<RelationKind, EnrichedEdge[]>();
    for (const e of shown) {
        const kind = kindOf(e.relation);
        byKind.set(kind, [...(byKind.get(kind) ?? []), e]);
    }

    return (
        <section className="space-y-3">
            <div className="flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
                <Badge variant="secondary" aria-label={`${title}, ${total} items`}>{total}</Badge>
            </div>

            {edges.length === 0 ? (
                <p className="px-3 text-sm text-muted-foreground">
                    {direction === 'dependents'
                        ? 'Nothing recorded as depending on this resource.'
                        : 'No recorded relationships for this resource.'}
                </p>
            ) : (
                kindOrder(direction)
                    .filter((kind) => byKind.has(kind))
                    .map((kind) => (
                        <div key={kind} className="space-y-1">
                            <p data-testid="kind-heading" className="px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                                {KIND_LABEL[kind]}
                            </p>
                            {byKind.get(kind)!.map((e) => (
                                <EdgeRow key={`${e.relation}-${e.other.resourceId}`} edge={e} onPivot={onPivot} />
                            ))}
                        </div>
                    ))
            )}

            {hidden > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                    +{hidden} more
                </Button>
            )}
            {truncated && (
                <p className="px-3 text-xs text-muted-foreground">
                    showing first {edges.length} of {total}
                </p>
            )}
        </section>
    );
}

export function ResourceDependenciesTab({
    resourceType, resourceId, active, onPivot,
}: {
    resourceType: string;
    resourceId: string;
    active: boolean;
    onPivot: (resourceType: string, resourceId: string) => void;
}) {
    const { data, isLoading, isError, error, refetch } = useResourceGraph({
        resourceType, resourceId, enabled: active,
    });

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Spinner size="sm" /> Loading dependencies…
            </div>
        );
    }

    if (isError || !data) {
        return (
            <div className="space-y-3 p-4">
                <p className="text-sm text-destructive">
                    Could not load dependencies{error instanceof Error ? `: ${error.message}` : ''}.
                </p>
                <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {!data.focus.exists && (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    This resource is not in inventory for this tenant, so the graph has nothing for it.
                    It may not have been discovered yet.
                </p>
            )}

            <Direction
                title="Depends on this"
                direction="dependents"
                edges={data.dependents.edges}
                total={data.dependents.total}
                truncated={data.dependents.truncated}
                onPivot={onPivot}
            />
            <Direction
                title="This depends on"
                direction="dependsOn"
                edges={data.dependsOn.edges}
                total={data.dependsOn.total}
                truncated={data.dependsOn.truncated}
                onPivot={onPivot}
            />

            <p className="border-t pt-3 text-xs text-muted-foreground" title={data.asOf.oldestSyncedAt ?? undefined}>
                {data.asOf.neverScanned
                    ? 'At least one account here has never been scanned — this may be incomplete.'
                    : data.asOf.oldestSyncedAt
                        ? `as of ${relativeTime(data.asOf.oldestSyncedAt)}, across ${data.asOf.accountsRepresented} account(s)`
                        : 'freshness unknown'}
            </p>
        </div>
    );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run components/inventory/__tests__/resource-dependencies-tab.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify `Spinner` and `Badge` export names**

Run: `cd apps/web-ui && grep -n "export" components/ui/spinner.tsx components/ui/badge.tsx | head`
Adapt imports to the real exports if they differ.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/components/inventory/resource-dependencies-tab.tsx apps/web-ui/components/inventory/__tests__/
git commit -m "feat(inventory): add dependencies list with kind grouping and honest empty states"
```

---

### Task 6: Wire the tab into the dialog — **mergeable milestone**

**Files:**
- Modify: `apps/web-ui/components/inventory/resource-detail-dialog.tsx`

**Interfaces:**
- Consumes: `<ResourceDependenciesTab>` (Task 5).
- Produces: a `Dependencies` tab. `onPivot` is a no-op until Task 8.

- [ ] **Step 1: Add the trigger and content**

Change `TabsList` from `grid-cols-3` to `grid-cols-4` and add the trigger after `metadata`:

```tsx
                        <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
```

Track the active tab so the query only fires on activation — replace `<Tabs defaultValue="details" …>` with:

```tsx
                <Tabs
                    value={activeTab}
                    onValueChange={setActiveTab}
                    className="flex-1 overflow-hidden flex flex-col"
                >
```

and add near the top of the component body:

```tsx
    const [activeTab, setActiveTab] = useState('details');
```

Add the content panel alongside the other `TabsContent` blocks:

```tsx
                        <TabsContent value="dependencies" className="mt-0">
                            <ResourceDependenciesTab
                                resourceType={resource.resourceType}
                                resourceId={resource.resourceId}
                                active={activeTab === 'dependencies'}
                                onPivot={() => { /* wired in Task 8 */ }}
                            />
                        </TabsContent>
```

Import at the top:

```tsx
import { ResourceDependenciesTab } from './resource-dependencies-tab';
```

- [ ] **Step 2: Confirm `useState` is imported**

Run: `cd apps/web-ui && grep -n "^import { useState\|useState" components/inventory/resource-detail-dialog.tsx | head -3`
Add `useState` to the existing `react` import if absent.

- [ ] **Step 3: Typecheck and run the inventory tests**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: unchanged from baseline.

Run: `cd apps/web-ui && bunx vitest run components/inventory/`
Expected: PASS.

- [ ] **Step 4: Verify by hand in the running app**

Run: `bun run dev` from the repo root, open `/app/inventory`, click a resource, open **Dependencies**.
Expected: real rows for a resource that has edges (e.g. `i-0bc34f29c893a4bd9` shows 6 under "This depends on"). Check the dev console shows the query only after clicking the tab, not on dialog open.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/inventory/resource-detail-dialog.tsx
git commit -m "feat(inventory): surface resource dependencies in the detail dialog"
```

---

### Task 7: Mini-map

**Files:**
- Create: `apps/web-ui/lib/resource-graph/mini-map-layout.ts`
- Create: `apps/web-ui/components/inventory/dependency-mini-map.tsx`
- Test: `apps/web-ui/lib/resource-graph/__tests__/mini-map-layout.test.ts`
- Test: `apps/web-ui/components/inventory/__tests__/dependency-mini-map.test.tsx`
- Modify: `apps/web-ui/components/inventory/resource-dependencies-tab.tsx`

**Interfaces:**
- Consumes: `EnrichedEdge` (Task 2), `kindOf`/`kindOrder` (Task 1).
- Produces: `computeMiniMap(args): MiniMapLayout` with `MiniMapNode { id, x, y, side, label, resourceType, resourceId, kind, exists }`, `MiniMapEdge { from, to, relation, labelX, labelY }`, `MiniMapLayout { nodes, edges, width, height, overflow: { dependents: number; dependsOn: number }, showEdgeLabels: boolean }`; `<DependencyMiniMap layout onPivot />`.

Layout is a **pure module** so determinism is testable without a DOM.

- [ ] **Step 1: Write the failing layout test**

```typescript
// apps/web-ui/lib/resource-graph/__tests__/mini-map-layout.test.ts
import { describe, it, expect } from 'vitest';
import { computeMiniMap, PER_SIDE_CAP } from '../mini-map-layout';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

const edge = (relation: string, resourceId: string): EnrichedEdge => ({
    relation, region: 'ap-south-1',
    other: { resourceType: 'ec2_vpcs', resourceId, name: `n-${resourceId}`,
             status: null, accountId: 'acc-1', exists: true },
});

const focus = { resourceType: 'ec2_instances', resourceId: 'i-1', label: 'i-1' };

describe('computeMiniMap', () => {
    it('places inbound left, focus centre, outbound right', () => {
        const l = computeMiniMap({ focus, dependents: [edge('in_vpc', 'a')], dependsOn: [edge('in_vpc', 'b')] });
        const left = l.nodes.find((n) => n.resourceId === 'a')!;
        const centre = l.nodes.find((n) => n.side === 'focus')!;
        const right = l.nodes.find((n) => n.resourceId === 'b')!;

        expect(left.x).toBeLessThan(centre.x);
        expect(right.x).toBeGreaterThan(centre.x);
    });

    // The whole point of a fixed layout: no drift between renders.
    it('is deterministic for identical input', () => {
        const args = { focus, dependents: [edge('in_vpc', 'a'), edge('monitors', 'b')], dependsOn: [] };
        expect(computeMiniMap(args)).toEqual(computeMiniMap(args));
    });

    it('caps each side and reports the overflow', () => {
        const many = Array.from({ length: PER_SIDE_CAP + 4 }, (_, i) => edge('in_vpc', `v-${i}`));
        const l = computeMiniMap({ focus, dependents: many, dependsOn: [] });

        expect(l.nodes.filter((n) => n.side === 'dependents')).toHaveLength(PER_SIDE_CAP);
        expect(l.overflow.dependents).toBe(4);
    });

    it('orders a side by kind, matching the list', () => {
        const l = computeMiniMap({
            focus,
            dependents: [edge('monitors', 'obs'), edge('routes_to_instance', 'tg')],
            dependsOn: [],
        });
        const side = l.nodes.filter((n) => n.side === 'dependents').sort((a, b) => a.y - b.y);
        expect(side[0].resourceId).toBe('tg');
    });

    it('suppresses inline edge labels once the graph gets busy', () => {
        const few = computeMiniMap({ focus, dependents: [edge('in_vpc', 'a')], dependsOn: [] });
        expect(few.showEdgeLabels).toBe(true);

        const many = Array.from({ length: 5 }, (_, i) => edge('in_vpc', `v-${i}`));
        const busy = computeMiniMap({ focus, dependents: many, dependsOn: many });
        expect(busy.showEdgeLabels).toBe(false);
    });

    it('emits one edge per node and never exceeds the height ceiling', () => {
        const many = Array.from({ length: PER_SIDE_CAP }, (_, i) => edge('in_vpc', `v-${i}`));
        const l = computeMiniMap({ focus, dependents: many, dependsOn: many });

        expect(l.edges).toHaveLength(PER_SIDE_CAP * 2);
        expect(l.height).toBeLessThanOrEqual(260);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/mini-map-layout.test.ts`
Expected: FAIL — cannot resolve `../mini-map-layout`.

- [ ] **Step 3: Write the layout module**

```typescript
// apps/web-ui/lib/resource-graph/mini-map-layout.ts
import { kindOf, kindOrder, type RelationKind } from './relation-kinds';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

export const PER_SIDE_CAP = 6;
const MAX_HEIGHT = 260;
const ROW_H = 34;
const COL_W = 210;
const INLINE_LABEL_MAX_NODES = 8;

export type Side = 'dependents' | 'focus' | 'dependsOn';

export interface MiniMapNode {
    id: string;
    x: number;
    y: number;
    side: Side;
    label: string;
    resourceType: string;
    resourceId: string;
    kind: RelationKind | null;
    exists: boolean;
}

export interface MiniMapEdge {
    from: string;
    to: string;
    relation: string;
    labelX: number;
    labelY: number;
}

export interface MiniMapLayout {
    nodes: MiniMapNode[];
    edges: MiniMapEdge[];
    width: number;
    height: number;
    overflow: { dependents: number; dependsOn: number };
    showEdgeLabels: boolean;
}

/**
 * Fixed three-column geometry: identical input always yields identical output. A
 * force-directed layout is what turns infrastructure graphs into unreadable webs
 * with overlapping labels, so there is no simulation here at all.
 */
export function computeMiniMap(args: {
    focus: { resourceType: string; resourceId: string; label: string };
    dependents: EnrichedEdge[];
    dependsOn: EnrichedEdge[];
}): MiniMapLayout {
    const pick = (edges: EnrichedEdge[], side: 'dependents' | 'dependsOn') => {
        const order = kindOrder(side);
        const sorted = [...edges].sort((a, b) => {
            const byKind = order.indexOf(kindOf(a.relation)) - order.indexOf(kindOf(b.relation));
            return byKind !== 0 ? byKind : a.other.resourceId.localeCompare(b.other.resourceId);
        });
        return { visible: sorted.slice(0, PER_SIDE_CAP), overflow: Math.max(0, sorted.length - PER_SIDE_CAP) };
    };

    const left = pick(args.dependents, 'dependents');
    const right = pick(args.dependsOn, 'dependsOn');

    const rows = Math.max(left.visible.length, right.visible.length, 1);
    const height = Math.min(MAX_HEIGHT, rows * ROW_H + 24);
    const width = COL_W * 3;
    const midY = height / 2;
    const columnTop = (count: number) => midY - ((count - 1) * ROW_H) / 2;

    const nodes: MiniMapNode[] = [{
        id: 'focus',
        x: COL_W * 1.5,
        y: midY,
        side: 'focus',
        label: args.focus.label,
        resourceType: args.focus.resourceType,
        resourceId: args.focus.resourceId,
        kind: null,
        exists: true,
    }];
    const edges: MiniMapEdge[] = [];

    const place = (
        picked: { visible: EnrichedEdge[] },
        side: 'dependents' | 'dependsOn',
        x: number,
    ) => {
        const top = columnTop(picked.visible.length);
        picked.visible.forEach((e, i) => {
            const id = `${side}:${e.relation}:${e.other.resourceId}`;
            const y = top + i * ROW_H;
            nodes.push({
                id, x, y, side,
                label: e.other.name ?? e.other.resourceId,
                resourceType: e.other.resourceType,
                resourceId: e.other.resourceId,
                kind: kindOf(e.relation),
                exists: e.other.exists,
            });
            edges.push({
                from: side === 'dependents' ? id : 'focus',
                to: side === 'dependents' ? 'focus' : id,
                relation: e.relation,
                labelX: (x + COL_W * 1.5) / 2,
                labelY: (y + midY) / 2,
            });
        });
    };

    place(left, 'dependents', COL_W * 0.5);
    place(right, 'dependsOn', COL_W * 2.5);

    return {
        nodes,
        edges,
        width,
        height,
        overflow: { dependents: left.overflow, dependsOn: right.overflow },
        showEdgeLabels: nodes.length - 1 <= INLINE_LABEL_MAX_NODES,
    };
}
```

- [ ] **Step 4: Run layout test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/resource-graph/__tests__/mini-map-layout.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing component test**

```tsx
// apps/web-ui/components/inventory/__tests__/dependency-mini-map.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { computeMiniMap } from '@/lib/resource-graph/mini-map-layout';
import { DependencyMiniMap } from '../dependency-mini-map';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

const edge = (relation: string, resourceId: string, exists = true): EnrichedEdge => ({
    relation, region: 'ap-south-1',
    other: { resourceType: 'ec2_vpcs', resourceId, name: `n-${resourceId}`,
             status: null, accountId: 'acc-1', exists },
});

const focus = { resourceType: 'ec2_instances', resourceId: 'i-1', label: 'i-1' };

describe('DependencyMiniMap', () => {
    it('renders a node per layout node and pivots on click', () => {
        const onPivot = vi.fn();
        const layout = computeMiniMap({ focus, dependents: [], dependsOn: [edge('in_vpc', 'vpc-1')] });
        render(<DependencyMiniMap layout={layout} onPivot={onPivot} />);

        fireEvent.click(screen.getByRole('button', { name: /n-vpc-1/ }));
        expect(onPivot).toHaveBeenCalledWith('ec2_vpcs', 'vpc-1');
    });

    it('shows the relation on the edge when the graph is small', () => {
        const layout = computeMiniMap({ focus, dependents: [], dependsOn: [edge('in_vpc', 'vpc-1')] });
        render(<DependencyMiniMap layout={layout} onPivot={vi.fn()} />);

        expect(screen.getByText('in_vpc')).toBeTruthy();
    });

    it('does not make a missing resource pivotable', () => {
        const layout = computeMiniMap({ focus, dependents: [], dependsOn: [edge('in_vpc', 'gone', false)] });
        render(<DependencyMiniMap layout={layout} onPivot={vi.fn()} />);

        expect(screen.queryByRole('button', { name: /gone/ })).toBeNull();
    });

    it('renders an overflow affordance when a side is capped', () => {
        const many = Array.from({ length: 10 }, (_, i) => edge('in_vpc', `v-${i}`));
        const layout = computeMiniMap({ focus, dependents: many, dependsOn: [] });
        render(<DependencyMiniMap layout={layout} onPivot={vi.fn()} />);

        expect(screen.getByText(/\+4/)).toBeTruthy();
    });
});
```

- [ ] **Step 6: Run component test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/inventory/__tests__/dependency-mini-map.test.tsx`
Expected: FAIL — cannot resolve `../dependency-mini-map`.

- [ ] **Step 7: Write the component**

```tsx
// apps/web-ui/components/inventory/dependency-mini-map.tsx
'use client';

import type { MiniMapLayout, MiniMapNode } from '@/lib/resource-graph/mini-map-layout';
import type { RelationKind } from '@/lib/resource-graph/relation-kinds';

/** Kind tints. Tailwind classes only, so dark mode needs no second code path. */
const KIND_FILL: Record<RelationKind, string> = {
    traffic: 'fill-chart-1',
    reachability: 'fill-chart-2',
    containment: 'fill-chart-3',
    attachment: 'fill-chart-4',
    observation: 'fill-chart-5',
    other: 'fill-muted',
};

function Node({ node, onPivot }: { node: MiniMapNode; onPivot: (t: string, i: string) => void }) {
    const isFocus = node.side === 'focus';
    const r = isFocus ? 13 : 10;
    const fill = isFocus ? 'fill-primary' : KIND_FILL[node.kind ?? 'other'];
    const anchor = node.side === 'dependents' ? 'end' : 'start';
    const textX = node.side === 'dependents' ? node.x - r - 6 : node.x + r + 6;

    const body = (
        <>
            <circle
                cx={node.x}
                cy={node.y}
                r={r}
                className={`${fill} ${node.exists ? '' : 'opacity-50'}`}
                strokeDasharray={node.exists ? undefined : '3 2'}
                stroke="currentColor"
                strokeOpacity={isFocus ? 0.9 : 0.25}
            />
            <text
                x={isFocus ? node.x : textX}
                y={isFocus ? node.y + r + 14 : node.y + 4}
                textAnchor={isFocus ? 'middle' : anchor}
                className="fill-foreground text-[11px]"
            >
                {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
            </text>
        </>
    );

    if (isFocus || !node.exists) {
        return <g aria-label={node.label}>{body}</g>;
    }

    return (
        <g
            role="button"
            tabIndex={0}
            aria-label={node.label}
            className="cursor-pointer"
            onClick={() => onPivot(node.resourceType, node.resourceId)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onPivot(node.resourceType, node.resourceId);
            }}
        >
            {body}
        </g>
    );
}

export function DependencyMiniMap({
    layout, onPivot,
}: {
    layout: MiniMapLayout;
    onPivot: (resourceType: string, resourceId: string) => void;
}) {
    const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));

    return (
        <svg
            role="img"
            aria-label="Resource dependency map"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="h-auto w-full text-border"
            style={{ maxHeight: layout.height }}
        >
            {layout.edges.map((e) => {
                const from = nodeById.get(e.from)!;
                const to = nodeById.get(e.to)!;
                return (
                    <g key={`${e.from}->${e.to}`}>
                        <line
                            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                            stroke="currentColor" strokeWidth={1}
                        />
                        {layout.showEdgeLabels && (
                            <text
                                x={e.labelX} y={e.labelY - 4}
                                textAnchor="middle"
                                className="fill-muted-foreground text-[9px] uppercase tracking-wide"
                            >
                                {e.relation}
                            </text>
                        )}
                    </g>
                );
            })}

            {layout.nodes.map((n) => <Node key={n.id} node={n} onPivot={onPivot} />)}

            {layout.overflow.dependents > 0 && (
                <text x={8} y={layout.height - 6} className="fill-muted-foreground text-[10px]">
                    +{layout.overflow.dependents} more
                </text>
            )}
            {layout.overflow.dependsOn > 0 && (
                <text x={layout.width - 8} y={layout.height - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
                    +{layout.overflow.dependsOn} more
                </text>
            )}
        </svg>
    );
}
```

- [ ] **Step 8: Verify the chart colour tokens exist**

Run: `cd apps/web-ui && grep -n "chart-1\|chart1\|--chart" tailwind.config.ts app/globals.css | head`
If `chart-*` tokens are absent, define five kind tokens in `globals.css` (light + dark) and reference those instead. Do **not** hard-code hex in the component.

- [ ] **Step 9: Run component test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run components/inventory/__tests__/dependency-mini-map.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 10: Mount the map in the tab**

In `resource-dependencies-tab.tsx`, add the imports:

```tsx
import { computeMiniMap } from '@/lib/resource-graph/mini-map-layout';
import { DependencyMiniMap } from './dependency-mini-map';
```

and render it above the two `<Direction>` blocks, only when there is something to draw:

```tsx
            {(data.dependents.edges.length > 0 || data.dependsOn.edges.length > 0) && (
                <div className="rounded-lg border bg-muted/20 p-4">
                    <DependencyMiniMap
                        layout={computeMiniMap({
                            focus: {
                                resourceType: data.focus.resourceType,
                                resourceId: data.focus.resourceId,
                                label: data.focus.resourceId,
                            },
                            dependents: data.dependents.edges,
                            dependsOn: data.dependsOn.edges,
                        })}
                        onPivot={onPivot}
                    />
                </div>
            )}
```

- [ ] **Step 11: Run the full inventory and resource-graph suites**

Run: `cd apps/web-ui && bunx vitest run components/inventory/ lib/resource-graph/`
Expected: PASS.

- [ ] **Step 12: Verify by hand**

Open `/app/inventory` → a resource with edges → **Dependencies**. Confirm the map draws with relation labels, is stable across re-renders, and looks correct in **both light and dark** themes.

- [ ] **Step 13: Commit**

```bash
git add apps/web-ui/lib/resource-graph/mini-map-layout.ts apps/web-ui/components/inventory/dependency-mini-map.tsx apps/web-ui/lib/resource-graph/__tests__/mini-map-layout.test.ts apps/web-ui/components/inventory/__tests__/dependency-mini-map.test.tsx apps/web-ui/components/inventory/resource-dependencies-tab.tsx
git commit -m "feat(inventory): add deterministic dependency mini-map"
```

---

### Task 8: Single-resource route and pivot

**Files:**
- Create: `apps/web-ui/app/api/inventory/resources/[type]/[id]/route.ts`
- Test: `apps/web-ui/app/api/inventory/resources/[type]/[id]/route.test.ts`
- Modify: `apps/web-ui/components/inventory/resource-detail-dialog.tsx`

**Interfaces:**
- Consumes: `ResourceDetailProps` (existing, in `resource-detail-dialog.tsx`).
- Produces: `GET /api/inventory/resources/:type/:id` → `{ success, data: ResourceDetailProps }`.

- [ ] **Step 1: Find the inventory repository method for a single resource**

Run: `cd apps/web-ui && grep -n "export interface IInventoryRepository" -A 25 lib/db/repositories/inventory/interface.ts`
If no single-resource getter exists, add one (`findOne({ tenantId, resourceType, resourceId })`) to the interface and its Postgres implementation, returning `tags` and `metadata`. Use `getTenantClient(tenantId).inventoryResource.findFirst` so the tenant extension scopes it.

- [ ] **Step 2: Write the failing route test**

```typescript
// apps/web-ui/app/api/inventory/resources/[type]/[id]/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data, _status: init?.status ?? 200,
        })),
    },
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

// vi.hoisted for the same reason as Task 3 — see app/api/accounts/bulk/route.test.ts.
const mockAuthorize = vi.hoisted(() => vi.fn());
const mockFindOne = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));
vi.mock('@/lib/db/repository-factory', () => ({
    getInventoryRepository: () => ({ findOne: mockFindOne }),
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: () => 'tenant-1' }));

import { GET } from './route';

const ctx = { params: Promise.resolve({ type: 'ec2_instances', id: 'i-1' }) };

describe('GET /api/inventory/resources/[type]/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthorize.mockResolvedValue(null);
    });

    it('rejects when RBAC denies', async () => {
        mockAuthorize.mockResolvedValue({ _data: {}, _status: 403 });
        const res = await GET({} as never, ctx);
        expect((res as never as { _status: number })._status).toBe(403);
    });

    it('404s an unknown resource', async () => {
        mockFindOne.mockResolvedValue(null);
        const res = await GET({} as never, ctx);
        expect((res as never as { _status: number })._status).toBe(404);
    });

    it('returns tags and metadata so pivoted tabs are not degraded', async () => {
        mockFindOne.mockResolvedValue({
            resourceId: 'i-1', resourceType: 'ec2_instances', region: 'ap-south-1',
            accountId: 'acc-1', name: 'bastion', status: 'running',
            tags: { Name: 'bastion' }, metadata: { instanceType: 't3.micro' },
            discoveredAt: '2026-08-11T00:00:00.000Z',
        });

        const res = await GET({} as never, ctx);
        const body = (res as never as { _data: { data: { tags: unknown; metadata: unknown } } })._data;
        expect(body.data.tags).toEqual({ Name: 'bastion' });
        expect(body.data.metadata).toEqual({ instanceType: 't3.micro' });
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run "app/api/inventory/resources/[type]/[id]/route.test.ts"`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 4: Write the route**

```typescript
// apps/web-ui/app/api/inventory/resources/[type]/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getInventoryRepository } from '@/lib/db/repository-factory';

export async function GET(
    _req: NextRequest,
    ctx: { params: Promise<{ type: string; id: string }> },
) {
    const authError = await authorize('read', 'Resource');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const { type, id } = await ctx.params;
        const resource = await getInventoryRepository().findOne({
            tenantId,
            resourceType: decodeURIComponent(type),
            resourceId: decodeURIComponent(id),
        });

        if (!resource) {
            return NextResponse.json({ success: false, error: 'Resource not found' }, { status: 404 });
        }

        return NextResponse.json({ success: true, data: resource });
    } catch (error) {
        console.error('API - Error fetching inventory resource:', error);
        return NextResponse.json({ success: false, error: 'Failed to fetch resource' }, { status: 500 });
    }
}
```

> Next 15 passes `params` as a Promise. Awaiting it is required, not optional.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run "app/api/inventory/resources/[type]/[id]/route.test.ts"`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the focus stack and breadcrumb to the dialog**

In `resource-detail-dialog.tsx`:

```tsx
    const [stack, setStack] = useState<ResourceDetailProps[]>([]);
    const focused = stack.length ? stack[stack.length - 1] : resource;

    // A pivot targets a resource we only know by type+id, so hydrate the full row
    // before pushing — otherwise Details/Tags/Metadata would render blank.
    const pivot = async (resourceType: string, resourceId: string) => {
        const res = await fetch(
            `/api/inventory/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`,
        );
        const body = await res.json();
        if (!res.ok || !body.success) {
            toast.error('Could not open that resource', { description: body.error });
            return;
        }
        setStack((prev) => [...prev, body.data as ResourceDetailProps]);
        setActiveTab('dependencies');
    };
```

Reset the stack whenever the dialog closes or the incoming resource changes:

```tsx
    useEffect(() => { setStack([]); }, [resource?.resourceId, open]);
```

Render the breadcrumb above `<Tabs>` when the stack is non-empty:

```tsx
                {stack.length > 0 && (
                    <nav aria-label="Focus trail" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {[resource!, ...stack].map((r, i, all) => (
                            <span key={`${r.resourceType}:${r.resourceId}`} className="flex items-center gap-1">
                                {i > 0 && <span aria-hidden>›</span>}
                                {i === all.length - 1 ? (
                                    <span className="font-medium text-foreground">{r.name || r.resourceId}</span>
                                ) : (
                                    <button
                                        type="button"
                                        className="hover:underline"
                                        onClick={() => setStack((prev) => prev.slice(0, i))}
                                    >
                                        {r.name || r.resourceId}
                                    </button>
                                )}
                            </span>
                        ))}
                    </nav>
                )}
```

Then replace every use of `resource` in the body with `focused`, and pass the real pivot:

```tsx
                            <ResourceDependenciesTab
                                resourceType={focused.resourceType}
                                resourceId={focused.resourceId}
                                active={activeTab === 'dependencies'}
                                onPivot={pivot}
                            />
```

Add imports: `useEffect` from react, `toast` from `sonner`.

- [ ] **Step 7: Typecheck and run the suites**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: unchanged from baseline.

Run: `cd apps/web-ui && bunx vitest run components/inventory/ app/api/inventory/`
Expected: PASS.

- [ ] **Step 8: Verify by hand**

Open a target group with an ECS dependent (`nucleus-cloud-ops-web-ui-tg`), click the dependent, confirm the breadcrumb appears, Details/Tags populate for the pivoted resource, and clicking an earlier crumb returns.

- [ ] **Step 9: Commit**

```bash
git add apps/web-ui/app/api/inventory/resources apps/web-ui/components/inventory/resource-detail-dialog.tsx apps/web-ui/lib/db/repositories/inventory/
git commit -m "feat(inventory): pivot between resources from the dependencies tab"
```

---

### Task 9: URL state

**Files:**
- Modify: the inventory page's client component (find it: `grep -rn "ResourceDetailDialog" apps/web-ui/components apps/web-ui/app`)
- Test: `apps/web-ui/components/inventory/__tests__/resource-detail-url-state.test.tsx`

**Interfaces:**
- Consumes: `ResourceDetailDialog` (Task 8).
- Produces: `?resource=<type>:<id>&tab=dependencies` reflecting and restoring dialog state.

- [ ] **Step 1: Locate the dialog's owner**

Run: `cd apps/web-ui && grep -rn "ResourceDetailDialog" components/ app/ | grep -v __tests__`
The component holding the `selectedResource` state owns the URL sync.

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web-ui/components/inventory/__tests__/resource-detail-url-state.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockPush = vi.fn();
let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: mockPush, replace: vi.fn() }),
    useSearchParams: () => search,
    usePathname: () => '/app/inventory',
}));

// Replace with the real owner component discovered in Step 1.
import { InventoryClientComponent } from '../inventory-client-component';

describe('inventory URL state', () => {
    beforeEach(() => { vi.clearAllMocks(); search = new URLSearchParams(); });

    it('restores the dialog from the URL on a cold load', async () => {
        search = new URLSearchParams('resource=ec2_instances:i-1&tab=dependencies');
        render(<InventoryClientComponent />);

        expect(await screen.findByRole('dialog')).toBeTruthy();
    });

    it('pushes history when a resource is opened', async () => {
        render(<InventoryClientComponent />);
        // Trigger opening the first resource row, then:
        expect(mockPush).toHaveBeenCalledWith(
            expect.stringContaining('resource=ec2_instances%3Ai-1'),
            expect.anything(),
        );
    });
});
```

> Adapt the import, the render props and the row-click trigger to the real
> component. Keep both assertions: cold-load restore and history push.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/inventory/__tests__/resource-detail-url-state.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement the URL sync**

In the owner component:

```tsx
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const urlResource = searchParams.get('resource');
    const urlTab = searchParams.get('tab') ?? undefined;

    // Pivot is navigation, so push: Back walks the trail the breadcrumb advertises
    // rather than discarding it by closing the dialog.
    const openResource = (r: ResourceDetailProps, tab?: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('resource', `${r.resourceType}:${r.resourceId}`);
        if (tab) params.set('tab', tab);
        router.push(`${pathname}?${params.toString()}`, { scroll: false });
    };

    const closeResource = () => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('resource');
        params.delete('tab');
        router.push(`${pathname}?${params.toString()}`, { scroll: false });
    };
```

Derive the open resource from `urlResource` (hydrating via the Task 8 route when it
is not in the loaded page), and pass `urlTab` as the dialog's initial tab.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run components/inventory/__tests__/resource-detail-url-state.test.tsx`
Expected: PASS.

- [ ] **Step 6: Verify by hand**

Copy the URL with a dialog open, paste it in a new tab — the same resource opens on
the same tab. Pivot twice, then press Back twice and confirm the focus walks back.

- [ ] **Step 7: Run the whole web-ui suite and typecheck**

Run: `cd apps/web-ui && bunx vitest run 2>&1 | tail -5`
Expected: no new failures versus the pre-existing baseline (~59 unrelated failures at time of writing).

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: 181, the baseline.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/components/inventory apps/web-ui/app/app/inventory
git commit -m "feat(inventory): make the resource dialog deep-linkable"
```

---

## Self-review notes

**Spec coverage.** §1 → Task 1. §2 → Task 3. §3 → Task 2. §4 → Task 8. §5 list → Task 5; mini-map → Task 7; interaction details → Tasks 5, 8, 9. §6 states → Task 5. §7 testing → distributed. §8 visual standards → Tasks 5 and 7. §9 mapping location → Task 1's guard test. §11 exclusions respected: no multi-hop, no depth control, no filters, no grid badge.

**Two things the spec asks for that are deliberately light here**, because they are judgement rather than logic and are best done against real screens: the copy-to-clipboard affordance on each row (§5 interaction details) and the final alignment/whitespace pass (§8). Both belong to Task 5 and Task 7 review, not to a separate task.

**Known adaptation points.** Task 3 Step 5, Task 5 Step 3/6, Task 7 Step 8, Task 8 Step 1 and Task 9 Step 1 all instruct the implementer to verify a real signature or token before coding. That is deliberate: three bugs in this feature so far came from confident assumptions about names. Verify, do not invent.
