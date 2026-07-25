"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MicButton } from "@/components/voice/mic-button";
import { Check, HelpCircle, Send } from "lucide-react";
import type { PendingClarification } from "./run-state";

export function ClarificationCard({
  clarification,
  onAnswer,
  decidedAnswer,
}: {
  clarification: PendingClarification;
  onAnswer: (toolCallId: string, answer: string) => void;
  /** Already-recorded answer (from the decision maps) — renders the card read-only. */
  decidedAnswer?: string;
}) {
  const [text, setText] = useState("");
  // Optimistic local echo: the click/send registers visually the moment it
  // happens, even before the decision lands in the parent's decision maps.
  const [localAnswer, setLocalAnswer] = useState<string | null>(null);

  const recordedAnswer = decidedAnswer ?? localAnswer ?? undefined;
  const isRecorded = recordedAnswer !== undefined;
  const isCustomAnswer =
    isRecorded && !clarification.options.includes(recordedAnswer);

  const submit = (answer: string) => {
    if (isRecorded) return;
    const trimmed = answer.trim();
    if (!trimmed) return;
    setLocalAnswer(trimmed);
    onAnswer(clarification.toolCallId, trimmed);
  };

  return (
    <div data-testid="clarification-card" className="my-2 overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm font-semibold text-foreground">
        <HelpCircle className="h-4 w-4 text-muted-foreground" />
        The agent needs input to continue
      </div>
      <div className="space-y-2.5 px-3 py-2.5 text-sm">
        <p>{clarification.question}</p>
        {clarification.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {clarification.options.map((opt) => {
              const isSelected = isRecorded && recordedAnswer === opt;
              return (
                <Button key={opt} size="sm" variant={isSelected ? "default" : "outline"}
                  disabled={isRecorded && !isSelected}
                  className="h-7 rounded-full text-xs"
                  onClick={() => submit(opt)}>
                  {isSelected && <Check className="mr-1 h-3 w-3" />}
                  {opt}
                </Button>
              );
            })}
          </div>
        )}
        {isCustomAnswer && (
          <div className="flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground">
              <Check className="h-3 w-3 text-muted-foreground" />
              {recordedAnswer}
            </span>
          </div>
        )}
        {isRecorded ? (
          <p className="text-[11px] text-muted-foreground">
            Answer recorded — the run resumes once every pending decision is submitted.
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <Textarea
              rows={1}
              value={text}
              placeholder="Or type a custom answer… (Enter to send)"
              className="min-h-[36px] resize-none text-xs"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(text);
                }
              }}
            />
            <MicButton value={text} onChange={setText} size="sm" />
            <Button size="sm" className="h-8 shrink-0" disabled={!text.trim()} onClick={() => submit(text)} aria-label="Send answer">
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
