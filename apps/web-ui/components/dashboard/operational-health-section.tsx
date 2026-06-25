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
        <div className="flex flex-wrap gap-2">
          {data.accounts.map((account) => (
            <div key={account.id} className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs">
              <div className={cn(
                "h-2 w-2 rounded-full",
                account.status === "connected" && "bg-emerald-500",
                account.status === "disconnected" && "bg-red-500",
                account.status !== "connected" && account.status !== "disconnected" && "bg-yellow-500"
              )} />
              <span className="font-medium">{account.name}</span>
              {account.lastSyncedAt && (
                <span className="text-muted-foreground">{formatRelativeTime(account.lastSyncedAt)}</span>
              )}
            </div>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Execution Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ success: { label: "Success", color: "#10b981" }, failed: { label: "Failed", color: "#ef4444" } }}
                className="h-[300px]"
              >
                <LineChart data={data.executionTimeline}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="success" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Execution by Schedule</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ success: { label: "Success", color: "#10b981" }, partialFail: { label: "Partial Fail", color: "#f59e0b" }, fullFail: { label: "Full Fail", color: "#ef4444" } }}
                className="h-[300px]"
              >
                <BarChart data={data.executionBySchedule}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="scheduleName" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="success" stackId="a" fill="#10b981" />
                  <Bar dataKey="partialFail" stackId="a" fill="#f59e0b" />
                  <Bar dataKey="fullFail" stackId="a" fill="#ef4444" />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

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
