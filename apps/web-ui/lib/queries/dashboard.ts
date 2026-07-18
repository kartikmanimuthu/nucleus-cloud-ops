'use client';

/**
 * TanStack Query hooks for the dashboard.
 *
 * Each zone is cached independently so a range change only refetches the
 * relevant zone, and navigation back to the dashboard restores cached data
 * instantly.
 */
import { useQuery } from '@tanstack/react-query';
import { ClientDashboardService } from '@/lib/client-dashboard-service';
import { queryKeys } from '@/lib/queries/query-keys';
import type { TimeRange } from '@/lib/dashboard-types';

const DEFAULT_RANGE: TimeRange = '24h';

export function useDashboardHero(range: TimeRange = DEFAULT_RANGE) {
    return useQuery({
        queryKey: queryKeys.dashboard.hero(range),
        queryFn: () => ClientDashboardService.fetchZone('hero', range),
    });
}

export function useDashboardActionCenter(range: TimeRange = DEFAULT_RANGE) {
    return useQuery({
        queryKey: queryKeys.dashboard.actionCenter(range),
        queryFn: () => ClientDashboardService.fetchZone('action-center', range),
    });
}

export function useDashboardCoverage() {
    return useQuery({
        queryKey: queryKeys.dashboard.coverage(),
        queryFn: () => ClientDashboardService.fetchZone('coverage'),
    });
}

export function useDashboardCostAutomation(range: TimeRange = DEFAULT_RANGE) {
    return useQuery({
        queryKey: queryKeys.dashboard.costAutomation(range),
        queryFn: () => ClientDashboardService.fetchZone('cost-automation', range),
    });
}

export function useDashboardAgentActivity(range: TimeRange = DEFAULT_RANGE) {
    return useQuery({
        queryKey: queryKeys.dashboard.agentActivity(range),
        queryFn: () => ClientDashboardService.fetchZone('agent-activity', range),
    });
}

export function useDashboardInventory() {
    return useQuery({
        queryKey: queryKeys.dashboard.inventory(),
        queryFn: () => ClientDashboardService.fetchZone('inventory'),
    });
}

export function useDashboardAudit(range: TimeRange = DEFAULT_RANGE) {
    return useQuery({
        queryKey: queryKeys.dashboard.audit(range),
        queryFn: () => ClientDashboardService.fetchZone('audit', range),
    });
}
