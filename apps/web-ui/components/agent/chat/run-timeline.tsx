// apps/web-ui/components/agent/chat/run-timeline.tsx
"use client";

import React from "react";
import { cn } from "@/lib/utils";

const PHASE_DOT: Record<string, string> = {
  planning: "bg-violet-500", execution: "bg-amber-500", reflection: "bg-sky-500",
  revision: "bg-cyan-500", final: "bg-emerald-500", memory_recall: "bg-emerald-400",
  memory_save: "bg-emerald-400", text: "bg-muted-foreground/50",
};

function TimelineNode({ color, active, children }: { color: string; active?: boolean; children: React.ReactNode }) {
  return (
    <div className="relative pl-5">
      <span
        className={cn(
          "absolute left-[-5px] top-2 h-2.5 w-2.5 rounded-full ring-2 ring-background",
          color,
          active && "animate-pulse ring-4 ring-blue-500/20",
        )}
      />
      {children}
    </div>
  );
}

/**
 * Threaded timeline for one assistant message: each reasoning phase and each
 * tool call is a node on a vertical spine. data-* parts are NOT rendered here —
 * plan lives in the rail; approval/clarification cards render after the
 * timeline (see chat-interface integration).
 */
export function RunTimeline({
  parts,
  messageId,
  isActivelyStreaming,
  renderPhaseBlock,
  renderToolInvocation,
  parsePhase,
}: {
  parts: Array<{ type: string; [k: string]: any }>;
  messageId: string;
  isActivelyStreaming: boolean;
  renderPhaseBlock: (phase: string, content: string, key: string, isActive?: boolean) => React.ReactNode;
  renderToolInvocation: (part: unknown, messageId: string, index: number) => React.ReactNode;
  parsePhase: (content: string) => { phase: string; cleanContent: string };
}) {
  const lastReasoningIdx = parts.map((p) => p.type).lastIndexOf("reasoning");

  return (
    <div className="ml-1.5 space-y-2 border-l-2 border-border/70 py-1">
      {parts.map((part, index) => {
        const key = `${messageId}-tl-${index}`;
        if (part.type === "reasoning") {
          const { phase, cleanContent } = parsePhase(part.text || "");
          const isActive = isActivelyStreaming && index === lastReasoningIdx;
          const rendered = renderPhaseBlock(phase, cleanContent, key, isActive);
          if (!rendered) return null;
          return (
            <TimelineNode key={key} color={PHASE_DOT[phase] ?? PHASE_DOT.text} active={isActive}>
              {rendered}
            </TimelineNode>
          );
        }
        if (part.type?.startsWith?.("tool-") || part.toolCallId) {
          const rendered = renderToolInvocation(part, messageId, index);
          if (!rendered) return null; // suppressed duplicate — no dangling spine dot
          return (
            <TimelineNode key={key} color="bg-foreground/60" active={isActivelyStreaming && index === parts.length - 1}>
              {rendered}
            </TimelineNode>
          );
        }
        return null; // text parts render OUTSIDE the timeline (answer-level), data-* parts elsewhere
      })}
    </div>
  );
}
