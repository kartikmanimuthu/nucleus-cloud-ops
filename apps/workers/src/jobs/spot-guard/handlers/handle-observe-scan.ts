// workers/src/jobs/spot-guard/handlers/handle-observe-scan.ts
//
// Hourly re-observation of every managed service. READ-ONLY: it calls DescribeServices and writes
// the registry. It never calls UpdateService, and it makes no decisions.
//
// Why this exists. `observedStrategy` was only ever refreshed by paths that had another reason to
// look at a service — the placement-failure handler and the restore scan. Both are narrow:
//
//   * listRestoreCandidates returns only rows that are restore-pending or already on On-Demand, and
//     only when no backoff is armed. A healthy service sitting on Spot is never visited.
//   * the task-state event path deliberately does not call DescribeServices at all (it is high
//     volume), and carries observedStrategy forward untouched.
//
// So a row could be wrong forever with no code path that would ever correct it. That is not
// hypothetical: stx-kyc-ekyc-pf-app displayed "100% On-demand" while live AWS had it on
// FARGATE_SPOT w1 — its capacityState was 'spot' with no restore debt, so it failed the candidate
// filter, and the morning scale-up would not have fixed it either.
//
// Cost is one DescribeServices call per cluster per hour (the API takes 10 services at a time), so
// a tenant with nine services in one cluster costs one call.
import { createLogger } from '../../../lib/logger.js';
import type { LiveServiceState } from '../types.js';
import { resolveTenantsForAccount } from '../services/account-resolver.js';
import { listManagedServices, upsertObservedService, type ManagedServiceRef } from '../services/db-writer.js';
import { createSpokeClients, describeServicesBatch } from '../services/ecs-client.js';

const log = createLogger('spot-guard-observe');

interface ObserveScanJob {
    tenantId: string;
}

/** Group rows into one DescribeServices call per (account, region, cluster). */
function groupByCluster(rows: ManagedServiceRef[]): Map<string, ManagedServiceRef[]> {
    const groups = new Map<string, ManagedServiceRef[]>();
    for (const row of rows) {
        const key = `${row.accountId}|${row.region}|${row.clusterName}`;
        const existing = groups.get(key);
        if (existing) existing.push(row);
        else groups.set(key, [row]);
    }
    return groups;
}

export async function handleSpotGuardObserveScan(jobData: unknown): Promise<void> {
    const { tenantId } = jobData as ObserveScanJob;

    const rows = await listManagedServices(tenantId);
    if (rows.length === 0) {
        log.info('No managed services to re-observe', { tenantId });
        return;
    }

    let observed = 0;
    let missing = 0;
    let unreachable = 0;

    for (const [key, group] of groupByCluster(rows)) {
        const [accountId, region, clusterName] = key.split('|');

        // Read-only, so no acting-tenant election: every tenant that owns this account keeps its own
        // registry row and needs its own read. The mutation paths elect one tenant because
        // UpdateService acts on a single shared AWS resource; DescribeServices does not.
        const binding = (await resolveTenantsForAccount(accountId)).find((b) => b.tenantId === tenantId);
        if (!binding) {
            // The account was deactivated or Spot was switched off for it since the row was written.
            log.info('No active Spot-enabled binding — skipping cluster', { tenantId, accountId, clusterName });
            unreachable += group.length;
            continue;
        }

        let live: Map<string, LiveServiceState>;
        try {
            const clients = await createSpokeClients(binding, region);
            live = await describeServicesBatch(clients.ecs, clusterName, group.map((r) => r.serviceName));
        } catch (err) {
            // One unreachable account must not abort the other accounts' observations. AssumeRole
            // failures are the common case here (a customer rotating or removing the role).
            log.warn('Could not describe cluster — leaving those rows as they are', {
                tenantId,
                accountId,
                region,
                clusterName,
                error: err instanceof Error ? err.message : String(err),
            });
            unreachable += group.length;
            continue;
        }

        for (const row of group) {
            const state = live.get(row.serviceName);
            if (!state) {
                // Deleted in AWS but still in our registry. Not this pass's job to reconcile that —
                // it only records what it can see.
                missing += 1;
                continue;
            }

            await upsertObservedService({
                tenantId: row.tenantId,
                accountId: row.accountId,
                region: row.region,
                clusterName: row.clusterName,
                serviceName: row.serviceName,
                observedStrategy: state.currentStrategy,
                // capacityState is owned by the task-state observer, which learns it from real task
                // events. A strategy is what a service is CONFIGURED for; capacityState is what its
                // tasks actually launched on, and the two differ legitimately — most obviously right
                // after a strategy change, since that does not move already-running tasks. The only
                // exception is an empty strategy, where there is nothing to be on.
                capacityState: state.currentStrategy.length === 0 ? 'unknown' : row.capacityState,
                desiredCount: state.desiredCount,
                runningCount: state.runningCount,
                serviceStatus: state.status,
            });
            observed += 1;
        }
    }

    log.info('Re-observation complete', { tenantId, total: rows.length, observed, missing, unreachable });
}
