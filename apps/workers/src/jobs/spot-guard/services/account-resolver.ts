// workers/src/jobs/spot-guard/services/account-resolver.ts
//
// Maps an inbound ECS event's AWS account id to the tenant(s) that own it, and decides
// which single tenant is allowed to perform the AWS mutation (SG-007).
//
// This is the security boundary of the whole feature, so the reasoning is spelled out.
//
// WHAT IS TRUSTED
// `envelope.account` is stamped by EventBridge from the authenticated caller.
// PutEventsRequestEntry has exactly seven fields — Detail, DetailType, EventBusName,
// Resources, Source, Time, TraceHeader — and none of them is Account, so a sender
// cannot forge it. EventBridge also refuses to relay an event a second hop, so a spoke
// cannot launder a third party's event through its own bus. Therefore a malicious or
// compromised spoke can only inject events attributed to ITSELF.
//
// WHAT IS NOT TRUSTED
// Every ARN inside `detail` and `resources` is sender-controlled. A spoke could name
// another customer's cluster. assertArnsMatchAccount is what stops that.
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import type { EcsEventEnvelope, SpokeBinding } from '../types.js';

const log = createLogger('spot-guard-resolver');

/**
 * Every (tenant, account) binding for this AWS account that is active and has Spot
 * automation enabled.
 *
 * DELIBERATELY CROSS-TENANT — the one query in this feature that must span tenants.
 * `accounts` is unique on [tenantId, accountId], NOT on accountId alone, so the same
 * AWS account can legitimately be registered by more than one tenant (an MSP and its
 * end customer, for example). An inbound event carries only an account id, so it may
 * resolve to N tenants. Raw pg because the getTenantClient() extension neither applies
 * to nor should apply to this.
 *
 * ORDER BY "tenantId" ASC is load-bearing, not cosmetic: it makes resolveActingTenant
 * deterministic across replicas, retries, and duplicate deliveries with no coordination.
 */
export async function resolveTenantsForAccount(accountId: string): Promise<SpokeBinding[]> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<SpokeBinding>(
            `SELECT "tenantId", "accountId", "roleArn", "externalId", regions
               FROM accounts
              WHERE "accountId" = $1
                AND active = true
                AND "spotAutomationEnabled" = true
              ORDER BY "tenantId" ASC`,
            [accountId],
        );
        return rows;
    } finally {
        client.release();
    }
}

/**
 * The single tenant permitted to perform the AWS mutation for this event.
 *
 * Row 0 of a tenantId-ASC ordered result. Deterministic across replicas, retries and
 * duplicate deliveries with no lock, no leader election and no clock — which is why
 * this is preferred over any coordination scheme.
 *
 * Why one acting tenant at all: ecs:UpdateService acts on ONE AWS resource. Firing it
 * once per owning tenant would mean N rolling deployments with forceNewDeployment on the
 * same service — a thrashing service and potentially an outage. Observability rows are
 * still written for every tenant (both paid for that account); only the mutation is
 * elected.
 */
export function resolveActingTenant(bindings: SpokeBinding[]): SpokeBinding | null {
    return bindings.length > 0 ? bindings[0] : null;
}

/** Extract the account id from ARN segment 5, or null if the shape is wrong. */
export function accountFromArn(arn: string): string | null {
    const parts = arn.split(':');
    // arn:partition:service:region:account:resource
    if (parts.length < 6 || parts[0] !== 'arn') return null;
    return parts[4] || null;
}

/**
 * Anti-confused-deputy check: every ARN in the payload must belong to the account
 * EventBridge attributed the event to.
 *
 * Without this, spoke A could PutEvents a payload naming spoke B's cluster/service, and
 * we would resolve B's tenant, assume B's role, and mutate B's service on A's say-so.
 * The account field is authoritative (see the module header); the ARNs are not.
 *
 * Returns the offending ARN, or null when everything checks out.
 */
export function findArnAccountMismatch(envelope: EcsEventEnvelope): string | null {
    const account = envelope.account;
    if (!account) return null; // handled separately — no account means we drop anyway

    const arns = [...(envelope.resources ?? []), envelope.detail?.clusterArn, envelope.detail?.taskArn].filter(
        (a): a is string => typeof a === 'string' && a.length > 0,
    );

    for (const arn of arns) {
        const arnAccount = accountFromArn(arn);
        // A malformed ARN is not a mismatch — parsing is best-effort and a shape we do
        // not recognise carries no claim about ownership. Only a DIFFERENT, well-formed
        // account is an attack signal.
        if (arnAccount && arnAccount !== account) return arn;
    }
    return null;
}

// ── Unregistered-account logging, rate limited ────────────────────────────────
//
// An event from an account no tenant owns is not retryable: no amount of redelivery
// will register it. It is also the signal for two very different situations — a
// customer who removed the account but left their CloudFormation stack forwarding
// (they are still being billed for those custom events), and an unauthorized sender
// probing the bus. Both deserve a metric, neither deserves an unbounded log flood,
// because filling CloudWatch Logs would itself be the attack.

const UNREGISTERED_LOG_WINDOW_MS = 60_000;
const lastUnregisteredLogAt = new Map<string, number>();

/** True when this account's drop should be logged now (once per minute per account). */
export function shouldLogUnregistered(accountId: string, nowMs: number = Date.now()): boolean {
    const last = lastUnregisteredLogAt.get(accountId) ?? 0;
    if (nowMs - last < UNREGISTERED_LOG_WINDOW_MS) return false;
    lastUnregisteredLogAt.set(accountId, nowMs);
    // Bound the map so a flood of distinct spoofed accounts cannot grow it forever.
    if (lastUnregisteredLogAt.size > 1000) {
        for (const [k, t] of lastUnregisteredLogAt) {
            if (nowMs - t >= UNREGISTERED_LOG_WINDOW_MS) lastUnregisteredLogAt.delete(k);
        }
    }
    return true;
}

/** Reset the rate-limit memo. Test-only. */
export function __resetUnregisteredLogState(): void {
    lastUnregisteredLogAt.clear();
}

export type ResolutionOutcome =
    | { ok: true; bindings: SpokeBinding[]; acting: SpokeBinding }
    | { ok: false; reason: 'no_account' | 'arn_account_mismatch' | 'unregistered_account' };

/**
 * Full inbound authorization for one event. Ordered so the cheapest and most
 * security-relevant checks run before any database work.
 */
export async function authorizeEvent(envelope: EcsEventEnvelope): Promise<ResolutionOutcome> {
    if (!envelope.account) {
        log.warn('Spot Guard event with no account field — dropped', {
            metric: 'spotguard.event_no_account',
            detailType: envelope['detail-type'],
        });
        return { ok: false, reason: 'no_account' };
    }

    const mismatch = findArnAccountMismatch(envelope);
    if (mismatch) {
        // Always logged at error, never rate limited: this cannot happen by accident.
        log.error('Spot Guard event ARN/account mismatch — dropped', {
            metric: 'spotguard.arn_account_mismatch',
            account: envelope.account,
            arn: mismatch,
        });
        return { ok: false, reason: 'arn_account_mismatch' };
    }

    const bindings = await resolveTenantsForAccount(envelope.account);
    if (bindings.length === 0) {
        if (shouldLogUnregistered(envelope.account)) {
            log.warn('Spot Guard event from an account not registered to any tenant — dropped', {
                metric: 'spotguard.unregistered_account',
                account: envelope.account,
                detailType: envelope['detail-type'],
            });
        }
        return { ok: false, reason: 'unregistered_account' };
    }

    // Non-null because bindings.length > 0.
    return { ok: true, bindings, acting: resolveActingTenant(bindings)! };
}
