"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
    ArrowLeft,
    Clock,
    History,
    RotateCw,
    ShieldOff,
    SlidersHorizontal,
    Tag,
    TriangleAlert,
    Zap,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountRegion } from "@/components/shared/account-region";
import { EventTimeline } from "@/components/spot-guard/event-timeline";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { ConfirmServiceDialog } from "@/components/spot-guard/confirm-service-dialog";
import { useAccount } from "@/lib/queries/accounts";
import {
    CapacityBadge,
    DEFAULT_DISPLAY_TZ,
    ManagementBadge,
    SPOT_UNSUPERVISED_HINT,
    formatDateTime,
    formatRelative,
    formatStrategy,
    spotPercentOf,
    tzDisplay,
    tzLabel,
} from "@/components/spot-guard/shared";
import {
    useDisableSpot,
    useEnableSpot,
    useSpotGuardEvents,
    useSpotGuardService,
    useSpotGuardSettings,
    useTriggerSpotRestore,
} from "@/lib/queries/spot-guard";

/**
 * How long to watch a queued restore before giving up on hearing back.
 *
 * Same window and reasoning as the list page (app/app/cost-optimization/spot-guard/page.tsx):
 * the worker runs the restore in an ephemeral ECS task, so ~60-90s is normal and three minutes is
 * comfortably past that.
 */
const RESTORE_WATCH_MS = 180_000;
const RESTORE_POLL_MS = 5_000;

/** What the confirmation dialog is currently acting on — one service, so no id to track. */
type PendingAction =
    | { mode: "enable"; managed: boolean; initialSpotPct: number | null }
    | { mode: "disable" };

/**
 * Per-service detail: current state, the restore baseline, who changed it, the actions that
 * apply to it, and the event history.
 *
 * Laid out like the Cost Scheduler detail view — stat cards, then an Overview tab holding the
 * configuration and metadata cards, then the history — so the two cost-optimization pages read
 * the same way.
 *
 * The saved baseline (desiredStrategy) is the value that decides what a restore will actually
 * apply, and it is the one piece of state you most need when asking "why did this service end
 * up here", so it sits beside the live value rather than being buried.
 */
