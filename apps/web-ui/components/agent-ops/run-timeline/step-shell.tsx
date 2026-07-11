"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export function StepShell({
  icon,
  iconClass,
  title,
  meta,
  time,
  defaultOpen = false,
  running = false,
  tone = "default",
  children,
}: {
  icon: ReactNode;
  iconClass?: string;
  title: ReactNode;
  meta?: ReactNode;
  time?: string;
  defaultOpen?: boolean;
  running?: boolean;
  tone?: "default" | "error";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!children;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        "rounded-lg border bg-card",
        tone === "error" && "border-red-300 dark:border-red-900",
        running && "border-primary/50 shadow-[0_0_0_2px_hsl(var(--primary)/0.12)]",
      )}
    >
      <button
        type="button"
        onClick={() => expandable && setOpen(o => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
          expandable && "cursor-pointer hover:bg-accent/40 rounded-lg",
        )}
      >
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", iconClass)}>
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {meta}
        {time && <span className="shrink-0 text-xs text-muted-foreground">{time}</span>}
        {expandable && (
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="border-t px-3 py-2.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function formatStepDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
