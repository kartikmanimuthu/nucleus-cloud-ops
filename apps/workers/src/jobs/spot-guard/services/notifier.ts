// workers/src/jobs/spot-guard/services/notifier.ts
//
// The single place Spot Guard records an event and (maybe) tells Slack about it (SG-012).
//
// THE LOAD-BEARING RULE: alert dedup gates SLACK ONLY, never the database.
//
// The reference implementation throttled the alert itself — acceptable when Slack was the
// only surface. Here the spot_guard_events row IS the product surface, so suppressing rows
// would punch holes in the timeline during exactly the incident an operator is looking at:
// a burst of interruptions would appear as a handful of events with the rest silently
// missing. So step 1 always writes; only step 3 consults the dedup window, and the row
// records that Slack was suppressed so the UI can say so.
import { createLogger } from '../../../lib/logger.js';
import { writeAuditLog } from '../../discovery/services/audit-service.js';
import { env } from '../../../env.js';
import type { AlertType } from '../config.js';
import type { CapacityProviderStrategyItem, CapacityType, SpotEventSeverity, SpotEventType } from '../types.js';
import { buildDedupKey, claimAlertWindow } from './dedup.js';
import { markEventNotified, writeEvent } from './db-writer.js';

const log = createLogger('spot-guard-notifier');

/** Slack attachment colours: real hex codes, not the reference's invalid "#warning". */
const SEVERITY_COLOR: Record<SpotEventSeverity, string> = {
    info: '#36a64f',
    warning: '#ff9900',
    critical: '#e01e5a',
};

export interface NotifyInput {
    tenantId: string;
    spotServiceId?: string | null;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    eventType: SpotEventType;
    severity?: SpotEventSeverity;
    /** Omit to skip Slack entirely and only record the event (e.g. governance_skip). */
    alertType?: AlertType;
    /** Slack text. Defaults to `message`. Used as the notification fallback, not rendered. */
    slackText?: string;
    /** 'digest' keeps a pre-formatted multi-line body (the daily report) intact. */
    slackLayout?: 'alert' | 'digest';
    message: string;
    sourceEventId?: string | null;
    taskArn?: string | null;
    capacityProvider?: string | null;
    fromCapacity?: CapacityType | null;
    toCapacity?: CapacityType | null;
    stopCode?: string | null;
    stoppedReason?: string | null;
    strategyBefore?: CapacityProviderStrategyItem[] | null;
    strategyAfter?: CapacityProviderStrategyItem[] | null;
    metadata?: Record<string, unknown>;
    actor?: string;
    occurredAt?: Date;
    /** Also write an audit-log entry. Use for AWS mutations. */
    audit?: { eventType: string; action: string; severity: string; details: string };
}

/**
 * Record an event and, when it has an alertType and wins its dedup window, relay it to the
 * tenant's Slack.
 *
 * Never throws. A notification problem must not fail a remediation job — pg-boss would then
 * retry an ecs:UpdateService that already succeeded.
 */
