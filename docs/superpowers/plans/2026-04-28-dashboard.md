# Comprehensive SaaS Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing basic dashboard with a comprehensive, role-aware SaaS dashboard covering all 7 platform domains with independent section-level client fetching.

**Architecture:** Single scrollable page with a server-rendered shell. Each of 7 sections is a `"use client"` component that fetches its own data from a dedicated `/api/dashboard/*` endpoint. A shared `DashboardHeader` manages time range state (24h/7d/30d/90d) and manual refresh. All data queries go through `dashboard-service.ts` using `getTenantClient()` for tenant scoping.

**Tech Stack:** Next.js 15, React 19, Recharts, Tailwind CSS, Prisma ORM, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-28-dashboard-design.md`

---

## File Structure

```
web-ui/
├── app/
│   ├── app/dashboard/
│   │   └── page.tsx                    # MODIFY — server shell with role check
│   └── api/dashboard/
│       ├── kpi/route.ts                # CREATE
│       ├── cost/route.ts               # CREATE
│       ├── operations/route.ts         # CREATE
│       ├── agent/route.ts              # CREATE
│       ├── audit/route.ts              # CREATE
│       ├── inventory/route.ts          # CREATE
│       └── knowledge-base/route.ts     # CREATE
├── components/dashboard/
│   ├── dashboard-client.tsx            # MODIFY — replace with new layout
│   ├── dashboard-header.tsx            # CREATE
│   ├── section-skeleton.tsx            # CREATE
│   ├── section-error.tsx               # CREATE
│   ├── section-empty.tsx               # CREATE
│   ├── kpi-summary-section.tsx         # CREATE
│   ├── cost-optimization-section.tsx   # CREATE
│   ├── operational-health-section.tsx  # CREATE
│   ├── agent-analytics-section.tsx     # CREATE
│   ├── security-audit-section.tsx      # CREATE
│   ├── inventory-overview-section.tsx  # CREATE
│   └── knowledge-base-section.tsx      # CREATE
├── lib/
│   ├── dashboard-service.ts            # CREATE
│   └── dashboard-types.ts             # CREATE
└── tests/
    └── dashboard-service.test.ts       # CREATE
```

---

### Task 1: Dashboard Types & Time Range Utilities

**Files:**
- Create: `web-ui/lib/dashboard-types.ts`

- [ ] **Step 1: Create the shared types file**

```typescript
// web-ui/lib/dashboard-types.ts
export type TimeRange = '24h' | '7d' | '30d' | '90d';

export interface KpiCard {
  id: string;
  label: string;
  value: number;
  formattedValue: string;
  delta: number;
  deltaDirection: 'up' | 'down' | 'neutral';
  sparkline: number[];
}

export interface KpiResponse {
  cards: KpiCard[];
}

export interface CostResponse {
  trend: { time: string; savings: number; resourcesStopped: number }[];
  byAccount: { accountId: string; accountName: string; savings: number }[];
  summary: {
    totalSavings: number;
    avgDailySavings: number;
    topAccount: string;
    resourcesOptimized: number;
  };
}

