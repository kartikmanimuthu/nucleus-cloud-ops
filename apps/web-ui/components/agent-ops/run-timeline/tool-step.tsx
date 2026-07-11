"use client";

import { Check, Loader2, Wrench, X } from "lucide-react";
import { StepShell, formatStepDuration } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { TimelineStep } from "./build-steps";

type ToolStepData = Extract<TimelineStep, { kind: "tool" }>;

function StatusBadge({ status }: { status: ToolStepData["status"] }) {
  if (status === "ok") return <Check className="size-3.5 shrink-0 text-green-600" />;
  if (status === "error") return <span className="flex shrink-0 items-center gap-1 text-xs text-red-600"><X className="size-3.5" /> failed</span>;
  if (status === "running") return <span className="flex shrink-0 items-center gap-1 text-xs text-primary"><Loader2 className="size-3 animate-spin" /> running</span>;
  return null;
}

export function ToolStep({ step, timezone }: { step: ToolStepData; timezone?: string }) {
  const anchor = step.call ?? step.result;
  const args = step.call?.toolArgs;
  const output = step.result?.toolOutput ?? step.result?.content;

  return (
    <StepShell
      icon={<Wrench className="size-3.5 text-sky-600" />}
      iconClass="bg-sky-100 dark:bg-sky-950/50"
      title={<span className="font-mono text-[13px]">{step.toolName}</span>}
      meta={
        <span className="flex shrink-0 items-center gap-2">
          <StatusBadge status={step.status} />
          {step.durationMs !== undefined && (
            <span className="text-xs text-muted-foreground">{formatStepDuration(step.durationMs)}</span>
          )}
        </span>
      }
      time={anchor ? formatTime(anchor.createdAt, timezone) : undefined}
      running={step.status === "running"}
      tone={step.status === "error" ? "error" : "default"}
      defaultOpen={step.status === "error"}
    >
      {args && Object.keys(args).length > 0 && (
        <div className="mb-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Arguments</p>
          <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
      {output && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Output</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-xs">
            {output}
          </pre>
        </div>
      )}
      {!args && !output && <p className="text-xs text-muted-foreground">No detail captured.</p>}
    </StepShell>
  );
}
