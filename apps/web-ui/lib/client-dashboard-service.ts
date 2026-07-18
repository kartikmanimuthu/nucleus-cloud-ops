/**
 * Client-safe dashboard service.
 *
 * Wraps the consolidated `/api/dashboard` endpoint for use in React components
 * and TanStack Query hooks.
 */
import type { TimeRange } from '@/lib/dashboard-types';
import type {
    HeroKpisResponse,
    ActionCenterResponse,
    CoverageResponse,
    CostAutomationResponse,
    AgentActivityResponse,
    InventorySnapshotResponse,
    AuditSnapshotResponse,
} from '@/lib/dashboard-types';

type DashboardZone =
    | 'hero'
    | 'action-center'
    | 'coverage'
    | 'cost-automation'
    | 'agent-activity'
    | 'inventory'
    | 'audit';

type ZoneResponse<Z extends DashboardZone> =
    Z extends 'hero' ? HeroKpisResponse :
    Z extends 'action-center' ? ActionCenterResponse :
    Z extends 'coverage' ? CoverageResponse :
    Z extends 'cost-automation' ? CostAutomationResponse :
    Z extends 'agent-activity' ? AgentActivityResponse :
    Z extends 'inventory' ? InventorySnapshotResponse :
    Z extends 'audit' ? AuditSnapshotResponse :
    never;

interface ApiEnvelope<T> {
    success: boolean;
    data?: T;
    error?: string;
}

export class ClientDashboardService {
    private static baseUrl = '/api/dashboard';

    static async fetchZone<Z extends DashboardZone>(
        zone: Z,
        range: TimeRange = '24h'
    ): Promise<ZoneResponse<Z>> {
        const params = new URLSearchParams({ zone, range });
        const url = `${this.baseUrl}?${params.toString()}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
        });

        const result = (await response.json()) as ApiEnvelope<ZoneResponse<Z>>;

        if (!response.ok || !result.success) {
            throw new Error(result.error || `HTTP error! status: ${response.status}`);
        }

        if (result.data === undefined) {
            throw new Error('Dashboard API returned empty data');
        }

        return result.data;
    }
}
