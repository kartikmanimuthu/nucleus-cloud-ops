"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { RotateCw, ShieldOff, SlidersHorizontal, TriangleAlert, Zap } from "lucide-react";
import {
    CapacityBadge,
    DEFAULT_DISPLAY_TZ,
    ManagementBadge,
    SPOT_UNSUPERVISED_HINT,
    SPOT_UNSUPERVISED_LABEL,
    StrategySummary,
    formatDate,
    formatRelative,
} from "./shared";
import type { SpotGuardService } from "@/lib/db/repositories/spot-guard/interface";

/**
 * Who registered this service and when — the same line the Cost Scheduler rows carry.
 *
 * Reads createdBy rather than enabledBy: enabledBy holds only the most recent opt-in, so it
 * renames the row's creator every time someone re-enables the service. "system" is a real
 * answer here, not a gap — the observer registers services without a user.
 */
function auditLine(s: SpotGuardService, reportTimezone: string): string {
    return `Created by ${s.createdBy} • ${formatDate(s.createdAt, reportTimezone)}`;
}

// Shared with Scale Sentinel so the account/region emphasis order stays identical
// across both services and both their list and detail views.
import { AccountRegion } from "@/components/shared/account-region";

// Stable reference for the spotAutomationDisabledAccounts default — a fresh `new Set()` literal
// in the parameter list would be a new object every render.
const EMPTY_SET: Set<string> = new Set();

