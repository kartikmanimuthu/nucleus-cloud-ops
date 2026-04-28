# Nucleus Cloud Ops — Comprehensive SaaS Dashboard

## Overview

Replace the existing basic dashboard (`/app/dashboard`) with a comprehensive, role-aware SaaS dashboard covering all platform domains. Each section fetches data independently via dedicated API endpoints, rendering with individual loading states for progressive UX.

## Audience

| Role | View |
|------|------|
| Platform Admin | Cross-tenant aggregates, all sections visible, system-level metrics |
| Tenant Admin | Org-scoped data only, all sections visible |
| Executive | Same as Platform Admin — high-level KPIs emphasized |

## Architecture

**Pattern:** Section-Level Client Fetching

```
Page (server) — renders shell, reads user role from session
├── DashboardHeader (client) — time range toggle + manual refresh button
├── KpiSummarySection (client) → GET /api/dashboard/kpi?range=24h
├── CostOptimizationSection (client) → GET /api/dashboard/cost?range=24h
├── OperationalHealthSection (client) → GET /api/dashboard/operations?range=24h
├── AgentAnalyticsSection (client) → GET /api/dashboard/agent?range=24h
├── SecurityAuditSection (client) → GET /api/dashboard/audit?range=24h
├── InventoryOverviewSection (client) → GET /api/dashboard/inventory?range=24h
└── KnowledgeBaseSection (client) → GET /api/dashboard/knowledge-base
```

**Key decisions:**
- Each section is a `"use client"` component managing its own fetch/loading/error/empty states
- Time range state lives in `DashboardHeader`, passed down as prop to all sections
- Manual refresh only — no polling or WebSocket
- Default time range: 24h, toggles: 7d, 30d, 90d
- Chart library: Recharts (already integrated)
- Skeleton loaders while fetching, error card with retry on failure, empty state when no data

**Backend:**
- New service: `web-ui/lib/dashboard-service.ts` with domain-specific methods
- 7 new API routes under `web-ui/app/api/dashboard/`
- Each route: auth check → call service method → return JSON
- Service queries via existing repository layer (`getTenantClient()` for tenant scoping)
- Time range passed as query param, service computes time buckets accordingly

**Time bucketing logic:**
| Range | Bucket size | Max buckets |
|-------|-------------|-------------|
| 24h | 1 hour | 24 |
| 7d | 1 day | 7 |
| 30d | 1 day | 30 |
| 90d | 1 week | ~13 |

---

## Section 1: KPI Summary Row

**Endpoint:** `GET /api/dashboard/kpi?range=24h`

6 stat cards in a responsive grid (6-col desktop, 3×2 tablet, 2×3 mobile).

| Card | Metric | Source | Delta |
|------|--------|--------|-------|
| Monthly Savings | Estimated cost savings from stopped resources | `ScheduleExecution.resourcesStopped` × avg hourly cost | vs previous equivalent period |
| Resources Managed | Total resources under schedule coverage | `TargetedResource` count | vs previous period |
| Active Accounts | Connected AWS accounts | `Account` where active=true, connectionStatus=connected | vs previous period |
| Agent Runs | AI agent executions in period | `AgentOpsRun` count | vs previous period |
| Schedule Success Rate | % executions without failures | `ScheduleExecution` success/total | vs previous period |
| Audit Events | Total audit entries + critical count | `AuditLog` count + critical severity | vs previous period |

**Card anatomy:**
- Icon (lucide-react)
- Metric value (large text)
- Delta badge (green ↑ / red ↓ / gray neutral, percentage)
- Sparkline (tiny Recharts AreaChart, 7 data points showing trend)

**Response shape:**
```typescript
interface KpiResponse {
  cards: {
    id: string;
    label: string;
    value: number;
    formattedValue: string;
    delta: number; // percentage change vs previous period
    deltaDirection: 'up' | 'down' | 'neutral';
    sparkline: number[]; // 7 data points
  }[];
}
```

---

## Section 2: Cost Optimization & Savings

