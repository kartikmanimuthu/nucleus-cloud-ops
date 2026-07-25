"use client";

import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDictation } from "@/hooks/use-dictation";

export interface MicButtonProps {
  /** Current field value — dictation appends to it. */
  value: string;
  /** Controlled-field setter the transcript is written back through. */
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Mirrors the field's own `maxLength`, so dictation respects the same cap. */
  maxLength?: number;
  /** `sm` (h-7) suits dense inline rows; `default` (h-8) matches send buttons. */
  size?: "sm" | "default";
  className?: string;
}

/**
 * Push-to-dictate button for a controlled text field.
 *
 * Renders nothing on browsers without the Web Speech API (e.g. Firefox) — a
 * visible-but-dead mic is worse than no mic at all.
 */
export function MicButton({
  value,
  onChange,
  disabled = false,
  maxLength,
  size = "default",
  className,
}: MicButtonProps) {
  const { isSupported, isListening, toggle } = useDictation({
    value,
    onChange,
    disabled,
    maxLength,
  });

  if (!isSupported) return null;

  const label = isListening ? "Stop voice input" : "Start voice input";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      // While listening the button must stay clickable so dictation can be
      // stopped even if the field itself has just been disabled.
      disabled={disabled && !isListening}
      aria-label={label}
      aria-pressed={isListening}
      title={label}
      data-testid="mic-button"
      data-listening={isListening ? "true" : "false"}
      className={cn(
        "shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground",
        size === "sm" ? "h-7 w-7" : "h-8 w-8",
        isListening && "bg-destructive/10 text-destructive hover:text-destructive",
        className,
      )}
    >
      <Mic
        className={cn(size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4", isListening && "animate-pulse")}
      />
    </Button>
  );
}
