/**
 * ScalingAuditService (SA-001).
 *
 * Business logic for the Scaling Audit module — a SEBI compliance record of ECS
 * + ASG scaling events. Delegates persistence to the repository factory (reads
 * only — see IScalingAuditRepository) and audit-logs both manual scan triggers
 * and evidence exports (the export route calling this must itself be logged; an
 * evidence export with no audit trail of who pulled it is a gap the existing
 * inventory export route has and this module must not repeat).
 */
import { getScalingAuditRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import type {
    ScalingEventFilters,
    ScalingEventPage,
    ScalingAuditSummary,
    ScalingAuditFacets,
    ScalingAuditRun,
    WatermarkGap,
    PolicySnapshot,
    ScalingEvent,
} from '@/lib/db/repositories/scaling-audit/interface';

const SCAN_QUEUE = 'scaling-audit-scan';
const MAX_EXPORT_ROWS = 50_000;

export interface ExportData {
    events: ScalingEvent[];
    gaps: WatermarkGap[];
    seal: { day: string; seal: string; rowCount: number } | null;
    truncated: boolean;
}

export class ScalingAuditService {
    static async listEvents(filters: ScalingEventFilters): Promise<ScalingEventPage> {
        return getScalingAuditRepository().listEvents(filters);
    }

    static async getEvent(id: string, tenantId: string): Promise<ScalingEvent | null> {
        return getScalingAuditRepository().getEvent(id, tenantId);
    }

    static async getSummary(tenantId: string): Promise<ScalingAuditSummary> {
        return getScalingAuditRepository().getSummary(tenantId);
    }

    static async getFacets(tenantId: string): Promise<ScalingAuditFacets> {
        return getScalingAuditRepository().getFacets(tenantId);
    }

    static async listRuns(tenantId: string, page?: number, limit?: number): Promise<{ runs: ScalingAuditRun[]; total: number }> {
        return getScalingAuditRepository().listRuns(tenantId, page, limit);
    }

    static async getWatermarkGaps(tenantId: string): Promise<WatermarkGap[]> {
        return getScalingAuditRepository().getWatermarkGaps(tenantId);
    }

    static async listPolicySnapshots(tenantId: string, accountId: string, region: string, resourceId: string): Promise<PolicySnapshot[]> {
        return getScalingAuditRepository().listPolicySnapshots(tenantId, accountId, region, resourceId);
    }

    /**
     * Gathers everything an export needs: the events themselves, any known
     * coverage gaps (so the export can print them — a report must never imply
     * completeness it can't back), and the latest tamper-evidence seal. Caps at
     * MAX_EXPORT_ROWS and reports `truncated` rather than silently dropping rows.
     */
    static async getExportData(filters: Omit<ScalingEventFilters, 'page' | 'limit'>): Promise<ExportData> {
        const repo = getScalingAuditRepository();
        const [events, gaps, seal] = await Promise.all([
            repo.listAllEvents(filters, MAX_EXPORT_ROWS + 1),
            repo.getWatermarkGaps(filters.tenantId),
            repo.getLatestSeal(filters.tenantId),
        ]);
        const truncated = events.length > MAX_EXPORT_ROWS;
        return { events: truncated ? events.slice(0, MAX_EXPORT_ROWS) : events, gaps, seal, truncated };
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
            eventType: 'scaling_audit.scan.triggered',
            action: 'Triggered Scaling Audit scan',
            resourceType: 'ScalingAudit',
            resourceId: jobId ?? 'already-running',
            resourceName: 'scaling-audit-scan',
            user: triggeredBy || 'system',
            userType: 'user',
            status: 'success',
            severity: 'low',
            details: alreadyRunning ? 'Scan already queued/running — no duplicate enqueued' : 'On-demand scaling-audit scan enqueued',
            tenantId,
        });

        return { alreadyRunning };
    }

    /** Every export is itself an auditable action — who, when, filters, row
     *  count, and the seal it was generated from. */
    static async logExport(
        tenantId: string,
        exportedBy: string,
        format: 'xlsx' | 'pdf',
        filters: Record<string, unknown>,
        rowCount: number,
        seal: string | null
    ): Promise<void> {
        await AuditService.logUserAction({
            eventType: 'scaling_audit.export.completed',
            action: `Exported Scaling Audit records (${format.toUpperCase()})`,
            resourceType: 'ScalingAudit',
            resourceId: seal ?? 'no-seal',
            resourceName: `scaling-audit-export.${format}`,
            user: exportedBy || 'system',
            userType: 'user',
            status: 'success',
            severity: 'low',
            // "row(s)" not "scaling event row(s)" — this same call also logs a
            // Direct Connect & VPN export, whose rows are availability/bandwidth
            // summaries, not scaling events.
            details: `Exported ${rowCount} row(s) as ${format.toUpperCase()}. Filters: ${JSON.stringify(filters)}`,
            tenantId,
        });
    }
}
