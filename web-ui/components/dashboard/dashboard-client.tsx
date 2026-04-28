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
