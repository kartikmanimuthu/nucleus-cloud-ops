"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HelpCircle, Send } from "lucide-react";
import type { PendingClarification } from "./run-state";

export function ClarificationCard({
  clarification,
  onAnswer,
}: {
  clarification: PendingClarification;
  onAnswer: (toolCallId: string, answer: string) => void;
}) {
  const [text, setText] = useState("");

  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    onAnswer(clarification.toolCallId, trimmed);
  };

  return (
    <div data-testid="clarification-card" className="my-2 overflow-hidden rounded-lg border border-blue-500/30 bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b border-blue-500/20 bg-blue-500/10 px-3 py-2 text-sm font-semibold text-blue-700 dark:text-blue-400">
        <HelpCircle className="h-4 w-4" />
        The agent needs input to continue
      </div>
      <div className="space-y-2.5 px-3 py-2.5 text-sm">
        <p>{clarification.question}</p>
        {clarification.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {clarification.options.map((opt) => (
              <Button key={opt} size="sm" variant="outline"
                className="h-7 rounded-full border-blue-500/40 text-xs text-blue-700 hover:bg-blue-500/10 dark:text-blue-400"
                onClick={() => submit(opt)}>
                {opt}
              </Button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            value={text}
            placeholder="Or type a custom answer… (Enter to send — the run resumes immediately)"
            className="min-h-[36px] resize-none text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(text);
              }
            }}
          />
          <Button size="sm" className="h-8 shrink-0" disabled={!text.trim()} onClick={() => submit(text)}>
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
