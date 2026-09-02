"use client";

import type { ReactNode } from "react";
import { Bot, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { StepShell } from "./step-shell";
import type { TimelineStep } from "./build-steps";

const STATUS = {
  running: { icon: <Loader2 className="size-3.5 animate-spin" />, cls: "bg-primary/10 text-primary" },
  done: { icon: <CheckCircle2 className="size-3.5" />, cls: "bg-green-500/10 text-green-600" },
  failed: { icon: <XCircle className="size-3.5" />, cls: "bg-red-500/10 text-red-600" },
} as const;

export function SubagentStep({
  step,
  renderStep,
}: {
  step: Extract<TimelineStep, { kind: "subagent" }>;
  renderStep: (s: TimelineStep, i: number) => ReactNode;
}) {
  const status = STATUS[step.status] ?? STATUS.running;

  return (
    <StepShell
      icon={status.icon ?? <Bot className="size-3.5" />}
      iconClass={status.cls}
      title={<span className="font-mono text-xs">{step.name}</span>}
      meta={
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
          {step.summary || step.task}
        </span>
      }
      running={step.status === "running"}
      defaultOpen={step.status === "running"}
    >
      <div className="space-y-2">
        {step.task && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Task:</span> {step.task}
          </p>
        )}
        {step.steps.length > 0
          ? <div className="space-y-2">{step.steps.map((s, i) => renderStep(s, i))}</div>
          : <p className="text-xs text-muted-foreground">No recorded activity.</p>}
      </div>
    </StepShell>
  );
}
