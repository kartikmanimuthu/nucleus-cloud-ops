'use client';

/**
 * TanStack Query hooks for the Audit domain (read-only).
 *
 * Wraps the LIVE cursor-paginated service `client-audit-service-api` (the
 * non-`-api` client-audit-service.ts is dead code). Audit logs are immutable,
 * so there are no mutations — just cached reads for logs + stats.
 *
 * Note: the logs endpoint is cursor-paginated (nextPageToken). These hooks key
 * each page by its filters (which include nextPageToken), so navigating pages
 * caches each page independently. A useInfiniteQuery variant can be added when
 * the audit page is migrated.
 */
import { useQuery } from '@tanstack/react-query';
import {
    ClientAuditService,
    type AuditLogFilters,
    type AuditLogResponse,
    type AuditLogStats,
} from '@/lib/client-audit-service-api';
import { queryKeys } from '@/lib/queries/query-keys';

/** Fetch a page of audit logs for the given filters. Returns { logs, nextPageToken }. */
export function useAuditLogs(
    filters?: AuditLogFilters,
    options?: { initialData?: AuditLogResponse },
) {
    return useQuery({
        queryKey: queryKeys.audit.list(filters),
        queryFn: () => ClientAuditService.getAuditLogs(filters ?? {}),
        placeholderData: (prev) => prev,
        initialData: options?.initialData,
    });
}

/** Fetch aggregate audit-log stats for the given filters. */
export function useAuditLogStats(
    filters?: AuditLogFilters,
    options?: { initialData?: AuditLogStats },
) {
    return useQuery({
        queryKey: queryKeys.audit.stats(filters),
        queryFn: () => ClientAuditService.getAuditLogStats(filters ?? {}),
        placeholderData: (prev) => prev,
        initialData: options?.initialData,
    });
}

export interface AuditFilterOptions {
    sources: string[];
    users: string[];
    resourceTypes: string[];
    eventTypes: string[];
    severities: string[];
    statuses: string[];
    userTypes: string[];
}

const EMPTY_FILTER_OPTIONS: AuditFilterOptions = {
    sources: [],
    users: [],
    resourceTypes: [],
    eventTypes: [],
    severities: [],
    statuses: [],
    userTypes: [],
};

/**
 * DB-driven dropdown values for the audit filters. Changes rarely, so it's
 * cached for 5 minutes. Shows empty options as placeholder while loading.
 */
export function useAuditFilterOptions() {
    return useQuery({
        queryKey: [...queryKeys.audit.all, 'filter-options'] as const,
        queryFn: async (): Promise<AuditFilterOptions> => {
            const res = await fetch('/api/audit/filters');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to fetch audit filter options');
            }
            return json.data as AuditFilterOptions;
        },
        staleTime: 5 * 60_000,
        placeholderData: EMPTY_FILTER_OPTIONS,
    });
}

export type { AuditLogFilters, AuditLogResponse, AuditLogStats };
