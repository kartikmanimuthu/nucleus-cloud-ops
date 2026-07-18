# Dashboard Refactor Plan

**Status:** Design complete — awaiting implementation phase approval  
**Scope:** Frontend UX, component architecture, and backend data model for the Nucleus Cloud Ops dashboard.

---

## 1. Current state audit

### 1.1 File map

| Layer | File | Role |
|---|---|---|
| Page | `apps/web-ui/app/app/dashboard/page.tsx` | Server component, auth gate, renders `DashboardClient` |
| Orchestrator | `apps/web-ui/components/dashboard/dashboard-client.tsx` | Holds `timeRange`, refresh state, stacks 7 sections vertically |
| Header | `apps/web-ui/components/dashboard/dashboard-header.tsx` | Title, `24h/7d/30d/90d` toggle, refresh button |
| KPIs | `apps/web-ui/components/dashboard/kpi-summary-section.tsx` | 6 stat cards with sparklines |
| Cost | `apps/web-ui/components/dashboard/cost-optimization-section.tsx` | Savings trend + account bar chart |
| Operations | `apps/web-ui/components/dashboard/operational-health-section.tsx` | Account pills + execution timeline + schedule bar chart |
| Agent | `apps/web-ui/components/dashboard/agent-analytics-section.tsx` | Donut + timeline + top tools |
| Audit | `apps/web-ui/components/dashboard/security-audit-section.tsx` | Timeline + types + status + user/system |
| Inventory | `apps/web-ui/components/dashboard/inventory-overview-section.tsx` | Type donut + region bar + account stacked bar |
| KB | `apps/web-ui/components/dashboard/knowledge-base-section.tsx` | KB cards + vector donut |
| Service | `apps/web-ui/lib/dashboard-service.ts` | Single static class with 7 metric methods, queries Prisma directly |
| Types | `apps/web-ui/lib/dashboard-types.ts` | Request/response shapes for all sections |
| API | `apps/web-ui/app/api/dashboard/{kpi,cost,operations,agent,audit,inventory,knowledge-base}/route.ts` | Thin routes delegating to `DashboardService` |

### 1.2 Architectural violations

1. **No TanStack Query.** Every section uses hand-rolled `useState` + `useEffect` + `fetch`. This contradicts the project convention: *“never hand-roll `useState`+`useEffect`+`fetch`. Add a typed hook in `apps/web-ui/lib/queries/<domain>.ts`.”*
2. **No repository pattern.** `DashboardService` calls `getTenantClient(tenantId)` and queries Prisma models inline. It should go through the repository factory (`@/lib/db/repository-factory`) per project convention.
3. **No `queryKeys` entry.** `apps/web-ui/lib/queries/query-keys.ts` has no `dashboard` domain, so there is no central invalidation story.
4. **No dashboard RBAC subject.** Each endpoint reuses a different module subject (`Account`, `Schedule`, `Agent`, `AuditLog`, `Resource`, `KnowledgeBase`). There is no unified `Dashboard` subject.

### 1.3 Data-quality problems visible in prod

| Symptom | Root cause in code |
|---|---|
| **Resources Managed = 0** but Inventory Overview = 10,000 | KPI counts `TargetedResource` (schedule-attached resources); Inventory counts `InventoryResource` (discovery scan). Two different tables, no user-visible explanation. |
| **Schedule Success Rate = 0%** top KPI vs **100%** in Agent Analytics | KPI success rate is computed from `ScheduleExecution` status. The 0% implies no executions succeeded in the selected window; agent success is from `AgentOpsRun`. Metrics are not aligned. |
| **Savings = $0** despite 99 accounts / 10k resources | `DEFAULT_HOURLY_COST = 0.10` is applied to `resourcesStopped`. No real pricing, no resource-type costing (`HOURLY_COST_MAP` is defined but unused). |
| **“Other” = 9,389 resources (94%)** | `running` = `running/available/active`, `stopped` = `stopped/inactive`, everything else falls into `other`. This bucket is too broad and hides the real state. |
| **Resources by Account chart shows ~2 accounts** | Only accounts that have resources in the `InventoryResource` table appear. With 99 connected accounts, 97 show zero bars — a stacked bar chart is the wrong format. |
| **Top User = `scheduled-68379237-4671…`** | The audit summary picks the most frequent non-system `user` field. Service-account IDs are not resolved to human-readable names. |
| **KB section ignores `timeRange`** | `getKnowledgeBaseMetrics` does not accept a range. The global filter silently does not apply. |

