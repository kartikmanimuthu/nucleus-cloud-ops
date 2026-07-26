"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Activity, AlertTriangle, Bot, ChevronsDownUp, ChevronsUpDown, Cloud, Cpu, HelpCircle, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import { Plan, PlanContent, PlanStep } from "@/components/ai-elements/plan";
import { Spinner } from "@/components/ui/spinner";
import { SubagentCard } from "./subagent-card";
import { useSubagentRuns } from "@/lib/queries/subagents";
import type { RunState, SubagentState } from "./run-state";

const PHASE_LABELS: Record<string, string> = {
  planning: "Planning", execution: "Executing", reflection: "Reflecting",
  revision: "Revising", final: "Finalizing", text: "Idle",
};

// memory_recall/memory_save get their own detailed row (with spinner) in the
// Activity section below — the Status line falls back to this generic label
// for them instead of repeating "Recalling memory" / "Saving memory" verbatim.
const MEMORY_PHASES = new Set(["memory_recall", "memory_save"]);

// First clause of a plan step, capped at 60 chars — the full text stays
// available via the row's `title` tooltip attr (and PlanStep's own children).
// Split on the earliest of ". " / "," / " — " so the short title reads as a
// real clause rather than a mid-word truncation.
export function deriveStepTitle(step: string): string {
  const trimmed = step.trim();
  const match = trimmed.match(/\. |,| — /);
  let clause = (match?.index !== undefined ? trimmed.slice(0, match.index) : trimmed).trim();
  if (clause.length === 0) clause = trimmed;
  if (clause.length > 60) clause = `${clause.slice(0, 59).trimEnd()}…`;
  return clause;
}

