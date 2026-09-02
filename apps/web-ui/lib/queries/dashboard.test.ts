// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/client-dashboard-service', () => ({
    ClientDashboardService: { fetchZone: vi.fn() },
}));

import { ClientDashboardService } from '@/lib/client-dashboard-service';
import {
    useDashboardHero,
    useDashboardActionCenter,
    useDashboardCoverage,
    useDashboardCostAutomation,
    useDashboardAgentActivity,
    useDashboardInventory,
    useDashboardAudit,
} from './dashboard';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('dashboard queries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(ClientDashboardService.fetchZone).mockResolvedValue({} as any);
    });

    it.each([
        ['useDashboardHero', useDashboardHero, 'hero'],
        ['useDashboardActionCenter', useDashboardActionCenter, 'action-center'],
        ['useDashboardCostAutomation', useDashboardCostAutomation, 'cost-automation'],
        ['useDashboardAgentActivity', useDashboardAgentActivity, 'agent-activity'],
        ['useDashboardAudit', useDashboardAudit, 'audit'],
    ] as const)('%s defaults to the 24h range and forwards a custom one', async (_name, hook, zone) => {
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => hook(), { wrapper });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(ClientDashboardService.fetchZone).toHaveBeenCalledWith(zone, '24h');

        vi.mocked(ClientDashboardService.fetchZone).mockClear();
        const { result: custom } = renderHook(() => hook('7d'), { wrapper: createWrapper().wrapper });
        await waitFor(() => expect(custom.current.isSuccess).toBe(true));
        expect(ClientDashboardService.fetchZone).toHaveBeenCalledWith(zone, '7d');
    });

    it('useDashboardCoverage fetches the coverage zone with no range', async () => {
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useDashboardCoverage(), { wrapper });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(ClientDashboardService.fetchZone).toHaveBeenCalledWith('coverage');
    });

    it('useDashboardInventory fetches the inventory zone with no range', async () => {
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useDashboardInventory(), { wrapper });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(ClientDashboardService.fetchZone).toHaveBeenCalledWith('inventory');
    });
});
