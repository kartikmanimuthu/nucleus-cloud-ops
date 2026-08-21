"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { RefreshCw, Settings, SlidersHorizontal, Zap } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccounts } from "@/lib/queries/accounts";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { DEFAULT_DISPLAY_TZ, spotPercentOf } from "@/components/spot-guard/shared";
import {
    CAPACITY_SEGMENTS,
    activeCapacitySegment,
    anyFilterActive,
    hiddenFilterCount,
} from "@/components/spot-guard/filter-state";
import { SummaryCards, type SummaryCardAction } from "@/components/spot-guard/summary-cards";
import { EventTimeline } from "@/components/spot-guard/event-timeline";
import { HoursTable } from "@/components/spot-guard/hours-table";
import { ServicesTable } from "@/components/spot-guard/services-table";
import { EligibleServicesTable, eligibleTargetId } from "@/components/spot-guard/eligible-services-table";
import { ConfirmServiceDialog } from "@/components/spot-guard/confirm-service-dialog";
import { SyncAccountsDialog } from "@/components/inventory/sync-accounts-dialog";
import {
    useDisableSpot,
    useEnableSpot,
    useSpotGuardEligible,
    useSpotGuardEvents,
    useSpotGuardFacets,
    useSpotGuardReport,
    useSpotGuardServices,
    useSpotGuardSettings,
    useSpotGuardSummary,
    useTriggerSpotRestore,
} from "@/lib/queries/spot-guard";
import type { ServiceListFilters } from "@/lib/queries/spot-guard";
import { queryKeys } from "@/lib/queries/query-keys";
import type { EligibleService, SpotGuardService } from "@/lib/db/repositories/spot-guard/interface";

const DEFAULT_PAGE_SIZE = 25;

/**
 * Every KPI card resolves into one of these, so all four clicks feel the same: the page below
 * changes, the shared pagination bar follows, and nothing opens on top of the page.
 */
const TABS = ["managed", "eligible", "interruptions", "hours"] as const;
type TabKey = (typeof TABS)[number];

/** Which tabs the search box and filter popover actually apply to. */
const isServiceTab = (t: TabKey) => t === "managed" || t === "eligible";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long to watch a queued restore before giving up on hearing back.
 *
 * A restore is enqueued, picked up by the workers, and executed in an ephemeral ECS Fargate
 * task, so ~60-90s is normal. Three minutes is comfortably past that; beyond it something is
 * genuinely wrong and saying so is better than spinning forever.
 */
const RESTORE_WATCH_MS = 180_000;
const RESTORE_POLL_MS = 5_000;

/** A restore we have queued and are waiting on. */
type PendingRestore = { id: string; serviceName: string; queuedAt: number; lastRestoreAt: string | null };

