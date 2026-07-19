"use client"

import * as React from "react"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { buildTranscript, hasOutputValue, isEmptyDecisionCarrier, type LooseMessage, type TranscriptEvent } from "@/lib/agent-chat/events"
import type { RunState } from "@/components/agent/chat/run-state"
import type { DecisionMap } from "@/components/agent/chat/use-decisions"
import { AgentTurn, PendingTurn } from "./agent-turn"

export interface TranscriptProps {
  messages: LooseMessage[]
  toolVisibility: Map<string, string>
  decisions: DecisionMap
  showWork: boolean
  runState: RunState
  /** True while the last assistant message is actively streaming a response. */
  isStreaming: boolean
  onDecide: (toolCallId: string, decision: { approved: boolean; reason?: string }) => void
  onDecideRemaining: (approved: boolean) => void
  onAnswer: (toolCallId: string, answer: string) => void
}

function userMessageText(message: LooseMessage): string {
  const fromParts = (message.parts ?? [])
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("\n")
  if (fromParts) return fromParts
  // Messages sent as `{ content }` without parts (older sessions, external
  // senders) would otherwise render an empty bubble.
  const content = (message as any).content
  return typeof content === "string" ? content : ""
}

function userMessageImages(message: LooseMessage): string[] {
  return (message.parts ?? [])
    .map((p: any) => (typeof p?.url === "string" ? p.url : undefined))
    .filter((url: string | undefined): url is string => !!url)
}

function UserBubble({ message }: { message: LooseMessage }) {
  const text = userMessageText(message)
  const images = userMessageImages(message)
  return (
    <div className="flex justify-end">
      <div
        data-testid="user-bubble"
        className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground"
      >
        {images.map((url, i) => (
          <img key={i} src={url} alt="" className="mb-2 max-h-48 max-w-xs rounded object-contain" />
        ))}
        {text && <MarkdownContent content={text} className="[&_p]:text-sm" />}
      </div>
    </div>
  )
}

// A message is only safe to cache once every tool part it owns carries
// output. While any tool part is still output-less, toolVisibility (computed
// per-render in the parent from the FULL, current message list) can still
// reassign that toolCallId's "winning" message forward to a later message
// once the resume flow re-emits it with real output there (the "input-only
// twin" pattern — see run-state.ts's computeToolPartVisibility). Caching a
// still-pending message would freeze its stale (pre-reassignment) tool row
// forever, duplicating it alongside the new winner. Once every tool part has
// output, no later message can steal it away, so the build is stable and
// safe to reuse.
function isMessageSettled(message: LooseMessage): boolean {
  return (message.parts ?? []).every(
    (part: any) => !(part?.toolCallId && part.type !== "text") || hasOutputValue(part)
  )
}

// Best-effort thinking durations: for each `thinking` event, find the
// data-phase part active when its run started (the transition at/before the
// event's first-part index) and the next data-phase part after it. `ts: 0` or
// a missing bracket on either side yields no entry — undefined is fine.
function computeThinkingDurations(message: LooseMessage, events: TranscriptEvent[]): Map<string, number> {
  const durations = new Map<string, number>()
  const parts = message.parts ?? []
  const transitions: Array<{ index: number; ts: number }> = []
  parts.forEach((part: any, index) => {
    if (part?.type === "data-phase" && typeof part.data?.ts === "number") {
      transitions.push({ index, ts: part.data.ts })
    }
  })
  if (transitions.length === 0) return durations

  for (const event of events) {
    if (event.kind !== "thinking") continue
    const startIndex = Number(event.id.slice(message.id.length + 1))
    if (!Number.isFinite(startIndex)) continue

    let startTs: number | undefined
    let endTs: number | undefined
    for (const t of transitions) {
      if (t.index <= startIndex) startTs = t.ts
      else {
        endTs = t.ts
        break
      }
    }
    if (startTs && endTs && startTs > 0 && endTs > 0 && endTs > startTs) {
      durations.set(event.id, endTs - startTs)
    }
  }
  return durations
}

/**
 * The single scroll container for the Mission Control chat: renders user
 * bubbles and AgentTurn rows for assistant messages, auto-scrolling to the
 * bottom unless the user has scrolled up to read history.
 */
