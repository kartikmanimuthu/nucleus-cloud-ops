"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildSteps, type TimelineStep } from "./build-steps";
import { ToolStep } from "./tool-step";
import { MemoryStep } from "./memory-step";
import { EvaluationStep } from "./evaluation-step";
import { PlanningStep, ReflectionStep, FinalStep, ErrorStep } from "./simple-steps";
import { ThinkingBubble } from "./thinking-bubble";
import { WorkingGroup } from "./working-group";
import { TodoStep } from "./todo-step";
import { SubagentStep } from "./subagent-step";
import type { AgentOpsEvent, AgentOpsStatus } from "@/lib/agent-ops/types";

function StepRenderer({ step, timezone }: { step: TimelineStep; timezone?: string }) {
  switch (step.kind) {
    case "memory": return <MemoryStep step={step} timezone={timezone} />;
    case "evaluation": return <EvaluationStep step={step} timezone={timezone} />;
    case "planning": return <PlanningStep event={step.event} timezone={timezone} />;
    case "thinking": return <ThinkingBubble event={step.event} />;
    case "tool": return <ToolStep step={step} timezone={timezone} />;
    case "reflection": return <ReflectionStep event={step.event} timezone={timezone} />;
    case "final": return <FinalStep event={step.event} timezone={timezone} />;
    case "error": return <ErrorStep event={step.event} timezone={timezone} />;
    case "todo": return <TodoStep todos={step.todos} />;
    case "subagent":
      return (
        <SubagentStep
          step={step}
          renderStep={(s, i) => <StepRenderer key={i} step={s} timezone={timezone} />}
        />
      );
    case "group":
      return (
        <WorkingGroup
          step={step}
          renderStep={(s, i) => <StepRenderer key={i} step={s} timezone={timezone} />}
        />
      );
  }
}

export function RunTimeline({
  events,
  runStatus,
  timezone,
  live,
}: {
  events: AgentOpsEvent[];
  runStatus: AgentOpsStatus;
  timezone?: string;
  live: boolean;
}) {
  const steps = useMemo(() => buildSteps(events, runStatus), [events, runStatus]);
  const endRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const lastCount = useRef(0);

  // Follow the newest step unless the user scrolled away (pinned).
  useEffect(() => {
    if (events.length > lastCount.current && live && !pinned) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    lastCount.current = events.length;
  }, [events.length, live, pinned]);

  useEffect(() => {
    if (!live) return;
    const onScroll = () => {
      const gap = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      setPinned(gap > 240);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [live]);

  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {runStatus === "queued" ? "Waiting for the agent to start…" : "No events recorded."}
      </p>
    );
  }

  return (
    <div className="relative space-y-2">
      {steps.map((step, i) => <StepRenderer key={i} step={step} timezone={timezone} />)}
      {live && (
        <div className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Agent is working…
        </div>
      )}
      <div ref={endRef} />
      {pinned && live && (
        <div className="sticky bottom-4 flex justify-center">
          <Button
            size="sm"
            variant="secondary"
            className="shadow-md"
            onClick={() => {
              setPinned(false);
              endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
          >
            <ArrowDown className="mr-1.5 size-3.5" /> Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}