export interface OperationsResponse {
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

export interface AgentResponse {
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

export interface AuditDashboardResponse {
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

export interface InventoryResponse {
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

export interface KnowledgeBaseResponse {
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

export function getTimeRangeDate(range: TimeRange): Date {
  const now = new Date();
  switch (range) {
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case '90d': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  }
}

export function getTimeBucketFormat(range: TimeRange): { bucketMs: number; format: string } {
  switch (range) {
    case '24h': return { bucketMs: 60 * 60 * 1000, format: 'HH:00' };
    case '7d': return { bucketMs: 24 * 60 * 60 * 1000, format: 'MMM dd' };
    case '30d': return { bucketMs: 24 * 60 * 60 * 1000, format: 'MMM dd' };
    case '90d': return { bucketMs: 7 * 24 * 60 * 60 * 1000, format: 'MMM dd' };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx tsc --noEmit lib/dashboard-types.ts 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/lib/dashboard-types.ts
git commit -m "feat(dashboard): add shared types and time range utilities"
```

---

### Task 2: Shared Section Components (Skeleton, Error, Empty)

**Files:**
- Create: `web-ui/components/dashboard/section-skeleton.tsx`
- Create: `web-ui/components/dashboard/section-error.tsx`
- Create: `web-ui/components/dashboard/section-empty.tsx`

- [ ] **Step 1: Create section skeleton component**

```typescript
// web-ui/components/dashboard/section-skeleton.tsx
"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface SectionSkeletonProps {
  title: string;
  chartCount?: number;
}

export function SectionSkeleton({ title, chartCount = 2 }: SectionSkeletonProps) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`grid gap-4 ${chartCount > 1 ? 'md:grid-cols-2' : ''}`}>
          {Array.from({ length: chartCount }).map((_, i) => (
            <Skeleton key={i} className="h-[300px] w-full rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Create section error component**

```typescript
// web-ui/components/dashboard/section-error.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface SectionErrorProps {
  title: string;
  message?: string;
  onRetry: () => void;
}

export function SectionError({ title, message, onRetry }: SectionErrorProps) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive mb-3" />
          <p className="text-sm text-muted-foreground mb-4">
            {message || "Failed to load data. Please try again."}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Create section empty component**

```typescript
// web-ui/components/dashboard/section-empty.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Inbox } from "lucide-react";

interface SectionEmptyProps {
  title: string;
  message?: string;
}

export function SectionEmpty({ title, message }: SectionEmptyProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            {message || "No data available for the selected time range."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/section-skeleton.tsx --file components/dashboard/section-error.tsx --file components/dashboard/section-empty.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/section-skeleton.tsx web-ui/components/dashboard/section-error.tsx web-ui/components/dashboard/section-empty.tsx
git commit -m "feat(dashboard): add shared section skeleton, error, and empty state components"
```

---

### Task 3: Dashboard Header Component

**Files:**
- Create: `web-ui/components/dashboard/dashboard-header.tsx`

- [ ] **Step 1: Create the dashboard header with time range toggle and refresh**

```typescript
// web-ui/components/dashboard/dashboard-header.tsx
"use client";

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimeRange } from "@/lib/dashboard-types";

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
];

interface DashboardHeaderProps {
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
}

export function DashboardHeader({
  timeRange,
  onTimeRangeChange,
  onRefresh,
  isRefreshing,
}: DashboardHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-foreground">
          Dashboard
        </h2>
        <p className="text-sm text-muted-foreground">
          Platform overview and key metrics
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-lg border border-border bg-muted/50 p-1">
          {TIME_RANGES.map(({ value, label }) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 px-3 text-xs",
                timeRange === value &&
                  "bg-background shadow-sm text-foreground"
              )}
              onClick={() => onTimeRangeChange(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw
            className={cn("h-4 w-4", isRefreshing && "animate-spin")}
          />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/dashboard-header.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/dashboard-header.tsx
git commit -m "feat(dashboard): add dashboard header with time range toggle and refresh"
```

---

### Task 4: Dashboard Service — Core + KPI & Cost Methods

**Files:**
- Create: `web-ui/lib/dashboard-service.ts`

This is the backend aggregation layer. All 7 API routes delegate to methods here. We build it incrementally — this task covers the core helpers, KPI, and Cost methods. Subsequent tasks add the remaining methods.

- [ ] **Step 1: Create dashboard-service.ts with core helpers, KPI, and Cost methods**

```typescript
// web-ui/lib/dashboard-service.ts
import { getTenantClient } from '@/lib/db/pg-config';
import type {
  TimeRange,
  KpiResponse,
  CostResponse,
} from '@/lib/dashboard-types';
import { getTimeRangeDate } from '@/lib/dashboard-types';

const HOURLY_COST_MAP: Record<string, number> = {
  ec2: 0.10,
  rds: 0.15,
  ecs: 0.08,
  asg: 0.10,
  docdb: 0.12,
};

const DEFAULT_HOURLY_COST = 0.10;

function bucketTimestamp(date: Date, range: TimeRange): string {
  if (range === '24h') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:00`;
  }
  if (range === '90d') {
    const day = date.getDay();
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - day);
    return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function computeDelta(current: number, previous: number): { delta: number; deltaDirection: 'up' | 'down' | 'neutral' } {
  if (previous === 0) return { delta: 0, deltaDirection: 'neutral' };
  const delta = Math.round(((current - previous) / previous) * 100);
  return {
    delta: Math.abs(delta),
    deltaDirection: delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral',
  };
}

function getPreviousPeriodDate(range: TimeRange): { start: Date; end: Date } {
  const end = getTimeRangeDate(range);
  const now = new Date();
  const durationMs = now.getTime() - end.getTime();
  const start = new Date(end.getTime() - durationMs);
  return { start, end };
}

export class DashboardService {
  static async getKpiStats(tenantId: string, range: TimeRange): Promise<KpiResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);
    const prev = getPreviousPeriodDate(range);

    const [
      executions, prevExecutions,
      targetedResources, prevTargetedResources,
      activeAccounts, prevActiveAccounts,
      agentRuns, prevAgentRuns,
      auditLogs, prevAuditLogs,
      criticalAuditLogs,
    ] = await Promise.all([
      db.scheduleExecution.findMany({ where: { executionTime: { gte: since } }, select: { status: true, resourcesStopped: true, executionTime: true } }),
      db.scheduleExecution.findMany({ where: { executionTime: { gte: prev.start, lt: prev.end } }, select: { status: true, resourcesStopped: true } }),
      db.targetedResource.count(),
      db.targetedResource.count({ where: { createdAt: { lt: since } } }),
      db.account.count({ where: { active: true, connectionStatus: 'connected' } }),
      db.account.count({ where: { active: true, connectionStatus: 'connected', createdAt: { lt: since } } }),
      db.agentOpsRun.count({ where: { createdAt: { gte: since } } }),
      db.agentOpsRun.count({ where: { createdAt: { gte: prev.start, lt: prev.end } } }),
      db.auditLog.count({ where: { timestamp: { gte: since } } }),
      db.auditLog.count({ where: { timestamp: { gte: prev.start, lt: prev.end } } }),
      db.auditLog.count({ where: { timestamp: { gte: since }, severity: 'critical' } }),
    ]);

    const totalStopped = executions.reduce((sum, e) => sum + e.resourcesStopped, 0);
    const prevTotalStopped = prevExecutions.reduce((sum, e) => sum + e.resourcesStopped, 0);
    const savings = totalStopped * DEFAULT_HOURLY_COST;
    const prevSavings = prevTotalStopped * DEFAULT_HOURLY_COST;

    const successExecs = executions.filter(e => e.status === 'success').length;
    const totalExecs = executions.length;
    const successRate = totalExecs > 0 ? Math.round((successExecs / totalExecs) * 100) : 0;
    const prevSuccessExecs = prevExecutions.filter(e => e.status === 'success').length;
    const prevTotalExecs = prevExecutions.length;
    const prevSuccessRate = prevTotalExecs > 0 ? Math.round((prevSuccessExecs / prevTotalExecs) * 100) : 0;

    // Build sparklines from executions grouped into 7 buckets
    const sparklineBuckets = 7;
    const bucketDuration = (Date.now() - since.getTime()) / sparklineBuckets;
    const savingsSparkline = Array(sparklineBuckets).fill(0);
    for (const exec of executions) {
      const idx = Math.min(Math.floor((exec.executionTime.getTime() - since.getTime()) / bucketDuration), sparklineBuckets - 1);
      if (idx >= 0) savingsSparkline[idx] += exec.resourcesStopped * DEFAULT_HOURLY_COST;
    }

    return {
      cards: [
        {
          id: 'savings',
          label: 'Estimated Savings',
          value: savings,
          formattedValue: `$${savings.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
          ...computeDelta(savings, prevSavings),
          sparkline: savingsSparkline,
        },
        {
          id: 'resources',
          label: 'Resources Managed',
          value: targetedResources,
          formattedValue: targetedResources.toLocaleString(),
          ...computeDelta(targetedResources, prevTargetedResources),
          sparkline: [],
        },
        {
          id: 'accounts',
          label: 'Active Accounts',
          value: activeAccounts,
          formattedValue: activeAccounts.toLocaleString(),
          ...computeDelta(activeAccounts, prevActiveAccounts),
          sparkline: [],
        },
        {
          id: 'agent-runs',
          label: 'Agent Runs',
          value: agentRuns,
          formattedValue: agentRuns.toLocaleString(),
          ...computeDelta(agentRuns, prevAgentRuns),
          sparkline: [],
        },
        {
          id: 'success-rate',
          label: 'Schedule Success Rate',
          value: successRate,
          formattedValue: `${successRate}%`,
          ...computeDelta(successRate, prevSuccessRate),
          sparkline: [],
        },
        {
          id: 'audit-events',
          label: 'Audit Events',
          value: auditLogs,
          formattedValue: `${auditLogs.toLocaleString()}${criticalAuditLogs > 0 ? ` (${criticalAuditLogs} critical)` : ''}`,
          ...computeDelta(auditLogs, prevAuditLogs),
          sparkline: [],
        },
      ],
    };
  }

  static async getCostMetrics(tenantId: string, range: TimeRange): Promise<CostResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const executions = await db.scheduleExecution.findMany({
      where: { executionTime: { gte: since } },
      select: { scheduleId: true, accountId: true, resourcesStopped: true, executionTime: true },
    });

    const accounts = await db.account.findMany({
      select: { accountId: true, name: true },
    });
    const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));

    // Trend: group by time bucket
    const trendMap = new Map<string, { savings: number; resourcesStopped: number }>();
    for (const exec of executions) {
      const bucket = bucketTimestamp(exec.executionTime, range);
      const entry = trendMap.get(bucket) || { savings: 0, resourcesStopped: 0 };
      const cost = exec.resourcesStopped * DEFAULT_HOURLY_COST;
      entry.savings += cost;
      entry.resourcesStopped += exec.resourcesStopped;
      trendMap.set(bucket, entry);
    }
    const trend = Array.from(trendMap.entries())
      .map(([time, data]) => ({ time, ...data }))
      .sort((a, b) => a.time.localeCompare(b.time));

    // By account
    const accountSavings = new Map<string, number>();
    for (const exec of executions) {
      const current = accountSavings.get(exec.accountId) || 0;
      accountSavings.set(exec.accountId, current + exec.resourcesStopped * DEFAULT_HOURLY_COST);
    }
    const byAccount = Array.from(accountSavings.entries())
      .map(([accountId, savings]) => ({
        accountId,
        accountName: accountMap.get(accountId) || accountId,
        savings,
      }))
      .sort((a, b) => b.savings - a.savings)
      .slice(0, 10);

    const totalSavings = executions.reduce((sum, e) => sum + e.resourcesStopped * DEFAULT_HOURLY_COST, 0);
    const daysInRange = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const uniqueResources = new Set(executions.filter(e => e.resourcesStopped > 0).map(e => e.scheduleId));

    return {
      trend,
      byAccount,
      summary: {
        totalSavings,
        avgDailySavings: daysInRange > 0 ? totalSavings / daysInRange : 0,
        topAccount: byAccount[0]?.accountName || 'N/A',
        resourcesOptimized: uniqueResources.size,
      },
    };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx tsc --noEmit 2>&1 | grep dashboard-service | head -10`
Expected: No errors related to dashboard-service

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/lib/dashboard-service.ts
git commit -m "feat(dashboard): add dashboard service with KPI and cost metrics methods"
```

---

### Task 5: Dashboard Service — Operations, Agent, Audit Methods

**Files:**
- Modify: `web-ui/lib/dashboard-service.ts`

- [ ] **Step 1: Add getOperationsMetrics method to DashboardService**

Add the following method inside the `DashboardService` class in `web-ui/lib/dashboard-service.ts`:

```typescript
  static async getOperationsMetrics(tenantId: string, range: TimeRange): Promise<OperationsResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const [accounts, executions, schedules] = await Promise.all([
      db.account.findMany({
        where: { active: true },
        select: { id: true, name: true, connectionStatus: true, lastSyncedAt: true },
      }),
      db.scheduleExecution.findMany({
        where: { executionTime: { gte: since } },
        select: { scheduleId: true, status: true, resourcesStarted: true, resourcesStopped: true, resourcesFailed: true, duration: true, executionTime: true },
      }),
      db.schedule.findMany({
        select: { scheduleId: true, name: true },
      }),
    ]);

    const scheduleMap = new Map(schedules.map(s => [s.scheduleId, s.name]));

    // Account health
    const accountHealth = accounts.map(a => ({
      id: a.id,
      name: a.name,
      status: a.connectionStatus,
      lastSyncedAt: a.lastSyncedAt?.toISOString() || '',
    }));

    // Execution timeline
    const timelineMap = new Map<string, { success: number; failed: number }>();
    for (const exec of executions) {
      const bucket = bucketTimestamp(exec.executionTime, range);
      const entry = timelineMap.get(bucket) || { success: 0, failed: 0 };
      if (exec.status === 'success') entry.success++;
      else if (exec.status === 'failed') entry.failed++;
      timelineMap.set(bucket, entry);
    }
    const executionTimeline = Array.from(timelineMap.entries())
      .map(([time, data]) => ({ time, ...data }))
      .sort((a, b) => a.time.localeCompare(b.time));

    // Execution by schedule (top 10)
    const scheduleExecMap = new Map<string, { success: number; partialFail: number; fullFail: number }>();
    for (const exec of executions) {
      const entry = scheduleExecMap.get(exec.scheduleId) || { success: 0, partialFail: 0, fullFail: 0 };
      if (exec.status === 'success') {
        entry.success++;
      } else if (exec.resourcesFailed > 0 && (exec.resourcesStarted > 0 || exec.resourcesStopped > 0)) {
        entry.partialFail++;
      } else if (exec.resourcesFailed > 0) {
        entry.fullFail++;
      }
      scheduleExecMap.set(exec.scheduleId, entry);
    }
    const executionBySchedule = Array.from(scheduleExecMap.entries())
      .map(([scheduleId, data]) => ({
        scheduleId,
        scheduleName: scheduleMap.get(scheduleId) || scheduleId,
        ...data,
      }))
      .sort((a, b) => (b.success + b.partialFail + b.fullFail) - (a.success + a.partialFail + a.fullFail))
      .slice(0, 10);

    const totalExecutions = executions.length;
    const successCount = executions.filter(e => e.status === 'success').length;
    const totalDuration = executions.reduce((sum, e) => sum + (e.duration || 0), 0);

    return {
      accounts: accountHealth,
      executionTimeline,
      executionBySchedule,
      summary: {
        totalExecutions,
        successRate: totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0,
        avgDurationMs: totalExecutions > 0 ? Math.round((totalDuration / totalExecutions) * 1000) : 0,
        resourcesStarted: executions.reduce((sum, e) => sum + e.resourcesStarted, 0),
        resourcesStopped: executions.reduce((sum, e) => sum + e.resourcesStopped, 0),
        failedActions: executions.reduce((sum, e) => sum + e.resourcesFailed, 0),
      },
    };
  }
```

- [ ] **Step 2: Add getAgentMetrics method**

Add the following method inside the `DashboardService` class:

```typescript
  static async getAgentMetrics(tenantId: string, range: TimeRange): Promise<AgentResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const [runs, toolEvents, scheduledTasks, chatSessions, messageCount] = await Promise.all([
      db.agentOpsRun.findMany({
        where: { createdAt: { gte: since } },
        select: { source: true, status: true, durationMs: true, createdAt: true },
      }),
      db.agentOpsEvent.findMany({
        where: { createdAt: { gte: since }, eventType: 'tool_call' },
        select: { toolName: true },
      }),
      db.scheduledTask.count({ where: { taskStatus: 'active' } }),
      db.chatSession.count({ where: { createdAt: { gte: since } } }),
      db.chatMessage.count({ where: { createdAt: { gte: since } } }),
    ]);

    // By source
    const sourceMap = new Map<string, number>();
    for (const run of runs) {
      sourceMap.set(run.source, (sourceMap.get(run.source) || 0) + 1);
    }
    const bySource = Array.from(sourceMap.entries()).map(([source, count]) => ({ source, count }));

    // Timeline
    const timelineMap = new Map<string, { completed: number; failed: number; inProgress: number; cancelled: number }>();
    for (const run of runs) {
      const bucket = bucketTimestamp(run.createdAt, range);
      const entry = timelineMap.get(bucket) || { completed: 0, failed: 0, inProgress: 0, cancelled: 0 };
      if (run.status === 'completed') entry.completed++;
      else if (run.status === 'failed') entry.failed++;
      else if (run.status === 'in_progress' || run.status === 'queued') entry.inProgress++;
      else if (run.status === 'cancelled') entry.cancelled++;
      timelineMap.set(bucket, entry);
    }
    const timeline = Array.from(timelineMap.entries())
      .map(([time, data]) => ({ time, ...data }))
      .sort((a, b) => a.time.localeCompare(b.time));

    // Top tools
    const toolMap = new Map<string, number>();
    for (const event of toolEvents) {
      if (event.toolName) {
        toolMap.set(event.toolName, (toolMap.get(event.toolName) || 0) + 1);
      }
    }
    const topTools = Array.from(toolMap.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const completedRuns = runs.filter(r => r.status === 'completed');
    const totalDuration = completedRuns.reduce((sum, r) => sum + (r.durationMs || 0), 0);

    return {
      bySource,
      timeline,
      topTools,
      summary: {
        totalRuns: runs.length,
        successRate: runs.length > 0 ? Math.round((completedRuns.length / runs.length) * 100) : 0,
        avgDurationMs: completedRuns.length > 0 ? Math.round(totalDuration / completedRuns.length) : 0,
        activeScheduledTasks: scheduledTasks,
        chatSessions,
        messageCount,
      },
    };
  }
```

- [ ] **Step 3: Add getAuditMetrics method**

Add the following method inside the `DashboardService` class:

```typescript
  static async getAuditMetrics(tenantId: string, range: TimeRange): Promise<AuditDashboardResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const logs = await db.auditLog.findMany({
      where: { timestamp: { gte: since } },
      select: { eventType: true, status: true, severity: true, userType: true, user: true, timestamp: true },
      take: 5000,
      orderBy: { timestamp: 'desc' },
    });

    // Timeline by severity
    const timelineMap = new Map<string, { success: number; warning: number; error: number }>();
    for (const log of logs) {
      const bucket = bucketTimestamp(log.timestamp, range);
      const entry = timelineMap.get(bucket) || { success: 0, warning: 0, error: 0 };
      if (log.severity === 'critical' || log.severity === 'high') entry.error++;
      else if (log.severity === 'medium') entry.warning++;
      else entry.success++;
      timelineMap.set(bucket, entry);
    }
    const timeline = Array.from(timelineMap.entries())
      .map(([time, data]) => ({ time, ...data }))
      .sort((a, b) => a.time.localeCompare(b.time));

    // By type (top 10)
    const typeMap = new Map<string, { count: number; severity: string }>();
    for (const log of logs) {
      const existing = typeMap.get(log.eventType);
      if (existing) {
        existing.count++;
      } else {
        typeMap.set(log.eventType, { count: 1, severity: log.severity });
      }
    }
    const byType = Array.from(typeMap.entries())
      .map(([eventType, data]) => ({ eventType, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // By status
    const statusMap = new Map<string, number>();
    for (const log of logs) {
      statusMap.set(log.status, (statusMap.get(log.status) || 0) + 1);
    }
    const byStatus = Array.from(statusMap.entries()).map(([status, count]) => ({ status, count }));

    // User vs system
    const userSystemMap = new Map<string, { user: number; system: number }>();
    for (const log of logs) {
      const bucket = bucketTimestamp(log.timestamp, range);
      const entry = userSystemMap.get(bucket) || { user: 0, system: 0 };
      if (log.userType === 'system') entry.system++;
      else entry.user++;
      userSystemMap.set(bucket, entry);
    }
    const userVsSystem = Array.from(userSystemMap.entries())
      .map(([time, data]) => ({ time, ...data }))
      .sort((a, b) => a.time.localeCompare(b.time));

    const successCount = logs.filter(l => l.status === 'success').length;
    const criticalCount = logs.filter(l => l.severity === 'critical').length;
    const uniqueUsers = new Set(logs.map(l => l.user)).size;
    const systemEvents = logs.filter(l => l.userType === 'system').length;

    // Top user
    const userCountMap = new Map<string, number>();
    for (const log of logs) {
      if (log.userType !== 'system') {
        userCountMap.set(log.user, (userCountMap.get(log.user) || 0) + 1);
      }
    }
    const topUser = Array.from(userCountMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

    return {
      timeline,
      byType,
      byStatus,
      userVsSystem,
      summary: {
        totalEvents: logs.length,
        successRate: logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 0,
        criticalCount,
        uniqueUsers,
        systemEvents,
        topUser,
      },
    };
  }
```

- [ ] **Step 4: Add the missing imports at the top of dashboard-service.ts**

Update the import statement at the top of the file to include the new types:

```typescript
import type {
  TimeRange,
  KpiResponse,
  CostResponse,
  OperationsResponse,
  AgentResponse,
  AuditDashboardResponse,
} from '@/lib/dashboard-types';
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx tsc --noEmit 2>&1 | grep dashboard | head -10`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/lib/dashboard-service.ts
git commit -m "feat(dashboard): add operations, agent, and audit metrics to dashboard service"
```

---

### Task 6: Dashboard Service — Inventory & Knowledge Base Methods

**Files:**
- Modify: `web-ui/lib/dashboard-service.ts`

- [ ] **Step 1: Add getInventoryMetrics method to DashboardService**

Add the following method inside the `DashboardService` class:

```typescript
  static async getInventoryMetrics(tenantId: string, range: TimeRange): Promise<InventoryResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const [resources, accounts, latestSync] = await Promise.all([
      db.inventoryResource.findMany({
        select: { resourceType: true, region: true, accountId: true, status: true, discoveredAt: true },
      }),
      db.account.findMany({
        select: { accountId: true, name: true },
      }),
      db.inventorySyncStatus.findFirst({
        where: { tenantId },
        orderBy: { syncedAt: 'desc' },
        select: { syncedAt: true, accountsSynced: true },
      }),
    ]);

    const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));