/** Filter dropdown with a built-in "All" option. Mirrors the right-sizing page's control. */
function FilterSelect({
    label,
    value,
    onChange,
    options,
    className = "w-44",
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: [string, string][];
    /** Overridden to full width when stacked inside the "More filters" popover. */
    className?: string;
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className={className} aria-label={`Filter by ${label.toLowerCase()}`}>
                <SelectValue placeholder={label} />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">{label}: All</SelectItem>
                {options.map(([v, text]) => (
                    <SelectItem key={v} value={v}>
                        {text}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/** One labelled row inside the "More filters" popover. */
function MoreFilterRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}


/** What the confirmation dialog is currently acting on. */
type PendingAction =
    | {
          mode: "enable";
          id: string;
          serviceName: string;
          clusterName?: string | null;
          accountId: string;
          region: string;
          /** Already managed: this is a capacity change, not an opt-in. */
          managed?: boolean;
          /** Current Spot share, so the dialog opens on the real value rather than the default. */
          initialSpotPct?: number | null;
      }
    | { mode: "disable"; id: string; serviceName: string; clusterName?: string | null; accountId: string; region: string };

function SpotGuardPageInner() {
    const searchParams = useSearchParams();
    const [tab, setTab] = useState<TabKey>(() => {
        const requested = searchParams.get("tab") as TabKey | null;
        return requested && TABS.includes(requested) ? requested : "managed";
    });
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
    const [action, setAction] = useState<PendingAction | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    // Same dialog Inventory's own "Sync Now" opens — reused as-is, not forked, so the two
    // pages behave identically rather than drifting into two subtly different sync flows.
    const [syncDialogOpen, setSyncDialogOpen] = useState(false);

    // Only one at a time, deliberately: the restore job carries a per-tenant singletonKey, so a
    // second click joins the pass already queued rather than starting another.
    const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);

    // "all" rather than "" so the Select has a real value to bind to; mapped to undefined below,
    // which is what the API treats as "no filter".
    const [accountFilter, setAccountFilter] = useState("all");
    const [regionFilter, setRegionFilter] = useState("all");
    const [clusterFilter, setClusterFilter] = useState("all");
    const [capacityFilter, setCapacityFilter] = useState("all");

    /**
     * Lower bound for the Interruptions tab, matching the card's own 24h window (the summary
     * counts events with occurredAt >= now-24h).
     *
     * Anchored once per mount rather than recomputed inline: this string is part of the events
     * query key, so a fresh `Date.now()` on every render would produce a new key every render and
     * refetch in a loop.
     */
    const [interruptionsSince] = useState(() => new Date(Date.now() - DAY_MS).toISOString());
    const router = useRouter();

    // Invalidates the whole domain, so whichever tab is open refetches along with the KPI cards.
    // `refreshing` only drives the spinner; the queries keep their own loading state.
    const queryClient = useQueryClient();
    const [refreshing, setRefreshing] = useState(false);
    const refreshAll = async () => {
        setRefreshing(true);
        try {
            await queryClient.invalidateQueries({ queryKey: queryKeys.spotGuard.all });
        } finally {
            setRefreshing(false);
        }
    };
    const noneIfAll = (v: string) => (v === "all" ? undefined : v);

    const filterState = {
        account: accountFilter,
        region: regionFilter,
        cluster: clusterFilter,
        capacity: capacityFilter,
    };
    const filtersActive = anyFilterActive(filterState);
    const hiddenCount = hiddenFilterCount(filterState);

    const clearFilters = () => {
        setAccountFilter("all");
        setRegionFilter("all");
        setClusterFilter("all");
        setCapacityFilter("all");
        setPage(1);
    };

    // The tenant's configured report day-boundary zone, threaded into ServicesTable's audit
    // line so its dates agree with the daily report instead of a second, independent zone.
    // Empty until set — same "" the settings form itself treats as unset — so this falls back
    // to DEFAULT_DISPLAY_TZ (UTC), exactly matching the workers' own reportTimezoneFor().
    const settings = useSpotGuardSettings();
    const reportTimezone = settings.data?.reportTimezone || DEFAULT_DISPLAY_TZ;

    // The list route already accepts account/region/capacityState/managementState — only the
    // controls were missing, so this needs no API change.
    const summary = useSpotGuardSummary();
    const managed = useSpotGuardServices(
        {
            page,
            limit: pageSize,
            search,
            accountId: noneIfAll(accountFilter),
            region: noneIfAll(regionFilter),
            clusterName: noneIfAll(clusterFilter),
            capacityState: noneIfAll(capacityFilter) as ServiceListFilters["capacityState"],
            // Pinned, not a filter: this tab is the managed services, and Eligible is its exact
            // complement. The registry also holds 'unmanaged' and 'opted_out' rows, which used to
            // show up here and made "Managed" a list of things that were not managed.
            managementState: "managed",
        },
        { pollWhilePending: pendingRestore !== null },
    );
    const eligible = useSpotGuardEligible({
        page,
        limit: pageSize,
        search,
        accountId: noneIfAll(accountFilter),
        region: noneIfAll(regionFilter),
    });

    // Server-paginated: the events route already accepts page/limit/since and returns meta.total.
    const interruptions = useSpotGuardEvents(
        { page, limit: pageSize, eventType: "interruption", since: interruptionsSince },
        { enabled: tab === "interruptions" },
    );

    // NOT server-paginated: /api/spot-guard/report aggregates task sessions and returns the whole
    // window in one payload, so the rows are sliced client-side below.
    const report = useSpotGuardReport(undefined, { enabled: tab === "hours" });
    const hoursRows = useMemo(() => report.data?.rows ?? [], [report.data]);
    const pagedHoursRows = useMemo(
        () => hoursRows.slice((page - 1) * pageSize, page * pageSize),
        [hoursRows, page, pageSize],
    );

    // Populate the account filter from the tenant's real account list rather than from whatever
    // happens to be on the current page — otherwise filtering to an account with no rows on
    // page 1 would remove its own option.
    const facets = useSpotGuardFacets();
    const accounts = useAccounts({ limit: 1000, page: 1 });
    // Same filter Inventory's own Sync Now uses for its account picker — only accounts you
    // could actually sync are offered, matching what that dialog shows there.
    const syncableAccounts = useAccounts({ statusFilter: "active", connectionFilter: "connected", limit: 1000 });
    // accountId -> friendly name, for the AccountRegion emphasis block. Reuses the
    // accounts query already loaded above rather than issuing a second one.
    const accountNameById = useMemo(
        () => new Map((accounts.data?.accounts ?? []).map((a) => [a.accountId, a.name])),
        [accounts.data?.accounts]
    );
    const accountOptions = useMemo<[string, string][]>(
        () =>
            (accounts.data?.accounts ?? []).map((a) => [
                a.accountId,
                a.name ? `${a.accountId} · ${a.name}` : a.accountId,
            ]),
        [accounts.data],
    );
    // Reuses the same fetch as accountOptions above — no second network call. Threaded into both
    // tables so "Enable Spot" / "Capacity" disable themselves before the enable route's own 409,
    // rather than after a filled-out confirmation dialog.
    const spotAutomationDisabledAccounts = useMemo(() => {
        const disabled = new Set<string>();
        for (const a of accounts.data?.accounts ?? []) {
            if (!a.spotAutomationEnabled) disabled.add(a.accountId);
        }
        return disabled;
    }, [accounts.data]);

    // A skipped restore leaves the service row untouched and writes only a timeline row, so the
    // events feed is the only place the "why" exists. Polled solely while we are waiting.
    const pendingEvents = useSpotGuardEvents(
        { page: 1, limit: 5, serviceId: pendingRestore?.id },
        { enabled: pendingRestore !== null, pollMs: pendingRestore ? RESTORE_POLL_MS : false },
    );

    const enableSpot = useEnableSpot();
    const disableSpot = useDisableSpot();
    const restore = useTriggerSpotRestore();

    /**
     * The row whose "Restore now" request is in flight.
     *
     * Tracked separately from `action` on purpose. `action` is what the confirmation DIALOG is
     * acting on, and ConfirmServiceDialog is mounted whenever action !== null with `open` hard-set
     * — so borrowing `action` to mark a row busy (which this page used to do) flashed the
     * Disable-Spot dialog open for the duration of the request and then tore it down, complete
     * with its text and number inputs. Restore takes no confirmation, so it must never touch
     * `action`.
     */
    const [restoreClickId, setRestoreClickId] = useState<string | null>(null);

    const busyId = useMemo(
        () =>
            restore.isPending && restoreClickId
                ? restoreClickId
                : enableSpot.isPending || disableSpot.isPending
                  ? (action?.id ?? null)
                  : null,
        [enableSpot.isPending, disableSpot.isPending, restore.isPending, restoreClickId, action],
    );

    // Guards against toasting the same outcome twice: the effect below re-runs on every poll,
    // and both the service row and the events feed can satisfy it in the same tick.
    const settledRef = useRef<string | null>(null);

    const settle = (p: PendingRestore, fn: () => void) => {
        settledRef.current = p.id;
        fn();
        setPendingRestore(null);
    };

    /**
     * Resolve a queued restore from freshly polled data.
     *
     * Two ways it can resolve here: the service row shows the restore landed, or a timeline row
     * appeared — which is how a SKIP surfaces, carrying its reason. The deadline lives in its own
     * effect below.
     *
     * Driven purely by query data. This effect must NEVER write to pendingRestore except to clear
     * it: pendingRestore is its own dependency, so replacing it with a fresh copy (which an
     * earlier version did, as a crude re-evaluation timer) re-triggered the effect on a loop and
     * re-rendered the page every few seconds for the whole watch window — enough to dismiss any
     * open dropdown and to interrupt typing. The polling queries already supply the cadence.
     */
    useEffect(() => {
        if (!pendingRestore || settledRef.current === pendingRestore.id) return;

        // ONLY lastRestoreAt advancing counts as success. capacityState === 'spot' does not:
        // a service that is already on Spot has it before the click, so treating it as success
        // reported a restore that never happened and cleared the pending state on the first
        // frame. When the service is already on Spot the honest outcome is the worker's
        // 'nothing_to_do' timeline row, which the events branch below picks up.
        const row = managed.data?.data.find((s) => s.id === pendingRestore.id);
        if (row?.lastRestoreAt && row.lastRestoreAt !== pendingRestore.lastRestoreAt) {
            settle(pendingRestore, () =>
                toast.success(`${pendingRestore.serviceName} restored to Fargate Spot.`),
            );
            return;
        }

        const fresh = (pendingEvents.data?.data ?? []).find(
            (e) => new Date(e.occurredAt).getTime() >= pendingRestore.queuedAt,
        );
        if (!fresh) return;

        settle(pendingRestore, () => {
            if (fresh.eventType === "restore_failed") {
                toast.error(`${pendingRestore.serviceName}: ${fresh.message}`);
            } else if (fresh.eventType === "governance_skip" || fresh.eventType === "backoff_skip") {
                // Not an error — the worker deliberately declined, and the reason is precisely
                // the answer the user clicked for.
                toast.info(`${pendingRestore.serviceName}: ${fresh.message}`);
            } else {
                toast.success(`${pendingRestore.serviceName}: ${fresh.message}`);
            }
        });
    }, [pendingRestore, managed.data, pendingEvents.data]);

    /**
     * Give up watching after RESTORE_WATCH_MS.
     *
     * One timer per pending restore, armed once. Depends only on pendingRestore — which now
     * changes identity solely when a restore is queued or cleared — so this never re-arms on a
     * poll and never causes a render of its own until it actually fires.
     */
    useEffect(() => {
        if (!pendingRestore) return;
        const delay = Math.max(0, pendingRestore.queuedAt + RESTORE_WATCH_MS - Date.now());
        const timer = setTimeout(() => {
            if (settledRef.current === pendingRestore.id) return;
            settle(pendingRestore, () =>
                toast.warning(
                    `Still no result for ${pendingRestore.serviceName}. The pass may still be running — check the timeline.`,
                ),
            );
        }, delay);
        return () => clearTimeout(timer);
    }, [pendingRestore]);

    /**
     * A KPI click always resolves in place: it selects the tab that holds that card's detail and
     * resets to page 1. Nothing opens over the page, so all four cards behave identically.
     *
     * The service-count cards land on Managed with the matching capacity filter applied, because
     * those rows are already on screen. Interruptions and hours have no representation in the
     * services table, so each has its own tab.
     */
    const onSummarySelect = (action: SummaryCardAction) => {
        setPage(1);
        if (action === "on_spot" || action === "in_fallback") {
            setTab("managed");
            setCapacityFilter(action === "on_spot" ? "spot" : "on_demand");
            return;
        }
        setTab(action === "interruptions" ? "interruptions" : "hours");
    };

    const openEnable = (s: EligibleService) =>
        setAction({
            mode: "enable",
            id: eligibleTargetId(s),
            serviceName: s.serviceName,
            clusterName: s.clusterName,
            accountId: s.accountId,
            region: s.region,
            managed: s.managementState === "managed",
            // Prefer the REGISTRY strategy over the inventory one. The inventory column is only as
            // fresh as the last nightly discovery scan, so for an already-managed service it can be
            // hours stale — seeding from it opened a 50/50 service at 100% and one click reverted
            // the blend to full Spot.
            initialSpotPct: spotPercentOf(s.registryStrategy ?? s.capacityProviderStrategy),
        });

    /**
     * Change the Spot share of a service Nucleus already manages.
     *
     * Uses the same dialog and the same enable mutation — re-applying a strategy IS the change, and
     * enableSpot resolves the existing registry row rather than rejecting it. Seeded from the
     * observed strategy so opening it on a 30% service shows 30, not the new-service default.
     */
    const openCapacity = (s: SpotGuardService) =>
        setAction({
            mode: "enable",
            id: s.id,
            serviceName: s.serviceName,
            clusterName: s.clusterName,
            accountId: s.accountId,
            region: s.region,
            managed: true,
            initialSpotPct: spotPercentOf(s.observedStrategy),
        });

    const openDisable = (s: SpotGuardService) =>
        setAction({
            mode: "disable",
            id: s.id,
            serviceName: s.serviceName,
            clusterName: s.clusterName,
            accountId: s.accountId,
            region: s.region,
        });

    const onRestore = async (s: SpotGuardService) => {
        // Must NOT go through setAction — see restoreClickId. Restore is the one action with no
        // confirmation step, so opening the confirmation dialog here (even for a few hundred
        // milliseconds) is pure noise the user has to watch appear and vanish.
        setRestoreClickId(s.id);
        try {
            const result = await restore.mutateAsync({ id: s.id });
            // The route distinguishes "queued" from "already running" so the toast can be
            // honest instead of claiming a new pass every time.
            toast.success(
                result.alreadyQueued
                    ? `A restore pass is already running — ${s.serviceName} is included.`
                    : `Restore queued for ${s.serviceName}. Safety checks still apply.`,
            );
            // Start watching for the outcome. Capture lastRestoreAt as the "before" value so a
            // restore that lands can be told apart from one that has not happened yet — a bare
            // truthy check would match a restore from last week and report success instantly.
            settledRef.current = null;
            setPendingRestore({
                id: s.id,
                serviceName: s.serviceName,
                queuedAt: Date.now(),
                lastRestoreAt: s.lastRestoreAt ?? null,
            });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to queue restore");
        } finally {
            setRestoreClickId(null);
        }
    };

    const onConfirm = async (values: {
        confirmServiceName: string;
        spotWeight?: number;
        onDemandWeight?: number;
        onDemandBase?: number;
    }) => {
        if (!action) return;
        setActionError(null);
        try {
            if (action.mode === "enable") {
                await enableSpot.mutateAsync({ id: action.id, ...values });
                toast.success(`${action.serviceName} is being moved to Fargate Spot.`);
            } else {
                await disableSpot.mutateAsync({ id: action.id, confirmServiceName: values.confirmServiceName });
                toast.success(`${action.serviceName} is being moved to On-Demand.`);
            }
            setAction(null);
        } catch (err) {
            // Keep the dialog OPEN on failure: a 409 carries actionable detail (e.g. the
            // cluster's real capacity providers) that vanishes if the dialog closes.
            setActionError(err instanceof Error ? err.message : "Request failed");
        }
    };

    // One pagination bar drives whichever tab is open, so it reads its total from that tab.
    const { total, itemLabel } =
        tab === "managed"
            ? { total: managed.data?.total ?? 0, itemLabel: "services" }
            : tab === "eligible"
              ? { total: eligible.data?.total ?? 0, itemLabel: "services" }
              : tab === "interruptions"
                ? { total: interruptions.data?.total ?? 0, itemLabel: "interruptions" }
                : { total: hoursRows.length, itemLabel: "services" };

    return (
        <div className="space-y-6 p-6">
            <PageHeader
                icon={Zap}
                title="Spot Guard"
                description="Run ECS services on Fargate Spot safely — automatic fallback to On-Demand when Spot capacity runs out, and automatic restore when it returns."
                actions={
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing}>
                            <RefreshCw className={`mr-1 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                            Refresh
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                            <Link href="/app/cost-optimization/spot-guard/settings">
                                <Settings className="mr-1 h-3 w-3" />
                                Settings
                            </Link>
                        </Button>
                        {/* Identical to Inventory's own Sync Now: same component, same
                            /api/inventory/sync call, same "queue an AWS scan" behavior. Eligible
                            services come from that scan's output (inventory_resources), not
                            anything Spot Guard scans itself, so this is the same action, not a
                            new one — just offered from a second page.
                            size="sm" (Inventory's own button is default-sized, but every other
                            action in THIS header is "sm" — matching the row it actually sits in
                            beats matching Inventory's unrelated row). */}
                        <Button size="sm" onClick={() => setSyncDialogOpen(true)}>
                            <RefreshCw className="mr-1 h-3 w-3" />
                            Sync Now
                        </Button>
                    </div>
                }
            />

            <SummaryCards summary={summary.data ?? null} loading={summary.isLoading} onSelect={onSummarySelect} />

            <Tabs
                value={tab}
                onValueChange={(next) => {
                    setTab(next as TabKey);
                    setPage(1);
                }}
            >
                <TabsList>
                    <TabsTrigger value="managed">Managed</TabsTrigger>
                    <TabsTrigger value="eligible">Eligible</TabsTrigger>
                    <TabsTrigger value="interruptions">Interruptions</TabsTrigger>
                    <TabsTrigger value="hours">Spot Hours</TabsTrigger>
                </TabsList>

                {/* Card-wrapped filter block, matching the Cost Scheduler page so the two
                    cost-optimization screens read the same way.

                    Service tabs only: none of these controls reach the events feed or the
                    hours report, and leaving them on screen would imply they do. */}
                {isServiceTab(tab) && (
                    <Card className="mt-4">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">Filters</CardTitle>
                            <CardDescription>Search and filter services to find what you need</CardDescription>
                        </CardHeader>
                        <CardContent>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                aria-label="Search services"
                                placeholder="Search by service or cluster…"
                                value={search}
                                onChange={(e) => {
                                    setSearch(e.target.value);
                                    setPage(1);
                                }}
                                className="sm:max-w-xs"
                            />
                            {/* Capacity is the question people actually arrive with ("what is on Spot
                                right now?"), so it gets one click instead of a dropdown. Registry-only,
                                like the Cluster and Managed filters, hence the managed-tab guard. */}
                            {tab === "managed" && (
                                <ToggleGroup
                                    type="single"
                                    variant="outline"
                                    size="sm"
                                    value={activeCapacitySegment(capacityFilter)}
                                    onValueChange={(v) => {
                                        // Radix allows deselecting the active item, which would leave
                                        // no segment set. Treat that as a no-op rather than an
                                        // undefined fourth state.
                                        if (!v) return;
                                        setCapacityFilter(v);
                                        setPage(1);
                                    }}
                                    aria-label="Filter by capacity"
                                >
                                    {CAPACITY_SEGMENTS.map(([value, text]) => (
                                        <ToggleGroupItem key={value} value={value} aria-label={text}>
                                            {text}
                                        </ToggleGroupItem>
                                    ))}
                                </ToggleGroup>
                            )}
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button variant="outline" size="sm">
                                        <SlidersHorizontal className="mr-1 h-3 w-3" />
                                        More filters
                                        {hiddenCount > 0 && (
                                            <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                                                {hiddenCount}
                                            </span>
                                        )}
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent align="end" className="w-72 space-y-3">
                                    <MoreFilterRow label="Account">
                                        <FilterSelect
                                            label="Account"
                                            className="w-full"
                                            value={accountFilter}
                                            onChange={(v) => {
                                                setAccountFilter(v);
                                                setPage(1);
                                            }}
                                            options={accountOptions}
                                        />
                                    </MoreFilterRow>
                                    <MoreFilterRow label="Region">
                                        <FilterSelect
                                            label="Region"
                                            className="w-full"
                                            value={regionFilter}
                                            onChange={(v) => {
                                                setRegionFilter(v);
                                                setPage(1);
                                            }}
                                            options={(facets.data?.regions ?? []).map((r) => [r, r] as [string, string])}
                                        />
                                    </MoreFilterRow>
                                    {tab === "managed" && (
                                        <>
                                            <MoreFilterRow label="Cluster">
                                                <FilterSelect
                                                    label="Cluster"
                                                    className="w-full"
                                                    value={clusterFilter}
                                                    onChange={(v) => {
                                                        setClusterFilter(v);
                                                        setPage(1);
                                                    }}
                                                    options={(facets.data?.clusters ?? []).map(
                                                        (c) => [c, c] as [string, string],
                                                    )}
                                                />
                                            </MoreFilterRow>
                                            <MoreFilterRow label="Capacity">
                                                {/* Same state as the segmented control above. Kept so
                                                    Mixed and Unknown stay reachable — dropping them
                                                    would have removed real filtering, not just moved
                                                    it. */}
                                                <FilterSelect
                                                    label="Capacity"
                                                    className="w-full"
                                                    value={capacityFilter}
                                                    onChange={(v) => {
                                                        setCapacityFilter(v);
                                                        setPage(1);
                                                    }}
                                                    options={[
                                                        ["spot", "On Spot"],
                                                        ["on_demand", "On-Demand"],
                                                        ["mixed", "Mixed"],
                                                        ["unknown", "Unknown"],
                                                    ]}
                                                />
                                            </MoreFilterRow>
                                        </>
                                    )}
                                    {filtersActive && (
                                        <Button variant="ghost" size="sm" className="w-full" onClick={clearFilters}>
                                            Clear all filters
                                        </Button>
                                    )}
                                </PopoverContent>
                            </Popover>
                        </div>
                        </CardContent>
                    </Card>
                )}

                <TabsContent value="managed" className="mt-4 space-y-4">
                    {managed.isError ? (
                        <p className="text-sm text-red-600">
                            {managed.error instanceof Error ? managed.error.message : "Failed to load services"}
                        </p>
                    ) : (
                        <ServicesTable
                            services={managed.data?.data ?? []}
                            loading={managed.isLoading}
                            onRestore={onRestore}
                            onDisable={openDisable}
                            onChangeCapacity={openCapacity}
                            busyId={busyId}
                            restoringId={pendingRestore?.id ?? null}
                            reportTimezone={reportTimezone}
                            spotAutomationDisabledAccounts={spotAutomationDisabledAccounts}
                            accountNameById={accountNameById}
                            onSelect={(s) => router.push(`/app/cost-optimization/spot-guard/${s.id}`)}
                        />
                    )}
                </TabsContent>

                <TabsContent value="eligible" className="mt-4 space-y-4">
                    {eligible.isError ? (
                        <p className="text-sm text-red-600">
                            {eligible.error instanceof Error ? eligible.error.message : "Failed to load eligible services"}
                        </p>
                    ) : (
                        <EligibleServicesTable
                            services={eligible.data?.data ?? []}
                            loading={eligible.isLoading}
                            onEnable={openEnable}
                            busyId={busyId}
                            spotAutomationDisabledAccounts={spotAutomationDisabledAccounts}
                            // Same gesture as the Managed table. spotServiceId is the registry id,
                            // which is what the detail route is keyed on; the table only calls this
                            // for rows that have one.
                            onSelect={(s) =>
                                s.spotServiceId &&
                                router.push(`/app/cost-optimization/spot-guard/${s.spotServiceId}`)
                            }
                        />
                    )}
                </TabsContent>

                <TabsContent value="interruptions" className="mt-4 space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Every Spot reclaim AWS signalled in the last 24 hours, newest first. Nucleus drains the
                        task from its load balancer before it dies.
                    </p>
                    {interruptions.isError ? (
                        <p className="text-sm text-red-600">
                            {interruptions.error instanceof Error
                                ? interruptions.error.message
                                : "Failed to load interruptions"}
                        </p>
                    ) : (
                        <EventTimeline
                            events={interruptions.data?.data ?? []}
                            loading={interruptions.isLoading}
                            emptyKind="interruptions"
                        />
                    )}
                </TabsContent>

                <TabsContent value="hours" className="mt-4 space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Time-weighted hours per service over the last 7 days. A task spanning midnight counts on
                        both days, and tasks still running are counted up to now.
                    </p>
                    {report.isError ? (
                        <p className="text-sm text-red-600">
                            {report.error instanceof Error ? report.error.message : "Failed to load the hours report"}
                        </p>
                    ) : (
                        <HoursTable
                            rows={pagedHoursRows}
                            loading={report.isLoading}
                            orphaned={report.data?.dataQuality.orphaned ?? 0}
                            inFlightSessions={report.data?.totals.inFlightSessions ?? 0}
                        />
                    )}
                </TabsContent>
            </Tabs>

            <PaginationBar
                currentPage={page}
                totalItems={total}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPage(1);
                }}
                itemLabel={itemLabel}
            />

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
                    serviceName={action.serviceName}
                    clusterName={action.clusterName}
                    accountId={action.accountId}
                    region={action.region}
                    pending={enableSpot.isPending || disableSpot.isPending}
                    error={actionError}
                    onConfirm={onConfirm}
                />
            )}

            <SyncAccountsDialog
                open={syncDialogOpen}
                onOpenChange={setSyncDialogOpen}
                accounts={syncableAccounts.data?.accounts ?? []}
                onSyncStarted={(count) => {
                    // Same wording Inventory's own callback uses.
                    toast.success(
                        count === 1
                            ? "Sync started for 1 account. It may take a few minutes to complete."
                            : `Sync started for ${count} accounts. It may take a few minutes to complete.`,
                        { duration: 5000 },
                    );
                    // Inventory's equivalent refetches its own sync-status widget; Spot Guard has
                    // no such widget, so the closest equivalent is refreshing what it does show.
                    // The scan itself is async and runs for minutes, so this will not yet reflect
                    // newly discovered services — same limitation Inventory's own callback has.
                    refreshAll();
                }}
            />
        </div>
    );
}

export default function SpotGuardPage() {
    // Suspense is required because the inner component reads useSearchParams.
    return (
        <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
            <SpotGuardPageInner />
        </Suspense>
    );
}
