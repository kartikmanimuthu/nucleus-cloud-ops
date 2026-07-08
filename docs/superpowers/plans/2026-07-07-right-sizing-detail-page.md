# Right Sizing Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped `recommendation-detail-dialog.tsx` modal with a dedicated `/app/right-sizing/[id]` page that has room for a resource context panel, per-metric charts, and a reasoning breakdown, plus prev/next triage navigation through the filtered list.

**Architecture:** A thin server-component route (`app/app/right-sizing/[id]/page.tsx`) renders a client component (`RecommendationDetailPage`) that fetches one new `GET /api/right-sizing/recommendations/[id]` endpoint via a new TanStack Query hook. That endpoint composes three *existing* repository methods (`RightSizingService.getRecommendation`, `getInventoryRepository().getResource`, `getAccountRepository().getAccount`) — no schema changes, no new repository methods. Prev/next re-uses the existing list endpoint at a larger page size to compute position. Two small pure-function modules (`console-links.ts`, `reasoning.ts`) drive the new content sections and are unit-tested directly.

**Tech Stack:** Next.js 15 App Router, TanStack Query, Vitest, Recharts, shadcn/ui, sonner.

## Global Constraints

- Every DB query stays tenant-scoped (`tenantId` passed through on every call) — no raw SQL added by this plan.
- Every route calls `authorize(action, 'RightSizing')` before touching data.
- No Prisma calls directly in routes/services — only repository-factory methods.
- No schema changes and no new CloudWatch/AWS calls — charts and reasoning use the `metricsSummary` already stored on the recommendation.
- `apps/web-ui/tsconfig.json` strict mode — no `any` in new code (test files may use `as any` for mock casting, matching existing test conventions).
- Vitest test file style matches `apps/web-ui/lib/right-sizing-service.test.ts` (service tests) and `apps/web-ui/app/api/skills/[id]/route.test.ts` (route tests) exactly — same mocking shape.
- Run tests with `cd apps/web-ui && npx vitest run <path>`.

---

### Task 1: `RightSizingService.getRecommendationDetail`

**Files:**
- Modify: `apps/web-ui/lib/right-sizing-service.ts`
- Modify: `apps/web-ui/lib/right-sizing-service.test.ts`

**Interfaces:**
- Consumes: `getRightSizingRepository().getRecommendation(id, tenantId)` (exists), `getInventoryRepository().getResource(tenantId, accountId, resourceType, resourceId)` (exists), `getAccountRepository().getAccount(accountId, tenantId)` (exists) — all from `@/lib/db/repository-factory`.
- Produces: `RightSizingService.getRecommendationDetail(id: string, tenantId: string): Promise<RecommendationDetail | null>` and the exported `RecommendationDetail` interface — both consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to the top of `apps/web-ui/lib/right-sizing-service.test.ts`, replacing the existing mock block:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoMock = {
    getRecommendation: vi.fn(),
    updateStatus: vi.fn(),
    getActiveRun: vi.fn(),
    createRun: vi.fn(),
};
const inventoryRepoMock = { getResource: vi.fn() };
const accountRepoMock = { getAccount: vi.fn() };
const bossSend = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({
    getRightSizingRepository: () => repoMock,
    getInventoryRepository: () => inventoryRepoMock,
    getAccountRepository: () => accountRepoMock,
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/boss-client', () => ({
    getBoss: vi.fn().mockResolvedValue({ send: (...args: unknown[]) => bossSend(...args) }),
}));