function RailSection({ icon: Icon, title, action, children }: { icon: React.ElementType; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" /> {title}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  );
}

export function RunRail({
  runState,
  isStreaming,
  context,
  threadId,
}: {
  runState: RunState;
  isStreaming: boolean;
  context: { accountNames: string[]; modelLabel: string; skillName: string | null; toolCount: number | null; kbLabel: string };
  /** Needed to fetch a persisted sub-agent transcript when a card is expanded
   *  after a reload. Optional so the existing rail tests keep compiling. */
  threadId?: string;
}) {
  const { plan, currentPhase, pendingApproval, pendingClarifications } = runState;

  // A reloaded thread has no data-subagent parts (they are not persisted), so the
  // cards are rebuilt from agent_subagent_runs. Only fetched when the thread is
  // known to have fanned out — a persisted dispatch_agent tool call — and only when
  // there is no live state to prefer.
  const needsPersistedSubagents = runState.usedSubagents && runState.subagents.length === 0;
  const { data: persistedRuns } = useSubagentRuns(threadId, needsPersistedSubagents);
  const subagents: SubagentState[] = needsPersistedSubagents
    ? (persistedRuns ?? []).map((run) => ({
        id: run.subagentId,
        role: run.role,
        task: run.task,
        status: run.status === "done" || run.status === "failed" ? run.status : "running",
        toolCount: run.toolCount,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        ...(run.summary ? { summary: run.summary } : {}),
      }))
    : runState.subagents;
  const done = plan.filter((s) => s.status === "completed").length;
  const mutativePending = pendingApproval?.tools.some((t) => t.guard?.isMutative) ?? false;

  // Plan steps render as a clipped one-clause title by default; clicking a
  // step toggles its full text, and the section-header control expands or
  // collapses all of them at once.
  const [expandAllSteps, setExpandAllSteps] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<ReadonlySet<number>>(new Set());
  const toggleStep = (i: number) =>
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <aside data-testid="run-rail" className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l bg-muted/20 p-3">
      {/* Phase — a run paused on a decision is NOT executing, whatever the last phase was */}
      <RailSection icon={Activity} title="Status">
        <div className="flex items-center gap-2 text-sm">
          {pendingApproval ? (
            <>
              <span className="h-2 w-2 rounded-full animate-pulse bg-amber-500" />
              Awaiting approval
            </>
          ) : pendingClarifications.length > 0 ? (
            <>
              <span className="h-2 w-2 rounded-full animate-pulse bg-blue-500" />
              Awaiting your answer
            </>
          ) : (
            <>
              <span className={cn("h-2 w-2 rounded-full", isStreaming ? "animate-pulse bg-blue-500" : "bg-muted-foreground/40")} />
              {MEMORY_PHASES.has(currentPhase) ? "Working" : (PHASE_LABELS[currentPhase] ?? currentPhase)}
            </>
          )}
        </div>
      </RailSection>

      {/* Live plan — progress bar + step status are both sourced from
          runState.plan, so they can never disagree with each other. The
          nested Plan card is rendered with isStreaming={false}: its own
          "Generating..." badge is a second, independently-derived status
          string, and this rail already shows accurate live progress above
          (via the section title) and below (via the progress bar + each
          step's own active/completed icon). */}
      {plan.length > 0 && (
        <RailSection
          icon={ListChecks}
          title={`Execution plan · ${done}/${plan.length}`}
          action={
            <button
              type="button"
              onClick={() => setExpandAllSteps((v) => !v)}
              aria-label={expandAllSteps ? "Collapse plan steps" : "Expand plan steps"}
              data-testid="plan-expand-toggle"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {expandAllSteps ? <ChevronsDownUp className="h-3 w-3" /> : <ChevronsUpDown className="h-3 w-3" />}
            </button>
          }
        >
          <div className="h-1 w-full overflow-hidden rounded bg-muted">
            <div
              data-testid="plan-progress-fill"
              className="h-full rounded bg-primary transition-all"
              style={{ width: `${(done / plan.length) * 100}%` }}
            />
          </div>
          <Plan defaultOpen isStreaming={false}>
            <PlanContent>
              {plan.map((step, i) => {
                const stepExpanded = expandAllSteps || expandedSteps.has(i);
                return (
                  <PlanStep key={i} number={i + 1}
                    status={step.status === "in_progress" ? "active" : step.status}
                    title={step.step}
                    onClick={() => toggleStep(i)}
                    className="cursor-pointer"
                    data-testid={`plan-step-${i}`}
                    data-expanded={stepExpanded}>
                    {stepExpanded ? step.step : deriveStepTitle(step.step)}
                  </PlanStep>
                );
              })}
            </PlanContent>
          </Plan>
        </RailSection>
      )}

      {/* Dispatched sub-agents — collapsed cards so their prose never lands in
          the transcript; each one expands to its own task + findings. */}
      {subagents.length > 0 && (
        <RailSection
          icon={Bot}
          title={`Sub-agents (${subagents.filter((s) => s.status === "running").length} running)`}
        >
          <div className="space-y-1.5">
            {subagents.map((subagent) => (
              <SubagentCard key={subagent.id} subagent={subagent} threadId={threadId} />
            ))}
          </div>
        </RailSection>
      )}

      {/* Activity */}
      <RailSection icon={Sparkles} title="Activity">
        <ul className="space-y-1 text-xs text-muted-foreground">
          {pendingApproval && (
            <li className="flex items-center gap-1.5 text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              {pendingApproval.tools.length} approval{pendingApproval.tools.length === 1 ? "" : "s"} pending
            </li>
          )}
          {pendingClarifications.length > 0 && (
            <li className="flex items-center gap-1.5 text-blue-600">
              <HelpCircle className="h-3 w-3" />
              {pendingClarifications.length > 1 ? `${pendingClarifications.length} questions awaiting your answer` : 'question awaiting your answer'}
            </li>
          )}
          {currentPhase === "memory_recall" && (
            <li className="flex items-center gap-1.5 text-muted-foreground">
              <Spinner size="xs" label="Recalling memory" />
              Recalling memory…
            </li>
          )}
          {currentPhase === "memory_save" && (
            <li className="flex items-center gap-1.5 text-muted-foreground">
              <Spinner size="xs" label="Saving memory" />
              Saving memory…
            </li>
          )}
          <li className="flex items-center gap-1.5">
            <ShieldCheck className={cn("h-3 w-3", mutativePending ? "text-red-500" : "text-emerald-600")} />
            {mutativePending ? "guard: destructive action held" : "guard: active"}
          </li>
        </ul>
      </RailSection>

      {/* Context */}
      <RailSection icon={Cloud} title="Context">
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li className="break-words" title={context.accountNames.join(", ")}>
            {context.accountNames.length > 0 ? context.accountNames.join(", ") : "No account selected"}
          </li>
          <li className="flex items-start gap-1.5" title={context.modelLabel}>
            <Cpu className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">{context.modelLabel || "Default model"}</span>
          </li>
          {context.skillName && <li className="break-words">Skill: {context.skillName}</li>}
          <li className="break-words">{context.kbLabel}{context.toolCount != null ? ` · ${context.toolCount} tools` : ""}</li>
        </ul>
      </RailSection>
    </aside>
  );
}
