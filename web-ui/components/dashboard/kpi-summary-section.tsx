"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  ChartContainer,
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
import { SectionEmpty } from "./section-empty";
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
  if (!data || data.cards.length === 0) return <SectionEmpty title="Key Metrics" message="No metrics available for the selected period." />;

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
