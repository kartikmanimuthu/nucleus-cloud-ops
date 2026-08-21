'use client';

/**
 * TanStack Query hook for the Scale Sentinel "Direct Connect & VPN"
 * compliance report.
 */
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type { NetworkAvailabilityReportRow } from '@/lib/db/repositories/network-links/interface';

export interface NetworkAvailabilityReportFilters {
    accountId?: string;
    region?: string;
    dateFrom?: string;
    dateTo?: string;
}

export function useNetworkAvailabilityReport(filters: NetworkAvailabilityReportFilters, options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: queryKeys.networkLinks.report(filters),
        queryFn: async (): Promise<NetworkAvailabilityReportRow[]> => {
            const params = new URLSearchParams();
            if (filters.accountId) params.set('account', filters.accountId);
            if (filters.region) params.set('region', filters.region);
            if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
            if (filters.dateTo) params.set('dateTo', filters.dateTo);

            const res = await fetch(`/api/network-links/report?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load network availability report');
            return json.data;
        },
        enabled: options?.enabled ?? true,
        placeholderData: (prev) => prev,
    });
}
