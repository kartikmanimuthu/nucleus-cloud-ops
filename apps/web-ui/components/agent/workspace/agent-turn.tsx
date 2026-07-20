"use client"

import * as React from "react"
import { Bot, ChevronRight, FileText, MessageSquareText } from "lucide-react"
import { cn } from "@/lib/utils"
import { MarkdownContent } from "@/components/ui/markdown-content"
import type { TranscriptEvent } from "@/lib/agent-chat/events"
import { groupEvents, type ToolGroup } from "@/lib/agent-chat/group-events"
import { ThinkingBlock } from "./events/thinking-block"
import { ToolRow, ToolGroupRow } from "./events/tool-row"
import { MemoryRow } from "./events/memory-row"
import { ApprovalBatchCard } from "@/components/agent/chat/approval-batch-card"
import { ClarificationCard } from "@/components/agent/chat/clarification-card"
import type { RunState } from "@/components/agent/chat/run-state"
import type { DecisionMap } from "@/components/agent/chat/use-decisions"

const WORKING_LABELS: Record<string, string> = {
  memory_recall: "Recalling memory",
  planning: "Planning",
  execution: "Working",
  reflection: "Reflecting",
  revision: "Revising",
  final: "Finalizing",
  memory_save: "Saving memory",
  text: "Thinking",
}

/**
 * Animated "the agent is doing something" row — shown in the gap between a
 * send and the first visible transcript event (and inside a still-empty
 * streaming turn), so the UI never looks frozen while the run spins up.
 */
export function WorkingIndicator({ phase }: { phase: string }) {
  return (
    <div
      data-testid="working-indicator"
      className="flex items-center gap-2 px-2 py-1.5 text-xs italic text-muted-foreground"
    >
      <span className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
      </span>
      {WORKING_LABELS[phase] ?? "Working"}…
    </div>
  )
}

function AgentAvatar() {
  return (
    <div
      data-testid="agent-turn-avatar"
      className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted"
    >
      <Bot className="size-4 text-muted-foreground" />
    </div>
  )
}

/** A full pending turn (avatar + WorkingIndicator) — used by Transcript when
 *  the run has started but no assistant message exists yet. */
export function PendingTurn({ phase }: { phase: string }) {
  return (
    <div className="flex gap-3">
      <AgentAvatar />
      <div className="min-w-0 flex-1">
        <WorkingIndicator phase={phase} />
      </div>
    </div>
  )
}

export interface AgentTurnProps {
  /** Pre-built via buildTranscript(message, …) — Transcript owns that single,
   *  memoized call (see transcript.tsx) so history isn't reparsed every render. */
  events: TranscriptEvent[]
  /** Live in-progress batch decisions (from useDecisions()) — feeds the
   *  interrupt cards below. */
  decisions: DecisionMap
  /** Default expand state for process rows; a local per-turn override applies once toggled. */
  showWork: boolean
  runState: RunState
  isLastAssistantMessage: boolean
  /** True while this session's response stream is active — drives the
   *  WorkingIndicator when this (last) turn has no visible rows yet. */
  isStreaming?: boolean
  /** Map<thinking event id, duration in ms>, best-effort — see Transcript. */
  durationMs?: Map<string, number>
  onDecide: (toolCallId: string, decision: { approved: boolean; reason?: string }) => void
  onDecideRemaining: (approved: boolean) => void
  onAnswer: (toolCallId: string, answer: string) => void
}

type Row = TranscriptEvent | ToolGroup
type AnswerEvent = Extract<TranscriptEvent, { kind: "answer" }>

// Phases whose plain-text output is the agent *narrating its work* ("Found the
// cluster… now describing it"). This text belongs to the process story, so we
// demote it into the left work-rail alongside the tool/thinking rows.
const NARRATION_PHASES = new Set<string>(["planning", "execution", "reflection"])
// Phases whose text is the compiled deliverable — elevated into a titled Report
// card so the reader can visually find the answer instead of hunting for it in
// a wall of identical prose.
const REPORT_PHASES = new Set<string>(["final", "revision"])

/** An answer that is mid-run narration (belongs in the work rail). */
function isNarration(row: Row): boolean {
  return row.kind === "answer" && !!row.phase && NARRATION_PHASES.has(row.phase)
}

/** An answer that is a compiled report (gets the elevated card). */
function isReport(row: Row): boolean {
  return row.kind === "answer" && !!row.phase && REPORT_PHASES.has(row.phase)
}