export async function notify(input: NotifyInput): Promise<{ eventId: string | null; slackDelivered: boolean }> {
    const severity = input.severity ?? 'info';

    // ── 1. ALWAYS record the event ────────────────────────────────────────────
    let eventId: string | null = null;
    try {
        eventId = await writeEvent({
            tenantId: input.tenantId,
            spotServiceId: input.spotServiceId ?? null,
            accountId: input.accountId,
            region: input.region,
            clusterName: input.clusterName,
            serviceName: input.serviceName,
            eventType: input.eventType,
            severity,
            sourceEventId: input.sourceEventId ?? null,
            taskArn: input.taskArn ?? null,
            capacityProvider: input.capacityProvider ?? null,
            fromCapacity: input.fromCapacity ?? null,
            toCapacity: input.toCapacity ?? null,
            stopCode: input.stopCode ?? null,
            stoppedReason: input.stoppedReason ?? null,
            strategyBefore: input.strategyBefore ?? null,
            strategyAfter: input.strategyAfter ?? null,
            message: input.message,
            metadata: input.metadata,
            actor: input.actor,
            occurredAt: input.occurredAt,
        });
    } catch (err) {
        // A duplicate sourceEventId returns null rather than throwing, so reaching here is a
        // genuine write failure. Keep going: an alert is still better than silence.
        log.error('Failed to write Spot Guard event', {
            eventType: input.eventType,
            serviceName: input.serviceName,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Audit-log AWS mutations separately from the timeline (CLAUDE.md requires it).
    if (input.audit) {
        await writeAuditLog({
            tenantId: input.tenantId,
            eventType: input.audit.eventType,
            action: input.audit.action,
            resourceId: `${input.accountId}/${input.clusterName}/${input.serviceName}`,
            status: 'success',
            severity: input.audit.severity,
            details: input.audit.details,
            accountId: input.accountId,
            region: input.region,
            metadata: { spotEventType: input.eventType, ...(input.metadata ?? {}) },
        }).catch((err) =>
            log.error('Failed to write Spot Guard audit log', {
                error: err instanceof Error ? err.message : String(err),
            }),
        );
    }

    // Event types that exist purely for the UI timeline carry no alertType and stop here.
    if (!input.alertType) return { eventId, slackDelivered: false };

    // ── 2. Dedup window — SLACK ONLY ──────────────────────────────────────────
    const claim = await claimAlertWindow({
        tenantId: input.tenantId,
        dedupKey: buildDedupKey({
            alertType: input.alertType,
            accountId: input.accountId,
            region: input.region,
            clusterName: input.clusterName,
            serviceName: input.serviceName,
        }),
        alertType: input.alertType,
    });

    if (!claim.granted) {
        // Record the suppression on the row so the UI can show "Slack suppressed" rather
        // than leaving a reader wondering why they were not paged.
        if (eventId) {
            await markEventNotified({
                tenantId: input.tenantId,
                eventId,
                notified: false,
                suppressedByDedup: true,
            }).catch(() => undefined);
        }
        log.debug('Slack alert suppressed by dedup window', {
            alertType: input.alertType,
            serviceName: input.serviceName,
            suppressedCount: claim.suppressedCount,
        });
        return { eventId, slackDelivered: false };
    }

    // ── 3. Relay to the tenant's Slack via web-ui ─────────────────────────────
    const result = await relayToSlack({
        tenantId: input.tenantId,
        text: input.slackText ?? input.message,
        color: SEVERITY_COLOR[severity],
        layout: input.slackLayout,
        eventType: input.eventType,
        serviceName: input.serviceName,
        accountId: input.accountId,
        region: input.region,
        clusterName: input.clusterName,
        fromCapacity: input.fromCapacity ?? null,
        toCapacity: input.toCapacity ?? null,
    });

    if (eventId) {
        await markEventNotified({
            tenantId: input.tenantId,
            eventId,
            notified: result.delivered,
            slackError: result.delivered ? null : result.error ?? null,
        }).catch(() => undefined);
    }

    return { eventId, slackDelivered: result.delivered };
}

/**
 * POST the alert to web-ui, which owns the per-tenant Slack credentials.
 *
 * Fails QUIETLY on a missing INTERNAL_API_KEY or base URL — that is the expected state on a
 * stack without the relay configured, and logging an error every alert would be noise.
 * Never throws, for the reason in the module header.
 */
async function relayToSlack(input: {
    tenantId: string;
    text: string;
    color: string;
    /** 'digest' tells web-ui to leave the daily report's own formatting alone. */
    layout?: 'alert' | 'digest';
    /**
     * Facts, not prose. web-ui composes the visible message from these (lib/spot-guard/notify.ts),
     * so every alert lands in the same compact shape and `text` is used only as Slack's
     * notification fallback.
     */
    eventType?: string;
    serviceName?: string;
    accountId?: string;
    region?: string;
    clusterName?: string;
    fromCapacity?: string | null;
    toCapacity?: string | null;
}): Promise<{ delivered: boolean; error?: string }> {
    const baseUrl = env.WEB_UI_BASE_URL;
    const key = env.INTERNAL_API_KEY;
    if (!baseUrl || !key) {
        log.debug('Slack relay not configured (WEB_UI_BASE_URL / INTERNAL_API_KEY unset) — skipping');
        return { delivered: false, error: 'relay_not_configured' };
    }

    try {
        const res = await fetch(`${baseUrl}/api/internal/spot-guard/notify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-internal-key': key,
                'x-tenant-id': input.tenantId,
            },
            body: JSON.stringify({
                    text: input.text,
                    color: input.color,
                    layout: input.layout,
                    eventType: input.eventType,
                    serviceName: input.serviceName,
                    accountId: input.accountId,
                    region: input.region,
                    clusterName: input.clusterName,
                    fromCapacity: input.fromCapacity,
                    toCapacity: input.toCapacity,
                }),
            // Bounded: a hanging relay must not hold a job slot open.
            signal: AbortSignal.timeout(10_000),
        });

        const body = (await res.json().catch(() => null)) as
            | { success?: boolean; data?: { delivered?: boolean; reason?: string; error?: string } }
            | null;

        if (!res.ok || !body?.success) {
            return { delivered: false, error: `relay HTTP ${res.status}` };
        }
        // The route answers 200 with delivered:false for "tenant has no Slack configured",
        // which is a normal outcome and not an error worth logging loudly.
        return { delivered: Boolean(body.data?.delivered), error: body.data?.error ?? body.data?.reason };
    } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
}
