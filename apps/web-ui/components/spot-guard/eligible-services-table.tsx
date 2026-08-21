"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Search, Zap } from "lucide-react";
import { EligibilityBadge, ELIGIBILITY_HINT, ManagementBadge, formatStrategy } from "./shared";
import type { EligibleService } from "@/lib/db/repositories/spot-guard/interface";

// Stable reference for the spotAutomationDisabledAccounts default — a fresh `new Set()` literal
// in the parameter list would be a new object every render.
const EMPTY_SET: Set<string> = new Set();

/**
 * Composite id the enable route parses back into a discovered target, so a service can be
 * opted in straight from this list with no separate "register" step. Must match parseTarget
 * in app/api/spot-guard/services/[id]/enable/route.ts.
 */
export function eligibleTargetId(s: EligibleService): string {
    return [s.accountId, s.region, s.clusterName ?? "", s.serviceName].join(":");
}

export function EligibleServicesTable({
    services,
    loading,
    onEnable,
    busyId,
    onSelect,
    spotAutomationDisabledAccounts = EMPTY_SET,
}: {
    services: EligibleService[];
    loading: boolean;
    onEnable: (service: EligibleService) => void;
    busyId: string | null;
    /**
     * Row activated — the page navigates to the service detail view, exactly as the Managed
     * table does. Only called for services that HAVE a registry row; see rowActionable.
     */
    onSelect?: (service: EligibleService) => void;
    /**
     * accountIds where the account's spotAutomationEnabled is false.
     *
     * ecs:UpdateService is granted to the cross-account role unconditionally (shared with the
     * Cost Scheduler), so nothing at the IAM layer stops "Enable Spot" from succeeding on one of
     * these accounts — the enable route rejects it with a 409, but by then a rolling deployment
     * confirmation dialog has already been filled out. This disables the button before that
     * happens; the 409 is still the real gate; if this list is stale for any reason, it is what
     * actually stops the request.
     */
    spotAutomationDisabledAccounts?: Set<string>;
}) {
    if (loading) {
        return (
            <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                ))}
            </div>
        );
    }

    if (services.length === 0) {
        return (
            <EmptyState
                icon={Search}
                title="No ECS services discovered yet"
                description="Spot Guard lists candidates from your inventory. Connect an AWS account and run a discovery scan, then eligible services will appear here."
            />
        );
    }

    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Service</TableHead>
                        <TableHead>Account / Region</TableHead>
                        <TableHead>Current strategy</TableHead>
                        <TableHead>Eligibility</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {services.map((s) => {
                        const id = eligibleTargetId(s);
                        const busy = busyId === id;
                        // Only the truly non-actionable case is blocked. A cluster whose providers
                        // discovery has not captured stays enabled on purpose: the mutation
                        // re-verifies against live AWS and returns an actionable 409, whereas
                        // hiding the button would strand a genuinely eligible service.
                        const blocked = s.eligibility === "needs_capacity_providers";
                        const automationDisabled = spotAutomationDisabledAccounts.has(s.accountId);

                        /**
                         * Clicking a row OPENS THE SERVICE, matching the Managed table. It used to
                         * open the enable dialog instead, so the same gesture was informational in
                         * one tab and a mutation in the other — and a stray click here put a
                         * confirmation dialog in front of you.
                         *
                         * Enabling is now solely the button's job.
                         *
                         * Only rows with a registry row can navigate: the detail view is keyed on
                         * spotServiceId, and a service Nucleus has never managed has no such row
                         * and therefore no page to open. Those rows stay inert rather than routing
                         * to a 404.
                         */
                        const rowActionable = Boolean(onSelect && s.spotServiceId);

                        return (
                            <TableRow
                                key={id}
                                role={rowActionable ? "button" : undefined}
                                tabIndex={rowActionable ? 0 : undefined}
                                aria-label={rowActionable ? `Open ${s.serviceName}` : undefined}
                                onClick={rowActionable ? () => onSelect?.(s) : undefined}
                                onKeyDown={
                                    rowActionable
                                        ? (e) => {
                                              if (e.key === "Enter") onSelect?.(s);
                                          }
                                        : undefined
                                }
                                className={rowActionable ? "cursor-pointer" : undefined}
                            >
                                <TableCell className="font-medium">
                                    <div>{s.serviceName}</div>
                                    <div className="text-xs text-muted-foreground">{s.clusterName ?? "—"}</div>
                                </TableCell>
                                <TableCell className="text-sm">
                                    <div className="font-mono text-xs">{s.accountId}</div>
                                    <div className="text-xs text-muted-foreground">{s.region}</div>
                                </TableCell>
                                <TableCell className="max-w-[20rem] text-xs text-muted-foreground">
                                    {formatStrategy(s.capacityProviderStrategy)}
                                    {s.launchType && s.capacityProviderStrategy.length === 0 && (
                                        <div className="text-xs">launchType: {s.launchType}</div>
                                    )}
                                </TableCell>
                                <TableCell>
                                    <EligibilityBadge eligibility={s.eligibility} />
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                    {/* s.managementState is always null | 'unmanaged' | 'opted_out' here — this
                                        table only ever receives the complement of the Managed tab, which the
                                        eligible query enforces with `managementState <> 'managed'`. null means
                                        Nucleus has never registered the service at all (no badge to show for
                                        that; there is no state), so it falls back to plain text. */}
                                    {s.managementState ? <ManagementBadge state={s.managementState} /> : "Not managed"}
                                </TableCell>
                                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                    <Button
                                        size="sm"
                                        disabled={busy || blocked || automationDisabled}
                                        onClick={() => onEnable(s)}
                                        title={
                                            automationDisabled
                                                ? "Spot automation is disabled for this account — enabling here would have no automated restore if interrupted. Turn on Spot Automation for the account first."
                                                : ELIGIBILITY_HINT[s.eligibility]
                                        }
                                    >
                                        <Zap className="mr-1 h-3 w-3" />
                                        Enable Spot
                                    </Button>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}
