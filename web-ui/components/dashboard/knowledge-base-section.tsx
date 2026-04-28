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
import { PieChart, Pie, Cell } from "recharts";
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
          <div className="space-y-3">
            {data.knowledgeBases.map((kb) => (
              <Card key={kb.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm">{kb.name}</span>
                    <Badge variant={kb.status === "active" ? "default" : "destructive"} className="text-xs">
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
                        <div key={ds.id} className="flex items-center justify-between text-xs rounded border px-2 py-1">
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
                              <span className="text-muted-foreground">{new Date(ds.lastSyncAt).toLocaleDateString()}</span>
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

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Vectors by Source Type</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ vectorCount: { label: "Vectors", color: "hsl(var(--chart-1))" } }}
                className="h-[300px]"
              >
                <PieChart>
                  <Pie
                    data={data.bySourceType}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    dataKey="vectorCount"
                    nameKey="sourceType"
                    label={({ sourceType, percent }) => `${sourceType} ${(percent * 100).toFixed(0)}%`}
                  >
                    {data.bySourceType.map((entry) => (
                      <Cell key={entry.sourceType} fill={SOURCE_TYPE_COLORS[entry.sourceType] || "#8884d8"} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-2xl font-bold">
                    {data.summary.totalVectors}
                  </text>
                </PieChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

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
