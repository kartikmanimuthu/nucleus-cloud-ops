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
  | { kind: "group"; steps: TimelineStep[]; durationMs: number; running: boolean }
  | { kind: "todo"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; event: AgentOpsEvent }
  | { kind: "subagent"; subagentId: string; name: string; task: string; status: "running" | "done" | "failed"; summary?: string; steps: TimelineStep[] };

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

  // Deep runs write rows from several concurrent producers, so createdAt ties are
  // common and the DB can only order by it. metadata.seq is NOT a run-wide
  // counter: it's per DeepEventRecorder *instance*, and driveDeepRun builds a
  // fresh recorder (and therefore a fresh seq starting at 0) on every execute
  // AND every resume — so a HITL-resumed run (autoApprove:false, the default)
  // has a leg-1 seq range and an unrelated leg-2 seq range that both start at
  // 0. Some rows also bypass the recorder entirely (the decisions and approve
  // API routes write synthetic tool_result / deep_approval_gate rows with no
  // seq at all), so any given createdAt millisecond can hold a mix of seq'd
  // and seq-less rows. A comparator that lets seq win whenever both sides have
  // it — but falls back to createdAt otherwise — is not a valid total order
  // over that mix (it's intransitive: A(seq=5) beats B(seq=1), but a seq-less
  // C sharing their createdAt ties both, so A~C and C~B yet A>B).
  //
  // So createdAt is primary and seq only disambiguates same-millisecond rows
  // within it — the one thing seq was ever needed for. Plan-mode rows have no
  // seq and are unaffected (createdAt alone already orders them; a `?? -1`
  // default just means a seq-less row sorts before a seq'd one at the exact
  // same millisecond, which never occurs in practice since seq'd rows are
  // deep-only). Trade-off: two same-leg rows with inverted seq but different
  // milliseconds now order by millisecond instead of seq — an intentional,
  // sub-millisecond-window difference that matches what the DB actually
  // returns and matches plan mode's own ordering.
  const seqOf = (e: AgentOpsEvent): number | undefined => {
    const s = (e.metadata as { seq?: unknown } | undefined)?.seq;
    return typeof s === "number" ? s : undefined;
  };
  const ordered = [...events].sort((a, b) => {
    const dt = ts(a) - ts(b);
    if (dt !== 0) return dt;
    return (seqOf(a) ?? -1) - (seqOf(b) ?? -1);
  });

  const subIdOf = (e: AgentOpsEvent): string | undefined => {
    const id = (e.metadata as { subagentId?: unknown } | undefined)?.subagentId;
    return typeof id === "string" ? id : undefined;
  };

  const toolCallIdOf = (e: AgentOpsEvent | undefined): string | undefined => {
    const id = (e?.metadata as { toolCallId?: unknown } | undefined)?.toolCallId;
    return typeof id === "string" ? id : undefined;
  };

  // Partition: sub-agent-tagged rows are folded into their own groups so the
  // parent timeline stays readable when several sub-agents run in parallel.
  const parentEvents: AgentOpsEvent[] = [];
  const bySubagent = new Map<string, AgentOpsEvent[]>();
  for (const e of ordered) {
    const id = subIdOf(e);
    if (id) {
      const list = bySubagent.get(id) ?? [];
      list.push(e);
      bySubagent.set(id, list);
    } else {
      parentEvents.push(e);
    }
  }

  const flat: TimelineStep[] = [];
  const openTools: Array<Extract<TimelineStep, { kind: "tool" }>> = [];

  for (const e of parentEvents) {
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
        // Deep runs tag both call and result with metadata.toolCallId and drain
        // run.toolCalls in parallel watchers, so two concurrent same-named tool
        // calls can settle out of order — pairing by toolName alone cross-pairs
        // them (wrong output/args/duration, error badge on the wrong card).
        // Prefer the id when the result carries one; plan-mode rows never do,
        // so they fall back to the name-only match unchanged.
        const resultCallId = toolCallIdOf(e);
        const idx = resultCallId !== undefined
          ? openTools.findIndex(t => !t.result && toolCallIdOf(t.call) === resultCallId)
          : openTools.findIndex(t => t.toolName === (e.toolName ?? "tool") && !t.result);
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
      case "todo": {
        const todos = (e.metadata as { todos?: unknown } | undefined)?.todos;
        if (Array.isArray(todos)) flat.push({ kind: "todo", todos: todos as never, event: e });
        break;
      }
      case "subagent":
        // Handled in the sub-agent fold below — a lifecycle row carries subagentId,
        // so it never reaches here unless it was written without one. Explicitly
        // a no-op (rather than falling to default) so it never renders as an
        // anonymous "thinking" bubble.
        break;
      default:
        flat.push({ kind: "thinking", event: e as AgentOpsEvent });
        break;
    }
  }

  for (const open of openTools) open.status = runActive ? "running" : "unknown";

  // Fold each sub-agent's rows into one collapsible step. Groups are appended
  // after all parent-level steps, in the order their sub-agent's rows first
  // appeared in `ordered` (Map insertion order) — they are NOT interleaved back
  // into the parent sequence at the position of their first row. Interleaving
  // would require merging two sorted lists, which no test specifies and which
  // risks reordering plan-mode timelines (which never carry subagentId, but
  // share this same code path).
  const subSteps: TimelineStep[] = [];
  for (const [subagentId, rows] of bySubagent) {
    const lifecycle = rows.filter(r => r.eventType === "subagent");
    const last = lifecycle[lifecycle.length - 1];
    const meta = (last?.metadata ?? {}) as { name?: string; task?: string; status?: string; summary?: string };
    const inner = buildSteps(
      rows.filter(r => r.eventType !== "subagent").map(r => ({ ...r, metadata: { ...(r.metadata as object), subagentId: undefined } })),
      runStatus,
    );
    subSteps.push({
      kind: "subagent",
      subagentId,
      name: meta.name ?? subagentId,
      task: meta.task ?? "",
      status: (meta.status as "running" | "done" | "failed") ?? (runActive ? "running" : "done"),
      summary: meta.summary,
      steps: inner,
    });
  }

  // Latest-wins for todos: a run rewrites the whole checklist on every
  // write_todos call, so only the most recent row is worth showing. Unlike the
  // sub-agent groups above, the surviving todo step is pinned to the FRONT of
  // the list rather than left at its arrival position: a plan checklist is a
  // persistent header for the whole run, not a chronological event — do not
  // "fix" this to match sub-agent placement, the asymmetry is intentional.
  // Widened to TimelineStep[] explicitly: without it, TS infers a type
  // predicate from the `s.kind === "todo"` / `!== "todo"` comparisons and
  // narrows these arrays to include/exclude the "todo" variant specifically,
  // which then rejects `[keptTodo, ...flatNoTodos]` below.
  const todoSteps: TimelineStep[] = flat.filter(s => s.kind === "todo");
  const keptTodo = todoSteps[todoSteps.length - 1];
  let flatNoTodos: TimelineStep[] = flat.filter(s => s.kind !== "todo");
  if (keptTodo) flatNoTodos = [keptTodo, ...flatNoTodos];
  const withSubs = [...flatNoTodos, ...subSteps];

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
  for (const step of withSubs) {
    if (step.kind === "tool" || step.kind === "thinking") segment.push(step);
    else { flush(); out.push(step); }
  }
  flush();
  return out;
}