    // By type
    const typeMap = new Map<string, number>();
    for (const r of resources) {
      typeMap.set(r.resourceType, (typeMap.get(r.resourceType) || 0) + 1);
    }
    const byType = Array.from(typeMap.entries())
      .map(([resourceType, count]) => ({ resourceType, count }))
      .sort((a, b) => b.count - a.count);

    // By region
    const regionMap = new Map<string, number>();
    for (const r of resources) {
      regionMap.set(r.region, (regionMap.get(r.region) || 0) + 1);
    }
    const byRegion = Array.from(regionMap.entries())
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count);

    // By account with breakdown
    const accountBreakdown = new Map<string, Map<string, number>>();
    for (const r of resources) {
      if (!accountBreakdown.has(r.accountId)) {
        accountBreakdown.set(r.accountId, new Map());
      }
      const typeBreakdown = accountBreakdown.get(r.accountId)!;
      typeBreakdown.set(r.resourceType, (typeBreakdown.get(r.resourceType) || 0) + 1);
    }
    const byAccount = Array.from(accountBreakdown.entries()).map(([accountId, breakdown]) => ({
      accountId,
      accountName: accountMap.get(accountId) || accountId,
      breakdown: Array.from(breakdown.entries()).map(([resourceType, count]) => ({ resourceType, count })),
    }));

