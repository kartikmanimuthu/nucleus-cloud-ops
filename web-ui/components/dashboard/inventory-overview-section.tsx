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
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Resources by Type</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ count: { label: "Resources", color: "hsl(var(--chart-1))" } }}
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
                      label={({ resourceType, percent }) => `${resourceType.toUpperCase()} ${(percent * 100).toFixed(0)}%`}
                    >
                      {data.byType.map((entry) => (
                        <Cell key={entry.resourceType} fill={TYPE_COLORS[entry.resourceType.toLowerCase()] || "#8884d8"} />
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

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Resources by Region</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ count: { label: "Resources", color: "hsl(var(--chart-2))" } }}
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
                      for (const b of a.breakdown) row[b.resourceType.toLowerCase()] = b.count;
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