export default function SpotGuardServiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const [tab, setTab] = useState("overview");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [action, setAction] = useState<PendingAction | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    /**
     * A restore we have queued and are waiting on, keyed to THIS service — there is only ever
     * one row on this page, unlike the list page's PendingRestore, which tracks an id because one
     * mutation object is shared across every row in the table.
     */
    const [pendingRestore, setPendingRestore] = useState<{ queuedAt: number; lastRestoreAt: string | null } | null>(
        null,
    );
    const settledRef = useRef<boolean>(false);

    const { data, isLoading, isError, error } = useSpotGuardService(id, {
        pollMs: pendingRestore ? RESTORE_POLL_MS : false,
    });
    const service = data?.service;

    // The tenant's configured report day-boundary zone, so every timestamp on this page agrees
    // with the daily report instead of a second, independent zone — same fallback the workers'
    // own reportTimezoneFor() uses when the setting is empty.
    const settings = useSpotGuardSettings();
    const reportTimezone = settings.data?.reportTimezone || DEFAULT_DISPLAY_TZ;

    // A single-account fetch, not the list page's 1000-row one — this page only ever needs one.
    // Undefined while loading is treated as "not disabled" below: the enable route's own 409 is
    // the actual gate, so a brief window where the button looks enabled before this resolves is
    // a UX rough edge, not a safety gap.
    const account = useAccount(service?.accountId);
    const automationDisabled = account.data?.spotAutomationEnabled === false;

    /**
     * Events are paginated server-side rather than taken from the detail response, which returns
     * only a fixed slice — a service with a long history silently lost the older half, and history
     * is the whole reason to open this view.
     *
     * Unfiltered: there is one events tab now. The old "Capacity changes" tab was a strict subset
     * of this list, so it made the reader check two places for one question.
     */
    const eventsQuery = useSpotGuardEvents(
        { page, limit: pageSize, serviceId: id },
        { enabled: Boolean(id) && tab === "events" },
    );
    const events = eventsQuery.data?.data ?? [];
    const eventsTotal = eventsQuery.data?.total ?? 0;

    // A skipped restore leaves the service row untouched and writes only a timeline row, so the
    // events feed is the only place the "why" exists — same reasoning as the list page's
    // pendingEvents. Independent of the events TAB above: this polls regardless of which tab is
    // open, since the outcome must be caught whichever one the user is looking at.
    const pendingEvents = useSpotGuardEvents(
        { page: 1, limit: 5, serviceId: id },
        { enabled: pendingRestore !== null, pollMs: pendingRestore ? RESTORE_POLL_MS : false },
    );

    const enableSpot = useEnableSpot();
    const disableSpot = useDisableSpot();
    const restore = useTriggerSpotRestore();
    const busy = enableSpot.isPending || disableSpot.isPending || restore.isPending;

    const settle = (fn: () => void) => {
        settledRef.current = true;
        fn();
        setPendingRestore(null);
    };

    /**
     * Resolve a queued restore from freshly polled data. Same two-way resolution as the list
     * page: the service row shows the restore landed, or a timeline row appeared (how a SKIP
     * surfaces, carrying its reason). The deadline lives in its own effect below.
     */
    useEffect(() => {
        if (!pendingRestore || settledRef.current || !service) return;

        // ONLY lastRestoreAt advancing counts as success — see the list page's identical guard
        // for why capacityState === 'spot' does not.
        if (service.lastRestoreAt && service.lastRestoreAt !== pendingRestore.lastRestoreAt) {
            settle(() => toast.success(`${service.serviceName} restored to Fargate Spot.`));
            return;
        }

        const fresh = (pendingEvents.data?.data ?? []).find(
            (e) => new Date(e.occurredAt).getTime() >= pendingRestore.queuedAt,
        );
        if (!fresh) return;

        settle(() => {
            if (fresh.eventType === "restore_failed") {
                toast.error(`${service.serviceName}: ${fresh.message}`);
            } else if (fresh.eventType === "governance_skip" || fresh.eventType === "backoff_skip") {
                toast.info(`${service.serviceName}: ${fresh.message}`);
            } else {
                toast.success(`${service.serviceName}: ${fresh.message}`);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingRestore, service?.lastRestoreAt, pendingEvents.data]);

    /** Give up watching after RESTORE_WATCH_MS. One timer per pending restore, armed once. */
    useEffect(() => {
        if (!pendingRestore) return;
        const delay = Math.max(0, pendingRestore.queuedAt + RESTORE_WATCH_MS - Date.now());
        const timer = setTimeout(() => {
            if (settledRef.current) return;
            settle(() =>
                toast.warning(
                    `Still no result for ${service?.serviceName ?? "this service"}. The pass may still be running — check the timeline.`,
                ),
            );
        }, delay);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingRestore]);

    const onRestore = async () => {
        if (!service) return;
        try {
            const result = await restore.mutateAsync({ id: service.id });
            toast.success(
                result.alreadyQueued
                    ? `A restore pass is already running — ${service.serviceName} is included.`
                    : `Restore queued for ${service.serviceName}. Safety checks still apply.`,
            );
            settledRef.current = false;
            setPendingRestore({ queuedAt: Date.now(), lastRestoreAt: service.lastRestoreAt ?? null });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to queue restore");
        }
    };

    /**
     * Seeded from the registry's own observedStrategy either way — this page has no separate
     * discovery-inventory row to prefer over it (unlike the eligible list), so it is always the
     * freshest value available. `managed` only changes the dialog's title/copy and whether the
     * result is framed as a change vs. an opt-in.
     */
    const openEnableDialog = (managed: boolean) =>
        service && setAction({ mode: "enable", managed, initialSpotPct: spotPercentOf(service.observedStrategy) });
    const openDisableDialog = () => setAction({ mode: "disable" });

    const onConfirm = async (values: {
        confirmServiceName: string;
        spotWeight?: number;
        onDemandWeight?: number;
        onDemandBase?: number;
    }) => {
        if (!action || !service) return;
        setActionError(null);
        try {
            if (action.mode === "enable") {
                await enableSpot.mutateAsync({ id: service.id, ...values });
                toast.success(`${service.serviceName} is being moved to Fargate Spot.`);
            } else {
                await disableSpot.mutateAsync({ id: service.id, confirmServiceName: values.confirmServiceName });
                toast.success(`${service.serviceName} is being moved to On-Demand.`);
            }
            setAction(null);
        } catch (err) {
            // Keep the dialog OPEN on failure — same reasoning as the list page: a 409 carries
            // actionable detail (e.g. the cluster's real capacity providers).
            setActionError(err instanceof Error ? err.message : "Request failed");
        }
    };

    const backoffActive = service?.backoffUntil ? new Date(service.backoffUntil) > new Date() : false;
    /**
     * Same two gates ServicesTable applies to its own Restore now button — mirrored rather than
     * imported because they are one-line boolean expressions over the same service shape, and
     * duplicating two lines beats threading a shared predicate through two very differently
     * shaped callers for this little logic.
     */
    const needsRestore = Boolean(service?.restorePending || service?.capacityState === "on_demand");
    const stopped = service?.desiredCount === 0;
    const restoring = pendingRestore !== null;

    return (
        <div className="space-y-6 p-6">
            {isError ? (
                <>
                    <BackLink />
                    <p className="text-sm text-red-600">
                        {error instanceof Error ? error.message : "Failed to load this service"}
                    </p>
                </>
            ) : isLoading || !service ? (
                <>
                    <BackLink />
                    <div className="space-y-3">
                        <Skeleton className="h-8 w-80" />
                        <Skeleton className="h-28 w-full" />
                    </div>
                </>
            ) : (
                <>
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex items-start gap-3">
                            <BackLink />
                            <div>
                                <h1 className="text-2xl font-semibold">{service.serviceName}</h1>
                                <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
                                    <span>{service.clusterName}</span>
                                    <span aria-hidden>·</span>
                                    {/* Same emphasis order as the list rows and Scale Sentinel. */}
                                    <AccountRegion
                                        layout="inline"
                                        accountId={service.accountId}
                                        accountName={account.data?.name}
                                        region={service.region}
                                    />
                                </p>
                            </div>
                        </div>

                        <div className="flex flex-col items-end gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <CapacityBadge state={service.capacityState} />
                                <ManagementBadge state={service.managementState} />
                            </div>

                            {/*
                             * Actions are the exact complement of the Managed / Eligible split:
                             * a managed service gets the three live-AWS actions the Managed table
                             * offers per row; anything else (opted_out, unmanaged) gets only
                             * Enable Spot, matching the single action the Eligible table offers
                             * for a not-managed service. Nothing renders both — a service is
                             * either being automated or it is not, and offering Capacity/Restore/
                             * Disable on a service Nucleus is not touching would be three buttons
                             * that do nothing until Enable Spot is clicked first.
                             */}
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                {service.managementState === "managed" ? (
                                    <>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy || automationDisabled}
                                            onClick={() => openEnableDialog(true)}
                                            title={
                                                automationDisabled
                                                    ? "Spot automation is disabled for this account — changing capacity here would have no automated restore if interrupted. Turn on Spot Automation for the account first."
                                                    : "Change how much of this service runs on Spot."
                                            }
                                        >
                                            <SlidersHorizontal className="mr-1 h-3 w-3" />
                                            Capacity
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy || !needsRestore || stopped}
                                            onClick={onRestore}
                                            title={
                                                restoring
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
                                        <Button variant="outline" size="sm" disabled={busy} onClick={openDisableDialog}>
                                            <ShieldOff className="mr-1 h-3 w-3" />
                                            Disable
                                        </Button>
                                    </>
                                ) : (
                                    <Button
                                        size="sm"
                                        disabled={busy || automationDisabled}
                                        onClick={() => openEnableDialog(false)}
                                        title={
                                            automationDisabled
                                                ? "Spot automation is disabled for this account — enabling here would have no automated restore if interrupted. Turn on Spot Automation for the account first."
                                                : "Move this service onto Fargate Spot and start automating it."
                                        }
                                    >
                                        <Zap className="mr-1 h-3 w-3" />
                                        Enable Spot
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Nothing gates a service already enabled before automation was turned off
                        for its account — only a NEW enable/capacity action is blocked above. A
                        service already on Spot when that happens keeps running exactly as before,
                        with the hourly restore scan and the interruption handler both silently
                        skipping its account from here on — recorded only as a routine timeline
                        row, no Slack post. This is the only proactive signal for that. */}
                    {service.managementState === "managed" &&
                        automationDisabled &&
                        service.capacityState !== "on_demand" && (
                            // Amber, matching every other "worth knowing, nothing is broken"
                            // signal in this domain (backoff-paused, restore-paused) — this is
                            // not the destructive/red tier, since AWS itself is not failing here.
                            <Alert className="border-amber-300 bg-amber-50/50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-400 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-500">
                                <TriangleAlert className="h-4 w-4" />
                                <AlertDescription className="text-amber-800 dark:text-amber-400">
                                    {SPOT_UNSUPERVISED_HINT}
                                </AlertDescription>
                            </Alert>
                        )}

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <StatCard
                            title="Interruptions"
                            value={String(service.interruptionCount)}
                            hint={`${service.placementFailureCount} capacity unavailable`}
                            icon={Clock}
                            accent="text-sky-600"
                        />
                        <StatCard
                            title="Fallbacks / Restores"
                            value={`${service.fallbackCount} / ${service.restoreCount}`}
                            hint={
                                service.lastRestoreAt
                                    ? `Last restore ${formatRelative(service.lastRestoreAt)}`
                                    : "No restore recorded yet"
                            }
                            icon={RotateCw}
                            accent="text-emerald-600"
                        />
                        <StatCard
                            title="Consecutive failures"
                            value={String(service.consecutiveFailures)}
                            hint={
                                backoffActive
                                    ? `Automated restore paused until ${formatDateTime(service.backoffUntil, reportTimezone)} ${tzLabel(reportTimezone)}`
                                    : "Automated restore is not backed off"
                            }
                            icon={TriangleAlert}
                            accent={
                                service.consecutiveFailures > 0 ? "text-amber-600" : "text-muted-foreground"
                            }
                        />
                    </div>

                    <Tabs
                        value={tab}
                        onValueChange={(v) => {
                            setTab(v);
                            setPage(1);
                        }}
                    >
                        <TabsList>
                            <TabsTrigger value="overview">Overview</TabsTrigger>
                            <TabsTrigger value="events">All events</TabsTrigger>
                        </TabsList>

                        <TabsContent value="overview" className="mt-4 space-y-4">
                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                                <Card>
                                    <CardHeader>
                                        <CardTitle className="flex items-center text-base">
                                            <SlidersHorizontal className="mr-2 h-4 w-4" />
                                            Capacity Configuration
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-3 text-sm">
                                        <Row
                                            label="Running now"
                                            value={formatStrategy(service.observedStrategy)}
                                            hint={
                                                service.strategyFromInventory
                                                    ? "From the last discovery scan, not a live read"
                                                    : service.observedAt
                                                      ? `Observed ${formatRelative(service.observedAt)}`
                                                      : undefined
                                            }
                                        />
                                        {/* The baseline is what a restore returns to. Showing it beside the
                                            live value makes drift — and a deliberate 50/50 split — visible.
                                            The hint is management-state-aware: claiming "Restore now and the
                                            hourly job return this service to X" was flatly false once a
                                            service is opted_out or unmanaged — neither ever touches it, and
                                            now there is no Restore now button on the page to even imply it. */}
                                        <Row
                                            label="Restore baseline"
                                            value={formatStrategy(service.desiredStrategy)}
                                            hint={
                                                service.managementState === "managed"
                                                    ? "What “Restore now” and the hourly job return this service to"
                                                    : "Recorded from when this service was last managed. Automation is off, so nothing restores it to this — use Enable Spot above to resume."
                                            }
                                        />
                                        {/* Never print "? running". Task counts are only recorded when Spot
                                            Guard last did a live describe, so on an older row the running
                                            count can be genuinely unknown — in which case say what IS known
                                            rather than showing a placeholder that looks like a defect. */}
                                        <Row
                                            label="Tasks"
                                            value={
                                                service.runningCount != null && service.desiredCount != null
                                                    ? `${service.runningCount} running / ${service.desiredCount} desired`
                                                    : service.desiredCount != null
                                                      ? `${service.desiredCount} desired`
                                                      : "—"
                                            }
                                            hint={
                                                service.runningCount == null && service.desiredCount != null
                                                    ? "Running count recorded on the next capacity action or hourly pass"
                                                    : undefined
                                            }
                                        />
                                    </CardContent>
                                </Card>

                                {/* Who changed this and when. Spot Guard has always written these
                                    columns; nothing rendered them, so answering "who put this on
                                    Spot?" meant opening the audit log. */}
                                <Card>
                                    <CardHeader>
                                        <CardTitle className="flex items-center text-base">
                                            <Tag className="mr-2 h-4 w-4" />
                                            Service Metadata
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <Field
                                                label="Created"
                                                value={formatDateTime(service.createdAt, reportTimezone)}
                                            />
                                            <Field
                                                label="Last Updated"
                                                value={formatDateTime(service.updatedAt, reportTimezone)}
                                            />
                                            <Field label="Created By" value={service.createdBy} />
                                            <Field label="Last Modified By" value={service.updatedBy} />
                                        </div>
                                        <p className="mt-4 text-xs text-muted-foreground">
                                            Timestamps are {tzDisplay(reportTimezone)}. Set under{" "}
                                            <Link href="/app/cost-optimization/spot-guard/settings" className="underline">
                                                Spot Guard settings
                                            </Link>
                                            .
                                        </p>
                                    </CardContent>
                                </Card>
                            </div>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center text-base">
                                        <History className="mr-2 h-4 w-4" />
                                        Fallback &amp; Restore History
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                        <Field label="Last fallback" value={formatRelative(service.lastFallbackAt)} />
                                        <Field label="Last restore" value={formatRelative(service.lastRestoreAt)} />
                                        <Field
                                            label="Last restore attempt"
                                            value={formatRelative(service.lastRestoreAttemptAt)}
                                        />
                                        <Field
                                            label="Restore pending"
                                            value={service.restorePending ? "Yes" : "No"}
                                            sub={
                                                service.restorePending
                                                    ? "Queued for the next restore pass"
                                                    : undefined
                                            }
                                        />
                                    </div>
                                </CardContent>
                            </Card>
                        </TabsContent>

                        <TabsContent value="events" className="mt-4 space-y-4">
                            {eventsQuery.isError ? (
                                <p className="text-sm text-red-600">Failed to load events for this service.</p>
                            ) : (
                                <>
                                    <EventTimeline events={events} loading={eventsQuery.isLoading} />
                                    <PaginationBar
                                        currentPage={page}
                                        totalItems={eventsTotal}
                                        pageSize={pageSize}
                                        onPageChange={setPage}
                                        onPageSizeChange={(size) => {
                                            setPageSize(size);
                                            setPage(1);
                                        }}
                                        itemLabel="events"
                                    />
                                </>
                            )}
                        </TabsContent>
                    </Tabs>

                    {action && (
                        <ConfirmServiceDialog
                            open
                            onOpenChange={(open) => {
                                if (!open) {
                                    setAction(null);
                                    setActionError(null);
                                }
                            }}
                            mode={action.mode}
                            managed={action.mode === "enable" ? action.managed : false}
                            initialSpotPct={action.mode === "enable" ? action.initialSpotPct : null}
                            serviceName={service.serviceName}
                            clusterName={service.clusterName}
                            accountId={service.accountId}
                            region={service.region}
                            pending={enableSpot.isPending || disableSpot.isPending}
                            error={actionError}
                            onConfirm={onConfirm}
                        />
                    )}
                </>
            )}
        </div>
    );
}

function BackLink() {
    return (
        <Button variant="outline" size="sm" asChild>
            <Link href="/app/cost-optimization/spot-guard">
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back to Spot Guard
            </Link>
        </Button>
    );
}

function StatCard({
    title,
    value,
    hint,
    icon: Icon,
    accent,
}: {
    title: string;
    value: string;
    hint: string;
    icon: React.ComponentType<{ className?: string }>;
    accent: string;
}) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
                <Icon className={`h-4 w-4 ${accent}`} />
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-semibold">{value}</div>
                <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
            </CardContent>
        </Card>
    );
}

/** Stacked label/value, the shape the Cost Scheduler metadata card uses. */
function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="space-y-1">
            <span className="block text-sm font-medium">{label}</span>
            <p className="break-all text-sm text-muted-foreground">{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
    );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{label}</span>
            <span className="text-right">
                <span className="font-mono text-xs">{value}</span>
                {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
            </span>
        </div>
    );
}
