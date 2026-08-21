/**
 * CapacityPlanningService (SA-004).
 *
 * Business logic for the Capacity Planning report — installed vs. utilised
 * vs. peak CPU/Mem and >70% breach instances, the companion report to Scale
 * Sentinel's scaling event log. Delegates persistence to the repository
 * factory (reads only) and owns the manual-scan enqueue, mirroring
 * ScalingAuditService.triggerScan exactly.
 */
import { getCapacityPlanningRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import type {
    CapacityPlanningFilters,
    CapacityUtilizationSummaryPage,
    CapacityBreachPage,
    CapacityPlanningRun,
    CapacityResourceDetail,
    CapacityResourceType,
} from '@/lib/db/repositories/capacity-planning/interface';

const SCAN_QUEUE = 'capacity-planning-scan';

const COMPUTE_TYPES: CapacityResourceType[] = ['ecs', 'asg'];

/** Clamps the caller's resourceType to this module's own resource types —
 *  defense in depth so this API can never return the other module's rows
 *  even if the shared table ever picks up an unexpected value. */
function clampToCompute(filters: CapacityPlanningFilters): CapacityPlanningFilters {
    const requested = filters.resourceType;
    if (!requested) return { ...filters, resourceType: COMPUTE_TYPES };
    const allowed = (Array.isArray(requested) ? requested : [requested]).filter((t) => COMPUTE_TYPES.includes(t));
    return { ...filters, resourceType: allowed.length ? allowed : COMPUTE_TYPES };
}

export class CapacityPlanningService {
    static async getUtilizationSummary(filters: CapacityPlanningFilters, thresholdPercent?: number): Promise<CapacityUtilizationSummaryPage> {
        return getCapacityPlanningRepository().getUtilizationSummary(clampToCompute(filters), thresholdPercent);
    }

    static async listBreachInstances(filters: CapacityPlanningFilters, thresholdPercent?: number): Promise<CapacityBreachPage> {
        return getCapacityPlanningRepository().listBreachInstances(clampToCompute(filters), thresholdPercent);
    }

    /** One resource's installed/utilised/breach detail — feeds the Scale Sentinel
     *  resource detail page's "Scaling & Capacity" tab (ecs/asg only). */
    static async getResourceDetail(filters: CapacityPlanningFilters, resourceId: string): Promise<CapacityResourceDetail | null> {
        return getCapacityPlanningRepository().getResourceDetail(clampToCompute(filters), resourceId);
    }

    static async listRuns(tenantId: string, page?: number, limit?: number): Promise<{ runs: CapacityPlanningRun[]; total: number }> {
        return getCapacityPlanningRepository().listRuns(tenantId, page, limit);
    }

    /** Enqueue an on-demand scan. Stately-queue singletonKey is the atomic dedup
     *  authority — a concurrent request gets jobId === null, not a duplicate run. */
    static async triggerScan(tenantId: string, triggeredBy: string): Promise<{ alreadyRunning: boolean }> {
        const boss = await getBoss();
        const jobId = await boss.send(
            SCAN_QUEUE,
            { tenantId, trigger: 'manual' },
            { singletonKey: `tenant:${tenantId}`, retryLimit: 2, retryDelay: 60, retryBackoff: true }
        );
        const alreadyRunning = jobId === null;

        await AuditService.logUserAction({
            eventType: 'capacity_planning.scan.triggered',
            action: 'Triggered Capacity Planning scan',
            resourceType: 'ScalingAudit',
            resourceId: jobId ?? 'already-running',
            resourceName: 'capacity-planning-scan',
            user: triggeredBy || 'system',
            userType: 'user',
            status: 'success',
            severity: 'low',
            details: alreadyRunning ? 'Scan already queued/running — no duplicate enqueued' : 'On-demand capacity-planning scan enqueued',
            tenantId,
        });

        return { alreadyRunning };
    }
}