### 1.4 Visual / UX problems

- Every section invents its own chart colors instead of using a semantic palette.
- Single-segment donuts (Agent “scheduled 100%”) communicate nothing.
- The inventory type donut has 20+ overlapping labels.
- Operational Health renders 80+ account chips as a wall of text.
- All cards use identical white styling — no visual hierarchy.
- Empty states have no CTAs.
- No section links to a filtered drill-down page.

---

## 2. Design principles for the refactor

1. **One story per screen.** The dashboard answers: *“How much am I saving, are my automations healthy, and what needs my attention next?”*
2. **Semantic color only.** Green = healthy/saving/success, amber = warning/attention, red = failure/critical, blue/gray = informational.
3. **Clickable everything.** Every metric, chart bar, and account status links to the relevant module filtered to that slice.
4. **Truthful data.** Remove contradictions by aligning definitions and naming metrics precisely.
5. **Convention over custom.** Use TanStack Query, repository factory, `queryKeys`, and existing UI primitives.
6. **Responsive grid, not a scroll stack.** Primary insights span wide; supporting details sit narrow.

---

## 3. Proposed dashboard structure

### 3.1 Layout zones

```
┌─────────────────────────────────────────────────────────────┐
│  Page header + global time filter (24h/7d/30d/90d)          │
├─────────────────────────────────────────────────────────────┤
│  HERO KPIs (6 cards)                                        │
│  Savings · Schedule success · Accounts synced · Agent runs ·  │
│  Open approvals · Critical events                             │
├─────────────────────────────────────────────────────────────┤
│  ACTION CENTER (left 2/3)          │  COVERAGE (right 1/3)    │
│  - Failing executions              │  - Account sync health   │
│  - Agent runs awaiting approval    │  - Discovery freshness   │
│  - Accounts with sync errors       │  - Inventory coverage    │
│  - Critical audit events           │                          │
├─────────────────────────────────────────────────────────────┤
│  COST & AUTOMATION (left 1/2)        │  AGENT ACTIVITY (1/2)  │
│  - Savings trend                   │  - Runs by source      │
│  - Recent executions table         │  - Approval queue        │
│  - Upcoming schedule actions       │  - Tool success rates    │
├─────────────────────────────────────────────────────────────┤
│  INVENTORY SNAPSHOT (left 2/3)     │  AUDIT SNAPSHOT (1/3)  │
│  - Resource distribution (bar)     │  - Open findings       │
│  - Status breakdown              │  - Event timeline      │
│  - Top accounts by resource count  │  - Top event types     │
└─────────────────────────────────────────────────────────────┘
```

Knowledge Base is removed from the main dashboard and moved to a small **“Set up Knowledge Base”** CTA in the Agent Activity zone if no KBs exist.

### 3.2 New component inventory

| New component | Responsibility |
|---|---|
| `dashboard-layout.tsx` | Responsive grid wrapper for zones |
| `action-center-section.tsx` | Failed executions, agent approvals, sync errors, critical events |
| `coverage-section.tsx` | Account sync health + discovery freshness |
| `cost-automation-section.tsx` | Savings trend + recent executions + upcoming actions |
| `agent-activity-section.tsx` | Runs by source + approval queue + tool success |
| `inventory-snapshot-section.tsx` | Resource distribution + status + top accounts |
| `audit-snapshot-section.tsx` | Open findings + event timeline mini |
| `kpi-summary-section.tsx` | Refactored: 6 cards, semantic colors, links |
| `dashboard-query-hooks.ts` | TanStack Query hooks + `queryKeys` integration |

Removed/merged:
- `operational-health-section.tsx` → split into `coverage-section.tsx` and `cost-automation-section.tsx`
- `security-audit-section.tsx` → renamed/rebuilt as `audit-snapshot-section.tsx`
- `knowledge-base-section.tsx` → removed from dashboard; module landing page remains

---

## 4. Data model & backend changes

### 4.1 New `Dashboard` RBAC subject

Add to `apps/web-ui/lib/rbac/types.ts`:

```typescript
export type Subject =
  | 'Account'
  | 'Schedule'
  | ...
  | 'Dashboard'; // new
```

All dashboard routes will authorize `read` on `Dashboard` instead of piggy-backing on unrelated modules. A migration/seed update may be needed to grant existing roles the `read` action on `Dashboard`.

### 4.2 Repository refactor

Create a dedicated dashboard repository behind the repository factory:

```
apps/web-ui/lib/db/repositories/dashboard/
├── interface.ts
└── postgres.ts
```