// "Output" = what renders as the turn's deliverable, full-width and outside the
// work rail: images, report answers, and plain (no-phase / bare 'text' phase)
// chat answers. Narration answers are deliberately excluded — they render in
// the rail instead. Conservative type guard: narrows to answer|image but may
// return false for some of them (narration), which is fine for filtering.
function isOutputRow(row: Row): row is Extract<TranscriptEvent, { kind: "answer" | "image" }> {
  if (row.kind === "image") return true
  if (row.kind === "answer") return !isNarration(row)
  return false
}

function renderProcessRow(row: Row, durationMs?: Map<string, number>, defaultOpen = false): React.ReactNode {
  switch (row.kind) {
    case "thinking":
      return <ThinkingBlock key={row.id} event={row} durationMs={durationMs?.get(row.id)} defaultOpen={defaultOpen} />
    case "tool":
      return <ToolRow key={row.id} event={row} defaultOpen={defaultOpen} />
    case "tool-group":
      return <ToolGroupRow key={row.id} group={row} defaultOpen={defaultOpen} />
    case "memory":
      return <MemoryRow key={row.id} event={row} defaultOpen={defaultOpen} />
    case "answer":
      // Only narration answers reach the rail (see isOutputRow); render them as
      // muted, one-step-smaller commentary with a speech marker so they read as
      // "the agent talking", clearly not the report.
      return renderNarrationRow(row)
    default:
      return null
  }
}

/** Interstitial narration inside the work rail: muted, text-xs, speech icon. */
function renderNarrationRow(row: AnswerEvent): React.ReactNode {
  return (
    <div key={row.id} className="flex items-start gap-1.5 px-2 py-1">
      <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
      <MarkdownContent
        content={row.text}
        className="min-w-0 text-muted-foreground [&_p]:text-[15px] [&_li]:text-[15px]"
      />
    </div>
  )
}

/**
 * Renders a deliverable row (image / report / plain answer). Reports (final &
 * revision phases, in runs that actually did tool work) are wrapped in a titled
 * card so the compiled answer is an unmistakable landmark; plain chat answers
 * keep the bare, compact treatment.
 */
function renderOutputRow(
  row: Extract<TranscriptEvent, { kind: "answer" | "image" }>,
  elevateReports = false,
): React.ReactNode {
  if (row.kind === "image") {
    return <img key={row.id} src={row.url} alt="" className="max-w-xs max-h-72 rounded border object-contain" />
  }
  // No `prose` wrapper — the typography plugin's own heading/margin scale
  // fights MarkdownContent's compact chat scale (documents-sized titles inside
  // messages). MarkdownContent self-styles; here we only bump the answer body
  // one step larger than process rows. No measure cap: the prose fills the full
  // transcript column so it fluidly reflows to use whatever width is freed when
  // the session sidebar or plan rail is toggled (no dead side-margins).
  const body = (
    <MarkdownContent
      content={row.text}
      className="[&_p]:text-[15px] [&_li]:text-[15px]"
    />
  )

  if (elevateReports && isReport(row)) {
    return (
      <div
        key={row.id}
        data-testid="report-card"
        className="rounded-lg border bg-card px-4 py-3 shadow-sm"
      >
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FileText className="h-3.5 w-3.5" />
          <span>Report</span>
        </div>
        {body}
      </div>
    )
  }

  return <React.Fragment key={row.id}>{body}</React.Fragment>
}

/**
 * One assistant "turn": a single avatar, the transcript grammar rendered via
 * groupEvents(events) — events are pre-built by Transcript, not here — and
 * (only for the last assistant message) the Mission Control interrupt cards.
 * Three visual tiers keep reasoning, actions, and the answer distinct:
 *  - Rail rows — thinking/tool/tool-group/memory AND interstitial narration
 *    answers (phase planning/execution/reflection) — sit inside a left guide
 *    line and collapse behind a single "Show work" toggle.
 *  - Report answers (phase final/revision, in tool-running turns) render as an
 *    elevated titled card so the deliverable is an obvious landmark.
 *  - Plain chat answers keep the bare, full-width treatment.
 */
