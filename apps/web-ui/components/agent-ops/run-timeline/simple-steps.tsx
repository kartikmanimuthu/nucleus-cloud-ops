"use client";

import { CheckCircle2, ClipboardList, RefreshCw, XCircle } from "lucide-react";
import { MarkdownContent } from "@/components/ui/markdown-content";
import { StepShell } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { AgentOpsEvent } from "@/lib/agent-ops/types";

const PREVIEW_LEN = 140;

function preview(text?: string): string {
  if (!text) return "";
  const line = text.split("\n")[0];
  return line.length > PREVIEW_LEN ? `${line.slice(0, PREVIEW_LEN)}…` : line;
}

function ContentBody({ content }: { content?: string }) {
  if (!content) return null;
  return (
    <div className="max-h-96 overflow-auto text-sm">
      <MarkdownContent content={content} />
    </div>
  );
}

export function PlanningStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<ClipboardList className="size-3.5 text-blue-600" />}
      iconClass="bg-blue-100 dark:bg-blue-950/50"
      title={preview(event.content) || "Planning"}
      time={formatTime(event.createdAt, timezone)}
    >
      <ContentBody content={event.content} />
    </StepShell>
  );
}

export function ReflectionStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<RefreshCw className="size-3.5 text-purple-600" />}
      iconClass="bg-purple-100 dark:bg-purple-950/50"
      title={event.eventType === "revision" ? "Revision" : "Reflection"}
      meta={<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{preview(event.content)}</span>}
      time={formatTime(event.createdAt, timezone)}
    >
      <ContentBody content={event.content} />
    </StepShell>
  );
}

export function FinalStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<CheckCircle2 className="size-3.5 text-green-600" />}
      iconClass="bg-green-100 dark:bg-green-950/50"
      title={event.node === "__cancelled__" ? "Run cancelled" : "Final summary"}
      time={formatTime(event.createdAt, timezone)}
      defaultOpen
    >
      <ContentBody content={event.content} />
    </StepShell>
  );
}

export function ErrorStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<XCircle className="size-3.5 text-red-600" />}
      iconClass="bg-red-100 dark:bg-red-950/50"
      title={preview(event.content) || "Error"}
      time={formatTime(event.createdAt, timezone)}
      tone="error"
      defaultOpen
    >
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-red-50 p-2 font-mono text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
        {event.content}
      </pre>
    </StepShell>
  );
}
