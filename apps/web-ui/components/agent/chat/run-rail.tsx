"use client";

import { cn } from "@/lib/utils";
import { Activity, AlertTriangle, Cloud, Cpu, HelpCircle, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import { Plan, PlanContent, PlanHeader, PlanStep } from "@/components/ai-elements/plan";
import type { RunState } from "./run-state";

const PHASE_LABELS: Record<string, string> = {
  planning: "Planning", execution: "Executing", reflection: "Reflecting",
  revision: "Revising", final: "Finalizing", memory_recall: "Recalling memory",
  memory_save: "Saving memory", text: "Idle",
};

function RailSection({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" /> {title}
      </div>
      {children}
    </div>
  );
}

export function RunRail({
  runState,
  isStreaming,
  context,
}: {
  runState: RunState;
  isStreaming: boolean;
  context: { accountNames: string[]; modelLabel: string; skillName: string | null; toolCount: number | null; kbLabel: string };
}) {
  const { plan, currentPhase, pendingApproval, pendingClarifications } = runState;
  const done = plan.filter((s) => s.status === "completed").length;
  const mutativePending = pendingApproval?.tools.some((t) => t.guard?.isMutative) ?? false;

  return (
    <aside data-testid="run-rail" className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l bg-muted/20 p-3">
      {/* Phase */}
      <RailSection icon={Activity} title="Status">
        <div className="flex items-center gap-2 text-sm">
          <span className={cn("h-2 w-2 rounded-full", isStreaming ? "animate-pulse bg-blue-500" : "bg-muted-foreground/40")} />
          {PHASE_LABELS[currentPhase] ?? currentPhase}
        </div>
      </RailSection>

      {/* Live plan */}
      {plan.length > 0 && (
        <RailSection icon={ListChecks} title={`Execution plan · ${done}/${plan.length}`}>
          <Plan defaultOpen isStreaming={isStreaming}>
            <PlanHeader title="Plan" />
            <PlanContent>
              {plan.map((step, i) => (
                <PlanStep key={i} number={i + 1}
                  status={step.status === "in_progress" ? "active" : step.status}>
                  {step.step}
                </PlanStep>
              ))}
            </PlanContent>
          </Plan>
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
          <li className="flex items-center gap-1.5">
            <ShieldCheck className={cn("h-3 w-3", mutativePending ? "text-red-500" : "text-emerald-600")} />
            {mutativePending ? "guard: destructive action held" : "guard: active"}
          </li>
        </ul>
      </RailSection>

      {/* Context */}
      <RailSection icon={Cloud} title="Context">
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li className="truncate">{context.accountNames.length > 0 ? context.accountNames.join(", ") : "No account selected"}</li>
          <li className="flex items-center gap-1.5 truncate"><Cpu className="h-3 w-3 shrink-0" />{context.modelLabel || "Default model"}</li>
          {context.skillName && <li className="truncate">Skill: {context.skillName}</li>}
          <li className="truncate">{context.kbLabel}{context.toolCount != null ? ` · ${context.toolCount} tools` : ""}</li>
        </ul>
      </RailSection>
    </aside>
  );
}
