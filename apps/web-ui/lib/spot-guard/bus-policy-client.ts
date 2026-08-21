// web-ui/lib/spot-guard/bus-policy-client.ts
//
// Asks the workers process to reconcile the Spot Guard event-bus allowlist.
//
// web-ui does not call EventBridge itself — the IAM grant for events:PutPermission is on
// the WORKERS task role only (see infra/compute/index.ts). Keeping the AWS-mutation
// surface in the workers process means a web-ui compromise cannot rewrite the bus policy,
// and it keeps a single writer for a document that PutPermission replaces wholesale.
import { getBoss } from '@/lib/boss-client';

const RECONCILE_QUEUE = 'spot-guard-bus-policy-reconcile';

/**
 * Fire-and-forget request to reconcile the bus policy.
 *
 * DELIBERATELY NEVER THROWS, and deliberately not awaited by callers. An account
 * mutation the user explicitly asked for must not fail because a follow-up bookkeeping
 * enqueue did — and it does not need to, because the workers run an hourly reconcile
 * cron that converges regardless. The worst case of a lost enqueue is bounded staleness
 * (up to an hour before a newly enabled account's events are accepted), not a 500 on
 * account creation.
 *
 * singletonSeconds collapses a burst of onboardings into one write and serialises across
 * the two worker replicas.
 */
export function requestBusPolicyReconcile(reason: string): void {
    void (async () => {
        const boss = await getBoss();
        await boss.send(
            RECONCILE_QUEUE,
            { reason },
            { singletonKey: 'spot-guard-bus-policy', singletonSeconds: 30, retryLimit: 3, retryDelay: 30, retryBackoff: true },
        );
    })().catch((err) => {
        console.error(
            `[spot-guard] bus policy reconcile enqueue failed (reason=${reason}); the hourly cron will converge`,
            err,
        );
    });
}
