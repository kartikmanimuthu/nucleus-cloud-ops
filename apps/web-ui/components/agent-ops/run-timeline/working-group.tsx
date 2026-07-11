"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, Loader2, Terminal } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { formatStepDuration } from "./step-shell";
import type { TimelineStep } from "./build-steps";

type GroupStepData = Extract<TimelineStep, { kind: "group" }>;

export function WorkingGroup({
  step,
  renderStep,
}: {
  step: GroupStepData;
  renderStep: (s: TimelineStep, i: number) => ReactNode;
}) {
  // Groups with live work stay open; settled groups start collapsed.
  const [open, setOpen] = useState(step.running);
  const toolCount = step.steps.filter(s => s.kind === "tool").length;

  return (
    <div className={cn("rounded-lg border bg-muted/20", step.running && "border-primary/40")}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/40"
      >
        {step.running
          ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          : <Terminal className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="flex-1 font-medium text-muted-foreground">
          {step.running ? "Working" : "Worked"} — {toolCount} tool call{toolCount === 1 ? "" : "s"}
        </span>
        {step.durationMs > 0 && (
          <span className="text-xs text-muted-foreground">{formatStepDuration(step.durationMs)}</span>
        )}
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 border-t px-3 py-2.5 pl-5">
              {step.steps.map((s, i) => renderStep(s, i))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
