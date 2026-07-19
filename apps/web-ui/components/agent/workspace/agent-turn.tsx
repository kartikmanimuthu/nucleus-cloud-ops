"use client"

import * as React from "react"
import { Bot, ChevronRight } from "lucide-react"
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

function isOutputRow(row: Row): row is Extract<TranscriptEvent, { kind: "answer" | "image" }> {
  return row.kind === "answer" || row.kind === "image"
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
    default:
      return null
  }
}

function renderOutputRow(row: Extract<TranscriptEvent, { kind: "answer" | "image" }>): React.ReactNode {
  if (row.kind === "image") {
    return <img key={row.id} src={row.url} alt="" className="max-w-xs max-h-72 rounded border object-contain" />
  }
  // No `prose` wrapper — the typography plugin's own heading/margin scale
  // fights MarkdownContent's compact chat scale (documents-sized titles inside
  // messages). MarkdownContent self-styles; here we only add the answer
  // hierarchy: body text one step larger than process rows, and prose capped
  // at a readable measure while tables/code keep the full fluid width.
  return (
    <MarkdownContent
      key={row.id}
      content={row.text}
      className="[&_p]:text-sm [&_li]:text-sm [&_p]:max-w-[75ch] [&_li]:max-w-[75ch] [&_h1]:max-w-[75ch] [&_h2]:max-w-[75ch] [&_h3]:max-w-[75ch] [&_h4]:max-w-[75ch] [&_blockquote]:max-w-[75ch]"
    />
  )
}

/**
 * One assistant "turn": a single avatar, the transcript grammar rendered via
 * groupEvents(events) — events are pre-built by Transcript, not here — and
 * (only for the last assistant message) the Mission Control interrupt cards.
 * Process rows (thinking/tool/tool-group/memory) sit inside a left guide line
 * and can be hidden behind a single "Show work" toggle; the answer/image rows
 * always render at full opacity below the guide.
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

  const processRows = grouped.filter((row) => !isOutputRow(row))
  const outputRows = grouped.filter(isOutputRow) as Array<Extract<TranscriptEvent, { kind: "answer" | "image" }>>
  // Counted from the raw, pre-grouping events so a >=3-tool run collapsed into
  // one ToolGroupRow still reports its true step count, not 1.
  const hiddenStepCount = events.filter((e) => e.kind !== "answer" && e.kind !== "image").length

  // Chronological segments: runs of consecutive process rows (each rendered as
  // one guide block) interleaved with the answer/narration text in true event
  // order. Since execution narration streams as TEXT between tool calls, the
  // old two-bucket layout (all work above, all text below) would scramble the
  // story: "Step 2 complete" must sit between its tool rows, not after them all.
  type Segment = { kind: "process"; rows: Row[] } | { kind: "output"; row: Extract<TranscriptEvent, { kind: "answer" | "image" }> }
  const segments: Segment[] = []
  for (const row of grouped) {
    if (isOutputRow(row)) {
      segments.push({ kind: "output", row })
    } else {
      const last = segments[segments.length - 1]
      if (last?.kind === "process") last.rows.push(row)
      else segments.push({ kind: "process", rows: [row] })
    }
  }

  const showClarifications = isLastAssistantMessage && runState.pendingClarifications.length > 0
  const showApproval = isLastAssistantMessage && runState.pendingApproval !== null

  // A turn with nothing visible yet (e.g. only data-phase parts during memory
  // recall) must not render as a lone floating avatar: show the animated
  // working indicator while streaming, and nothing at all once settled.
  if (processRows.length === 0 && outputRows.length === 0 && !showClarifications && !showApproval) {
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
              <React.Fragment key={seg.row.id}>{renderOutputRow(seg.row)}</React.Fragment>
            ) : (
              <div key={`process-${i}`} className="ml-3 space-y-0.5 border-l pl-3">
                {seg.rows.map((row) => renderProcessRow(row, durationMs, showWork))}
              </div>
            )
          )
        ) : (
          <>
            {processRows.length > 0 && (
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
                {outputRows.map(renderOutputRow)}
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