**Endpoint:** `GET /api/dashboard/cost?range=24h`

**Layout:** Two charts side by side + summary stats row below.

### Chart A — Savings Trend (Area Chart)
- X-axis: time buckets
- Y-axis: estimated savings ($)
- Single filled area
- Tooltip: date, savings amount, resources stopped count
- Source: `ScheduleExecution` aggregated per time bucket — `resourcesStopped` × default hourly cost rate per resource type (hardcoded map in dashboard-service.ts: EC2=$0.10/hr, RDS=$0.15/hr, ECS=$0.08/hr, ASG=$0.10/hr, DocumentDB=$0.12/hr — placeholder estimates until a cost configuration UI exists)

### Chart B — Savings by Account (Horizontal Bar Chart)
- Each bar = one AWS account
- Bar length = total savings for that account in period
- Top 10, sorted descending
- Color-coded by account
- Source: `ScheduleExecution` joined via `Schedule.accountId` → `Account.name`

### Summary stats row:
- Total savings (period)
- Avg daily savings
- Top saving account
- Resources optimized (stopped at least once in period)

**Response shape:**
```typescript
interface CostResponse {
  trend: { time: string; savings: number; resourcesStopped: number }[];
  byAccount: { accountId: string; accountName: string; savings: number }[];
  summary: {
    totalSavings: number;
    avgDailySavings: number;
    topAccount: string;
    resourcesOptimized: number;
  };
}
```

---

## Section 3: Operational Health

**Endpoint:** `GET /api/dashboard/operations?range=24h`

**Layout:** Account health row at top, two charts below, summary stats at bottom.

### Account Health Badges
- Compact row of badges per connected account
- Each badge: account name, status dot (green=connected, red=disconnected, yellow=stale), last synced relative time
- Source: `Account` table

### Chart A — Execution Timeline (Line Chart)
- X-axis: time buckets
- Y-axis: execution count
- Two lines: successful (green), failed (red)
- Tooltip: timestamp, success count, failure count, resources affected
- Source: `ScheduleExecution` grouped by time bucket and status

### Chart B — Execution by Schedule (Stacked Bar Chart)
- X-axis: top 10 most active schedules
- Y-axis: execution count
- Stacked: success, partial failure (resourcesFailed > 0 AND (resourcesStarted > 0 OR resourcesStopped > 0)), full failure (resourcesFailed > 0 AND resourcesStarted = 0 AND resourcesStopped = 0)
- Identifies problematic schedules
- Source: `ScheduleExecution` grouped by `scheduleId` and outcome

### Summary stats row:
- Total executions | Success rate % | Avg duration | Resources started | Resources stopped | Failed actions

**Response shape:**
```typescript
interface OperationsResponse {
  accounts: { id: string; name: string; status: string; lastSyncedAt: string }[];
  executionTimeline: { time: string; success: number; failed: number }[];
  executionBySchedule: { scheduleId: string; scheduleName: string; success: number; partialFail: number; fullFail: number }[];
  summary: {
    totalExecutions: number;
    successRate: number;
    avgDurationMs: number;
    resourcesStarted: number;
    resourcesStopped: number;
    failedActions: number;
  };
}
```

---

## Section 4: AI Agent Analytics

**Endpoint:** `GET /api/dashboard/agent?range=24h`

**Layout:** Two charts top row, one chart bottom, summary stats below.

### Chart A — Runs by Source (Donut Chart)
- Segments: Slack, Jira, API, Scheduled
- Center text: total run count
- Hover: count + percentage per segment
- Source: `AgentOpsRun` grouped by `source`

### Chart B — Run Timeline (Stacked Area Chart)
- X-axis: time buckets
- Y-axis: run count
- Stacked areas by status: completed (green), failed (red), in_progress (blue), cancelled (gray)
- Source: `AgentOpsRun` grouped by time bucket and `status`

### Chart C — Top Tool Usage (Horizontal Bar Chart)
- Each bar = tool name (execute_command, read_file, write_file, glob, grep, etc.)
- Bar length = invocation count
- Top 10, sorted descending
- Source: `AgentOpsEvent` where `eventType = 'tool_call'`, grouped by `toolName`

