import type { AgentOpsEvent, AgentOpsStatus } from "@/lib/agent-ops/types";

export type StepStatus = "ok" | "error" | "running" | "unknown";

export type TimelineStep =
  | { kind: "memory"; phase: "recall" | "save"; event: AgentOpsEvent }
  | { kind: "evaluation"; event: AgentOpsEvent }
  | { kind: "planning"; event: AgentOpsEvent }
  | { kind: "thinking"; event: AgentOpsEvent }
  | { kind: "tool"; call?: AgentOpsEvent; result?: AgentOpsEvent; toolName: string; status: StepStatus; durationMs?: number }
  | { kind: "reflection"; event: AgentOpsEvent }
  | { kind: "final"; event: AgentOpsEvent }
  | { kind: "error"; event: AgentOpsEvent }
  | { kind: "group"; steps: TimelineStep[]; durationMs: number; running: boolean };

const GROUP_MIN = 3;
const ACTIVE_STATUSES: AgentOpsStatus[] = ["queued", "in_progress", "awaiting_input", "awaiting_approval"];

function isErrorOutput(e: AgentOpsEvent): boolean {
  const text = e.toolOutput ?? e.content ?? "";
  return /^(command failed|error[:\s]|failed[:\s])/i.test(text.trim());
}

function ts(e: AgentOpsEvent): number {
  return new Date(e.createdAt).getTime();
}

/** Map raw events to flat steps (pass 1), then fold work segments (pass 2). */
export function buildSteps(events: AgentOpsEvent[], runStatus: AgentOpsStatus): TimelineStep[] {
  const runActive = ACTIVE_STATUSES.includes(runStatus);
  const flat: TimelineStep[] = [];
  const openTools: Array<Extract<TimelineStep, { kind: "tool" }>> = [];

  for (const e of events) {
    switch (e.eventType) {
      case "memory_recall":
        flat.push({ kind: "memory", phase: "recall", event: e });
        break;
      case "memory_save":
        flat.push({ kind: "memory", phase: "save", event: e });
        break;
      case "evaluation":
        flat.push({ kind: "evaluation", event: e });
        break;
      case "planning":
        // Legacy runs recorded the evaluator's decision as a planning event with
        // the old structured metadata shape ({ mode, skillId, ... }). New runs
        // emit a dedicated 'evaluation' eventType instead, so a node==='evaluator'
        // planning event without that shape is just the evaluator's raw LLM
        // chatter — treat it as a normal planning step, not a second evaluation pill.
        if (e.node === "evaluator" && e.metadata && "mode" in e.metadata) flat.push({ kind: "evaluation", event: e });
        else flat.push({ kind: "planning", event: e });
        break;
      case "tool_call": {
        const step: Extract<TimelineStep, { kind: "tool" }> = {
          kind: "tool", call: e, toolName: e.toolName ?? "tool", status: "unknown",
        };
        flat.push(step);
        openTools.push(step);
        break;
      }
      case "tool_result": {
        const idx = openTools.findIndex(t => t.toolName === (e.toolName ?? "tool") && !t.result);
        if (idx >= 0) {
          const step = openTools[idx];
          step.result = e;
          step.status = isErrorOutput(e) ? "error" : "ok";
          if (step.call) step.durationMs = Math.max(0, ts(e) - ts(step.call));
          openTools.splice(idx, 1);
        } else {
          flat.push({
            kind: "tool", result: e, toolName: e.toolName ?? "tool",
            status: isErrorOutput(e) ? "error" : "ok",
          });
        }
        break;
      }
      case "execution":
        flat.push({ kind: "thinking", event: e });
        break;
      case "reflection":
      case "revision":
        flat.push({ kind: "reflection", event: e });
        break;
      case "final":
        flat.push({ kind: "final", event: e });
        break;
      case "error":
        flat.push({ kind: "error", event: e });
        break;
      case "notification":
        // Scheduled digest delivery marker — a failed delivery is surfaced as an
        // error step so it's impossible to miss; successful delivery is a quiet step.
        if ((e.metadata as { status?: string } | undefined)?.status === "failed") {
          flat.push({ kind: "error", event: e });
        } else {
          flat.push({ kind: "thinking", event: e });
        }
        break;
      default:
        flat.push({ kind: "thinking", event: e as AgentOpsEvent });
        break;
    }
  }

  for (const open of openTools) open.status = runActive ? "running" : "unknown";

  // Pass 2 — fold contiguous work (tool/thinking) segments of >= GROUP_MIN into groups.
  const out: TimelineStep[] = [];
  let segment: TimelineStep[] = [];
  const flush = () => {
    if (segment.length >= GROUP_MIN) {
      out.push({
        kind: "group",
        steps: segment,
        durationMs: segment.reduce((acc, s) => acc + (s.kind === "tool" ? (s.durationMs ?? 0) : 0), 0),
        running: segment.some(s => s.kind === "tool" && s.status === "running"),
      });
    } else {
      out.push(...segment);
    }
    segment = [];
  };
  for (const step of flat) {
    if (step.kind === "tool" || step.kind === "thinking") segment.push(step);
    else { flush(); out.push(step); }
  }
  flush();
  return out;
}