`DashboardService` must **only** orchestrate and transform. It must not issue Prisma queries directly.

Example interface:

```typescript
export interface IDashboardRepository {
  getKpiStats(tenantId: string, range: TimeRange): Promise<KpiResponse>;
  getActionCenter(tenantId: string, range: TimeRange): Promise<ActionCenterResponse>;
  getCoverage(tenantId: string): Promise<CoverageResponse>;
  getCostAutomation(tenantId: string, range: TimeRange): Promise<CostAutomationResponse>;
  getAgentActivity(tenantId: string, range: TimeRange): Promise<AgentActivityResponse>;
  getInventorySnapshot(tenantId: string): Promise<InventorySnapshotResponse>;
  getAuditSnapshot(tenantId: string, range: TimeRange): Promise<AuditSnapshotResponse>;
}
```

The existing `IInventoryRepository` and `IScheduleExecutionRepository` (or their service layers) should be reused where possible instead of raw Prisma.

### 4.3 New response types

Update or replace `apps/web-ui/lib/dashboard-types.ts` with shapes that match the new UI zones.

```typescript
// Hero KPIs
export interface KpiResponse {
  cards: KpiCard[];
}
export interface KpiCard {
  id: 'savings' | 'schedule-success' | 'accounts-synced' | 'agent-runs' | 'agent-approvals' | 'critical-events';
  label: string;
  value: number;
  formattedValue: string;
  delta: number;
  deltaDirection: 'up' | 'down' | 'neutral';
  sparkline: number[];
  href: string; // link to filtered view
}

// Action Center
export interface ActionCenterResponse {
  failingExecutions: { scheduleId: string; scheduleName: string; accountName: string; failedAt: string; reason: string; href: string }[];
  pendingAgentApprovals: { runId: string; taskName: string; requestedAt: string; href: string }[];
  accountsWithErrors: { accountId: string; name: string; error: string; lastSyncAt: string; href: string }[];
  criticalEvents: { eventType: string; message: string; timestamp: string; href: string }[];
}

// Coverage
export interface CoverageResponse {
  totalAccounts: number;
  connectedAccounts: number;
  accountsSynced: number;
  staleAccounts: number;
  neverSynced: number;
  lastScanAt: string | null;
  accounts: { id: string; name: string; status: 'connected' | 'disconnected' | 'stale' | 'never'; lastSyncAt: string | null; href: string }[];
}

// Cost & Automation
export interface CostAutomationResponse {
  trend: { time: string; savings: number; resourcesStopped: number }[];
  recentExecutions: { scheduleName: string; accountName: string; action: 'start' | 'stop'; status: string; time: string; savings: number; href: string }[];
  upcomingExecutions: { scheduleName: string; accountName: string; action: string; nextRun: string; href: string }[];
  summary: { totalSavings: number; avgDailySavings: number; resourcesOptimized: number; topAccountName: string };
}

// Agent Activity
export interface AgentActivityResponse {
  bySource: { source: string; count: number; successCount: number }[];
  approvalQueue: { runId: string; taskName: string; requestedAt: string; href: string }[];
  topTools: { toolName: string; count: number; successRate: number }[];
  summary: { totalRuns: number; successRate: number; avgDurationMs: number; activeScheduledTasks: number };
}

// Inventory Snapshot
export interface InventorySnapshotResponse {
  byType: { resourceType: string; count: number }[];
  byRegion: { region: string; count: number }[];
  byAccount: { accountId: string; accountName: string; total: number }[];
  statusBreakdown: { status: string; count: number }[];
  summary: {
    totalResources: number;
    accountsSynced: number;
    lastScanAt: string | null;
    running: number;
    stopped: number;
    untracked: number;
    newDiscovered: number;
  };
}

// Audit Snapshot
export interface AuditSnapshotResponse {
  timeline: { time: string; success: number; warning: number; error: number }[];
  openFindings: { severity: string; count: number; href: string }[];
  byType: { eventType: string; count: number }[];
  summary: { totalEvents: number; successRate: number; criticalCount: number };
}
```

### 4.4 Fix the savings calculation

Replace `DEFAULT_HOURLY_COST` with a real pricing signal.

**Option A (immediate):** Use `HOURLY_COST_MAP` by resource type when `ScheduleExecution` knows the resource type. If it does not, add `resourceType` to `ScheduleExecution` (schema change + worker backfill).

