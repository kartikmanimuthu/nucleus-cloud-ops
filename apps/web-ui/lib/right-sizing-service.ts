/**
 * RightSizingService (RS-017..020).
 *
 * Business logic for right-sizing recommendations + runs. Delegates persistence to the
 * repository factory and audit-logs reviewer status changes + on-demand scan triggers.
 */
import { getRightSizingRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import type {
    RecommendationFilters,
    RecommendationPage,
    RecommendationStatus,
    RightSizingRecommendation,
    RightSizingSummary,
    RightSizingRun,
} from '@/lib/db/repositories/right-sizing/interface';

const SCAN_QUEUE = 'right-sizing-scan';
const VALID_REVIEW_STATUSES: RecommendationStatus[] = ['approved', 'dismissed', 'snoozed', 'open'];

export class RightSizingService {
    static async listRecommendations(filters: RecommendationFilters): Promise<RecommendationPage> {
        return getRightSizingRepository().listRecommendations(filters);
    }

    static async getRecommendation(id: string, tenantId: string): Promise<RightSizingRecommendation | null> {
        return getRightSizingRepository().getRecommendation(id, tenantId);
    }

    static async getSummary(tenantId: string): Promise<RightSizingSummary> {
        return getRightSizingRepository().getSummary(tenantId);
    }

    static async listRuns(tenantId: string, page?: number, limit?: number) {
        return getRightSizingRepository().listRuns(tenantId, page, limit);
    }

    /**
     * Update a recommendation's review status. Pre-flight ownership check (caller passes the
     * tenantId from the session); `applied` is rejected — automated resize is out of scope (v1).
     */
    static async updateStatus(
        id: string,
        tenantId: string,
        status: RecommendationStatus,
        reviewedBy: string,
        snoozeUntil?: Date | null
    ): Promise<RightSizingRecommendation> {
        if (status === 'applied') {
            throw new Error('Applying recommendations (automated resize) is not supported in this version.');
        }
        if (!VALID_REVIEW_STATUSES.includes(status)) {
            throw new Error(`Invalid status: ${status}`);
        }
        const repo = getRightSizingRepository();
        const existing = await repo.getRecommendation(id, tenantId);
        if (!existing) {
            throw new Error('NOT_FOUND'); // route maps to 403/404 — no cross-tenant leak
        }
        const updated = await repo.updateStatus(id, tenantId, status, reviewedBy, snoozeUntil);

        await AuditService.logUserAction({
            eventType: 'right_sizing.recommendation.updated',
            action: `Recommendation ${status}`,
            resourceType: 'RightSizing',
            resourceId: id,
            resourceName: existing.resourceId,
            user: reviewedBy || 'system',
            userType: 'user',
            status: 'success',
            severity: 'low',
            details: `Right-sizing recommendation for ${existing.resourceId} (${existing.finding}) set to ${status}`,
            tenantId,
            dataClassification: 'infrastructure',
            metadata: {
                tenantId,
                resourceType: existing.resourceType,
                finding: existing.finding,
                before: existing.status,
                after: status,
                estimatedMonthlySavings: existing.estimatedMonthlySavings,
            },
        });
        return updated;
    }

    /**
     * Enqueue an on-demand scan for the tenant. The pg-boss `singletonKey` (stately queue) is
     * the atomic dedup authority — a second concurrent request gets jobId === null and does not
     * create a duplicate. The worker creates the RightSizingRun when it picks up the job, so we
     * never pre-create a DB row (which previously risked a check-then-create race and an
     * orphaned `running` row permanently blocking future scans).
     */
    static async triggerScan(tenantId: string, triggeredBy: string): Promise<{ run: RightSizingRun | null; alreadyRunning: boolean }> {
        const repo = getRightSizingRepository();
        const boss = await getBoss();
        const jobId = await boss.send(
            SCAN_QUEUE,
            { tenantId, trigger: 'manual' },
            { singletonKey: `tenant:${tenantId}`, retryLimit: 2, retryDelay: 60, retryBackoff: true }
        );
        const alreadyRunning = jobId === null;

        await AuditService.logUserAction({
            eventType: 'right_sizing.scan.triggered',
            action: 'Triggered Right Sizing scan',
            resourceType: 'RightSizing',
            resourceId: jobId ?? 'already-running',
            resourceName: 'right-sizing-scan',
            user: triggeredBy || 'system',
            userType: 'user',
            status: 'success',
            severity: 'low',
            details: alreadyRunning ? 'Scan already queued/running — no duplicate enqueued' : 'On-demand right-sizing scan enqueued',
            tenantId,
            dataClassification: 'infrastructure',
            metadata: { tenantId, jobId, alreadyRunning },
        });

        // For display only — may be null in the brief window before the worker creates the run.
        const run = await repo.getActiveRun(tenantId);
        return { run, alreadyRunning };
    }
}
