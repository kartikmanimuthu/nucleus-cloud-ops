"use client"

import * as React from "react"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { buildTranscript, isEmptyDecisionCarrier, type LooseMessage, type TranscriptEvent } from "@/lib/agent-chat/events"
import type { RunState } from "@/components/agent/chat/run-state"
import type { DecisionMap } from "@/components/agent/chat/use-decisions"
import { AgentTurn } from "./agent-turn"

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
  return (message.parts ?? [])
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("\n")
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
        {text && <MarkdownContent content={text} className="prose prose-sm prose-invert max-w-none" />}
      </div>
    </div>
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

  return (
    <div className="flex-1 overflow-y-auto" onScroll={handleScroll}>
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
        {visible.map((message, index) => {
          if (message.role === "user") {
            return <UserBubble key={message.id} message={message} />
          }

          const isLastAssistantMessage = index === visible.length - 1
          const messageIsStreaming = isLastAssistantMessage && isStreaming

          // Built here (in addition to AgentTurn's own build) purely to derive
          // best-effort thinking durations from this message's data-phase
          // parts — AgentTurn remains the single source of truth for the
          // rendered event list.
          const events = buildTranscript(message, {
            isStreaming: messageIsStreaming,
            toolVisibility,
            decisions: decisionsForTranscript,
          })
          const durationMs = computeThinkingDurations(message, events)

          return (
            <AgentTurn
              key={message.id}
              message={message}
              isStreaming={messageIsStreaming}
              toolVisibility={toolVisibility}
              decisions={decisions}
              showWork={showWork}
              runState={runState}
              isLastAssistantMessage={isLastAssistantMessage}
              durationMs={durationMs}
              onDecide={onDecide}
              onDecideRemaining={onDecideRemaining}
              onAnswer={onAnswer}
            />
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
