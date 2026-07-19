"use client";

import { Bot, ClipboardList, DollarSign, Server, Zap } from "lucide-react";

const SUGGESTIONS: Array<{ icon: React.ElementType; title: string; prompt: string }> = [
  {
    icon: Server,
    title: "Check infrastructure health",
    prompt:
      "Check all EC2 instances and ECS services across my selected accounts and report anything that is down or unhealthy.",
  },
  {
    icon: DollarSign,
    title: "Find cost savings",
    prompt:
      "Review my inventory for idle or oversized resources and suggest right-sizing or shutdown candidates with estimated savings.",
  },
  {
    icon: Zap,
    title: "Audit Lambda functions",
    prompt:
      "Review my AWS Lambda functions for errors, outdated runtimes, and misconfigurations, and summarize the findings.",
  },
  {
    icon: ClipboardList,
    title: "Summarize recent changes",
    prompt:
      "Summarize last week's activity on my change management board, highlighting completed work and anything still in progress.",
  },
];

/**
 * Welcome screen for a fresh session — replaces the blank transcript until the
 * first message is sent. Explains what the agent does and offers one-click
 * starter prompts (they fill the composer, they don't auto-send, so the user
 * can still pick accounts/model/skill first).
 */
export function EmptyState({ onSuggestion }: { onSuggestion: (prompt: string) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto" data-testid="session-empty-state">
      <div className="w-full max-w-2xl space-y-6 px-6 py-8 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border bg-muted">
          <Bot className="size-6 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h3 className="text-lg font-semibold">What should the agent run for you?</h3>
          <p className="mx-auto max-w-lg text-sm text-muted-foreground">
            Describe a task across your connected AWS accounts, tools, and knowledge bases. The agent
            plans, executes, reflects, and revises — and always pauses for your approval before
            anything risky.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => onSuggestion(s.prompt)}
              data-testid="empty-state-suggestion"
              className="group flex items-start gap-2.5 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <s.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-tight">{s.title}</span>
                <span className="mt-1 block text-xs leading-snug text-muted-foreground line-clamp-2">
                  {s.prompt}
                </span>
              </span>
            </button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          Pick accounts, model, mode, and skill in the composer below — or just start typing.
        </p>
      </div>
    </div>
  );
}
