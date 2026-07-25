"use client";

import { Check, MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RunState } from "@/components/agent/chat/run-state";
import { formatTokens } from "@/lib/agent-chat/token-usage";

export type TranscriptMenuAction = "export-report" | "export-md" | "export-pdf" | "copy" | "schedule" | "skill" | "clear";

export interface TranscriptHeaderProps {
  title: string;
  runState: RunState;
  isStreaming: boolean;
  elapsedMs: number | null;
  onMenuAction: (action: TranscriptMenuAction) => void;
}

type StepKey = "plan" | "execute" | "reflect" | "revise";
type StepStatus = "done" | "active" | "upcoming";

interface StepDef {
  key: StepKey;
  label: string;
  phases: string[];
}

// Steps are checked in this fixed order; each maps to the phase(s) that
// belong to it (execution absorbs memory_recall, revision absorbs
// memory_save — see run-state.ts's phase vocabulary).
const STEPS: StepDef[] = [
  { key: "plan", label: "Plan", phases: ["planning"] },
  { key: "execute", label: "Execute", phases: ["execution", "memory_recall"] },
  { key: "reflect", label: "Reflect", phases: ["reflection"] },
  { key: "revise", label: "Revise", phases: ["revision", "memory_save"] },
];

function stepIndexForPhase(phase: string): number {
  return STEPS.findIndex((step) => step.phases.includes(phase));
}

const MENU_ITEMS: Array<{ action: TranscriptMenuAction; label: string }> = [
  { action: "export-report", label: "Export report (PDF)" },
  { action: "export-md", label: "Export as Markdown" },
  { action: "export-pdf", label: "Export transcript (PDF)" },
  { action: "copy", label: "Copy" },
  { action: "schedule", label: "Convert to scheduled task" },
  { action: "skill", label: "Save as skill" },
  { action: "clear", label: "Clear" },
];

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Live phase stepper — status derives ONLY from runState.currentPhase's
 * CANONICAL POSITION in the fixed Plan→Execute→Reflect→Revise order, never
 * from cumulative phase history. Both the fast and planning agents loop
 * execute→reflect→revise repeatedly (a data-phase part is pushed on every
 * on_chat_model_start, see app/api/chat/route.ts), so history-based "has
 * this phase ever occurred" membership would keep Reflect/Revise stuck
 * "done" forever after lap 1 even while lap 2's execution is still 25+
 * iterations from finishing. Position-based derivation is monotonic PER
 * LAP: whichever step currentPhase maps to is `active`, everything before
 * it in the fixed order is `done`, everything after is `upcoming` — this
 * can never contradict the plan progress shown elsewhere (the
 * "Generating…" vs "19/19" bug this component exists to kill), and it
 * resets correctly every time the run loops back to an earlier step.
 */
function StepBadge({
  step,
  status,
  progress,
}: {
  step: StepDef;
  status: StepStatus;
  progress: string | null;
}) {
  return (
    <span
      data-testid={`step-${step.key}`}
      data-status={status}
      className={cn(
        "flex items-center gap-1 whitespace-nowrap",
        status === "done" && "text-emerald-600",
        status === "active" && "text-primary",
        status === "upcoming" && "text-muted-foreground/50"
      )}
    >
      {status === "done" && <Check className="h-3 w-3" />}
      {status === "active" && <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
      {step.label}
      {progress && <span className="font-mono text-[10px] text-muted-foreground">{progress}</span>}
    </span>
  );
}

export function TranscriptHeader({ title, runState, isStreaming, elapsedMs, onMenuAction }: TranscriptHeaderProps) {
  const { phases, currentPhase, plan } = runState;
  const isIdle = !isStreaming && phases.length === 0;
  const isFinal = currentPhase === "final";
  const activeIndex = stepIndexForPhase(currentPhase);
  const doneCount = plan.filter((s) => s.status === "completed").length;

  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <h2 className="truncate text-sm font-medium" title={title}>{title}</h2>

      {!isIdle && (
        <div data-testid="phase-stepper" className="flex shrink-0 items-center gap-2 text-xs">
          {STEPS.map((step, i) => {
            const status: StepStatus = isFinal
              ? "done"
              : i < activeIndex
                ? "done"
                : i === activeIndex
                  ? "active"
                  : "upcoming";
            const progress = step.key === "execute" && plan.length > 0 ? `${doneCount}/${plan.length}` : null;
            return (
              <span key={step.key} className="flex items-center gap-2">
                {i > 0 && <span className="text-muted-foreground/30">·</span>}
                <StepBadge step={step} status={status} progress={progress} />
              </span>
            );
          })}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {(runState.tokenUsage.input > 0 || runState.tokenUsage.output > 0) && (
          <span
            data-testid="token-usage"
            className="font-mono text-xs text-muted-foreground"
            title={`Incoming ${runState.tokenUsage.input.toLocaleString()} tokens · Outgoing ${runState.tokenUsage.output.toLocaleString()} tokens`}
          >
            ↓ {formatTokens(runState.tokenUsage.input)} · ↑ {formatTokens(runState.tokenUsage.output)}
          </span>
        )}
        {elapsedMs != null && (
          <span data-testid="elapsed-timer" className="font-mono text-xs text-muted-foreground">
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="More actions">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {MENU_ITEMS.map((item) => (
              <DropdownMenuItem key={item.action} onClick={() => onMenuAction(item.action)}>
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