export function Transcript({
  messages,
  toolVisibility,
  decisions,
  showWork,
  runState,
  isStreaming,
  onDecide,
  onDecideRemaining,
  onAnswer,
}: TranscriptProps) {
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const scrollRafRef = React.useRef<number | null>(null)
  const [userHasScrolledUp, setUserHasScrolledUp] = React.useState(false)

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 50
    setUserHasScrolledUp(!isAtBottom)
  }

  React.useEffect(() => {
    if (!userHasScrolledUp) {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" })
        scrollRafRef.current = null
      })
    }
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [messages, userHasScrolledUp])

  const visible = React.useMemo(() => messages.filter((m) => !isEmptyDecisionCarrier(m)), [messages])

  const decisionsForTranscript = React.useMemo(
    () => new Map(Object.entries(decisions).map(([id, d]) => [id, { approved: d.approved, answer: d.answer }])),
    [decisions]
  )

  // Per-message buildTranscript cache, keyed by message id + a cheap
  // "has this message's content changed" fingerprint (part count). During
  // streaming, `messages` gets a new array reference on every token, which
  // would otherwise re-run buildTranscript (an O(parts) reduce) across the
  // ENTIRE visible history on every tick. Non-last messages are typically
  // settled — their part count stops growing once the run moves on — so
  // they're safe to reuse verbatim; only the last (actively streaming)
  // message always recomputes.
  //
  // Two edge cases this interacts with, both guarded on the WRITE side (see
  // isMessageSettled above and getMessageTranscript below), not just the
  // `!isLastAssistantMessage` read-side check:
  //  1. A live decision resolving a pending tool call that happens to live on
  //     a NON-last message (rather than the latest one, where pending
  //     approvals/clarifications actually surface) won't invalidate the
  //     cache until that message's part count next changes. In practice this
  //     never happens — pending decisions are always attached to the latest
  //     message.
  //  2. Approval-resume reassigns toolVisibility: a pending tool call's
  //     "winning" message can shift FORWARD from message N (which owns an
  //     output-less/pending tool part) to a later message N+1 that re-emits
  //     the same toolCallId with real output — N's own parts never change
  //     ("input-only twin"), so N's cache key would otherwise still match
  //     after N stops being last, silently returning N's stale pre-shift
  //     tool row (a permanent duplicate). Guarded by NEVER caching a message
  //     while it still has an unresolved tool part — once every tool part it
  //     owns has output, no later message can steal that toolCallId away, so
  //     the cached build can no longer go stale.
  const cacheRef = React.useRef(new Map<string, { partsLength: number; events: TranscriptEvent[]; durationMs: Map<string, number> }>())

  React.useEffect(() => {
    const liveIds = new Set(visible.map((m) => m.id))
    for (const id of cacheRef.current.keys()) {
      if (!liveIds.has(id)) cacheRef.current.delete(id)
    }
  }, [visible])

  function getMessageTranscript(message: LooseMessage, isLastAssistantMessage: boolean) {
    const partsLength = message.parts?.length ?? 0
    const cached = cacheRef.current.get(message.id)
    if (!isLastAssistantMessage && cached && cached.partsLength === partsLength) {
      return cached
    }

    const messageIsStreaming = isLastAssistantMessage && isStreaming
    const events = buildTranscript(message, {
      isStreaming: messageIsStreaming,
      toolVisibility,
      decisions: decisionsForTranscript,
    })
    const durationMs = computeThinkingDurations(message, events)
    const entry = { partsLength, events, durationMs }
    // Only settled messages are safe to cache — see isMessageSettled above.
    if (isMessageSettled(message)) {
      cacheRef.current.set(message.id, entry)
    }
    return entry
  }

  return (
    <div className="flex-1 overflow-y-auto" onScroll={handleScroll}>
      {/* Fully fluid: the transcript takes whatever width the workspace's
          collapsible side panels leave it, at every resolution — no fixed cap,
          just breathing-room padding. */}
      <div className="w-full space-y-4 px-4 py-4 md:px-8">
        {visible.map((message, index) => {
          if (message.role === "user") {
            return <UserBubble key={message.id} message={message} />
          }

          const isLastAssistantMessage = index === visible.length - 1
          const { events, durationMs } = getMessageTranscript(message, isLastAssistantMessage)

          return (
            <AgentTurn
              key={message.id}
              events={events}
              decisions={decisions}
              showWork={showWork}
              runState={runState}
              isLastAssistantMessage={isLastAssistantMessage}
              isStreaming={isStreaming}
              durationMs={durationMs}
              onDecide={onDecide}
              onDecideRemaining={onDecideRemaining}
              onAnswer={onAnswer}
            />
          )
        })}
        {/* The gap between a send and the assistant message's first chunk —
            without this the page reads as frozen while the run spins up. */}
        {isStreaming && visible[visible.length - 1]?.role === "user" && (
          <PendingTurn phase={runState.currentPhase} />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
