'use client';

/**
 * TanStack Query hooks for the Fargate Spot Guard domain. No client service class exists,
 * so the API fetches are inlined in the query/mutation fns — same shape as
 * lib/queries/right-sizing.ts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type {
    CapacityState,
    EligibleService,
    HoursReport,
    ManagementState,
    SpotEligibility,
    SpotGuardEvent,
    SpotGuardService,
    SpotGuardSummary,
} from '@/lib/db/repositories/spot-guard/interface';

export interface ServiceListFilters {
    page: number;
    limit: number;
    search?: string;
    accountId?: string;
    region?: string;
    clusterName?: string;
    capacityState?: CapacityState;
    managementState?: ManagementState;
}

export interface EligibleListFilters {
    page: number;
    limit: number;
    search?: string;
    accountId?: string;
    region?: string;
    eligibility?: SpotEligibility;
}

interface Paged<T> {
    data: T[];
    total: number;
}

/** Unwrap the repo-wide { success, data, meta } envelope, surfacing `error` as a throw. */
async function getJson<T>(url: string): Promise<{ data: T; total: number }> {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
        throw new Error(body?.error ?? `Request failed with ${res.status}`);
    }
    return { data: body.data as T, total: body.meta?.total ?? (Array.isArray(body.data) ? body.data.length : 0) };
}

async function postJson<T>(url: string, payload?: unknown): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
        // The API returns actionable messages for 409s (e.g. the cluster's real capacity
        // providers), so surfacing body.error verbatim is what makes the toast useful.
        throw new Error(body?.error ?? `Request failed with ${res.status}`);
    }
    return body.data as T;
}

function buildParams(filters: Record<string, string | number | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === '') continue;
        params.set(key, String(value));
    }
    return params.toString();
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * @param pollWhilePending when true, poll every few seconds.
 *
 * "Restore now" is asynchronous — it enqueues a job that the workers run in an ephemeral ECS
 * task, so the outcome lands roughly a minute after the click. Without polling the table only
 * ever refetched immediately (before anything had happened) and then never again, so the row
 * stayed stale and a restore that had actually succeeded looked like a no-op.
 *
 * Same conditional-interval shape as useAgentOpsRuns (lib/queries/agent-ops.ts:56): poll fast
 * while work is in flight, and not at all otherwise, so an idle page costs nothing.
 */
export function useSpotGuardServices(filters: ServiceListFilters, opts: { pollWhilePending?: boolean } = {}) {
    return useQuery({
        queryKey: queryKeys.spotGuard.services(filters),
        refetchInterval: opts.pollWhilePending ? 5000 : false,
        queryFn: async (): Promise<Paged<SpotGuardService>> => {
            const qs = buildParams({
                page: filters.page,
                limit: filters.limit,
                search: filters.search?.trim(),
                account: filters.accountId,
                region: filters.region,
                cluster: filters.clusterName,
                capacityState: filters.capacityState,
                managementState: filters.managementState,
            });
            const { data, total } = await getJson<SpotGuardService[]>(`/api/spot-guard/services?${qs}`);
            return { data, total };
        },
        // Keep the previous page visible while the next loads, so the table does not flash
        // empty on every filter change.
        placeholderData: (prev) => prev,
    });
}

/**
 * @param opts.pollMs poll interval; omit for no polling.
 *
 * Polling is used while the detail page's own "Restore now" is in flight, for the same reason
 * useSpotGuardServices supports it: the outcome lands roughly a minute after the click, in an
 * ephemeral ECS task, and a query that only refetches once (on the mutation's onSuccess) would
 * show the pre-restore row for that whole window.
 */
export function useSpotGuardService(id: string | null, opts: { pollMs?: number | false } = {}) {
    return useQuery({
        queryKey: queryKeys.spotGuard.detail(id ?? 'none'),
        refetchInterval: opts.pollMs ?? false,
        queryFn: async () => {
            const { data } = await getJson<{ service: SpotGuardService; events: SpotGuardEvent[] }>(
                `/api/spot-guard/services/${id}`,
            );
            return data;
        },
        enabled: Boolean(id),
    });
}

export function useSpotGuardEligible(filters: EligibleListFilters) {
    return useQuery({
        queryKey: queryKeys.spotGuard.eligible(filters),
        queryFn: async (): Promise<Paged<EligibleService>> => {
            const qs = buildParams({
                page: filters.page,
                limit: filters.limit,
                search: filters.search?.trim(),
                account: filters.accountId,
                region: filters.region,
                eligibility: filters.eligibility,
            });
            const { data, total } = await getJson<EligibleService[]>(`/api/spot-guard/eligible?${qs}`);
            return { data, total };
        },
        placeholderData: (prev) => prev,
    });
}

/**
 * @param opts.enabled skip the request entirely (default true).
 * @param opts.pollMs  poll interval; omit for no polling.
 *
 * Polling is used while a manual restore is in flight: a SKIPPED restore writes only a timeline
 * row (the service row's timestamps do not move), so this query is the only way the UI can learn
 * that the worker declined, and why.
 */