**Option B (better):** Query the `PricingCatalogEntry` table used by right-sizing to get per-instance-type on-demand pricing. Compute savings as:

```
savings = sum(stoppedHours * onDemandPricePerHour)
```

**Option C (fallback for now):** If no pricing data exists, show savings as **“Estimated (no pricing configured)”** and expose the cost model in tenant settings. Do not silently show `$0`.

Recommended path: implement Option A immediately, then migrate to Option B.

### 4.5 Fix inventory status mapping

Replace the three buckets (`running`, `stopped`, `other`) with the actual AWS state vocabulary:

```typescript
const STATUS_BUCKETS: Record<string, string> = {
  running: 'Running',
  available: 'Running',
  active: 'Running',
  stopped: 'Stopped',
  inactive: 'Stopped',
  terminated: 'Terminated',
  deleting: 'Deleting',
  pending: 'Pending',
  // fallback bucketed as 'Other' only if truly unmapped
};
```

Return the top 5 distinct statuses + an `other` remainder, not a single catch-all.

### 4.6 Fix account sync status

The current `connectionStatus` field is binary (`connected`/`disconnected`). Add a computed `syncStatus` for dashboard use:

```typescript
type SyncStatus = 'connected' | 'disconnected' | 'stale' | 'never';
```

Rules:
- `disconnected` if `connectionStatus !== 'connected'`.
- `stale` if `lastSyncedAt` is older than N hours (e.g., 24h).
- `never` if `lastSyncedAt` is null.
- otherwise `connected`.

Show a summary tile: **“87 healthy · 3 stale · 2 never scanned · 7 disconnected.”**

### 4.7 Resolve audit “Top User”

If `userType === 'system'`, ignore for the top-user metric. If the top non-system user looks like a service-account ID (`scheduled-...`, `agent-...`), label it as **“System / scheduled”** instead of surfacing the raw ID.

---

## 5. Frontend changes

### 5.1 TanStack Query integration

Add to `apps/web-ui/lib/queries/query-keys.ts`:

```typescript
export const queryKeys = {
  // ...existing keys
  dashboard: {
    all: ['dashboard'] as const,
    kpis: (range: TimeRange) => [...queryKeys.dashboard.all, 'kpis', range] as const,
    actionCenter: (range: TimeRange) => [...queryKeys.dashboard.all, 'action-center', range] as const,
    coverage: () => [...queryKeys.dashboard.all, 'coverage'] as const,
    costAutomation: (range: TimeRange) => [...queryKeys.dashboard.all, 'cost-automation', range] as const,
    agentActivity: (range: TimeRange) => [...queryKeys.dashboard.all, 'agent-activity', range] as const,
    inventorySnapshot: () => [...queryKeys.dashboard.all, 'inventory-snapshot'] as const,
    auditSnapshot: (range: TimeRange) => [...queryKeys.dashboard.all, 'audit-snapshot', range] as const,
  },
};
```

Create `apps/web-ui/lib/queries/dashboard-queries.ts`:

```typescript
export function useDashboardKpis(range: TimeRange) {
  return useQuery({
    queryKey: queryKeys.dashboard.kpis(range),
    queryFn: () => fetchDashboardKpis(range),
  });
}
// ...repeat for each zone
```

Remove all `useState`/`useEffect`/`fetch` patterns from dashboard components.

### 5.2 New `dashboard-layout.tsx`

Use a CSS grid with named areas:

```tsx
<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
  <div className="lg:col-span-3"><KpiSummarySection /></div>
  <div className="lg:col-span-2"><ActionCenterSection /></div>
  <div className="lg:col-span-1"><CoverageSection /></div>
  <div className="lg:col-span-1"><CostAutomationSection /></div>
  <div className="lg:col-span-1"><AgentActivitySection /></div>
  <div className="lg:col-span-2"><InventorySnapshotSection /></div>
  <div className="lg:col-span-1"><AuditSnapshotSection /></div>
</div>
```

### 5.3 Color system

Use only Tailwind semantic colors and CSS variables:

| Meaning | Class |
|---|---|
| Healthy / success / saving | `text-emerald-500` / `bg-emerald-500` |
| Warning / attention | `text-amber-500` / `bg-amber-500` |
| Failure / critical | `text-red-500` / `bg-red-500` |
| Info / neutral | `text-blue-500` / `bg-muted` |
| Running resource | `text-emerald-500` |
| Stopped resource | `text-slate-500` |
| Terminated resource | `text-red-500` |