    const running = resources.filter(r => r.status === 'running' || r.status === 'available' || r.status === 'active').length;
    const stopped = resources.filter(r => r.status === 'stopped' || r.status === 'inactive').length;
    const newDiscovered = resources.filter(r => r.discoveredAt >= since).length;

    return {
      byType,
      byRegion,
      byAccount,
      summary: {
        totalResources: resources.length,
        accountsSynced: latestSync?.accountsSynced || 0,
        lastScanAt: latestSync?.syncedAt?.toISOString() || '',
        running,
        stopped,
        other: resources.length - running - stopped,
        newDiscovered,
      },
    };
  }
```

- [ ] **Step 2: Add getKnowledgeBaseMetrics method**

Add the following method inside the `DashboardService` class:

```typescript
  static async getKnowledgeBaseMetrics(tenantId: string): Promise<KnowledgeBaseResponse> {
    const db = getTenantClient(tenantId);

    const kbs = await db.knowledgeBase.findMany({
      select: {
        id: true,
        name: true,
        status: true,
        vectorCount: true,
        dataSources: {
          select: {
            id: true,
            name: true,
            sourceType: true,
            status: true,
            vectorCount: true,
            lastSyncAt: true,
            lastSyncError: true,
          },
        },
      },
    });

    const knowledgeBases = kbs.map(kb => ({
      id: kb.id,
      name: kb.name,
      status: kb.status,
      vectorCount: kb.vectorCount,
      dataSources: kb.dataSources.map(ds => ({
        id: ds.id,
        name: ds.name,
        sourceType: ds.sourceType,
        status: ds.status,
        lastSyncAt: ds.lastSyncAt?.toISOString() || null,
        lastSyncError: ds.lastSyncError || null,
      })),
    }));

    // By source type
    const sourceTypeMap = new Map<string, number>();
    for (const kb of kbs) {
      for (const ds of kb.dataSources) {
        sourceTypeMap.set(ds.sourceType, (sourceTypeMap.get(ds.sourceType) || 0) + ds.vectorCount);
      }
    }
    const bySourceType = Array.from(sourceTypeMap.entries())
      .map(([sourceType, vectorCount]) => ({ sourceType, vectorCount }));

    const allDataSources = kbs.flatMap(kb => kb.dataSources);
    const syncErrors = allDataSources.filter(ds => ds.status === 'error').length;
    const lastSyncDates = allDataSources
      .filter(ds => ds.lastSyncAt)
      .map(ds => ds.lastSyncAt!.getTime());
    const lastSyncAt = lastSyncDates.length > 0
      ? new Date(Math.max(...lastSyncDates)).toISOString()
      : null;

    return {
      knowledgeBases,
      bySourceType,
      summary: {
        totalKBs: kbs.length,
        totalVectors: kbs.reduce((sum, kb) => sum + kb.vectorCount, 0),
        totalDataSources: allDataSources.length,
        syncErrors,
        lastSyncAt,
      },
    };
  }
```

- [ ] **Step 3: Add the missing imports at the top of dashboard-service.ts**

Update the import to include:

```typescript
import type {
  TimeRange,
  KpiResponse,
  CostResponse,
  OperationsResponse,
  AgentResponse,
  AuditDashboardResponse,
  InventoryResponse,
  KnowledgeBaseResponse,
} from '@/lib/dashboard-types';
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx tsc --noEmit 2>&1 | grep dashboard | head -10`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/lib/dashboard-service.ts
git commit -m "feat(dashboard): add inventory and knowledge base metrics to dashboard service"
```

---

### Task 7: API Routes — All 7 Dashboard Endpoints

**Files:**
- Create: `web-ui/app/api/dashboard/kpi/route.ts`
- Create: `web-ui/app/api/dashboard/cost/route.ts`
- Create: `web-ui/app/api/dashboard/operations/route.ts`
- Create: `web-ui/app/api/dashboard/agent/route.ts`
- Create: `web-ui/app/api/dashboard/audit/route.ts`
- Create: `web-ui/app/api/dashboard/inventory/route.ts`
- Create: `web-ui/app/api/dashboard/knowledge-base/route.ts`

All routes follow the same pattern: auth check → parse range param → call service → return JSON. We create all 7 in one task since they're identical in structure.

- [ ] **Step 1: Create the KPI route**

```typescript
// web-ui/app/api/dashboard/kpi/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);

export async function GET(request: NextRequest) {
  const authError = await authorize('read', 'Account');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const range = (request.nextUrl.searchParams.get('range') || '24h') as TimeRange;
    if (!VALID_RANGES.has(range)) {
      return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
    }

    const data = await DashboardService.getKpiStats(tenantId, range);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/kpi error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch KPI stats' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Create the cost route**

```typescript
// web-ui/app/api/dashboard/cost/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);

export async function GET(request: NextRequest) {
  const authError = await authorize('read', 'Schedule');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const range = (request.nextUrl.searchParams.get('range') || '24h') as TimeRange;
    if (!VALID_RANGES.has(range)) {
      return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
    }

    const data = await DashboardService.getCostMetrics(tenantId, range);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/cost error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch cost metrics' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Create the operations route**

```typescript
// web-ui/app/api/dashboard/operations/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);

export async function GET(request: NextRequest) {
  const authError = await authorize('read', 'Schedule');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const range = (request.nextUrl.searchParams.get('range') || '24h') as TimeRange;
    if (!VALID_RANGES.has(range)) {
      return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
    }

    const data = await DashboardService.getOperationsMetrics(tenantId, range);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/operations error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch operations metrics' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4: Create the agent route**

```typescript
// web-ui/app/api/dashboard/agent/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);

export async function GET(request: NextRequest) {
  const authError = await authorize('read', 'AgentOps');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const range = (request.nextUrl.searchParams.get('range') || '24h') as TimeRange;
    if (!VALID_RANGES.has(range)) {
      return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
    }

    const data = await DashboardService.getAgentMetrics(tenantId, range);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/agent error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch agent metrics' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 5: Create the audit route**

```typescript
// web-ui/app/api/dashboard/audit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);

export async function GET(request: NextRequest) {
  const authError = await authorize('read', 'AuditLog');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const range = (request.nextUrl.searchParams.get('range') || '24h') as TimeRange;
    if (!VALID_RANGES.has(range)) {
      return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
    }

    const data = await DashboardService.getAuditMetrics(tenantId, range);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/audit error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch audit metrics' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 6: Create the inventory route**

```typescript
// web-ui/app/api/dashboard/inventory/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);

export async function GET(request: NextRequest) {
  const authError = await authorize('read', 'Account');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const range = (request.nextUrl.searchParams.get('range') || '24h') as TimeRange;
    if (!VALID_RANGES.has(range)) {
      return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
    }

    const data = await DashboardService.getInventoryMetrics(tenantId, range);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/inventory error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch inventory metrics' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 7: Create the knowledge-base route**

```typescript
// web-ui/app/api/dashboard/knowledge-base/route.ts
import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';

export async function GET() {
  const authError = await authorize('read', 'KnowledgeBase');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const data = await DashboardService.getKnowledgeBaseMetrics(tenantId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/knowledge-base error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch knowledge base metrics' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 8: Verify lint passes on all routes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/app/api/dashboard/
git commit -m "feat(dashboard): add all 7 dashboard API routes"
```

---

### Task 8: KPI Summary Section Component

**Files:**
- Create: `web-ui/components/dashboard/kpi-summary-section.tsx`

- [ ] **Step 1: Create the KPI summary section with 6 stat cards and sparklines**

```typescript
// web-ui/components/dashboard/kpi-summary-section.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import {
  DollarSign,
  Server,
  Globe,
  Bot,
  CheckCircle,
  Shield,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import type { TimeRange, KpiResponse, KpiCard } from "@/lib/dashboard-types";

const ICON_MAP: Record<string, React.ElementType> = {
  savings: DollarSign,
  resources: Server,
  accounts: Globe,
  "agent-runs": Bot,
  "success-rate": CheckCircle,
  "audit-events": Shield,
};

const DELTA_ICON_MAP = {
  up: TrendingUp,
  down: TrendingDown,
  neutral: Minus,
};

interface KpiSummarySectionProps {
  timeRange: TimeRange;
  refreshKey: number;
}

export function KpiSummarySection({ timeRange, refreshKey }: KpiSummarySectionProps) {
  const [data, setData] = useState<KpiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/kpi?range=${timeRange}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to fetch KPI data");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch KPI data");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (loading) return <SectionSkeleton title="Key Metrics" chartCount={3} />;
  if (error) return <SectionError title="Key Metrics" message={error} onRetry={fetchData} />;
  if (!data) return null;

  return (
    <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      {data.cards.map((card) => (
        <KpiStatCard key={card.id} card={card} />
      ))}
    </div>
  );
}

function KpiStatCard({ card }: { card: KpiCard }) {
  const Icon = ICON_MAP[card.id] || Shield;
  const DeltaIcon = DELTA_ICON_MAP[card.deltaDirection];

  const sparklineData = card.sparkline.length > 0
    ? card.sparkline.map((value, i) => ({ idx: i, value }))
    : null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">{card.label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="text-2xl font-bold text-foreground">{card.formattedValue}</div>
        <div className="flex items-center gap-1 mt-1">
          <DeltaIcon
            className={cn(
              "h-3 w-3",
              card.deltaDirection === "up" && "text-emerald-500",
              card.deltaDirection === "down" && "text-red-500",
              card.deltaDirection === "neutral" && "text-muted-foreground"
            )}
          />
          <span
            className={cn(
              "text-xs",
              card.deltaDirection === "up" && "text-emerald-500",
              card.deltaDirection === "down" && "text-red-500",
              card.deltaDirection === "neutral" && "text-muted-foreground"
            )}
          >
            {card.delta}%
          </span>
          <span className="text-xs text-muted-foreground">vs prev</span>
        </div>
        {sparklineData && (
          <div className="mt-2 h-8">
            <ChartContainer
              config={{ value: { label: card.label, color: "hsl(var(--chart-1))" } }}
              className="h-8 w-full"
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sparklineData}>
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="hsl(var(--chart-1))"
                    fill="hsl(var(--chart-1))"
                    fillOpacity={0.1}
                    strokeWidth={1.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/kpi-summary-section.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/kpi-summary-section.tsx
git commit -m "feat(dashboard): add KPI summary section with stat cards and sparklines"
```

---

### Task 9: Cost Optimization Section Component

**Files:**
- Create: `web-ui/components/dashboard/cost-optimization-section.tsx`

- [ ] **Step 1: Create the cost optimization section with area chart and horizontal bar chart**

```typescript
// web-ui/components/dashboard/cost-optimization-section.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { DollarSign, TrendingDown, Target, Award } from "lucide-react";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SectionEmpty } from "./section-empty";
import type { TimeRange, CostResponse } from "@/lib/dashboard-types";

interface CostOptimizationSectionProps {
  timeRange: TimeRange;
  refreshKey: number;
}

export function CostOptimizationSection({ timeRange, refreshKey }: CostOptimizationSectionProps) {
  const [data, setData] = useState<CostResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/cost?range=${timeRange}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to fetch cost data");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch cost data");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (loading) return <SectionSkeleton title="Cost Optimization" />;
  if (error) return <SectionError title="Cost Optimization" message={error} onRetry={fetchData} />;
  if (!data || (data.trend.length === 0 && data.byAccount.length === 0)) {
    return <SectionEmpty title="Cost Optimization" message="No schedule executions found for the selected period." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Cost Optimization & Savings</CardTitle>
        <CardDescription>Estimated savings from resource scheduling</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {/* Savings Trend */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Savings Trend</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  savings: { label: "Savings ($)", color: "hsl(var(--chart-1))" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.trend}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area
                      type="monotone"
                      dataKey="savings"
                      stroke="hsl(var(--chart-1))"
                      fill="hsl(var(--chart-1))"
                      fillOpacity={0.2}
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Savings by Account */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Savings by Account</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  savings: { label: "Savings ($)", color: "hsl(var(--chart-2))" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byAccount} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis dataKey="accountName" type="category" tick={{ fontSize: 11 }} width={120} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="savings" fill="hsl(var(--chart-2))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Savings</p>
              <p className="text-sm font-bold">${data.summary.totalSavings.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Avg Daily</p>
              <p className="text-sm font-bold">${data.summary.avgDailySavings.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Award className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Top Account</p>
              <p className="text-sm font-bold truncate">{data.summary.topAccount}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Target className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Optimized</p>
              <p className="text-sm font-bold">{data.summary.resourcesOptimized} schedules</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/cost-optimization-section.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/cost-optimization-section.tsx
git commit -m "feat(dashboard): add cost optimization section with savings trend and account breakdown"
```

---

### Task 10: Operational Health Section Component

**Files:**
- Create: `web-ui/components/dashboard/operational-health-section.tsx`

- [ ] **Step 1: Create the operational health section with account badges, execution timeline, and execution by schedule charts**

```typescript
// web-ui/components/dashboard/operational-health-section.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { Activity, CheckCircle, Clock, Server, XCircle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SectionEmpty } from "./section-empty";
import type { TimeRange, OperationsResponse } from "@/lib/dashboard-types";

interface OperationalHealthSectionProps {
  timeRange: TimeRange;
  refreshKey: number;
}

export function OperationalHealthSection({ timeRange, refreshKey }: OperationalHealthSectionProps) {
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/operations?range=${timeRange}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to fetch operations data");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch operations data");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (loading) return <SectionSkeleton title="Operational Health" />;
  if (error) return <SectionError title="Operational Health" message={error} onRetry={fetchData} />;
  if (!data) return <SectionEmpty title="Operational Health" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Operational Health</CardTitle>
        <CardDescription>Account connectivity and schedule execution performance</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Account Health Badges */}
        <div className="flex flex-wrap gap-2">
          {data.accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs"
            >
              <div
                className={cn(
                  "h-2 w-2 rounded-full",
                  account.status === "connected" && "bg-emerald-500",
                  account.status === "disconnected" && "bg-red-500",
                  account.status !== "connected" && account.status !== "disconnected" && "bg-yellow-500"
                )}
              />
              <span className="font-medium">{account.name}</span>
              {account.lastSyncedAt && (
                <span className="text-muted-foreground">
                  {formatRelativeTime(account.lastSyncedAt)}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Execution Timeline */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Execution Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  success: { label: "Success", color: "#10b981" },
                  failed: { label: "Failed", color: "#ef4444" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.executionTimeline}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line type="monotone" dataKey="success" stroke="#10b981" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Execution by Schedule */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Execution by Schedule</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  success: { label: "Success", color: "#10b981" },
                  partialFail: { label: "Partial Fail", color: "#f59e0b" },
                  fullFail: { label: "Full Fail", color: "#ef4444" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.executionBySchedule}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="scheduleName" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="success" stackId="a" fill="#10b981" />
                    <Bar dataKey="partialFail" stackId="a" fill="#f59e0b" />
                    <Bar dataKey="fullFail" stackId="a" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Executions</p>
              <p className="text-sm font-bold">{data.summary.totalExecutions}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Success Rate</p>
              <p className="text-sm font-bold">{data.summary.successRate}%</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Avg Duration</p>
              <p className="text-sm font-bold">{(data.summary.avgDurationMs / 1000).toFixed(1)}s</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Zap className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Started</p>
              <p className="text-sm font-bold">{data.summary.resourcesStarted}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Server className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Stopped</p>
              <p className="text-sm font-bold">{data.summary.resourcesStopped}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Failed</p>
              <p className="text-sm font-bold text-destructive">{data.summary.failedActions}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/operational-health-section.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/operational-health-section.tsx
git commit -m "feat(dashboard): add operational health section with account badges and execution charts"
```

---

### Task 11: Agent Analytics Section Component

**Files:**
- Create: `web-ui/components/dashboard/agent-analytics-section.tsx`

- [ ] **Step 1: Create the agent analytics section with donut, stacked area, and horizontal bar charts**

```typescript
// web-ui/components/dashboard/agent-analytics-section.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { Bot, CheckCircle, Clock, Calendar, MessageSquare, Wrench } from "lucide-react";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SectionEmpty } from "./section-empty";
import type { TimeRange, AgentResponse } from "@/lib/dashboard-types";

const SOURCE_COLORS: Record<string, string> = {
  slack: "#4A154B",
  jira: "#0052CC",
  api: "#10b981",
  scheduled: "#f59e0b",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "#10b981",
  failed: "#ef4444",
  inProgress: "#3b82f6",
  cancelled: "#6b7280",
};

interface AgentAnalyticsSectionProps {
  timeRange: TimeRange;
  refreshKey: number;
}

export function AgentAnalyticsSection({ timeRange, refreshKey }: AgentAnalyticsSectionProps) {
  const [data, setData] = useState<AgentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/agent?range=${timeRange}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to fetch agent data");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch agent data");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (loading) return <SectionSkeleton title="AI Agent Analytics" />;
  if (error) return <SectionError title="AI Agent Analytics" message={error} onRetry={fetchData} />;
  if (!data || data.summary.totalRuns === 0) {
    return <SectionEmpty title="AI Agent Analytics" message="No agent runs found for the selected period." />;
  }

  const totalRuns = data.bySource.reduce((sum, s) => sum + s.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">AI Agent Analytics</CardTitle>
        <CardDescription>Agent usage patterns, performance, and tool utilization</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {/* Runs by Source (Donut) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Runs by Source</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  count: { label: "Runs", color: "hsl(var(--chart-1))" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.bySource}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      dataKey="count"
                      nameKey="source"
                      label={({ source, percent }) =>
                        `${source} ${(percent * 100).toFixed(0)}%`
                      }
                    >
                      {data.bySource.map((entry) => (
                        <Cell
                          key={entry.source}
                          fill={SOURCE_COLORS[entry.source] || "#8884d8"}
                        />
                      ))}
                    </Pie>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-2xl font-bold">
                      {totalRuns}
                    </text>
                  </PieChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Run Timeline (Stacked Area) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Run Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  completed: { label: "Completed", color: "#10b981" },
                  failed: { label: "Failed", color: "#ef4444" },
                  inProgress: { label: "In Progress", color: "#3b82f6" },
                  cancelled: { label: "Cancelled", color: "#6b7280" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.timeline}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area type="monotone" dataKey="completed" stackId="1" stroke="#10b981" fill="#10b981" fillOpacity={0.4} />
                    <Area type="monotone" dataKey="failed" stackId="1" stroke="#ef4444" fill="#ef4444" fillOpacity={0.4} />
                    <Area type="monotone" dataKey="inProgress" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.4} />
                    <Area type="monotone" dataKey="cancelled" stackId="1" stroke="#6b7280" fill="#6b7280" fillOpacity={0.4} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        {/* Top Tool Usage */}
        {data.topTools.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Top Tool Usage</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  count: { label: "Invocations", color: "hsl(var(--chart-3))" },
                }}
                className="h-[250px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.topTools} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis dataKey="toolName" type="category" tick={{ fontSize: 11 }} width={140} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="count" fill="hsl(var(--chart-3))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        )}

        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Runs</p>
              <p className="text-sm font-bold">{data.summary.totalRuns}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Success Rate</p>
              <p className="text-sm font-bold">{data.summary.successRate}%</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Avg Duration</p>
              <p className="text-sm font-bold">{(data.summary.avgDurationMs / 1000).toFixed(1)}s</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Scheduled Tasks</p>
              <p className="text-sm font-bold">{data.summary.activeScheduledTasks}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Chat Sessions</p>
              <p className="text-sm font-bold">{data.summary.chatSessions}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Messages</p>
              <p className="text-sm font-bold">{data.summary.messageCount}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/agent-analytics-section.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/agent-analytics-section.tsx
git commit -m "feat(dashboard): add agent analytics section with source donut, timeline, and tool usage"
```

---

### Task 12: Security & Audit Section Component

**Files:**
- Create: `web-ui/components/dashboard/security-audit-section.tsx`

- [ ] **Step 1: Create the security audit section with 2x2 chart grid**

```typescript
// web-ui/components/dashboard/security-audit-section.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { Shield, CheckCircle, AlertTriangle, Users, Monitor, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SectionEmpty } from "./section-empty";
import type { TimeRange, AuditDashboardResponse } from "@/lib/dashboard-types";

const STATUS_COLORS: Record<string, string> = {
  success: "#10b981",
  failure: "#ef4444",
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#3b82f6",
};

interface SecurityAuditSectionProps {
  timeRange: TimeRange;
  refreshKey: number;
}

export function SecurityAuditSection({ timeRange, refreshKey }: SecurityAuditSectionProps) {
  const [data, setData] = useState<AuditDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/audit?range=${timeRange}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to fetch audit data");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch audit data");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (loading) return <SectionSkeleton title="Security & Audit" chartCount={4} />;
  if (error) return <SectionError title="Security & Audit" message={error} onRetry={fetchData} />;
  if (!data || data.summary.totalEvents === 0) {
    return <SectionEmpty title="Security & Audit" message="No audit events found for the selected period." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Security & Audit</CardTitle>
        <CardDescription>Audit trail, event patterns, and security posture</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {/* Event Timeline */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Event Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  success: { label: "Success", color: "#10b981" },
                  warning: { label: "Warning", color: "#f59e0b" },
                  error: { label: "Error/Critical", color: "#ef4444" },
                }}
                className="h-[250px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.timeline}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line type="monotone" dataKey="success" stroke="#10b981" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="warning" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="error" stroke="#ef4444" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Events by Type */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Events by Type</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  count: { label: "Events", color: "hsl(var(--chart-1))" },
                }}
                className="h-[250px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byType}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="eventType" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="count" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Status Distribution */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Status Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  count: { label: "Events", color: "hsl(var(--chart-2))" },
                }}
                className="h-[250px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.byStatus}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      dataKey="count"
                      nameKey="status"
                      label={({ status, percent }) =>
                        `${status} ${(percent * 100).toFixed(0)}%`
                      }
                    >
                      {data.byStatus.map((entry) => (
                        <Cell
                          key={entry.status}
                          fill={STATUS_COLORS[entry.status] || "#8884d8"}
                        />
                      ))}
                    </Pie>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-xl font-bold">
                      {data.summary.totalEvents}
                    </text>
                  </PieChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* User vs System */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">User vs System Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  user: { label: "User", color: "#3b82f6" },
                  system: { label: "System", color: "#6b7280" },
                }}
                className="h-[250px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.userVsSystem}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area type="monotone" dataKey="user" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.4} />
                    <Area type="monotone" dataKey="system" stackId="1" stroke="#6b7280" fill="#6b7280" fillOpacity={0.4} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Events</p>
              <p className="text-sm font-bold">{data.summary.totalEvents}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Success Rate</p>
              <p className="text-sm font-bold">{data.summary.successRate}%</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <AlertTriangle className={cn("h-4 w-4", data.summary.criticalCount > 0 ? "text-destructive" : "text-muted-foreground")} />
            <div>
              <p className="text-xs text-muted-foreground">Critical</p>
              <p className={cn("text-sm font-bold", data.summary.criticalCount > 0 && "text-destructive")}>{data.summary.criticalCount}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Users className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Unique Users</p>
              <p className="text-sm font-bold">{data.summary.uniqueUsers}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">System Events</p>
              <p className="text-sm font-bold">{data.summary.systemEvents}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <User className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Top User</p>
              <p className="text-sm font-bold truncate">{data.summary.topUser}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/security-audit-section.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/security-audit-section.tsx
git commit -m "feat(dashboard): add security audit section with 2x2 chart grid"
```

---

### Task 13: Inventory Overview Section Component

**Files:**
- Create: `web-ui/components/dashboard/inventory-overview-section.tsx`

- [ ] **Step 1: Create the inventory overview section with donut, bar, and stacked bar charts**

```typescript
// web-ui/components/dashboard/inventory-overview-section.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { Database, Globe, Server, Plus, Play, Square } from "lucide-react";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SectionEmpty } from "./section-empty";
import type { TimeRange, InventoryResponse } from "@/lib/dashboard-types";

const TYPE_COLORS: Record<string, string> = {
  ec2: "#3b82f6",
  ecs: "#8b5cf6",
  rds: "#f59e0b",
  asg: "#10b981",
  docdb: "#ef4444",
};

interface InventoryOverviewSectionProps {
  timeRange: TimeRange;
  refreshKey: number;
}

export function InventoryOverviewSection({ timeRange, refreshKey }: InventoryOverviewSectionProps) {
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/inventory?range=${timeRange}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to fetch inventory data");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch inventory data");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (loading) return <SectionSkeleton title="Inventory Overview" />;
  if (error) return <SectionError title="Inventory Overview" message={error} onRetry={fetchData} />;
  if (!data || data.summary.totalResources === 0) {
    return <SectionEmpty title="Inventory Overview" message="No resources discovered yet. Run a discovery scan to populate inventory." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Inventory Overview</CardTitle>
        <CardDescription>Discovered AWS resources across all connected accounts</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {/* Resources by Type (Donut) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Resources by Type</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  count: { label: "Resources", color: "hsl(var(--chart-1))" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.byType}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      dataKey="count"
                      nameKey="resourceType"
                      label={({ resourceType, percent }) =>
                        `${resourceType.toUpperCase()} ${(percent * 100).toFixed(0)}%`
                      }
                    >
                      {data.byType.map((entry) => (
                        <Cell
                          key={entry.resourceType}
                          fill={TYPE_COLORS[entry.resourceType.toLowerCase()] || "#8884d8"}
                        />
                      ))}
                    </Pie>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-2xl font-bold">
                      {data.summary.totalResources}
                    </text>
                  </PieChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Resources by Region (Bar) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Resources by Region</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  count: { label: "Resources", color: "hsl(var(--chart-2))" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byRegion}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="region" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        {/* Resources by Account (Stacked Bar) */}
        {data.byAccount.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Resources by Account</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  ec2: { label: "EC2", color: "#3b82f6" },
                  ecs: { label: "ECS", color: "#8b5cf6" },
                  rds: { label: "RDS", color: "#f59e0b" },
                  asg: { label: "ASG", color: "#10b981" },
                  docdb: { label: "DocDB", color: "#ef4444" },
                }}
                className="h-[250px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.byAccount.map((a) => {
                      const row: Record<string, string | number> = { accountName: a.accountName };
                      for (const b of a.breakdown) {
                        row[b.resourceType.toLowerCase()] = b.count;
                      }
                      return row;
                    })}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="accountName" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="ec2" stackId="a" fill="#3b82f6" />
                    <Bar dataKey="ecs" stackId="a" fill="#8b5cf6" />
                    <Bar dataKey="rds" stackId="a" fill="#f59e0b" />
                    <Bar dataKey="asg" stackId="a" fill="#10b981" />
                    <Bar dataKey="docdb" stackId="a" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        )}

        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Database className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-sm font-bold">{data.summary.totalResources}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Accounts Synced</p>
              <p className="text-sm font-bold">{data.summary.accountsSynced}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Server className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Last Scan</p>
              <p className="text-sm font-bold">{data.summary.lastScanAt ? new Date(data.summary.lastScanAt).toLocaleDateString() : 'Never'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Play className="h-4 w-4 text-emerald-500" />
            <div>
              <p className="text-xs text-muted-foreground">Running</p>
              <p className="text-sm font-bold">{data.summary.running}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Square className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Stopped</p>
              <p className="text-sm font-bold">{data.summary.stopped}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Plus className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">New Discovered</p>
              <p className="text-sm font-bold">{data.summary.newDiscovered}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/inventory-overview-section.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/inventory-overview-section.tsx
git commit -m "feat(dashboard): add inventory overview section with resource distribution charts"
```

---

### Task 14: Knowledge Base Section Component

**Files:**
- Create: `web-ui/components/dashboard/knowledge-base-section.tsx`

- [ ] **Step 1: Create the knowledge base section with KB cards and vectors donut**

```typescript
// web-ui/components/dashboard/knowledge-base-section.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { BookOpen, Database, FileText, AlertCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SectionEmpty } from "./section-empty";
import type { KnowledgeBaseResponse } from "@/lib/dashboard-types";

const SOURCE_TYPE_COLORS: Record<string, string> = {
  "s3-bucket": "#f59e0b",
  "confluence": "#3b82f6",
  "bitbucket": "#0052CC",
  "file-upload": "#10b981",
};

const SOURCE_TYPE_ICONS: Record<string, string> = {
  "s3-bucket": "S3",
  "confluence": "CF",
  "bitbucket": "BB",
  "file-upload": "FU",
};

interface KnowledgeBaseSectionProps {
  refreshKey: number;
}

export function KnowledgeBaseSection({ refreshKey }: KnowledgeBaseSectionProps) {
  const [data, setData] = useState<KnowledgeBaseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/knowledge-base");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to fetch KB data");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch KB data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (loading) return <SectionSkeleton title="Knowledge Base" />;
  if (error) return <SectionError title="Knowledge Base" message={error} onRetry={fetchData} />;
  if (!data || data.summary.totalKBs === 0) {
    return <SectionEmpty title="Knowledge Base" message="No knowledge bases configured yet." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Knowledge Base Status</CardTitle>
        <CardDescription>Knowledge base health and data source sync status</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {/* KB Cards */}
          <div className="space-y-3">
            {data.knowledgeBases.map((kb) => (
              <Card key={kb.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm">{kb.name}</span>
                    <Badge
                      variant={kb.status === "active" ? "default" : "destructive"}
                      className="text-xs"
                    >
                      {kb.status}
                    </Badge>
                  </div>
                  <div className="flex gap-4 text-xs text-muted-foreground mb-2">
                    <span>{kb.vectorCount} vectors</span>
                    <span>{kb.dataSources.length} sources</span>
                  </div>
                  {kb.dataSources.length > 0 && (
                    <div className="space-y-1.5">
                      {kb.dataSources.map((ds) => (
                        <div
                          key={ds.id}
                          className="flex items-center justify-between text-xs rounded border px-2 py-1"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] bg-muted px-1 rounded">
                              {SOURCE_TYPE_ICONS[ds.sourceType] || ds.sourceType}
                            </span>
                            <span className="truncate max-w-[120px]">{ds.name}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {ds.status === "error" ? (
                              <AlertCircle className="h-3 w-3 text-destructive" />
                            ) : ds.status === "synced" ? (
                              <div className="h-2 w-2 rounded-full bg-emerald-500" />
                            ) : (
                              <div className="h-2 w-2 rounded-full bg-yellow-500" />
                            )}
                            {ds.lastSyncAt && (
                              <span className="text-muted-foreground">
                                {new Date(ds.lastSyncAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Vectors by Source Type (Donut) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Vectors by Source Type</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  vectorCount: { label: "Vectors", color: "hsl(var(--chart-1))" },
                }}
                className="h-[300px]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.bySourceType}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      dataKey="vectorCount"
                      nameKey="sourceType"
                      label={({ sourceType, percent }) =>
                        `${sourceType} ${(percent * 100).toFixed(0)}%`
                      }
                    >
                      {data.bySourceType.map((entry) => (
                        <Cell
                          key={entry.sourceType}
                          fill={SOURCE_TYPE_COLORS[entry.sourceType] || "#8884d8"}
                        />
                      ))}
                    </Pie>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-2xl font-bold">
                      {data.summary.totalVectors}
                    </text>
                  </PieChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">KBs</p>
              <p className="text-sm font-bold">{data.summary.totalKBs}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Database className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Vectors</p>
              <p className="text-sm font-bold">{data.summary.totalVectors.toLocaleString()}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Data Sources</p>
              <p className="text-sm font-bold">{data.summary.totalDataSources}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <AlertCircle className={cn("h-4 w-4", data.summary.syncErrors > 0 ? "text-destructive" : "text-muted-foreground")} />
            <div>
              <p className="text-xs text-muted-foreground">Sync Errors</p>
              <p className={cn("text-sm font-bold", data.summary.syncErrors > 0 && "text-destructive")}>{data.summary.syncErrors}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Last Sync</p>
              <p className="text-sm font-bold">{data.summary.lastSyncAt ? new Date(data.summary.lastSyncAt).toLocaleDateString() : 'Never'}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file components/dashboard/knowledge-base-section.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/components/dashboard/knowledge-base-section.tsx
git commit -m "feat(dashboard): add knowledge base section with KB cards and vectors donut"
```

---

### Task 15: Assemble Dashboard Page & Client Component

**Files:**
- Modify: `web-ui/app/app/dashboard/page.tsx`
- Modify: `web-ui/components/dashboard/dashboard-client.tsx`

This task replaces the existing dashboard page and client component with the new comprehensive layout that wires all 7 sections together.

- [ ] **Step 1: Replace the dashboard page server component**

Replace the entire contents of `web-ui/app/app/dashboard/page.tsx` with:

```typescript
// web-ui/app/app/dashboard/page.tsx
import { DashboardClient } from "@/components/dashboard/dashboard-client";

export default function Dashboard() {
  return <DashboardClient />;
}
```

- [ ] **Step 2: Replace the dashboard client component**

Replace the entire contents of `web-ui/components/dashboard/dashboard-client.tsx` with:

```typescript
// web-ui/components/dashboard/dashboard-client.tsx
"use client";

import { useState, useCallback } from "react";
import type { TimeRange } from "@/lib/dashboard-types";
import { DashboardHeader } from "./dashboard-header";
import { KpiSummarySection } from "./kpi-summary-section";
import { CostOptimizationSection } from "./cost-optimization-section";
import { OperationalHealthSection } from "./operational-health-section";
import { AgentAnalyticsSection } from "./agent-analytics-section";
import { SecurityAuditSection } from "./security-audit-section";
import { InventoryOverviewSection } from "./inventory-overview-section";
import { KnowledgeBaseSection } from "./knowledge-base-section";

export function DashboardClient() {
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    setRefreshKey((k) => k + 1);
    setTimeout(() => setIsRefreshing(false), 1000);
  }, []);

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 bg-background">
      <DashboardHeader
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
      />

      <KpiSummarySection timeRange={timeRange} refreshKey={refreshKey} />
      <CostOptimizationSection timeRange={timeRange} refreshKey={refreshKey} />
      <OperationalHealthSection timeRange={timeRange} refreshKey={refreshKey} />
      <AgentAnalyticsSection timeRange={timeRange} refreshKey={refreshKey} />
      <SecurityAuditSection timeRange={timeRange} refreshKey={refreshKey} />
      <InventoryOverviewSection timeRange={timeRange} refreshKey={refreshKey} />
      <KnowledgeBaseSection refreshKey={refreshKey} />
    </div>
  );
}
```

- [ ] **Step 3: Verify lint passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next lint --file app/app/dashboard/page.tsx --file components/dashboard/dashboard-client.tsx 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 4: Verify the build compiles**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npx next build 2>&1 | tail -20`
Expected: Build succeeds (or only pre-existing warnings)

- [ ] **Step 5: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add web-ui/app/app/dashboard/page.tsx web-ui/components/dashboard/dashboard-client.tsx
git commit -m "feat(dashboard): assemble comprehensive dashboard with all 7 sections"
```

---

### Task 16: Visual Verification & Smoke Test

**Files:** None (verification only)

This task verifies the dashboard renders correctly in the browser with the dev server running.

- [ ] **Step 1: Start the dev server**

The user should start the dev server manually:
```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard/web-ui && npm run dev
```

- [ ] **Step 2: Navigate to the dashboard**

Open `http://localhost:3001/app/dashboard` in the browser.

Verify:
- Dashboard header renders with "Dashboard" title, time range toggles (24h/7d/30d/90d), and refresh button
- 24h is selected by default
- All 7 sections render (some may show empty states if no data exists — that's expected)
- Each section shows a loading skeleton briefly, then resolves to data or empty state
- No console errors in the browser DevTools

- [ ] **Step 3: Test time range switching**

Click each time range toggle (7d, 30d, 90d, back to 24h). Verify:
- All sections re-fetch when the range changes
- Loading skeletons appear during fetch
- Data updates reflect the new range

- [ ] **Step 4: Test manual refresh**

Click the refresh button. Verify:
- The refresh icon spins briefly
- All sections re-fetch their data
- No errors

- [ ] **Step 5: Test responsive layout**

Resize the browser window:
- Desktop (≥1280px): charts side by side in 2-column grids
- Tablet (~768px): charts may stack or stay 2-column
- Mobile (~375px): single column, all charts full width
- KPI cards: 6-col → 3×2 → 2×3

- [ ] **Step 6: Test error handling**

Temporarily disconnect the database (stop the postgres container) and refresh. Verify:
- Each section shows the error card with "Failed to load data" message and a Retry button
- Clicking Retry re-fetches the data
- Restart postgres and verify sections recover on retry

- [ ] **Step 7: Final commit (if any fixes were needed)**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/dashboard
git add -A
git commit -m "fix(dashboard): address visual verification feedback"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Dashboard types & time range utilities | `dashboard-types.ts` |
| 2 | Shared section components (skeleton, error, empty) | 3 components |
| 3 | Dashboard header component | `dashboard-header.tsx` |
| 4 | Dashboard service — KPI & cost methods | `dashboard-service.ts` |
| 5 | Dashboard service — operations, agent, audit methods | `dashboard-service.ts` |
| 6 | Dashboard service — inventory & KB methods | `dashboard-service.ts` |
| 7 | All 7 API routes | 7 route files |
| 8 | KPI summary section component | `kpi-summary-section.tsx` |
| 9 | Cost optimization section component | `cost-optimization-section.tsx` |
| 10 | Operational health section component | `operational-health-section.tsx` |
| 11 | Agent analytics section component | `agent-analytics-section.tsx` |
| 12 | Security & audit section component | `security-audit-section.tsx` |
| 13 | Inventory overview section component | `inventory-overview-section.tsx` |
| 14 | Knowledge base section component | `knowledge-base-section.tsx` |
| 15 | Assemble dashboard page & client | `page.tsx`, `dashboard-client.tsx` |
| 16 | Visual verification & smoke test | — |
