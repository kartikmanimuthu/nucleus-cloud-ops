"use client";

import { CheckCircle2, Circle, Loader2, ListChecks } from "lucide-react";
import { StepShell } from "./step-shell";
import { cn } from "@/lib/utils";

type Todo = { content: string; status: "pending" | "in_progress" | "completed" };

const ICON = {
  completed: <CheckCircle2 className="size-3.5 text-green-600" />,
  in_progress: <Loader2 className="size-3.5 animate-spin text-primary" />,
  pending: <Circle className="size-3.5 text-muted-foreground" />,
} as const;

export function TodoStep({ todos }: { todos: Todo[] }) {
  const done = todos.filter(t => t.status === "completed").length;

  return (
    <StepShell
      icon={<ListChecks className="size-3.5" />}
      iconClass="bg-primary/10 text-primary"
      title="Plan"
      meta={<span className="shrink-0 text-xs text-muted-foreground">{done}/{todos.length}</span>}
      defaultOpen
    >
      <ul className="space-y-1.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">{ICON[t.status] ?? ICON.pending}</span>
            <span className={cn("min-w-0", t.status === "completed" && "text-muted-foreground line-through")}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </StepShell>
  );
}