export function ServicesTable({
    services,
    loading,
    onRestore,
    onDisable,
    onChangeCapacity,
    busyId,
    onSelect,
    restoringId = null,
    reportTimezone = DEFAULT_DISPLAY_TZ,
    spotAutomationDisabledAccounts = EMPTY_SET,
    accountNameById,
}: {
    services: SpotGuardService[];
    loading: boolean;
    onRestore: (service: SpotGuardService) => void;
    onDisable: (service: SpotGuardService) => void;
    /** Change how much of the service runs on Spot. Re-applies a strategy to an existing row. */
    onChangeCapacity?: (service: SpotGuardService) => void;
    busyId: string | null;
    /** Row activated — the page navigates to the service detail view. */
    onSelect?: (service: SpotGuardService) => void;
    /**
     * The tenant's Spot Guard "Report timezone" setting (Settings -> Spot Guard), so the
     * "Created by … •" date agrees with the daily report's day boundary instead of a second,
     * independent zone. Defaults to DEFAULT_DISPLAY_TZ (UTC) only for a caller that has not
     * threaded the real value through yet — the list page always does.
     */
    reportTimezone?: string;
    /**
     * accountIds where spotAutomationEnabled is false. Only gates Capacity, which re-applies a
     * Spot-first strategy via the same enableSpot() path a fresh opt-in uses — the enable route
     * rejects it with a 409 either way, this just avoids a confirmation dialog that could only
     * end in that rejection. Restore now and Disable are unaffected: Disable's whole point is
     * getting a service OFF Spot, and Restore now does not change the strategy's Spot-first-ness.
     */
    spotAutomationDisabledAccounts?: Set<string>;
    /** accountId -> friendly name; absent entries fall back to the number alone. */
    accountNameById?: Map<string, string>;
    /**
     * A restore has been QUEUED for this row and we are waiting on the worker.
     *
     * Distinct from busyId, which only covers the in-flight HTTP request (milliseconds). The
     * work itself runs in an ephemeral ECS task and takes ~60-90s, and without showing that the
     * table looked idle and unchanged — which is what made a working restore look broken.
     */
    restoringId?: string | null;
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
                icon={Zap}
                title="No services under Spot Guard yet"
                description="Enable Spot on an eligible ECS service to start managing it. Nucleus will then fall it back to On-Demand when Spot capacity runs out, and restore it automatically."
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
                        <TableHead>Capacity</TableHead>
                        <TableHead>Strategy</TableHead>
                        <TableHead className="text-right">Interruptions</TableHead>
                        <TableHead>Last event</TableHead>
                        <TableHead>Managed</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {services.map((s) => {
                        const restoring = restoringId === s.id;
                        const busy = busyId === s.id || restoring;
                        /**
                         * Is there anything to restore?
                         *
                         * Mirrors the worker's own trigger — `restorePending || isFallbackState(live)`
                         * in evaluateRestore — where capacityState 'on_demand' is the persisted form
                         * of isFallbackState. Offering the action on a service already running Spot
                         * could only ever produce a 'nothing_to_do' skip, i.e. a rolling-deployment
                         * button that does nothing and then has to explain itself.
                         *
                         * restorePending is kept as an independent condition so a service whose
                         * capacityState is stale (or unknown) can still be nudged — the worker
                         * self-heals from live AWS state, so the button should not be the thing
                         * blocking that.
                         */
                        const needsRestore = s.restorePending || s.capacityState === "on_demand";
                        /**
                         * Scaled to zero — the engine's scheduler_protection gate will decline any
                         * restore (restoring would forceNewDeployment a stopped service and fight
                         * the Cost Scheduler). Offering the button anyway is the same defect as
                         * offering it to a service already on Spot: a click that can only ever
                         * produce a skip. Non-prod is shut down nightly, so this is every managed
                         * service for hours at a time, not a rare case.
                         */
                        const stopped = s.desiredCount === 0;
                        // A backoff means an automated restore is deliberately paused. Showing
                        // it prevents the "why isn't this back on Spot?" question.
                        const backoffActive = s.backoffUntil && new Date(s.backoffUntil) > new Date();
                        const automationDisabled = spotAutomationDisabledAccounts.has(s.accountId);
                        // Nothing gates a service already enabled before automation was turned
                        // off for its account — only a NEW enable/capacity action is blocked. So
                        // this can be true for a perfectly healthy-looking row: capacityState
                        // 'on_demand' means it already fell back and there is nothing at risk;
                        // 'spot', 'mixed', or 'unknown' all mean some portion is riding on Spot
                        // with nobody watching for the next interruption.
                        const unsupervisedOnSpot = automationDisabled && s.capacityState !== "on_demand";
                        return (
                            <TableRow
                                key={s.id}
                                role={onSelect ? "button" : undefined}
                                tabIndex={onSelect ? 0 : undefined}
                                onClick={onSelect ? () => onSelect(s) : undefined}
                                onKeyDown={
                                    onSelect
                                        ? (e) => {
                                              if (e.key === "Enter") onSelect(s);
                                          }
                                        : undefined
                                }
                                className={onSelect ? "cursor-pointer" : undefined}
                            >
                                <TableCell className="font-medium">
                                    <div>{s.serviceName}</div>
                                    <div className="text-xs text-muted-foreground">{s.clusterName}</div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        {auditLine(s, reportTimezone)}
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <AccountRegion
                                        accountId={s.accountId}
                                        accountName={accountNameById?.get(s.accountId)}
                                        region={s.region}
                                    />
                                </TableCell>
                                <TableCell>
                                    <CapacityBadge
                                        state={s.capacityState}
                                        desiredCount={s.desiredCount}
                                        strategy={s.observedStrategy}
                                    />
                                    {restoring && (
                                        // The row is otherwise unchanged for the ~60-90s the
                                        // worker takes, so without this the click looks ignored.
                                        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                            <Spinner className="h-3 w-3" />
                                            Restoring…
                                        </div>
                                    )}
                                    {backoffActive && (
                                        <div
                                            className="mt-1 text-xs text-amber-600"
                                            title={`Automated restore is paused after ${s.consecutiveFailures} consecutive failure(s). Use "Restore now" to bypass the backoff — every other safety check still applies.`}
                                        >
                                            Restore paused
                                        </div>
                                    )}
                                    {unsupervisedOnSpot && (
                                        <div
                                            className="mt-1 flex items-center gap-1 text-xs text-amber-600"
                                            title={SPOT_UNSUPERVISED_HINT}
                                        >
                                            <TriangleAlert className="h-3 w-3" />
                                            {SPOT_UNSUPERVISED_LABEL}
                                        </div>
                                    )}
                                </TableCell>
                                <TableCell className="max-w-[22rem]">
                                    <StrategySummary
                                        strategy={s.observedStrategy}
                                        fromInventory={s.strategyFromInventory}
                                    />
                                </TableCell>
                                <TableCell className="text-right text-sm">{s.interruptionCount}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                    {formatRelative(s.lastEventAt)}
                                </TableCell>
                                <TableCell>
                                    <ManagementBadge state={s.managementState} />
                                </TableCell>
                                {/* Buttons live inside a clickable row, so their clicks must not
                                    also navigate — otherwise Disable opens a dialog AND changes page. */}
                                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                    <div className="flex justify-end gap-2">
                                        {onChangeCapacity && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={busy || automationDisabled}
                                                onClick={() => onChangeCapacity(s)}
                                                title={
                                                    automationDisabled
                                                        ? "Spot automation is disabled for this account — changing capacity here would have no automated restore if interrupted. Turn on Spot Automation for the account first."
                                                        : "Change how much of this service runs on Spot."
                                                }
                                            >
                                                <SlidersHorizontal className="mr-1 h-3 w-3" />
                                                Capacity
                                            </Button>
                                        )}
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy || s.managementState !== "managed" || !needsRestore || stopped}
                                            onClick={() => onRestore(s)}
                                            title={
                                                s.managementState !== "managed"
                                                    ? "Only managed services are restored automatically."
                                                    : restoring
                                                      ? "A restore pass is running for this service."
                                                      : stopped
                                                        ? "Scaled to 0 tasks — nothing to restore until it scales back up."
                                                        : !needsRestore
                                                          ? "Already running on Spot — there is nothing to restore."
                                                          : "Queue an immediate restore pass. Safety checks still apply."
                                            }
                                        >
                                            {restoring ? (
                                                <Spinner className="mr-1 h-3 w-3" />
                                            ) : (
                                                <RotateCw className="mr-1 h-3 w-3" />
                                            )}
                                            {restoring ? "Restoring…" : "Restore now"}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy || s.managementState === "opted_out"}
                                            onClick={() => onDisable(s)}
                                        >
                                            <ShieldOff className="mr-1 h-3 w-3" />
                                            Disable
                                        </Button>
                                    </div>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}
