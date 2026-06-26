"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { BulkAction } from "@/lib/bulk-actions/types";

interface BulkActionBarProps {
    count: number;
    actions: BulkAction[];
    onAction: (key: string) => void | Promise<void>;
    onClear: () => void;
    isLoading?: boolean;
    /** Action keys that should render disabled (e.g. mid-flight or unauthorized). */
    disabledKeys?: string[];
    /** Noun shown next to the count, e.g. "account" / "schedule". */
    itemNoun?: string;
}

/**
 * Config-driven floating toolbar for bulk actions. Renders nothing when no
 * rows are selected. Destructive actions are confirmed via an AlertDialog
 * before firing. Module-agnostic — callers pass their own action config and
 * an `onAction` that hits the matching bulk endpoint.
 */
export function BulkActionBar({
    count,
    actions,
    onAction,
    onClear,
    isLoading = false,
    disabledKeys = [],
    itemNoun = "item",
}: BulkActionBarProps) {
    const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);

    if (count === 0) return null;

    const noun = `${itemNoun}${count !== 1 ? "s" : ""}`;

    const handleClick = (action: BulkAction) => {
        if (action.destructive) {
            setPendingAction(action);
            return;
        }
        void onAction(action.key);
    };

    const confirmPending = () => {
        if (pendingAction) void onAction(pendingAction.key);
        setPendingAction(null);
    };

    return (
        <>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-4 py-3">
                <div className="flex items-center gap-2 mr-2">
                    <Badge variant="secondary">{count}</Badge>
                    <span className="text-sm text-muted-foreground">
                        {noun} selected
                    </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {actions.map((action) => {
                        const Icon = action.icon;
                        return (
                            <Button
                                key={action.key}
                                size="sm"
                                variant={action.variant ?? "outline"}
                                disabled={isLoading || disabledKeys.includes(action.key)}
                                onClick={() => handleClick(action)}
                            >
                                <Icon className="h-4 w-4 mr-1.5" />
                                {action.label}
                            </Button>
                        );
                    })}
                </div>

                <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={onClear}
                    disabled={isLoading}
                >
                    <X className="h-4 w-4 mr-1.5" />
                    Clear
                </Button>
            </div>

            <AlertDialog
                open={pendingAction !== null}
                onOpenChange={(open) => !open && setPendingAction(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {pendingAction?.confirmTitle ?? `${pendingAction?.label}?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {pendingAction?.confirmDescription ??
                                `This will ${pendingAction?.label.toLowerCase()} ${count} ${noun}. This action cannot be undone.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={confirmPending}
                        >
                            {pendingAction?.label}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
