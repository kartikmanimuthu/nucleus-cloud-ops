"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Small icon button that copies `value` to the clipboard and flips to a check for
 * ~1.5s. Uses the native `title` attribute for the hover hint (no TooltipProvider
 * dependency). Stops click propagation so it works inside clickable table rows.
 */
export function CopyButton({
    value,
    label = "Copy",
    className,
}: {
    value: string;
    label?: string;
    className?: string;
}) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard API unavailable (e.g. non-secure context) — silently ignore.
        }
    };

    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleCopy}
            title={copied ? "Copied!" : label}
            aria-label={label}
            className={cn(
                "h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground",
                className,
            )}
        >
            {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
            ) : (
                <Copy className="h-3.5 w-3.5" />
            )}
        </Button>
    );
}