Remove all hardcoded hex literals from dashboard components (`TYPE_COLORS`, inline `#10b981`, etc.). Use `chart-1` / `chart-2` CSS variables for chart series but keep semantics consistent.

### 5.4 Chart replacements

| Current | Replace with | Why |
|---|---|---|
| Single-segment donut (agent source) | Small progress ring or just a percentage metric | One value does not need a chart |
| Inventory type donut (20+ labels) | Horizontal bar chart, top 10 + Other | Readable |
| Account stacked bar (only 2 accounts visible) | Horizontal bar of top 10 accounts by total resources | Better use of space |
| Region vertical bar with angled labels | Horizontal bar | Labels stay readable |
| Operational Health account pills | Compact table or summary tiles | 80+ pills are not scannable |
| Flat execution timeline | Keep line chart but add explicit empty-state CTA | If no data, show “No executions — create a schedule” |

### 5.5 Empty states with CTAs

Update `section-empty.tsx` to accept an optional `action` prop:

```tsx
<SectionEmpty
  title="Cost Optimization"
  message="No schedule executions found for the selected period."
  action={{ label: "Create a schedule", href: "/schedules/new" }}
/>
```

### 5.6 Click-through behavior

Every `KpiCard` and every row in Action Center / recent executions / approval queue receives an `href`. Wrap the card/row in `next/link` or a button. On click, navigate to the relevant module with query params that pre-apply the filter (e.g., `/schedules?status=failed`, `/agent-ops?status=awaiting_approval`).

---

## 6. API route changes

Replace the seven granular routes with six zone routes that match the new UI:

```
app/api/dashboard/
├── kpis/route.ts
├── action-center/route.ts
├── coverage/route.ts
├── cost-automation/route.ts
├── agent-activity/route.ts
├── inventory-snapshot/route.ts
└── audit-snapshot/route.ts
```

Deprecate and remove:
- `cost/route.ts`
- `operations/route.ts`
- `agent/route.ts`
- `audit/route.ts`
- `inventory/route.ts`
- `knowledge-base/route.ts`

Each route:
1. Validates session + tenant.
2. Calls `authorize('read', 'Dashboard')`.
3. Calls the appropriate `DashboardService` method.
4. Returns `{ success: true, data }`.

---

## 7. Implementation phases

### Phase 1 — Backend foundation (no UI change)
1. Add `Dashboard` RBAC subject and seed permissions.
2. Create `IDashboardRepository` / `DashboardPostgresRepository` scaffold.
3. Refactor `DashboardService` to delegate to the repository.
4. Add new response types to `dashboard-types.ts`.
5. Add TanStack Query keys and hooks.

### Phase 2 — API consolidation
1. Create new zone API routes.
2. Update `DashboardService` methods to return new shapes.
3. Add computed `syncStatus` logic.
4. Fix savings calculation (Option A).
5. Fix inventory status mapping.
6. Remove old API routes.

### Phase 3 — Component rewrite
1. Build `dashboard-layout.tsx`.
2. Build new section components using TanStack Query hooks.
3. Replace chart types per section.
4. Add empty-state CTAs.
5. Wire click-through links.
6. Update `dashboard-client.tsx` to use the new layout.

### Phase 4 — Polish & QA
1. Unify colors (remove hardcoded hexes).
2. Responsive testing at `1280px`, `1024px`, `768px`, `375px`.
3. Accessibility review: color-only status, aria labels, keyboard navigation.
4. Add Vitest tests for `DashboardService` transformations and `syncStatus` logic.
5. Add Playwright smoke test: dashboard loads, KPIs render, click-through works.

---

## 8. Success metrics

- No hand-rolled `useState`+`useEffect`+`fetch` in dashboard components.
- `DashboardService` does not import `getTenantClient` directly.
- All dashboard API routes use the `Dashboard` RBAC subject.
- “Resources Managed” definition is reconciled with inventory or renamed.
- Savings metric uses resource-type pricing or shows a clear “estimated” disclaimer.
- Inventory `other` bucket is <10% of total (or replaced by real statuses).
- Lighthouse accessibility score ≥ 90 on `/app/dashboard`.

---

## 9. Open questions for product

1. Should the global `timeRange` apply to inventory and KB, or should those show an explicit “As of <timestamp>”?
2. What is the desired cost model for savings? (Right-sizing pricing catalog, per-type flat rates, or user-provided rates?)
3. Should Knowledge Base remain on the dashboard at all, or move to Agent Ops setup only?
4. Do we want a separate **“Needs attention”** email/Slack digest based on the Action Center data?