### Summary stats row:
- Total runs | Success rate % | Avg duration (s) | Active scheduled tasks | Chat sessions | Messages sent

**Response shape:**
```typescript
interface AgentResponse {
  bySource: { source: string; count: number }[];
  timeline: { time: string; completed: number; failed: number; inProgress: number; cancelled: number }[];
  topTools: { toolName: string; count: number }[];
  summary: {
    totalRuns: number;
    successRate: number;
    avgDurationMs: number;
    activeScheduledTasks: number;
    chatSessions: number;
    messageCount: number;
  };
}
```

---

## Section 5: Security & Audit

**Endpoint:** `GET /api/dashboard/audit?range=24h`

**Layout:** 2×2 chart grid + summary stats below.

### Chart A — Event Timeline (Line Chart, top left)
- X-axis: time buckets
- Y-axis: event count
- Three lines: success (green), warning (amber), error/critical (red)
- Source: `AuditLog` grouped by time bucket and `severity`

### Chart B — Events by Type (Bar Chart, top right)
- X-axis: event type categories (top 10)
- Y-axis: count
- Color-coded by severity
- Source: `AuditLog` grouped by `eventType`

### Chart C — Status Distribution (Donut Chart, bottom left)
- Segments: success, failure, warning, error
- Center text: total event count
- Source: `AuditLog` grouped by `status`

### Chart D — User vs System Activity (Stacked Area Chart, bottom right)
- X-axis: time buckets
- Y-axis: event count
- Two stacked areas: user-initiated, system-initiated
- Source: `AuditLog` grouped by time bucket and `userType`

### Summary stats row:
- Total events | Success rate % | Critical events (red highlight if > 0) | Unique users | System events | Most active user

**Response shape:**
```typescript
interface AuditResponse {
  timeline: { time: string; success: number; warning: number; error: number }[];
  byType: { eventType: string; count: number; severity: string }[];
  byStatus: { status: string; count: number }[];
  userVsSystem: { time: string; user: number; system: number }[];
  summary: {
    totalEvents: number;
    successRate: number;
    criticalCount: number;
    uniqueUsers: number;
    systemEvents: number;
    topUser: string;
  };
}
```

---

## Section 6: Inventory Overview

**Endpoint:** `GET /api/dashboard/inventory?range=24h`

**Layout:** Two charts top row, one chart bottom, summary stats below.

### Chart A — Resources by Type (Donut Chart)
- Segments: EC2, ECS, RDS, ASG, DocumentDB, other
- Center text: total resource count
- Source: `InventoryResource` grouped by `resourceType`

### Chart B — Resources by Region (Bar Chart)
- X-axis: AWS regions
- Y-axis: resource count
- Sorted descending
- Source: `InventoryResource` grouped by `region`

### Chart C — Resources by Account (Stacked Bar Chart)
- X-axis: AWS accounts
- Y-axis: resource count
- Stacked by resource type
- Source: `InventoryResource` grouped by `accountId` and `resourceType`, joined with `Account.name`

### Summary stats row:
- Total resources | Accounts synced | Last scan timestamp | Running / Stopped / Other | New resources discovered (in period)

**Response shape:**
```typescript
interface InventoryResponse {
  byType: { resourceType: string; count: number }[];
  byRegion: { region: string; count: number }[];
  byAccount: { accountId: string; accountName: string; breakdown: { resourceType: string; count: number }[] }[];
  summary: {
    totalResources: number;
    accountsSynced: number;
    lastScanAt: string;
    running: number;
    stopped: number;
    other: number;
    newDiscovered: number;
  };
}
```

---

## Section 7: Knowledge Base Status

**Endpoint:** `GET /api/dashboard/knowledge-base`

**Layout:** Card list on left, donut chart on right, summary stats below. No time range filtering (KB state is current snapshot).

