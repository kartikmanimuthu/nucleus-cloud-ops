"use client";

import { Brain } from "lucide-react";
import { StepShell } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { MemoryRecallStats, MemorySaveStats } from "@/lib/agent/memory/types";
import type { TimelineStep } from "./build-steps";

type MemoryStepData = Extract<TimelineStep, { kind: "memory" }>;

function HitList({ label, hits }: { label: string; hits: Array<{ key: string; distance?: number }> }) {
  if (!hits.length) return null;
  return (
    <div className="mb-2 last:mb-0">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <ul className="space-y-0.5">
        {hits.map(h => (
          <li key={h.key} className="flex items-center gap-2 text-xs">
            <span className="font-mono">{h.key}</span>
            {h.distance !== undefined && (
              <span className="text-muted-foreground">d={h.distance.toFixed(2)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemoryStep({ step, timezone }: { step: MemoryStepData; timezone?: string }) {
  const meta = step.event.metadata as unknown as (MemoryRecallStats | MemorySaveStats) | undefined;
  const isRecall = step.phase === "recall";
  const recall = meta && meta.phase === "recall" ? meta : undefined;
  const save = meta && meta.phase === "save" ? meta : undefined;
  const hasDetail = !!(recall && (recall.facts.length || recall.rules.length || recall.episodes.length)) || !!save;

  return (
    <StepShell
      icon={<Brain className="size-3.5 text-violet-600" />}
      iconClass="bg-violet-100 dark:bg-violet-950/50"
      title={step.event.content || (isRecall ? "Memory recall" : "Memory save")}
      time={formatTime(step.event.createdAt, timezone)}
    >
      {hasDetail ? (
        <>
          {recall && (
            <>
              <HitList label="Facts" hits={recall.facts} />
              <HitList label="Learned rules" hits={recall.rules} />
              <HitList label="Episodes replayed" hits={recall.episodes} />
            </>
          )}
          {save && (
            <ul className="space-y-0.5 text-xs">
              <li>{save.savedFacts} fact(s), {save.savedRules} rule(s) saved</li>
              <li>Episode captured: {save.episodeCaptured ? "yes" : "no"}</li>
              {save.reconcileActions && (
                <li className="text-muted-foreground">
                  Reconcile: {Object.entries(save.reconcileActions).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(", ") || "no-op"}
                </li>
              )}
            </ul>
          )}
        </>
      ) : undefined}
    </StepShell>
  );
}
