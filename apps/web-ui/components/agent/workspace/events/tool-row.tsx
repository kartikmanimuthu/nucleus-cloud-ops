"use client"

import * as React from "react"
import { ChevronDown, Terminal, FileText, FilePen, BookOpen, Wrench, Check, X } from "lucide-react"
import type { TranscriptEvent } from "@/lib/agent-chat/events"
import type { ToolGroup } from "@/lib/agent-chat/group-events"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type ToolEvent = Extract<TranscriptEvent, { kind: "tool" }>

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  execute_command: Terminal,
  read_file: FileText,
  write_file: FilePen,
  search_knowledge_base: BookOpen,
}

function toolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  return TOOL_ICONS[toolName] ?? Wrench
}

// Moved to lib/agent-chat/events.ts so non-React consumers (chat-export) can
// use it too; re-exported here to keep existing imports working.
export { unwrapToolInput } from "@/lib/agent-chat/events"
import { unwrapToolInput } from "@/lib/agent-chat/events"

const PREVIEW_KEYS = ["command", "file_path", "path", "query"] as const

function argumentPreview(unwrapped: unknown): string {
  if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
    const record = unwrapped as Record<string, unknown>
    for (const key of PREVIEW_KEYS) {
      if (typeof record[key] === "string") return record[key] as string
    }
    for (const value of Object.values(record)) {
      if (typeof value === "string") return value
    }
    return ""
  }
  if (typeof unwrapped === "string") return unwrapped
  return ""
}

function renderOutput(output: unknown): string {
  if (typeof output === "string") return output
  return JSON.stringify(output, null, 2)
}

function StatusGlyph({ status, durationMs }: { status: ToolEvent["status"]; durationMs?: number }) {
  if (status === "running") return <Spinner size="xs" />
  if (status === "rejected")
    return (
      <span className="inline-block rounded bg-red-500/10 px-1.5 text-[10px] text-red-500">Rejected</span>
    )
  if (status === "error") return <X className="h-3.5 w-3.5 shrink-0 text-red-500" />
  return (
    <span className="inline-flex items-center gap-1">
      <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      {durationMs != null && (
        <span className="text-xs text-muted-foreground">{`${(durationMs / 1000).toFixed(1)}s`}</span>
      )}
    </span>
  )
}

/**
 * Compact single-line row for a `tool` TranscriptEvent: chevron, tool icon,
 * mono tool name, truncated argument preview, status glyph. Expands to show
 * Input/Output panes. Built directly on @/components/ui/collapsible, mirroring
 * ThinkingBlock's row grammar — not faded/italic since tool rows aren't
 * ambient narration.
 */
export function ToolRow({
  event,
  durationMs,
  defaultOpen = false,
}: {
  event: ToolEvent
  durationMs?: number
  /** With the "Show work" toggle on, rows render expanded (input/output visible). */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)

  // Re-sync when the "Show work" toggle changes; manual toggles in between are kept.
  React.useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])
  const Icon = toolIcon(event.toolName)
  const unwrappedInput = React.useMemo(() => unwrapToolInput(event.input), [event.input])
  const preview = React.useMemo(() => argumentPreview(unwrappedInput), [unwrappedInput])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left",
          "text-xs hover:bg-muted/40",
          "outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono shrink-0">{event.toolName}</span>
        {preview && (
          <span className="max-w-[24rem] truncate font-mono text-muted-foreground">{preview}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          <StatusGlyph status={event.status} durationMs={durationMs} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 px-2 pb-2 pt-1">
          <div>
            <div className="mb-1 text-[10px] uppercase text-muted-foreground">Input</div>
            <pre className="max-h-80 overflow-x-auto overflow-y-auto rounded bg-muted/40 p-2 font-mono text-xs">
              {JSON.stringify(unwrappedInput, null, 2)}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase text-muted-foreground">Output</div>
            <pre className="max-h-80 overflow-x-auto overflow-y-auto rounded bg-muted/40 p-2 font-mono text-xs">
              {renderOutput(event.output)}
            </pre>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Header row for a collapsed run of >=3 consecutive `done` tool events
 * (see group-events.ts). Expands to the individual ToolRows.
 */
export function ToolGroupRow({ group, defaultOpen = false }: { group: ToolGroup; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen)

  React.useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left",
          "text-xs hover:bg-muted/40",
          "outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        <span>{`Ran ${group.tools.length} tools`}</span>
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0.5 pl-3">
          {group.tools.map((tool) => (
            <ToolRow key={tool.id} event={tool} defaultOpen={defaultOpen} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
