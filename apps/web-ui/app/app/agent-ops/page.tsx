"use client";

import { useState } from "react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
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
  StopCircle,
  ShieldCheck,
  CalendarClock,
  Settings2,
} from "lucide-react";
import type {
  TriggerSource,
  AgentOpsStatus,
} from "@/lib/agent-ops/types";
import { NewRunDialog } from "@/components/agent-ops/new-run-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { formatDateTime } from "@/lib/date-utils";
import { useTenant } from '@/lib/tenant-context';
import { useAgentOpsRuns, useCancelRun } from "@/lib/queries/agent-ops";

const SOURCE_ICONS: Record<TriggerSource, typeof Zap> = {
  slack: MessageSquare,
  jira: AlertCircle,
  api: Globe,
  scheduled: CalendarClock,
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
  awaiting_input: { label: "Awaiting Input", variant: "outline", icon: AlertCircle },
  awaiting_approval: { label: "Awaiting Approval", variant: "outline", icon: ShieldCheck },
  completed: { label: "Completed", variant: "secondary", icon: CheckCircle2 },
  failed: { label: "Failed", variant: "destructive", icon: XCircle },
  cancelled: { label: "Cancelled", variant: "outline", icon: StopCircle },
};

export default function AgentOpsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantId = searchParams.get("tenantId") || "default";
  const { timezone } = useTenant();
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const runsQuery = useAgentOpsRuns({ source: sourceFilter, status: statusFilter });
  const runs = runsQuery.data ?? [];
  const loading = runsQuery.isLoading;
  const cancelRun = useCancelRun();

  const formatDuration = (ms?: number) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatTime = (iso: string) => formatDateTime(iso, "shortDateTime", timezone);

  // Stats
  const stats = {
    total: runs.length,
    inProgress: runs.filter((r) => r.status === "in_progress").length,
    completed: runs.filter((r) => r.status === "completed").length,
    failed: runs.filter((r) => r.status === "failed").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        icon={Zap}
        title="Agent Ops"
        description="Background agent executions triggered by Slack, Jira, API, or schedule"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => runsQuery.refetch()} disabled={runsQuery.isFetching}>
              <RefreshCw className={`h-4 w-4 mr-2 ${runsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.push("/app/agent-ops/scheduled-tasks")}>
              <CalendarClock className="h-4 w-4 mr-2" />
              Scheduled Tasks
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Settings2 className="h-4 w-4 mr-2" />
                  Settings
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => router.push("/app/agent-ops/slack-settings")}>
                  <MessageSquare className="h-4 w-4 mr-2" /> Slack
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/app/agent-ops/jira-settings")}>
                  <AlertCircle className="h-4 w-4 mr-2" /> Jira
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/app/agent-ops/mcp-settings")}>
                  <Plug className="h-4 w-4 mr-2" /> MCP Servers
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <NewRunDialog tenantId={tenantId} />
          </>
        }
      />

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
            <SelectItem value="scheduled">Scheduled</SelectItem>
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
            <SelectItem value="awaiting_approval">Awaiting Approval</SelectItem>
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
              <Spinner size="sm" className="mr-2" />
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
                    className={`relative flex items-center justify-between overflow-hidden rounded-lg border p-3 pl-4 hover:bg-accent/50 cursor-pointer transition-colors`}
                    onClick={() => router.push(`/app/agent-ops/${run.runId}?tenantId=${run.tenantId}`)}
                  >
                    <span
                      className={`absolute inset-y-0 left-0 w-1 ${
                        run.status === "completed" ? "bg-green-500/70"
                        : run.status === "failed" ? "bg-red-500/70"
                        : run.status === "in_progress" ? "bg-primary animate-pulse"
                        : run.status === "awaiting_approval" || run.status === "awaiting_input" ? "bg-amber-400/80"
                        : "bg-muted-foreground/30"
                      }`}
                    />
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                        <SourceIcon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm line-clamp-2">{run.taskDescription}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                          <span className="capitalize">{run.source}</span>
                          <span>•</span>
                          <span>{run.mode} mode</span>
                          {run.selectedSkill && (<><span>•</span><span>skill: {run.selectedSkill}</span></>)}
                          <span>•</span>
                          <span>{formatTime(run.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-xs text-muted-foreground">{formatDuration(run.durationMs)}</span>
                      <Badge variant={statusConfig.variant} className="flex items-center gap-1">
                        <StatusIcon className={`h-3 w-3 ${run.status === "in_progress" ? "animate-spin" : ""}`} />
                        {statusConfig.label}
                      </Badge>
                      {(run.status === "in_progress" || run.status === "queued") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelRun.mutate({ runId: run.runId, body: { tenantId: run.tenantId } });
                          }}
                          disabled={cancelRun.isPending}
                          title="Cancel run"
                        >
                          {cancelRun.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <StopCircle className="h-3 w-3" />}
                        </Button>
                      )}
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
