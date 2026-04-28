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
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Savings Trend</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ savings: { label: "Savings ($)", color: "hsl(var(--chart-1))" } }}
                className="h-[300px]"
              >
                <AreaChart data={data.trend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="savings" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1))" fillOpacity={0.2} strokeWidth={2} />
                </AreaChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Savings by Account</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ savings: { label: "Savings ($)", color: "hsl(var(--chart-2))" } }}
                className="h-[300px]"
              >
                <BarChart data={data.byAccount} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="accountName" type="category" tick={{ fontSize: 11 }} width={120} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="savings" fill="hsl(var(--chart-2))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

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
              <p className="text-sm font-bold">{data.summary.resourcesOptimized} resources</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