export function AgentTurn({
  events,
  decisions,
  showWork,
  runState,
  isLastAssistantMessage,
  isStreaming = false,
  durationMs,
  onDecide,
  onDecideRemaining,
  onAnswer,
}: AgentTurnProps) {
  const [localExpanded, setLocalExpanded] = React.useState(false)
  const expanded = showWork || localExpanded

  const grouped = React.useMemo(() => groupEvents(events), [events])

  // Rail rows = the work story (thinking / tool / tool-group / memory) PLUS
  // narration answers. Output rows = the deliverable (report + plain answers +
  // images). Both derive from isOutputRow so the two buckets stay complementary.
  const railRows = grouped.filter((row) => !isOutputRow(row))
  const outputRows = grouped.filter(isOutputRow) as Array<Extract<TranscriptEvent, { kind: "answer" | "image" }>>
  // Only elevate a report card when the turn actually ran tools — this keeps a
  // casual chat reply (which may still land in a 'final' phase) from being
  // wrapped in a "Report" card it doesn't warrant.
  const elevateReports = events.some((e) => e.kind === "tool")
  // Counted from the raw, pre-grouping events so a >=3-tool run collapsed into
  // one ToolGroupRow still reports its true step count, not 1. Narration
  // answers count too — they're hidden behind "Show work" alongside the tools.
  const hiddenStepCount = events.filter(
    (e) =>
      (e.kind !== "answer" && e.kind !== "image") ||
      (e.kind === "answer" && !!e.phase && NARRATION_PHASES.has(e.phase)),
  ).length

  // Chronological segments: runs of consecutive rail rows (each rendered as one
  // guide block) interleaved with the deliverable output in true event order.
  // Since execution narration streams as TEXT between tool calls, the old
  // two-bucket layout (all work above, all text below) would scramble the
  // story: "Step 2 complete" must sit between its tool rows, not after them all.
  type Segment = { kind: "rail"; rows: Row[] } | { kind: "output"; row: Extract<TranscriptEvent, { kind: "answer" | "image" }> }
  const segments: Segment[] = []
  for (const row of grouped) {
    if (isOutputRow(row)) {
      segments.push({ kind: "output", row })
    } else {
      const last = segments[segments.length - 1]
      if (last?.kind === "rail") last.rows.push(row)
      else segments.push({ kind: "rail", rows: [row] })
    }
  }

  const showClarifications = isLastAssistantMessage && runState.pendingClarifications.length > 0
  const showApproval = isLastAssistantMessage && runState.pendingApproval !== null

  // A turn with nothing visible yet (e.g. only data-phase parts during memory
  // recall) must not render as a lone floating avatar: show the animated
  // working indicator while streaming, and nothing at all once settled.
  if (railRows.length === 0 && outputRows.length === 0 && !showClarifications && !showApproval) {
    if (isLastAssistantMessage && isStreaming) {
      return <PendingTurn phase={runState.currentPhase} />
    }
    return null
  }

  return (
    <div className="flex gap-3">
      <AgentAvatar />

      <div className="min-w-0 flex-1 space-y-2">
        {expanded ? (
          // Chronological: guide blocks of work interleaved with text, in the
          // order it actually happened. With "Show work" on, every row renders
          // expanded — the user asked for the full detail, not a click per row.
          segments.map((seg, i) =>
            seg.kind === "output" ? (
              <React.Fragment key={seg.row.id}>{renderOutputRow(seg.row, elevateReports)}</React.Fragment>
            ) : (
              <div key={`rail-${i}`} className="ml-3 space-y-2 border-l pl-3">
                {seg.rows.map((row) => renderProcessRow(row, durationMs, showWork))}
              </div>
            )
          )
        ) : (
          <>
            {railRows.length > 0 && (
              <button
                type="button"
                onClick={() => setLocalExpanded(true)}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-left",
                  "text-xs text-muted-foreground hover:bg-muted/40"
                )}
              >
                <ChevronRight className="h-3 w-3 shrink-0" />
                <span>{`Show work (${hiddenStepCount} steps)`}</span>
              </button>
            )}
            {outputRows.length > 0 && (
              <div className="space-y-2">
                {outputRows.map((r) => renderOutputRow(r, elevateReports))}
              </div>
            )}
          </>
        )}

        {/* Keep signalling activity between events (tool gaps, buffered
            synthesis runs) — but not while a decision card is waiting on the
            user, where "working" would be misleading. */}
        {isLastAssistantMessage && isStreaming && !showClarifications && !showApproval && (
          <WorkingIndicator phase={runState.currentPhase} />
        )}

        {showClarifications &&
          runState.pendingClarifications.map((c) => (
            <ClarificationCard
              key={c.toolCallId}
              clarification={c}
              decidedAnswer={decisions[c.toolCallId]?.answer}
              onAnswer={onAnswer}
            />
          ))}

        {showApproval && runState.pendingApproval && (
          <ApprovalBatchCard
            tools={runState.pendingApproval.tools}
            decisions={decisions}
            onDecide={onDecide}
            onDecideRemaining={onDecideRemaining}
          />
        )}
      </div>
    </div>
  )
}