import { RightSizingService } from './right-sizing-service';
```

Then append this new `describe` block at the end of the file:

```ts
describe('RightSizingService.getRecommendationDetail', () => {
    beforeEach(() => {
        repoMock.getRecommendation.mockReset();
        inventoryRepoMock.getResource.mockReset();
        accountRepoMock.getAccount.mockReset();
    });

    it('returns null when the recommendation is not found (no cross-tenant leak)', async () => {
        repoMock.getRecommendation.mockResolvedValue(null);
        const result = await RightSizingService.getRecommendationDetail('rec-x', 'tenant-a');
        expect(result).toBeNull();
        expect(inventoryRepoMock.getResource).not.toHaveBeenCalled();
        expect(accountRepoMock.getAccount).not.toHaveBeenCalled();
    });

    it('composes recommendation + resource + account when all three exist', async () => {
        repoMock.getRecommendation.mockResolvedValue({
            id: 'rec-1',
            accountId: '123456789012',
            resourceType: 'ec2_instances',
            resourceId: 'i-1',
        });
        inventoryRepoMock.getResource.mockResolvedValue({ id: 'inv-1', metadata: { vpcId: 'vpc-1' } });
        accountRepoMock.getAccount.mockResolvedValue({ id: 'acc-1', name: 'Prod' });

        const result = await RightSizingService.getRecommendationDetail('rec-1', 'tenant-a');

        expect(result?.recommendation.id).toBe('rec-1');
        expect(result?.resource?.metadata).toEqual({ vpcId: 'vpc-1' });
        expect(result?.account?.name).toBe('Prod');
        expect(inventoryRepoMock.getResource).toHaveBeenCalledWith('tenant-a', '123456789012', 'ec2_instances', 'i-1');
        expect(accountRepoMock.getAccount).toHaveBeenCalledWith('123456789012', 'tenant-a');
    });

    it('degrades gracefully when the inventory/account lookups fail or return null', async () => {
        repoMock.getRecommendation.mockResolvedValue({
            id: 'rec-1',
            accountId: '123456789012',
            resourceType: 'ec2_instances',
            resourceId: 'i-1',
        });
        inventoryRepoMock.getResource.mockRejectedValue(new Error('boom'));
        accountRepoMock.getAccount.mockResolvedValue(null);

        const result = await RightSizingService.getRecommendationDetail('rec-1', 'tenant-a');

        expect(result?.recommendation.id).toBe('rec-1');
        expect(result?.resource).toBeNull();
        expect(result?.account).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && npx vitest run lib/right-sizing-service.test.ts`
Expected: FAIL — `RightSizingService.getRecommendationDetail is not a function`

- [ ] **Step 3: Implement `getRecommendationDetail`**

In `apps/web-ui/lib/right-sizing-service.ts`, update the imports at the top:

```ts
import { getRightSizingRepository, getInventoryRepository, getAccountRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import type {
    RecommendationFilters,
    RecommendationPage,
    RecommendationStatus,
    RightSizingRecommendation,
    RightSizingSummary,
    RightSizingRun,
} from '@/lib/db/repositories/right-sizing/interface';
import type { InventoryResource } from '@/lib/db/repositories/inventory/interface';
import type { UIAccount } from '@/lib/types';

export interface RecommendationDetail {
    recommendation: RightSizingRecommendation;
    resource: InventoryResource | null;
    account: UIAccount | null;
}
```

Add this method to the `RightSizingService` class, right after `getRecommendation`:

```ts
    /**
     * Full detail for the recommendation detail page: the recommendation plus best-effort
     * context from inventory (resource metadata) and accounts (display name). The recommendation
     * itself is the only thing that 404s the page — a missing/failed join degrades to a null
     * field rather than failing the whole request.
     */
    static async getRecommendationDetail(id: string, tenantId: string): Promise<RecommendationDetail | null> {
        const recommendation = await getRightSizingRepository().getRecommendation(id, tenantId);
        if (!recommendation) return null;

        const [resource, account] = await Promise.all([
            getInventoryRepository()
                .getResource(tenantId, recommendation.accountId, recommendation.resourceType, recommendation.resourceId)
                .catch(() => null),
            getAccountRepository()
                .getAccount(recommendation.accountId, tenantId)
                .catch(() => null),
        ]);

        return { recommendation, resource, account };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && npx vitest run lib/right-sizing-service.test.ts`
Expected: PASS — all `getRecommendationDetail` + existing `updateStatus`/`triggerScan` tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/right-sizing-service.ts apps/web-ui/lib/right-sizing-service.test.ts
git commit -m "feat(right-sizing): add getRecommendationDetail service method"
```

---

### Task 2: `GET /api/right-sizing/recommendations/[id]`

**Files:**
- Modify: `apps/web-ui/app/api/right-sizing/recommendations/[id]/route.ts` (currently exports only `PATCH`)
- Create: `apps/web-ui/app/api/right-sizing/recommendations/[id]/route.test.ts`

**Interfaces:**
- Consumes: `RightSizingService.getRecommendationDetail(id, tenantId)` from Task 1.
- Produces: `GET` handler returning `{ success: true, data: RecommendationDetail }` (200) or `{ success: false, error }` (404) — consumed by Task 3's query hook.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/app/api/right-sizing/recommendations/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
            status: init?.status ?? 200,
            json: async () => data,
        })),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getSessionUserId: vi.fn(),
}));
vi.mock('@/lib/right-sizing-service', () => ({
    RightSizingService: {
        getRecommendationDetail: vi.fn(),
        updateStatus: vi.fn(),
    },
}));

import { GET } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const makeRequest = () => ({}) as any;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    vi.mocked(authorize).mockResolvedValue(null);
});

