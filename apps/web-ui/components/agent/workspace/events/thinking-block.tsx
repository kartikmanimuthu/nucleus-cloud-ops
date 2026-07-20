"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import type { TranscriptEvent } from "@/lib/agent-chat/events"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"

type ThinkingEvent = Extract<TranscriptEvent, { kind: "thinking" }>

// "reflection" -> "Reflection", "memory_recall" -> "Memory recall"
function sentenceCasePhase(phase: string): string {
  const spaced = phase.replace(/_/g, " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Faded, auto-collapsing "Thought for Ns" row for TranscriptEvent's thinking
 * variant. Built directly on the plain Radix collapsible primitives
 * (@/components/ui/collapsible), not ai-elements/reasoning.tsx's Reasoning —
 * that component unconditionally renders its own Brain icon + purple
 * "Thinking..." pill whenever isStreaming is true, duplicating this row's
 * own faded label and violating the "faded, no border" spec. It's a shared
 * primitive (also used by chat-interface.tsx), so we own our row instead of
 * patching it.
 */
export function ThinkingBlock({
  event,
  durationMs,
  defaultOpen = false,
}: {
  event: ThinkingEvent
  durationMs?: number
  /** With the "Show work" toggle on, rows render expanded so the full detail
   *  is visible without a click; toggling it re-syncs every row. */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen || event.streaming)

  // Auto-open while streaming; when streaming ends, collapse only if the
  // "Show work" default doesn't hold the row open. Manual toggles afterward
  // are preserved since this effect only re-runs when its inputs change.
  React.useEffect(() => {
    setOpen(defaultOpen || event.streaming)
  }, [event.streaming, defaultOpen])

  const label = durationMs != null
    ? `Thought for ${Math.round(durationMs / 1000)}s`
    : event.streaming
      ? "Thinking…"
      : "Thought"

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left",
          "text-[15px] italic text-muted-foreground hover:bg-muted/40",
          "outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        <span className={cn(event.streaming && "animate-pulse")}>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pb-2 pt-1 text-[15px] text-muted-foreground">
          {event.phase !== "execution" && (
            <span className="mb-1 mr-1 inline-block rounded bg-muted px-1.5 text-[10px]">
              {sentenceCasePhase(event.phase)}
            </span>
          )}
          <MarkdownContent content={event.text} className="text-[15px] text-muted-foreground" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
