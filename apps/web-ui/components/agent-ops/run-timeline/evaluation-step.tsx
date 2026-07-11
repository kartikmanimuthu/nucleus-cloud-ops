"use client";

import { Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StepShell } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { TimelineStep } from "./build-steps";

type EvaluationStepData = Extract<TimelineStep, { kind: "evaluation" }>;

export function EvaluationStep({ step, timezone }: { step: EvaluationStepData; timezone?: string }) {
  const m = (step.event.metadata ?? {}) as {
    mode?: string; skillId?: string | null; skillName?: string | null;
    knowledgeBaseIds?: string[]; requiresApproval?: boolean;
  };
  const kbs = m.knowledgeBaseIds ?? [];

  return (
    <StepShell
      icon={<Zap className="size-3.5 text-amber-600" />}
      iconClass="bg-amber-100 dark:bg-amber-950/50"
      title="Evaluated request"
      meta={
        <span className="flex shrink-0 flex-wrap items-center gap-1">
          {m.mode && <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">{m.mode} mode</Badge>}
          {(m.skillName || m.skillId) && (
            <Badge variant="outline" className="px-1.5 py-0 text-[11px]">skill: {m.skillName ?? m.skillId}</Badge>
          )}
          {kbs.length > 0 && <Badge variant="outline" className="px-1.5 py-0 text-[11px]">KB ×{kbs.length}</Badge>}
          {m.requiresApproval && <Badge variant="outline" className="border-amber-400 px-1.5 py-0 text-[11px] text-amber-600">approval</Badge>}
        </span>
      }
      time={formatTime(step.event.createdAt, timezone)}
    >
      {step.event.content ? (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">{step.event.content}</p>
          {kbs.length > 0 && <p>Knowledge bases: <span className="font-mono">{kbs.join(", ")}</span></p>}
        </div>
      ) : undefined}
    </StepShell>
  );
}
