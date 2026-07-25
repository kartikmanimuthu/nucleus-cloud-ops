"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { MicButton } from "./mic-button";

export interface DictationTextareaProps
  extends Omit<React.ComponentProps<"textarea">, "value" | "onChange"> {
  value: string;
  /** Receives the new text directly — no ChangeEvent unwrapping at call sites. */
  onValueChange: (next: string) => void;
  /** Extra classes for the positioning wrapper, not the textarea. */
  wrapperClassName?: string;
}

/**
 * `Textarea` with a dictation mic tucked into its bottom-right corner.
 *
 * For standalone prompt fields that have no adjacent control row of their own.
 * Surfaces that already render a send button next to the field should compose
 * `MicButton` into that row instead.
 */
export const DictationTextarea = React.forwardRef<HTMLTextAreaElement, DictationTextareaProps>(
  ({ value, onValueChange, className, wrapperClassName, disabled, maxLength, ...props }, ref) => {
    return (
      <div className={cn("relative", wrapperClassName)}>
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          disabled={disabled}
          maxLength={maxLength}
          // Reserve the corner the mic occupies so text never slides under it.
          className={cn("pr-11", className)}
          {...props}
        />
        <MicButton
          value={value}
          onChange={onValueChange}
          disabled={disabled}
          maxLength={maxLength}
          size="sm"
          className="absolute bottom-1.5 right-1.5"
        />
      </div>
    );
  },
);
DictationTextarea.displayName = "DictationTextarea";
