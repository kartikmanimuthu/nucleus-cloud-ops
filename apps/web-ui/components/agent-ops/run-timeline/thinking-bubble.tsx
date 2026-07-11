"use client";

import { motion } from "framer-motion";
import { MarkdownContent } from "@/components/ui/markdown-content";
import type { AgentOpsEvent } from "@/lib/agent-ops/types";

/** Narrative agent thinking, rendered as a quiet bubble between steps (design: B-style). */
export function ThinkingBubble({ event }: { event: AgentOpsEvent }) {
  if (!event.content) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="max-w-[94%] rounded-xl border border-dashed border-muted-foreground/25 bg-muted/30 px-3.5 py-2.5 text-sm italic text-muted-foreground [&_p]:my-0.5"
    >
      <MarkdownContent content={event.content} />
    </motion.div>
  );
}
