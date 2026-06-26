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
