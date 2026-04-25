"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, RefreshCw, CheckCircle2, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { UIAccount } from "@/lib/types";

export interface AccountSyncStatus {
    accountId: string;
    accountName: string;
    lastSyncedAt?: string;
    lastSyncStatus?: string;
    lastSyncResourceCount?: number;
}

interface SyncAccountsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    accounts: UIAccount[];
    syncStatuses: AccountSyncStatus[];
    onSyncComplete?: () => void;
}

type JobState = "idle" | "queued" | "error";

function formatRelativeTime(iso?: string): string {
    if (!iso) return "Never";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

export function SyncAccountsDialog({
    open,
    onOpenChange,
    accounts,
    syncStatuses,
    onSyncComplete,
}: SyncAccountsDialogProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [jobStates, setJobStates] = useState<Record<string, JobState>>({});
    const [syncing, setSyncing] = useState(false);

    const statusMap = Object.fromEntries(syncStatuses.map((s) => [s.accountId, s]));

    const allSelected = accounts.length > 0 && selected.size === accounts.length;
    const someSelected = selected.size > 0 && !allSelected;

    const toggleAll = () => {
        if (allSelected) {
            setSelected(new Set());
        } else {
            setSelected(new Set(accounts.map((a) => a.accountId)));
        }
    };

    const toggle = (accountId: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(accountId)) next.delete(accountId);
            else next.add(accountId);
            return next;
        });
    };

    const triggerSync = async (accountId?: string): Promise<boolean> => {
        const res = await fetch("/api/inventory/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(accountId ? { accountId } : {}),
        });
        return res.ok;
    };

    const handleSync = async () => {
        setSyncing(true);

        if (selected.size === 0) {
            // Full sync — no accountId
            const ok = await triggerSync();
            if (ok) {
                toast.success("Full sync queued", { description: "Scanning all accounts in the background." });
                onSyncComplete?.();
                onOpenChange(false);
            } else {
                toast.error("Failed to queue sync — a job may already be running.");
            }
            setSyncing(false);
            return;
        }

        // Per-account syncs in parallel
        const ids = Array.from(selected);
        const initial: Record<string, JobState> = {};
        ids.forEach((id) => { initial[id] = "queued"; });
        setJobStates(initial);

        const results = await Promise.all(
            ids.map(async (id) => {
                const ok = await triggerSync(id);
                setJobStates((prev) => ({ ...prev, [id]: ok ? "queued" : "error" }));
                return { id, ok };
            })
        );

        const failed = results.filter((r) => !r.ok);
        if (failed.length === 0) {
            toast.success(`${ids.length} account scan${ids.length > 1 ? "s" : ""} queued`);
            onSyncComplete?.();
            onOpenChange(false);
        } else {
            toast.error(`${failed.length} of ${ids.length} scans failed to queue`);
        }

        setSyncing(false);
    };

    const handleClose = () => {
        if (!syncing) {
            setSelected(new Set());
            setJobStates({});
            onOpenChange(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-[520px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <RefreshCw className="h-5 w-5" />
                        Sync Inventory
                    </DialogTitle>
                    <DialogDescription>
                        Select accounts to sync, or leave all unchecked to run a full scan.
                    </DialogDescription>
                </DialogHeader>

                {accounts.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No connected accounts found.</p>
                ) : (
                    <div className="space-y-2">
                        {/* Select All row */}
                        <div
                            className="flex items-center gap-3 rounded-md border px-3 py-2 cursor-pointer hover:bg-accent"
                            onClick={toggleAll}
                        >
                            <Checkbox
                                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                                onCheckedChange={toggleAll}
                                onClick={(e) => e.stopPropagation()}
                            />
                            <span className="text-sm font-medium">All accounts</span>
                            <Badge variant="secondary" className="ml-auto">{accounts.length}</Badge>
                        </div>

                        <ScrollArea className="h-[280px] pr-1">
                            <div className="space-y-1">
                                {accounts.map((account) => {
                                    const status = statusMap[account.accountId];
                                    const job = jobStates[account.accountId];
                                    const isChecked = selected.has(account.accountId);

                                    return (
                                        <div
                                            key={account.accountId}
                                            className={cn(
                                                "flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer hover:bg-accent",
                                                isChecked && "bg-accent/50"
                                            )}
                                            onClick={() => toggle(account.accountId)}
                                        >
                                            <Checkbox
                                                checked={isChecked}
                                                onCheckedChange={() => toggle(account.accountId)}
                                                onClick={(e) => e.stopPropagation()}
                                                disabled={syncing}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium truncate">{account.name}</p>
                                                <p className="text-xs text-muted-foreground">{account.accountId}</p>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                {job === "queued" && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
                                                {job === "error" && <XCircle className="h-4 w-4 text-destructive" />}
                                                {!job && status?.lastSyncStatus === "success" && (
                                                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                                                )}
                                                {!job && status?.lastSyncStatus === "error" && (
                                                    <XCircle className="h-4 w-4 text-destructive" />
                                                )}
                                                <div className="text-right">
                                                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                                                        <Clock className="h-3 w-3" />
                                                        {formatRelativeTime(status?.lastSyncedAt)}
                                                    </p>
                                                    {status?.lastSyncResourceCount != null && (
                                                        <p className="text-xs text-muted-foreground">
                                                            {status.lastSyncResourceCount.toLocaleString()} resources
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </ScrollArea>
                    </div>
                )}

                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={handleClose} disabled={syncing}>
                        Cancel
                    </Button>
                    <Button onClick={handleSync} disabled={syncing || accounts.length === 0}>
                        {syncing ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Queuing...</>
                        ) : selected.size === 0 ? (
                            <><RefreshCw className="h-4 w-4 mr-2" />Sync All</>
                        ) : (
                            <><RefreshCw className="h-4 w-4 mr-2" />Sync {selected.size} Account{selected.size > 1 ? "s" : ""}</>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
