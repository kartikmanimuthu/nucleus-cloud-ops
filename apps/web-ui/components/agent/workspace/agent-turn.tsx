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

function renderProcessRow(row: Row, durationMs?: Map<string, number>): React.ReactNode {
  switch (row.kind) {
    case "thinking":
      return <ThinkingBlock key={row.id} event={row} durationMs={durationMs?.get(row.id)} />
    case "tool":
      return <ToolRow key={row.id} event={row} />
    case "tool-group":
      return <ToolGroupRow key={row.id} group={row} />
    case "memory":
      return <MemoryRow key={row.id} event={row} />
    default:
      return null
  }
}

function renderOutputRow(row: Extract<TranscriptEvent, { kind: "answer" | "image" }>): React.ReactNode {
  if (row.kind === "image") {
    return <img key={row.id} src={row.url} alt="" className="max-w-xs max-h-72 rounded border object-contain" />
  }
  return (
    <MarkdownContent key={row.id} content={row.text} className="prose prose-sm dark:prose-invert max-w-none" />
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

  const showClarifications = isLastAssistantMessage && runState.pendingClarifications.length > 0
  const showApproval = isLastAssistantMessage && runState.pendingApproval !== null

  return (
    <div className="flex gap-3">
      <div
        data-testid="agent-turn-avatar"
        className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted"
      >
        <Bot className="size-4 text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        {processRows.length > 0 && (
          expanded ? (
            <div className="ml-3 space-y-0.5 border-l pl-3">
              {processRows.map((row) => renderProcessRow(row, durationMs))}
            </div>
          ) : (
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
          )
        )}

        {outputRows.length > 0 && (
          <div className="space-y-2">
            {outputRows.map(renderOutputRow)}
          </div>
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
