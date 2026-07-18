"use client"

import * as React from "react"
import type { TranscriptEvent } from "@/lib/agent-chat/events"
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning"
import { cn } from "@/lib/utils"

type ThinkingEvent = Extract<TranscriptEvent, { kind: "thinking" }>

// "reflection" -> "Reflection", "memory_recall" -> "Memory recall"
function sentenceCasePhase(phase: string): string {
  const spaced = phase.replace(/_/g, " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Faded, auto-collapsing "Thought for Ns" row. Wraps ai-elements' Reasoning
 * primitives with the design spec's row styling (no border, faded/italic,
 * hover tint) and a phase chip in the expanded body.
 *
 * ai-elements' Reasoning auto-*opens* when `isStreaming` flips true (its own
 * internal effect) but has no matching auto-*collapse* when streaming ends,
 * so we drive `open` locally and pass it down as a controlled prop.
 */
export function ThinkingBlock({
  event,
  durationMs,
}: {
  event: ThinkingEvent
  durationMs?: number
}) {
  const [open, setOpen] = React.useState(event.streaming)

  React.useEffect(() => {
    setOpen(event.streaming)
  }, [event.streaming])

  const label = durationMs != null
    ? `Thought for ${Math.round(durationMs / 1000)}s`
    : event.streaming
      ? "Thinking…"
      : "Thought"

  const showPhaseChip = open && event.phase !== "execution"

  return (
    <Reasoning
      isStreaming={event.streaming}
      open={open}
      onOpenChange={setOpen}
      className="rounded-none border-0 bg-transparent shadow-none"
    >
      <ReasoningTrigger
        className={cn(
          "px-2 py-1 text-xs italic font-normal text-muted-foreground",
          "hover:text-muted-foreground hover:bg-muted/40"
        )}
      >
        {label}
      </ReasoningTrigger>
      {showPhaseChip && (
        <div className="px-2 pt-1">
          <span className="inline-block rounded bg-muted px-1.5 text-[10px] not-italic text-muted-foreground">
            {sentenceCasePhase(event.phase)}
          </span>
        </div>
      )}
      <ReasoningContent className="border-t-0 bg-none px-2 pb-2 pt-1 text-xs italic text-muted-foreground">
        {event.text}
      </ReasoningContent>
    </Reasoning>
  )
}
