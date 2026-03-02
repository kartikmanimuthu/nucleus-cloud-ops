"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Zap,
  Bot,
  MessageSquare,
  Globe,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Plug,
  Hash,
} from "lucide-react";
import type {
  AgentOpsRun,
  TriggerSource,
  AgentOpsStatus,
} from "@/lib/agent-ops/types";
import { NewRunDialog } from "@/components/agent-ops/new-run-dialog";

const SOURCE_ICONS: Record<TriggerSource, typeof Zap> = {
  slack: MessageSquare,
  jira: AlertCircle,
  api: Globe,
};

const STATUS_CONFIG: Record<
  AgentOpsStatus,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: typeof Clock;
  }
> = {
  queued: { label: "Queued", variant: "outline", icon: Clock },
  in_progress: { label: "In Progress", variant: "default", icon: Loader2 },
  completed: { label: "Completed", variant: "secondary", icon: CheckCircle2 },
  failed: { label: "Failed", variant: "destructive", icon: XCircle },
};

export default function AgentOpsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantId = searchParams.get("tenantId") || "default";
  const [runs, setRuns] = useState<AgentOpsRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ tenantId, limit: "50" });
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);

      const res = await fetch(`/api/agent-ops?${params}`);
      const data = await res.json();
      setRuns(data.runs || []);
    } catch (error) {
      console.error("Failed to fetch runs:", error);
    } finally {
      setLoading(false);
    }
  }, [sourceFilter, statusFilter, tenantId]);

  useEffect(() => {
    fetchRuns();
    // Auto-refresh every 10 seconds
    const interval = setInterval(fetchRuns, 10000);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  const formatDuration = (ms?: number) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Stats
  const stats = {
    total: runs.length,
    inProgress: runs.filter((r) => r.status === "in_progress").length,
    completed: runs.filter((r) => r.status === "completed").length,
    failed: runs.filter((r) => r.status === "failed").length,
  };

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="h-6 w-6 text-yellow-500" />
            Agent Ops
          </h1>
          <p className="text-muted-foreground mt-1">
            Background agent executions triggered by Slack, Jira, or API
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchRuns}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push("/agent-ops/slack-settings")}
          >
            <MessageSquare className="h-4 w-4 mr-2" />
            Slack Settings
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push("/agent-ops/jira-settings")}
          >
            <AlertCircle className="h-4 w-4 mr-2" />
            Jira Settings
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push("/agent-ops/mcp-settings")}
          >
            <Plug className="h-4 w-4 mr-2" />
            MCP Servers
          </Button>
          <NewRunDialog tenantId={tenantId} />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-xs text-muted-foreground">Total Runs</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-bold text-blue-500">
              {stats.inProgress}
            </div>
            <div className="text-xs text-muted-foreground">In Progress</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-bold text-green-500">
              {stats.completed}
            </div>
            <div className="text-xs text-muted-foreground">Completed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-bold text-red-500">
              {stats.failed}
            </div>
            <div className="text-xs text-muted-foreground">Failed</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="slack">Slack</SelectItem>
            <SelectItem value="jira">Jira</SelectItem>
            <SelectItem value="api">API</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Runs List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Execution Runs</CardTitle>
          <CardDescription>
            Click a run to view execution details
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && runs.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading runs...
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Bot className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No runs yet</p>
              <p className="text-sm mt-1">
                Trigger an agent via Slack, Jira, or the API to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => {
                const SourceIcon = SOURCE_ICONS[run.source];
                const statusConfig = STATUS_CONFIG[run.status];
                const StatusIcon = statusConfig.icon;

                return (
                  <div
                    key={run.runId}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/50 cursor-pointer transition-colors"
                    onClick={() =>
                      router.push(
                        `/agent-ops/${run.runId}?tenantId=${run.tenantId}`,
                      )
                    }
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                        <SourceIcon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">
                          {run.taskDescription}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                          <span className="capitalize">{run.source}</span>
                          <span>•</span>
                          <span>{run.mode} mode</span>
                          <span>•</span>
                          <span>{formatTime(run.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </span>
                      <Badge
                        variant={statusConfig.variant}
                        className="flex items-center gap-1"
                      >
                        <StatusIcon
                          className={`h-3 w-3 ${run.status === "in_progress" ? "animate-spin" : ""}`}
                        />
                        {statusConfig.label}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
