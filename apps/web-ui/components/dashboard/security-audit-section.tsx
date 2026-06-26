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
                <LineChart data={data.timeline}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="success" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="warning" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="error" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Events by Type</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ count: { label: "Events", color: "hsl(var(--chart-1))" } }}
                className="h-[250px]"
              >
                <BarChart data={data.byType}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="eventType" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Status Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ count: { label: "Events", color: "hsl(var(--chart-2))" } }}
                className="h-[250px]"
              >
                <PieChart>
                  <Pie
                    data={data.byStatus}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    dataKey="count"
                    nameKey="status"
                    label={({ status, percent }) => `${status} ${(percent * 100).toFixed(0)}%`}
                  >
                    {data.byStatus.map((entry) => (
                      <Cell key={entry.status} fill={STATUS_COLORS[entry.status] || "#8884d8"} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-xl font-bold">
                    {data.summary.totalEvents}
                  </text>
                </PieChart>
              </ChartContainer>
            </CardContent>
          </Card>

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
                <AreaChart data={data.userVsSystem}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="user" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.4} />
                  <Area type="monotone" dataKey="system" stackId="1" stroke="#6b7280" fill="#6b7280" fillOpacity={0.4} />
                </AreaChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

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
