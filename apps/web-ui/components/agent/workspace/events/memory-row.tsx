"use client"

import * as React from "react"
import { ChevronDown, Brain, Database } from "lucide-react"
import type { TranscriptEvent } from "@/lib/agent-chat/events"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"

type MemoryEvent = Extract<TranscriptEvent, { kind: "memory" }>

function memoryLabel(op: MemoryEvent["op"], count: number | null): string {
  const verb = op === "save" ? "Saved" : "Recalled"
  if (count === null) return `${verb} memories`
  const noun = count === 1 ? "memory" : "memories"
  return `${verb} ${count} ${noun}`
}

/**
 * Faded, always-collapsed-by-default row for TranscriptEvent's memory
 * variant. Mirrors ThinkingBlock's row grammar (same collapsible primitives,
 * same faded trigger classes) but never auto-opens — memory events arrive
 * as a single complete unit, not streamed incrementally like reasoning.
 */
export function MemoryRow({ event, defaultOpen = false }: { event: MemoryEvent; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen)

  // Re-sync when the "Show work" toggle changes; manual toggles in between are kept.
  React.useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])
  const Icon = event.op === "save" ? Database : Brain
  const label = memoryLabel(event.op, event.count)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left",
          "text-[15px] text-muted-foreground hover:bg-muted/40",
          "outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pb-2 pt-1">
          <MarkdownContent content={event.summary} className="text-[15px] text-muted-foreground" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
