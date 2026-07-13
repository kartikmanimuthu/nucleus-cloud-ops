"use client";

import {
  ArrowLeft, CalendarClock, CheckCircle2, ChevronDown, Cpu, Download, FileText, Globe, Loader2,
  MessageSquare, ShieldCheck, StopCircle, Timer, Wifi, XCircle, Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AgentOpsRun, AgentOpsStatus } from "@/lib/agent-ops/types";

const STATUS_STYLE: Record<AgentOpsStatus, { label: string; className: string; icon: typeof Loader2; spin?: boolean }> = {
  queued: { label: "Queued", className: "bg-muted text-muted-foreground", icon: Timer },
  in_progress: { label: "Running", className: "bg-primary/10 text-primary", icon: Loader2, spin: true },
  awaiting_input: { label: "Needs input", className: "bg-blue-500/10 text-blue-600", icon: MessageSquare },
  awaiting_approval: { label: "Needs approval", className: "bg-amber-500/10 text-amber-600", icon: ShieldCheck },
  completed: { label: "Completed", className: "bg-green-500/10 text-green-600", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-red-500/10 text-red-600", icon: XCircle },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground", icon: StopCircle },
};

const SOURCE_ICONS: Record<string, typeof Globe> = {
  slack: MessageSquare, scheduled: CalendarClock, api: Globe, jira: Zap,
};

function fmtDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function RunHeader({
  run, tokens, streaming, onCancel, cancelling, onExportPdf, onExportMarkdown, exporting, onBack,
}: {
  run: AgentOpsRun;
  tokens: { input: number; output: number };
  streaming: boolean;
  onCancel: () => void;
  cancelling: boolean;
  onExportPdf: () => void;
  onExportMarkdown: () => void;
  exporting: boolean;
  onBack: () => void;
}) {
  const status = STATUS_STYLE[run.status];
  const StatusIcon = status.icon;
  const SourceIcon = SOURCE_ICONS[run.source] ?? Globe;
  const active = run.status === "in_progress" || run.status === "queued";

  return (
    <div className="sticky top-0 z-10 -mx-1 space-y-3 border-b bg-background/95 px-1 pb-4 pt-1 backdrop-blur">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to Agent Ops">
          <ArrowLeft className="size-4" />
        </Button>
        <span className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium", status.className)}>
          <StatusIcon className={cn("size-3.5", status.spin && "animate-spin")} />
          {status.label}
        </span>
        {streaming && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Wifi className="size-3 text-green-600" /> live
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {run.status !== "queued" && run.status !== "in_progress" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={exporting}>
                  {exporting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Download className="mr-1.5 size-3.5" />}
                  Export
                  <ChevronDown className="ml-1 size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onExportPdf}>
                  <Download className="mr-2 size-3.5" /> PDF
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExportMarkdown}>
                  <FileText className="mr-2 size-3.5" /> Markdown
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {active && (
            <Button variant="destructive" size="sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <StopCircle className="mr-1.5 size-3.5" />}
              Cancel
            </Button>
          )}
        </span>
      </div>

      <p className="line-clamp-2 text-[15px] font-medium leading-snug">{run.taskDescription}</p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><SourceIcon className="size-3" /><span className="capitalize">{run.source}</span></span>
        <span className="capitalize">{run.mode} mode</span>
        {run.selectedSkill && <Badge variant="outline" className="px-1.5 py-0 text-[11px]">skill: {run.selectedSkill}</Badge>}
        {run.accountName && <span>{run.accountName}</span>}
        <span className="flex items-center gap-1"><Timer className="size-3" />{fmtDuration(run.durationMs)}</span>
        {(tokens.input > 0 || tokens.output > 0) && (
          <span className="flex items-center gap-1"><Cpu className="size-3" />{tokens.input.toLocaleString()}↑ {tokens.output.toLocaleString()}↓</span>
        )}
        <span className="font-mono text-[11px] opacity-60">{run.runId}</span>
      </div>
    </div>
  );
}
