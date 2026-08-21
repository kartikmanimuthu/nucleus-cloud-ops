"use client";

import { useState, useEffect, useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/rbac/gated";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, XCircle, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { UIAccount } from "@/lib/types";

interface SyncAccountsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    accounts: UIAccount[];
    onSyncStarted: (count: number) => void;
}

type JobState = "queued" | "error";

export function SyncAccountsDialog({
    open,
    onOpenChange,
    accounts,
    onSyncStarted,
}: SyncAccountsDialogProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set(accounts.map(a => a.accountId)));
    const [jobStates, setJobStates] = useState<Record<string, JobState>>({});
    const [syncing, setSyncing] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");

    // Fix #1: reset selection/state whenever the dialog opens
    useEffect(() => {
        if (open) {
            setSelected(new Set(accounts.map(a => a.accountId)));
            setJobStates({});
            setSearchQuery("");
        }
    }, [open, accounts]);

    // Fix #7: memoize filtered list
    const filteredAccounts = useMemo(() => {
        if (!searchQuery) return accounts;
        const q = searchQuery.toLowerCase();
        return accounts.filter(a =>
            a.name.toLowerCase().includes(q) || a.accountId.toLowerCase().includes(q)
        );
    }, [accounts, searchQuery]);

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

    // Fix #2: return structured result so callers can surface the error message
    const triggerSync = async (accountId?: string): Promise<{ ok: boolean; error?: string }> => {
        const res = await fetch("/api/inventory/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(accountId ? { accountId } : {}),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            return { ok: false, error: data.error || "Failed to queue sync" };
        }
        return { ok: true };
    };

    const handleSync = async () => {
        setSyncing(true);

        try {
            if (selected.size === accounts.length) {
                // Full sync — no accountId
                const result = await triggerSync();
                if (result.ok) {
                    toast.success("Full sync queued", { description: "Scanning all accounts in the background." });
                    onOpenChange(false);
                    onSyncStarted(selected.size);
                } else {
                    toast.error(result.error ?? "Failed to queue sync — a job may already be running.");
                }
                // Fix #5: removed redundant setSyncing(false) here; finally handles it
                return;
            }

            // Per-account syncs in parallel
            const ids = Array.from(selected);
            const initial: Record<string, JobState> = {};
            ids.forEach((id) => { initial[id] = "queued"; });
            setJobStates(initial);

            const results = await Promise.allSettled(
                ids.map(async (id) => {
                    const result = await triggerSync(id);
                    setJobStates((prev) => ({ ...prev, [id]: result.ok ? "queued" : "error" }));
                    return { id, ok: result.ok };
                })
            );

            const succeeded = results.filter(
                (r) => r.status === "fulfilled" && r.value.ok
            ).length;
            const failed = results.length - succeeded;

            if (failed === 0) {
                toast.success(`${ids.length} account scan${ids.length > 1 ? "s" : ""} queued`);
                onOpenChange(false);
                onSyncStarted(selected.size);
            } else if (succeeded > 0) {
                toast.warning(`Sync started for ${succeeded} of ${selected.size} accounts. ${failed} already in progress.`);
                onOpenChange(false);
                onSyncStarted(succeeded);
            } else {
                toast.error("Failed to queue sync — jobs may already be running.");
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to trigger sync");
        } finally {
            setSyncing(false);
        }
    };

    // Fix #1: effect handles reset on next open; just close here
    const handleClose = () => {
        if (!syncing) {
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
                        Select accounts to sync, or select all to run a full scan.
                    </DialogDescription>
                </DialogHeader>

                {accounts.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No connected accounts found.</p>
                ) : (
                    <div className="space-y-2">
                        {/* Search input */}
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search by name or account ID..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-9"
                            />
                        </div>

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
                                {filteredAccounts.map((account) => {
                                    const job = jobStates[account.accountId];
                                    const isChecked = selected.has(account.accountId);
                                    // Fix #3: removed unused isConnected variable

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
                                                <p className="text-xs text-muted-foreground">
                                                    {account.lastValidated
                                                        ? `synced ${formatDistanceToNow(new Date(account.lastValidated), { addSuffix: true })}`
                                                        : "never synced"}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <Badge
                                                    variant={account.connectionStatus === "connected" ? "default" : "destructive"}
                                                    className={account.connectionStatus === "connected" ? "bg-green-500 text-white text-xs shrink-0" : "text-xs shrink-0"}
                                                >
                                                    {account.connectionStatus ?? "unknown"}
                                                </Badge>
                                                {job === "queued" && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
                                                {job === "error" && <XCircle className="h-4 w-4 text-destructive" />}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </ScrollArea>
                    </div>
                )}

                <DialogFooter className="flex items-center justify-between sm:justify-between gap-2">
                    <span className="text-sm text-muted-foreground">{selected.size} selected</span>
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={handleClose} disabled={syncing}>
                            Cancel
                        </Button>
                        {/*
                         * The control that actually POSTs /api/inventory/sync,
                         * gated on the update/Resource that route enforces —
                         * the "Inventory Resource" submodule row. The opener on
                         * the inventory page carries the same gate; this one is
                         * here because it is the button that fires the request,
                         * so the two cannot drift apart.
                         */}
                        <GatedButton
                            action="update"
                            subject="Resource"
                            onClick={handleSync}
                            disabled={syncing || selected.size === 0}
                        >
                            {syncing ? (
                                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Queuing...</>
                            ) : (
                                <><RefreshCw className="h-4 w-4 mr-2" />Sync Selected</>
                            )}
                        </GatedButton>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