describe('GET /api/right-sizing/recommendations/[id]', () => {
    it('returns 200 with the composed detail on success', async () => {
        const detail = {
            recommendation: { id: 'rec-1', tenantId: 'tenant-a' },
            resource: { id: 'inv-1' },
            account: { id: 'acc-1' },
        };
        vi.mocked(RightSizingService.getRecommendationDetail).mockResolvedValue(detail as any);

        const res = await GET(makeRequest(), makeParams('rec-1'));

        expect((res as any)._status).toBe(200);
        expect((res as any)._data.success).toBe(true);
        expect((res as any)._data.data).toEqual(detail);
        expect(RightSizingService.getRecommendationDetail).toHaveBeenCalledWith('rec-1', 'tenant-a');
    });

    it('returns 404 when the recommendation is not found', async () => {
        vi.mocked(RightSizingService.getRecommendationDetail).mockResolvedValue(null);

        const res = await GET(makeRequest(), makeParams('missing'));

        expect((res as any)._status).toBe(404);
        expect((res as any)._data.success).toBe(false);
        expect((res as any)._data.error).toBe('Recommendation not found');
    });

    it('returns 403 when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({ status: 403, _data: { error: 'Forbidden' }, _status: 403 } as any);

        const res = await GET(makeRequest(), makeParams('rec-1'));

        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && npx vitest run app/api/right-sizing/recommendations/[id]/route.test.ts`
Expected: FAIL — `GET is not exported from './route'`

- [ ] **Step 3: Add the GET handler**

In `apps/web-ui/app/api/right-sizing/recommendations/[id]/route.ts`, add this above the existing `PATCH` export (keep `PATCH` exactly as-is):

```ts
// GET /api/right-sizing/recommendations/[id] — full detail for the recommendation detail page
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('read', 'RightSizing');
    if (authError) return authError;

    try {
        const { id } = await params;
        const tenantId = await getSessionTenantId();
        const detail = await RightSizingService.getRecommendationDetail(id, tenantId);
        if (!detail) {
            return NextResponse.json({ success: false, error: 'Recommendation not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: detail });
    } catch (error: unknown) {
        console.error('API - Error fetching right-sizing recommendation detail:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch recommendation' },
            { status: 500 }
        );
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && npx vitest run app/api/right-sizing/recommendations/[id]/route.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/right-sizing/recommendations/[id]/route.ts apps/web-ui/app/api/right-sizing/recommendations/[id]/route.test.ts
git commit -m "feat(right-sizing): add GET /api/right-sizing/recommendations/[id]"
```

---

### Task 3: Query hooks — `useRightSizingRecommendation` + `useUpdateRightSizingRecommendation`

**Files:**
- Modify: `apps/web-ui/lib/queries/query-keys.ts`
- Modify: `apps/web-ui/lib/queries/right-sizing.ts`

**Interfaces:**
- Consumes: `GET`/`PATCH /api/right-sizing/recommendations/[id]` from Task 2 (GET) and the pre-existing PATCH route.
- Produces: `useRightSizingRecommendation(id): UseQueryResult<RightSizingRecommendationDetail>`, `useUpdateRightSizingRecommendation(): UseMutationResult<...>`, `queryKeys.rightSizing.detail(id)` — all consumed by Task 8.

- [ ] **Step 1: Add the query keys**

In `apps/web-ui/lib/queries/query-keys.ts`, replace the `rightSizing` block with:

```ts
    rightSizing: {
        all: ['right-sizing'] as const,
        recommendations: (filters?: unknown) =>
            [...queryKeys.rightSizing.all, 'recommendations', filters ?? {}] as const,
        summary: () => [...queryKeys.rightSizing.all, 'summary'] as const,
        details: () => [...queryKeys.rightSizing.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.rightSizing.details(), id] as const,
    },
```

- [ ] **Step 2: Add the hooks**

In `apps/web-ui/lib/queries/right-sizing.ts`, add these imports alongside the existing ones:

```ts
import type {
    RightSizingRecommendation,
    RightSizingSummary,
    RecommendationStatus,
} from '@/lib/db/repositories/right-sizing/interface';
import type { InventoryResource } from '@/lib/db/repositories/inventory/interface';
import type { UIAccount } from '@/lib/types';
```

(`RecommendationStatus` and the two new type imports are additions; keep the existing `RightSizingRecommendation`/`RightSizingSummary` import.)

Append this to the end of the file:

```ts
export interface RightSizingRecommendationDetail {
    recommendation: RightSizingRecommendation;
    resource: InventoryResource | null;
    account: UIAccount | null;
}

export function useRightSizingRecommendation(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.rightSizing.detail(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<RightSizingRecommendationDetail> => {
            const res = await fetch(`/api/right-sizing/recommendations/${id}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Recommendation not found');
            }
            return json.data as RightSizingRecommendationDetail;
        },
    });
}

/** Approve / dismiss / snooze / reopen a recommendation. Invalidates both the list and detail caches. */
export function useUpdateRightSizingRecommendation() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({
            id,
            status,
            snoozeUntil,
        }: {
            id: string;
            status: RecommendationStatus;
            snoozeUntil?: string;
        }): Promise<RightSizingRecommendation> => {
            const res = await fetch(`/api/right-sizing/recommendations/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, snoozeUntil }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to update recommendation');
            }
            return json.data as RightSizingRecommendation;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.rightSizing.all });
        },
    });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: no new errors from `lib/queries/right-sizing.ts` or `lib/queries/query-keys.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/queries/query-keys.ts apps/web-ui/lib/queries/right-sizing.ts
git commit -m "feat(right-sizing): add single-recommendation query + update mutation hooks"
```

---

### Task 4: `buildConsoleUrl` pure function

**Files:**
- Create: `apps/web-ui/lib/right-sizing/console-links.ts`
- Create: `apps/web-ui/lib/right-sizing/console-links.test.ts`

**Interfaces:**
- Consumes: `RESOURCE_TYPES` from `@/lib/right-sizing/types` (exists).
- Produces: `buildConsoleUrl(resourceType: string, region: string, resourceId: string): string | null` — consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/right-sizing/console-links.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildConsoleUrl } from './console-links';
import { RESOURCE_TYPES } from './types';

describe('buildConsoleUrl', () => {
    it('builds an EC2 instance console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.EC2, 'ap-south-1', 'i-0a9cb077870bea18b')).toBe(
            'https://ap-south-1.console.aws.amazon.com/ec2/home?region=ap-south-1#InstanceDetails:instanceId=i-0a9cb077870bea18b'
        );
    });

    it('builds an EBS volume console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.EBS, 'ap-south-1', 'vol-0569512768763aa4c')).toBe(
            'https://ap-south-1.console.aws.amazon.com/ec2/home?region=ap-south-1#VolumeDetails:volumeId=vol-0569512768763aa4c'
        );
    });

    it('builds an RDS instance console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.RDS, 'ap-south-1', 'db-prod-1')).toBe(
            'https://ap-south-1.console.aws.amazon.com/rds/home?region=ap-south-1#database:id=db-prod-1;is-cluster=false'
        );
    });

    it('builds an ASG console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.ASG, 'ap-south-1', 'my-asg')).toBe(
            'https://ap-south-1.console.aws.amazon.com/ec2autoscaling/home?region=ap-south-1#/details/my-asg'
        );
    });

    it('returns null for an unknown resource type', () => {
        expect(buildConsoleUrl('unknown_type', 'ap-south-1', 'x-1')).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && npx vitest run lib/right-sizing/console-links.test.ts`
Expected: FAIL — module `./console-links` not found.

- [ ] **Step 3: Implement `buildConsoleUrl`**

Create `apps/web-ui/lib/right-sizing/console-links.ts`:

```ts
import { RESOURCE_TYPES, type ResourceTypeKey } from './types';

/**
 * Deep link into the AWS console for a resource, scoped to its own region. Points at the
 * *member* account's console — the viewer needs their own access to that account (e.g. via
 * AWS SSO) for the link to resolve; this is a convenience link, not an assumed-role hop.
 * Returns null for resource types without a known console URL shape.
 */
export function buildConsoleUrl(resourceType: string, region: string, resourceId: string): string | null {
    switch (resourceType as ResourceTypeKey) {
        case RESOURCE_TYPES.EC2:
            return `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${resourceId}`;
        case RESOURCE_TYPES.EBS:
            return `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#VolumeDetails:volumeId=${resourceId}`;
        case RESOURCE_TYPES.RDS:
            return `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${resourceId};is-cluster=false`;
        case RESOURCE_TYPES.ASG:
            return `https://${region}.console.aws.amazon.com/ec2autoscaling/home?region=${region}#/details/${resourceId}`;
        default:
            return null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && npx vitest run lib/right-sizing/console-links.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/right-sizing/console-links.ts apps/web-ui/lib/right-sizing/console-links.test.ts
git commit -m "feat(right-sizing): add AWS console deep-link builder"
```

---

### Task 5: `buildReasoningLines` pure function

**Files:**
- Create: `apps/web-ui/lib/right-sizing/reasoning.ts`
- Create: `apps/web-ui/lib/right-sizing/reasoning.test.ts`

**Interfaces:**
- Consumes: `RIGHT_SIZING_CONFIG` from `@/lib/right-sizing/config` (exists), `RESOURCE_TYPES`/`MetricsSummary` from `@/lib/right-sizing/types` (exists).
- Produces: `buildReasoningLines(resourceType: string, metricsSummary: MetricsSummary): string[]` — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/right-sizing/reasoning.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildReasoningLines } from './reasoning';
import { RESOURCE_TYPES } from './types';
import type { MetricsSummary } from './types';

const sig = (avg: number, p95: number) => ({ avg, p95, p99: p95, max: p95, count: 232 });

describe('buildReasoningLines', () => {
    it('flags EC2 CPU below the over-provisioned threshold', () => {
        const summary: MetricsSummary = { cpu: sig(18.3, 25.5), coverageDays: 9.67, datapointDensity: 0.69 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[0]).toContain('below the 40% over-provisioned threshold');
    });

    it('flags EC2 CPU above the under-provisioned threshold', () => {
        const summary: MetricsSummary = { cpu: sig(90, 95), coverageDays: 14, datapointDensity: 1 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[0]).toContain('above the 85% under-provisioned threshold');
    });

    it('reports high confidence when coverage and density both clear the threshold', () => {
        const summary: MetricsSummary = { cpu: sig(50, 60), coverageDays: 14, datapointDensity: 1 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[1]).toContain('high confidence');
    });

    it('reports low confidence when coverage is below the threshold', () => {
        const summary: MetricsSummary = { cpu: sig(50, 60), coverageDays: 9.67, datapointDensity: 0.69 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[1]).toContain('below the 7-day / 80% threshold');
    });

    it('omits the CPU line for EBS (no CPU-based threshold)', () => {
        const summary: MetricsSummary = { coverageDays: 14, datapointDensity: 1 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EBS, summary);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('high confidence');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && npx vitest run lib/right-sizing/reasoning.test.ts`
Expected: FAIL — module `./reasoning` not found.

- [ ] **Step 3: Implement `buildReasoningLines`**

Create `apps/web-ui/lib/right-sizing/reasoning.ts`:

```ts
import { RIGHT_SIZING_CONFIG } from './config';
import { RESOURCE_TYPES, type ResourceTypeKey, type MetricsSummary } from './types';

const CPU_THRESHOLDS: Partial<Record<ResourceTypeKey, { cpuOverProvisionedPct: number; cpuUnderProvisionedPct: number }>> = {
    [RESOURCE_TYPES.EC2]: RIGHT_SIZING_CONFIG.ec2,
    [RESOURCE_TYPES.RDS]: RIGHT_SIZING_CONFIG.rds,
    [RESOURCE_TYPES.ASG]: RIGHT_SIZING_CONFIG.asg,
};

/**
 * Plain-language breakdown of why a finding fired: the CPU threshold comparison (for resource
 * types that have one) plus a confidence/coverage line. Reads straight from RIGHT_SIZING_CONFIG
 * so the numbers shown always match the engine that actually produced the recommendation.
 * Idle-finding specifics (network-byte threshold, EBS "available" state) aren't broken down
 * here — only the over/under-provisioned CPU comparison and confidence drivers.
 */
export function buildReasoningLines(resourceType: string, metricsSummary: MetricsSummary): string[] {
    const lines: string[] = [];
    const thresholds = CPU_THRESHOLDS[resourceType as ResourceTypeKey];
    const cpu = metricsSummary.cpu;

    if (thresholds && cpu) {
        const { cpuOverProvisionedPct, cpuUnderProvisionedPct } = thresholds;
        const verdict =
            cpu.p95 < cpuOverProvisionedPct
                ? `below the ${cpuOverProvisionedPct}% over-provisioned threshold.`
                : cpu.p95 > cpuUnderProvisionedPct
                  ? `above the ${cpuUnderProvisionedPct}% under-provisioned threshold.`
                  : `within the normal ${cpuOverProvisionedPct}–${cpuUnderProvisionedPct}% range.`;
        lines.push(`CPU avg ${cpu.avg.toFixed(1)}%, p95 ${cpu.p95.toFixed(1)}% — ${verdict}`);
    }

    const { coverageDays, datapointDensity } = metricsSummary;
    const { lookbackDays, minCoverageDaysHighConfidence, minDatapointDensityHighConfidence } = RIGHT_SIZING_CONFIG;
    const highConfidence =
        coverageDays >= minCoverageDaysHighConfidence && datapointDensity >= minDatapointDensityHighConfidence;
    const coverageDesc = `${coverageDays.toFixed(1)} of ${lookbackDays} lookback days observed (${Math.round(datapointDensity * 100)}% density)`;
    lines.push(
        highConfidence
            ? `${coverageDesc} — high confidence.`
            : `${coverageDesc} — below the ${minCoverageDaysHighConfidence}-day / ${Math.round(minDatapointDensityHighConfidence * 100)}% threshold for high confidence.`
    );

    return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && npx vitest run lib/right-sizing/reasoning.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/right-sizing/reasoning.ts apps/web-ui/lib/right-sizing/reasoning.test.ts
git commit -m "feat(right-sizing): add threshold reasoning breakdown"
```

---

### Task 6: `ResourceContextPanel` component (+ move `ConfigTable` into `shared.tsx`)

**Files:**
- Modify: `apps/web-ui/components/right-sizing/shared.tsx`
- Create: `apps/web-ui/components/right-sizing/resource-context-panel.tsx`

**Interfaces:**
- Consumes: `buildConsoleUrl` (Task 4), `RightSizingRecommendation` / `InventoryResource` / `UIAccount` types (exist).
- Produces: `ConfigTable({ title, config })` exported from `shared.tsx`, `ResourceContextPanel({ recommendation, resource, account })` — both consumed by Task 8.

No unit test for this step — it's presentational composition of already-tested pieces (`buildConsoleUrl`) and plain JSX; verified visually in Task 12's manual pass, consistent with how `summary-cards.tsx` / `recommendations-table.tsx` have no component tests today.

- [ ] **Step 1: Move `ConfigTable` into `shared.tsx`**

Append to the end of `apps/web-ui/components/right-sizing/shared.tsx`:

```tsx
export function ConfigTable({ title, config }: { title: string; config: Record<string, unknown> | null | undefined }) {
    const entries = config ? Object.entries(config).filter(([, v]) => v != null) : [];
    return (
        <div className="rounded-md border p-3">
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{title}</div>
            {entries.length === 0 ? (
                <div className="text-sm text-muted-foreground">—</div>
            ) : (
                <dl className="space-y-1">
                    {entries.map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-4 text-sm">
                            <dt className="text-muted-foreground">{k}</dt>
                            <dd className="text-right font-medium">{String(v)}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    );
}
```

(Leave `recommendation-detail-dialog.tsx`'s own local `ConfigTable` untouched for now — it's deleted whole in Task 11, so there's no naming conflict in the meantime.)

- [ ] **Step 2: Create `ResourceContextPanel`**

Create `apps/web-ui/components/right-sizing/resource-context-panel.tsx`:

```tsx
"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfigTable } from "./shared";
import { buildConsoleUrl } from "@/lib/right-sizing/console-links";
import type { RightSizingRecommendation } from "@/lib/db/repositories/right-sizing/interface";
import type { InventoryResource } from "@/lib/db/repositories/inventory/interface";
import type { UIAccount } from "@/lib/types";

export function ResourceContextPanel({
    recommendation,
    resource,
    account,
}: {
    recommendation: RightSizingRecommendation;
    resource: InventoryResource | null;
    account: UIAccount | null;
}) {
    const consoleUrl = buildConsoleUrl(recommendation.resourceType, recommendation.region, recommendation.resourceId);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                    <span className="text-muted-foreground">Account: </span>
                    <span className="font-medium">{account?.name ?? "—"}</span>{" "}
                    <span className="font-mono text-xs text-muted-foreground">({recommendation.accountId})</span>
                    <span className="mx-2 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">Region: </span>
                    <span className="font-medium">{recommendation.region}</span>
                </div>
                {consoleUrl && (
                    <Button variant="outline" size="sm" asChild>
                        <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span className="ml-1">Open in AWS Console</span>
                        </a>
                    </Button>
                )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ConfigTable title="Current" config={recommendation.currentConfig} />
                <ConfigTable title="Recommended" config={recommendation.recommendedConfig} />
            </div>
            {resource?.metadata && Object.keys(resource.metadata).length > 0 && (
                <ConfigTable title="Resource metadata" config={resource.metadata} />
            )}
        </div>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/right-sizing/shared.tsx apps/web-ui/components/right-sizing/resource-context-panel.tsx
git commit -m "feat(right-sizing): add resource context panel with AWS console deep link"
```

---

### Task 7: `MetricCharts` component

**Files:**
- Create: `apps/web-ui/components/right-sizing/metric-charts.tsx`

**Interfaces:**
- Consumes: `MetricsSummary` / `SignalSummary` types from `@/lib/right-sizing/types` (exist).
- Produces: `MetricCharts({ metricsSummary })` — consumed by Task 8.

No unit test — pure Recharts presentation, verified visually in Task 12.

- [ ] **Step 1: Create the component**

Create `apps/web-ui/components/right-sizing/metric-charts.tsx`:

```tsx
"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { MetricsSummary, SignalSummary } from "@/lib/right-sizing/types";

const SIGNALS: { key: keyof MetricsSummary; label: string; isPercent: boolean }[] = [
    { key: "cpu", label: "CPU %", isPercent: true },
    { key: "memory", label: "Memory %", isPercent: true },
    { key: "throughputPercent", label: "Throughput %", isPercent: true },
    { key: "burstBalance", label: "Burst Balance %", isPercent: true },
    { key: "networkIn", label: "Network In (bytes)", isPercent: false },
    { key: "networkOut", label: "Network Out (bytes)", isPercent: false },
    { key: "diskReadOps", label: "Disk Read Ops", isPercent: false },
    { key: "diskWriteOps", label: "Disk Write Ops", isPercent: false },
    { key: "iops", label: "IOPS", isPercent: false },
    { key: "connections", label: "Connections", isPercent: false },
    { key: "freeableMemory", label: "Freeable Memory (bytes)", isPercent: false },
];

function round(n: number): number {
    return Number(n.toFixed(2));
}

export function MetricCharts({ metricsSummary }: { metricsSummary: MetricsSummary }) {
    const present = SIGNALS.filter((s) => (metricsSummary[s.key] as SignalSummary | null | undefined) != null);

    if (present.length === 0) {
        return <p className="text-sm text-muted-foreground">No CloudWatch signals were available for this resource.</p>;
    }

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {present.map((s) => {
                const signal = metricsSummary[s.key] as SignalSummary;
                const data = [
                    { stat: "avg", value: round(signal.avg) },
                    { stat: "p95", value: round(signal.p95) },
                    { stat: "p99", value: round(signal.p99) },
                    { stat: "max", value: round(signal.max) },
                ];
                return (
                    <div key={s.key} className="rounded-md border p-3">
                        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{s.label}</div>
                        <div className="h-32 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={data}>
                                    <XAxis dataKey="stat" tick={{ fontSize: 11 }} />
                                    <YAxis domain={s.isPercent ? [0, 100] : undefined} tick={{ fontSize: 11 }} />
                                    <Tooltip />
                                    <Bar dataKey="value" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/components/right-sizing/metric-charts.tsx
git commit -m "feat(right-sizing): add per-metric chart grid"
```

---

### Task 8: `RecommendationDetailPage` component

**Files:**
- Create: `apps/web-ui/components/right-sizing/recommendation-detail-page.tsx`

**Interfaces:**
- Consumes: `useRightSizingRecommendation`, `useRightSizingRecommendations`, `useUpdateRightSizingRecommendation`, `RightSizingFilters` (Task 3 + pre-existing), `buildReasoningLines` (Task 5), `ResourceContextPanel` (Task 6), `MetricCharts` (Task 7), `FindingBadge`/`RiskBadge`/`StatusBadge`/`formatMoney`/`RESOURCE_TYPE_LABELS` (pre-existing `shared.tsx`).
- Produces: `RecommendationDetailPage({ recommendationId }: { recommendationId: string })` — consumed by Task 9.

No unit test — this is the page composition itself, verified end-to-end in Task 12.

- [ ] **Step 1: Create the component**

Create `apps/web-ui/components/right-sizing/recommendation-detail-page.tsx`:

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ChevronLeft, ChevronRight, Check, X, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatMoney, FindingBadge, RiskBadge, StatusBadge, RESOURCE_TYPE_LABELS } from "./shared";
import { ResourceContextPanel } from "./resource-context-panel";
import { MetricCharts } from "./metric-charts";
import { buildReasoningLines } from "@/lib/right-sizing/reasoning";
import {
    useRightSizingRecommendation,
    useRightSizingRecommendations,
    useUpdateRightSizingRecommendation,
    type RightSizingFilters,
} from "@/lib/queries/right-sizing";
import type { RecommendationStatus } from "@/lib/db/repositories/right-sizing/interface";
import type { MetricsSummary } from "@/lib/right-sizing/types";

const PREV_NEXT_LIMIT = 1000;

function filtersFromSearchParams(sp: URLSearchParams): Omit<RightSizingFilters, "page" | "limit"> {
    return {
        sort: sp.get("sort") || "savings",
        search: sp.get("search") || undefined,
        resourceType: sp.get("resourceType") || undefined,
        finding: sp.get("finding") || undefined,
        status: sp.get("status") || undefined,
    };
}

export function RecommendationDetailPage({ recommendationId }: { recommendationId: string }) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [snoozeDate, setSnoozeDate] = useState("");
    const [busy, setBusy] = useState<RecommendationStatus | null>(null);

    const queryString = searchParams.toString();
    const filters = filtersFromSearchParams(searchParams);

    const detailQuery = useRightSizingRecommendation(recommendationId);
    const listQuery = useRightSizingRecommendations({ ...filters, page: 1, limit: PREV_NEXT_LIMIT });
    const updateMutation = useUpdateRightSizingRecommendation();

    const backHref = `/app/right-sizing${queryString ? `?${queryString}` : ""}`;

    if (detailQuery.isLoading) {
        return (
            <div className="space-y-4 p-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (!detailQuery.data) {
        return (
            <div className="space-y-4 p-6">
                <Button variant="outline" size="sm" onClick={() => router.push(backHref)}>
                    <ArrowLeft className="h-4 w-4" />
                    <span className="ml-1">Back to Right Sizing</span>
                </Button>
                <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                    {detailQuery.error instanceof Error ? detailQuery.error.message : "Recommendation not found."}
                </div>
            </div>
        );
    }

    const { recommendation: r, resource, account } = detailQuery.data;
    const pricingUnavailable = r.currentMonthlyCost == null;
    const reasoningLines = buildReasoningLines(r.resourceType, r.metricsSummary as MetricsSummary);

    const orderedIds = listQuery.data?.data.map((item) => item.id) ?? [];
    const currentIndex = orderedIds.indexOf(recommendationId);
    const prevId = currentIndex > 0 ? orderedIds[currentIndex - 1] : null;
    const nextId = currentIndex >= 0 && currentIndex < orderedIds.length - 1 ? orderedIds[currentIndex + 1] : null;
    const positionLabel =
        currentIndex >= 0 ? `${currentIndex + 1} of ${listQuery.data?.total ?? orderedIds.length}` : null;

    function stepTo(id: string) {
        router.push(`/app/right-sizing/${id}${queryString ? `?${queryString}` : ""}`);
    }

    async function setStatus(status: RecommendationStatus, snoozeUntil?: string) {
        setBusy(status);
        try {
            await updateMutation.mutateAsync({ id: r.id, status, snoozeUntil });
            toast.success(`Recommendation ${status}`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to update");
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Button variant="outline" size="sm" onClick={() => router.push(backHref)}>
                    <ArrowLeft className="h-4 w-4" />
                    <span className="ml-1">Back to Right Sizing</span>
                </Button>
                <div className="flex items-center gap-2">
                    {positionLabel && <span className="text-xs text-muted-foreground">{positionLabel}</span>}
                    <Button variant="outline" size="sm" disabled={!prevId} onClick={() => prevId && stepTo(prevId)}>
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm" disabled={!nextId} onClick={() => nextId && stepTo(nextId)}>
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight">
                    {RESOURCE_TYPE_LABELS[r.resourceType] ?? r.resourceType}: {r.name || r.resourceId}
                </h1>
                <div className="flex flex-wrap items-center gap-2">
                    <FindingBadge finding={r.finding} />
                    <RiskBadge risk={r.riskLevel} />
                    <StatusBadge status={r.status} />
                    <span className="text-xs text-muted-foreground">{Math.round(r.confidence * 100)}% confidence</span>
                </div>
            </div>

            {r.finding !== "optimized" && (
                <Card>
                    <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-end sm:justify-between">
                        <div className="flex items-end gap-2">
                            <div>
                                <label className="text-xs text-muted-foreground">Snooze until</label>
                                <Input
                                    type="date"
                                    value={snoozeDate}
                                    onChange={(e) => setSnoozeDate(e.target.value)}
                                    className="h-9 w-40"
                                />
                            </div>
                            <Button
                                variant="outline"
                                disabled={!snoozeDate || busy !== null}
                                onClick={() => setStatus("snoozed", snoozeDate)}
                            >
                                {busy === "snoozed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
                                <span className="ml-1">Snooze</span>
                            </Button>
                        </div>
                        <div className="flex gap-2">
                            <Button variant="outline" disabled={busy !== null} onClick={() => setStatus("dismissed")}>
                                {busy === "dismissed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                <span className="ml-1">Dismiss</span>
                            </Button>
                            <Button disabled={busy !== null} onClick={() => setStatus("approved")}>
                                {busy === "approved" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                <span className="ml-1">Approve</span>
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardContent className="pt-6">
                    <p className="text-sm">{r.rationale}</p>
                </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground">Current cost / mo</div>
                        <div className="text-lg font-semibold">{formatMoney(r.currentMonthlyCost)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground">Est. savings / mo</div>
                        <div className="text-lg font-semibold text-emerald-600">{formatMoney(r.estimatedMonthlySavings)}</div>
                    </CardContent>
                </Card>
            </div>
            {pricingUnavailable && (
                <p className="text-xs text-amber-600">
                    Pricing unavailable for this resource — savings could not be computed. The finding is still valid.
                </p>
            )}

            <Card>
                <CardContent className="space-y-3 pt-6">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Resource</div>
                    <ResourceContextPanel recommendation={r} resource={resource} account={account} />
                </CardContent>
            </Card>

            <Card>
                <CardContent className="space-y-3 pt-6">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">
                        Metrics ({Number((r.metricsSummary as MetricsSummary).coverageDays ?? 0).toFixed(1)}d observed)
                    </div>
                    <MetricCharts metricsSummary={r.metricsSummary as MetricsSummary} />
                </CardContent>
            </Card>

            <Card>
                <CardContent className="space-y-2 pt-6">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Why this finding fired</div>
                    <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                        {reasoningLines.map((line, i) => (
                            <li key={i}>{line}</li>
                        ))}
                    </ul>
                </CardContent>
            </Card>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/components/right-sizing/recommendation-detail-page.tsx
git commit -m "feat(right-sizing): add recommendation detail page component"
```

---

### Task 9: Route file `app/app/right-sizing/[id]/page.tsx`

**Files:**
- Create: `apps/web-ui/app/app/right-sizing/[id]/page.tsx`

**Interfaces:**
- Consumes: `RecommendationDetailPage` from Task 8.
- Produces: the `/app/right-sizing/[id]` route itself — consumed by Task 10's navigation.

- [ ] **Step 1: Create the route file**

Create `apps/web-ui/app/app/right-sizing/[id]/page.tsx`:

```tsx
import { Metadata } from "next";
import { RecommendationDetailPage } from "@/components/right-sizing/recommendation-detail-page";

interface RightSizingDetailRouteProps {
    params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: RightSizingDetailRouteProps): Promise<Metadata> {
    const { id } = await params;
    return { title: `Right Sizing — ${id.slice(0, 8)}` };
}

export default async function RightSizingDetailRoute({ params }: RightSizingDetailRouteProps) {
    const { id } = await params;
    return <RecommendationDetailPage recommendationId={id} />;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/app/app/right-sizing/[id]/page.tsx
git commit -m "feat(right-sizing): add /app/right-sizing/[id] route"
```

---

### Task 10: Wire up navigation — table row click + list page

**Files:**
- Modify: `apps/web-ui/components/right-sizing/recommendations-table.tsx`
- Modify: `apps/web-ui/app/app/right-sizing/page.tsx`

**Interfaces:**
- Consumes: the `/app/right-sizing/[id]` route from Task 9.
- Produces: row clicks navigate to the detail page instead of opening the (still-present-until-Task-11) dialog.

- [ ] **Step 1: Change the table's row-click contract**

In `apps/web-ui/components/right-sizing/recommendations-table.tsx`, add the router import at the top:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
```

Replace the `onRowClick` prop with `getHref` in the function signature:

```tsx
export function RecommendationsTable({
    recommendations,
    loading,
    getHref,
}: {
    recommendations: RightSizingRecommendation[];
    loading: boolean;
    getHref: (r: RightSizingRecommendation) => string;
}) {
    const router = useRouter();
```

Change the row's `onClick`:

```tsx
                        <TableRow key={r.id} className="cursor-pointer" onClick={() => router.push(getHref(r))}>
```

- [ ] **Step 2: Update the list page to build hrefs and drop the dialog**

In `apps/web-ui/app/app/right-sizing/page.tsx`:

Remove the dialog import and the `selected`/`dialogOpen` state:

```tsx
// REMOVE this import:
import { RecommendationDetailDialog } from "@/components/right-sizing/recommendation-detail-dialog";

// REMOVE these two lines:
const [selected, setSelected] = useState<RightSizingRecommendation | null>(null);
const [dialogOpen, setDialogOpen] = useState(false);
```

Add a href-builder function inside the component body, after the `filters` object is defined:

```tsx
    function buildDetailHref(r: RightSizingRecommendation): string {
        const params = new URLSearchParams();
        params.set("sort", sort);
        if (search.trim()) params.set("search", search.trim());
        if (resourceType !== ALL) params.set("resourceType", resourceType);
        if (finding !== ALL) params.set("finding", finding);
        if (status !== ALL) params.set("status", status);
        return `/app/right-sizing/${r.id}?${params.toString()}`;
    }
```

Replace the `<RecommendationsTable ... />` usage:

```tsx
            <RecommendationsTable
                recommendations={recommendations}
                loading={loading}
                getHref={buildDetailHref}
            />
```

Remove the `<RecommendationDetailDialog ... />` block entirely (it currently sits right after the `<PaginationBar>` block, before the closing `</div>`).

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: no new errors. (`recommendation-detail-dialog.tsx` still exists and still compiles on its own — it's just unused by the page now — so no import-resolution errors yet.)

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/right-sizing/recommendations-table.tsx apps/web-ui/app/app/right-sizing/page.tsx
git commit -m "feat(right-sizing): navigate to detail page instead of opening a modal"
```

---

### Task 11: Delete the modal

**Files:**
- Delete: `apps/web-ui/components/right-sizing/recommendation-detail-dialog.tsx`

**Interfaces:**
- Consumes: nothing (Task 10 already removed the only call site).
- Produces: nothing — cleanup only.

- [ ] **Step 1: Delete the file**

```bash
rm apps/web-ui/components/right-sizing/recommendation-detail-dialog.tsx
```

- [ ] **Step 2: Confirm nothing else references it**

Run: `cd apps/web-ui && grep -rn "recommendation-detail-dialog\|RecommendationDetailDialog" app components lib`
Expected: no output.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add -u apps/web-ui/components/right-sizing/recommendation-detail-dialog.tsx
git commit -m "chore(right-sizing): remove the recommendation detail modal"
```

---

### Task 12: Full test suite + manual verification

**Files:** none (verification only)

**Interfaces:** N/A — this task confirms Tasks 1–11 work together.

- [ ] **Step 1: Run the full web-ui test suite**

Run: `cd apps/web-ui && bun run test`
Expected: all tests pass, including the new ones from Tasks 1, 2, 4, 5. No regressions in unrelated suites.

- [ ] **Step 2: Full typecheck**

Run: `cd apps/web-ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Start the dev server**

Run: `cd apps/web-ui && bun run dev` (starts on :3001; requires `docker compose up -d postgres` already running and a valid `.env`)

- [ ] **Step 4: Manual walkthrough**

Using existing data from prior scans (or after running the local job-runner scan from `apps/workers` if the table is empty):

1. Open `/app/right-sizing` — confirm the table renders, then click a row with a non-"optimized" finding (e.g. an idle EBS volume).
2. Confirm you land on `/app/right-sizing/<id>?...` with the current filters in the URL, not a modal.
3. Confirm the header shows resource name, badges, confidence, and a "N of M" position indicator with working Prev/Next buttons.
4. Confirm the resource context panel shows account name, region, current/recommended config, and — for an EC2/EBS/RDS/ASG resource — an "Open in AWS Console" link that opens the right console page in a new tab.
5. Confirm the Metrics section shows one small chart per available signal (not one combined chart), and the "Why this finding fired" section shows a real threshold comparison line plus a confidence line.
6. Click Approve (or Dismiss, or set a Snooze date and click Snooze) — confirm a success toast appears and the recommendation's status badge updates.
7. Click "Back to Right Sizing" — confirm you land back on the list with the same filters/search/sort still applied.
8. Click Prev/Next a few times — confirm the URL and content update and the position indicator changes accordingly, wrapping correctly at both ends (buttons disable at the first/last item).

- [ ] **Step 5: Stop the dev server**

Nothing to commit in this task — it's verification only.

---

## Self-Review

**Spec coverage:** Routing/navigation (Tasks 9, 10), Prev/Next (Task 8), backend `getRecommendationDetail` + GET route (Tasks 1–2), query layer (Task 3), page content sections — header/action bar/cost card/resource context/metrics/reasoning (Tasks 6–8), removal of the dialog (Task 11), error handling (built into Task 8's not-found branch and Task 2's 404), testing (Tasks 1, 2, 4, 5 unit tests + Task 12 manual pass). All spec sections have a corresponding task.

**Placeholder scan:** No TBD/TODO markers; every step has complete, real code.

**Type consistency:** `RecommendationDetail` (Task 1) → `RightSizingRecommendationDetail` (Task 3, same shape, re-declared client-side since it crosses the server/client boundary via JSON) → consumed identically in Task 8 via `detailQuery.data`. `getHref`/`buildDetailHref` names match exactly between Task 10's table and page changes. `buildReasoningLines(resourceType: string, metricsSummary: MetricsSummary)` signature is identical between Task 5's implementation and Task 8's call site.
