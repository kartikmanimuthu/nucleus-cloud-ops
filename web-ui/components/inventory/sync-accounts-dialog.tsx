"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, XCircle, Search } from "lucide-react";
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
    onSyncStarted: (count: number) => void;
}

type JobState = "idle" | "queued" | "error";

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

    const filteredAccounts = accounts.filter(a =>
        !searchQuery ||
        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.accountId.toLowerCase().includes(searchQuery.toLowerCase())
    );

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

        try {
            if (selected.size === accounts.length) {
                // Full sync — no accountId
                const ok = await triggerSync();
                if (ok) {
                    toast.success("Full sync queued", { description: "Scanning all accounts in the background." });
                    onOpenChange(false);
                    onSyncStarted(selected.size);
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

            const results = await Promise.allSettled(
                ids.map(async (id) => {
                    const ok = await triggerSync(id);
                    setJobStates((prev) => ({ ...prev, [id]: ok ? "queued" : "error" }));
                    return { id, ok };
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
                                    const isConnected = account.connectionStatus === "connected";

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
                                                <Badge variant={isConnected ? "default" : "destructive"}>
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

                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={handleClose} disabled={syncing}>
                        Cancel
                    </Button>
                    <Button onClick={handleSync} disabled={syncing || accounts.length === 0}>
                        {syncing ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Queuing...</>
                        ) : selected.size === accounts.length ? (
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