### Left — KB Status Cards
- Each KB as a card: name, status badge (active/syncing/error), vector count, data source count
- Under each card: mini list of data sources with source type icon, sync status indicator, last sync time
- Source: `KnowledgeBase` + `DataSource` tables

### Right — Vectors by Source Type (Donut Chart)
- Segments: S3, Confluence, Bitbucket, File Upload
- Center text: total vector count
- Source: `DataSource` grouped by `sourceType`, summing `vectorCount`

### Summary stats row:
- Total KBs | Total vectors | Total data sources | Sources with sync errors | Last sync timestamp

**Response shape:**
```typescript
interface KnowledgeBaseResponse {
  knowledgeBases: {
    id: string;
    name: string;
    status: string;
    vectorCount: number;
    dataSources: {
      id: string;
      name: string;
      sourceType: string;
      status: string;
      lastSyncAt: string | null;
      lastSyncError: string | null;
    }[];
  }[];
  bySourceType: { sourceType: string; vectorCount: number }[];
  summary: {
    totalKBs: number;
    totalVectors: number;
    totalDataSources: number;
    syncErrors: number;
    lastSyncAt: string | null;
  };
}
```

---

## File Structure

```
web-ui/
├── app/
│   ├── app/dashboard/
│   │   └── page.tsx                    # Server component — shell, role check, layout
│   └── api/dashboard/
│       ├── kpi/route.ts
│       ├── cost/route.ts
│       ├── operations/route.ts
│       ├── agent/route.ts
│       ├── audit/route.ts
│       ├── inventory/route.ts
│       └── knowledge-base/route.ts
├── components/dashboard/
│   ├── dashboard-header.tsx            # Time range toggle + refresh button
│   ├── kpi-summary-section.tsx         # 6 KPI cards with sparklines
│   ├── cost-optimization-section.tsx   # Savings trend + by-account charts
│   ├── operational-health-section.tsx  # Account badges + execution charts
│   ├── agent-analytics-section.tsx     # Source donut + timeline + tools
│   ├── security-audit-section.tsx      # 2×2 audit chart grid
│   ├── inventory-overview-section.tsx  # Resource distribution charts
│   ├── knowledge-base-section.tsx      # KB cards + vectors donut
│   ├── section-skeleton.tsx            # Reusable loading skeleton
│   ├── section-error.tsx               # Reusable error card with retry
│   └── section-empty.tsx               # Reusable empty state
└── lib/
    └── dashboard-service.ts            # All dashboard data aggregation methods
```

---

## Shared Component Patterns

### Section wrapper
Each section follows the same pattern:
1. Accepts `timeRange` prop
2. Fetches data on mount and when `timeRange` changes
3. Shows `SectionSkeleton` while loading
4. Shows `SectionError` with retry button on failure
5. Shows `SectionEmpty` when response has no data
6. Renders charts and stats on success

### Responsive behavior
- Desktop (≥1280px): charts side by side in 2-column grid
- Tablet (≥768px): charts stack or go 2-column depending on section
- Mobile (<768px): single column, all charts full width

### Dark mode
- All charts use the existing `ChartContainer` from `components/ui/chart.tsx` which handles theme-aware colors
- Stat cards and badges adapt via Tailwind dark: variants

---

## Role-Based Visibility

The server component reads the session role and passes a `userRole` prop to the page client wrapper. Sections themselves don't hide — the API endpoints scope data:

| Role | Data scoping |
|------|-------------|
| Platform Admin | Cross-tenant aggregates (all tenants combined) |
| Tenant Admin | `getTenantClient(tenantId)` — only their org's data |
| Executive | Same as Platform Admin |

The API routes use `getServerSession()` to determine tenant context and role, then call the service with appropriate scoping.

---

## Non-Goals (out of scope)

- Real-time streaming or WebSocket updates
- Customizable widget layout or drag-and-drop
- Export to PDF/CSV from dashboard (existing export endpoints cover this)
- Alerting or threshold configuration from the dashboard
- Historical comparison overlays (e.g., this week vs last week on same chart)
- Drill-down navigation from charts to detail pages (can be added later)