export function useSpotGuardEvents(
    filters: {
        page: number;
        limit: number;
        serviceId?: string;
        eventType?: string;
        eventTypes?: string[];
        /** ISO timestamp; only events at or after it. Keep it stable across renders — it is part
         *  of the query key, so a value recomputed inline (`new Date()`) refetches every render. */
        since?: string;
    },
    opts: { enabled?: boolean; pollMs?: number | false } = {},
) {
    return useQuery({
        queryKey: queryKeys.spotGuard.events(filters),
        enabled: opts.enabled ?? true,
        refetchInterval: opts.pollMs ?? false,
        queryFn: async (): Promise<Paged<SpotGuardEvent>> => {
            const qs = buildParams({
                page: filters.page,
                limit: filters.limit,
                serviceId: filters.serviceId,
                eventType: filters.eventType,
                eventTypes: filters.eventTypes?.length ? filters.eventTypes.join(',') : undefined,
                since: filters.since,
            });
            const { data, total } = await getJson<SpotGuardEvent[]>(`/api/spot-guard/events?${qs}`);
            return { data, total };
        },
        placeholderData: (prev) => prev,
    });
}

/** Distinct regions/clusters for the filter dropdowns. Static enough to cache generously. */
export function useSpotGuardFacets() {
    return useQuery({
        queryKey: queryKeys.spotGuard.facets(),
        queryFn: async () => (await getJson<{ regions: string[]; clusters: string[] }>('/api/spot-guard/facets')).data,
        staleTime: 5 * 60_000,
    });
}

export function useSpotGuardSummary() {
    return useQuery({
        queryKey: queryKeys.spotGuard.summary(),
        queryFn: async () => (await getJson<SpotGuardSummary>('/api/spot-guard/summary')).data,
    });
}

export function useSpotGuardReport(range?: { from?: string; to?: string }, opts: { enabled?: boolean } = {}) {
    return useQuery({
        queryKey: queryKeys.spotGuard.report(range),
        // The report aggregates every task session in the window, so it is the most expensive
        // query in the domain. Callers that render it behind a tab pass enabled.
        enabled: opts.enabled ?? true,
        queryFn: async () => {
            const qs = buildParams({ from: range?.from, to: range?.to });
            return (await getJson<HoursReport>(`/api/spot-guard/report?${qs}`)).data;
        },
        placeholderData: (prev) => prev,
    });
}

export interface SpotGuardSettings {
    /** Slack channel id or #name. Empty means no destination, so alerts are recorded only. */
    slackChannelId: string;
    /** Opt-OUT: absent is treated as on, matching what notify() does server-side. */
    slackEnabled: boolean;
    /** IANA zone deciding what "a day" means for the daily report. Empty = the stack default. */
    reportTimezone: string;
}

export function useSpotGuardSettings() {
    return useQuery({
        queryKey: queryKeys.spotGuard.settings(),
        queryFn: async () => (await getJson<SpotGuardSettings>('/api/spot-guard/settings')).data,
    });
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Invalidate the whole domain — service state, events and summary all move together. */
function useInvalidateSpotGuard() {
    const qc = useQueryClient();
    return () => qc.invalidateQueries({ queryKey: queryKeys.spotGuard.all });
}

export interface EnableSpotPayload {
    id: string;
    confirmServiceName: string;
    spotWeight?: number;
    /** Relative weight for On-Demand. 0 = Spot only; equal to spotWeight = a 50/50 blend. */
    onDemandWeight?: number;
    onDemandBase?: number;
}

export function useEnableSpot() {
    const invalidate = useInvalidateSpotGuard();
    return useMutation({
        mutationFn: ({ id, ...rest }: EnableSpotPayload) =>
            // `confirm: true` is required by the route's Zod schema; the dialog is what makes
            // the user actually type the service name.
            postJson<SpotGuardService>(`/api/spot-guard/services/${encodeURIComponent(id)}/enable`, {
                confirm: true,
                ...rest,
            }),
        onSuccess: invalidate,
    });
}

export function useDisableSpot() {
    const invalidate = useInvalidateSpotGuard();
    return useMutation({
        mutationFn: ({ id, confirmServiceName }: { id: string; confirmServiceName: string }) =>
            postJson<SpotGuardService>(`/api/spot-guard/services/${id}/disable`, {
                confirm: true,
                confirmServiceName,
            }),
        onSuccess: invalidate,
    });
}

export function useSetManagementState() {
    const invalidate = useInvalidateSpotGuard();
    return useMutation({
        mutationFn: async ({ id, managementState }: { id: string; managementState: ManagementState }) => {
            const res = await fetch(`/api/spot-guard/services/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ managementState }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok || !body?.success) throw new Error(body?.error ?? `Request failed with ${res.status}`);
            return body.data as SpotGuardService;
        },
        onSuccess: invalidate,
    });
}

export function useSaveSpotGuardSettings() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (settings: Partial<SpotGuardSettings>) => {
            const res = await fetch('/api/spot-guard/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            const body = await res.json().catch(() => null);
            // The route returns the specific validation message (bad channel shape, bad timezone),
            // so surfacing body.error verbatim is what makes the toast useful.
            if (!res.ok || !body?.success) throw new Error(body?.error ?? `Request failed with ${res.status}`);
            return body.data as SpotGuardSettings;
        },
        // Only the settings query — nothing about a service row changed.
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.spotGuard.settings() }),
    });
}

export function useTriggerSpotRestore() {
    const invalidate = useInvalidateSpotGuard();
    return useMutation({
        mutationFn: ({ id }: { id: string }) =>
            postJson<{ jobId: string | null; alreadyQueued: boolean }>(`/api/spot-guard/services/${id}/restore`),
        onSuccess: invalidate,
    });
}
