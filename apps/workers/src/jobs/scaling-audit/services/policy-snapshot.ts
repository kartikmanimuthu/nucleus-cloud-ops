// workers/src/jobs/scaling-audit/services/policy-snapshot.ts
//
// Daily snapshot of scaling policies, scheduled actions, and min/max capacity
// bounds — content-addressed (configHash), so diffing consecutive snapshots
// yields a guardrail-change history for free. This is how ASG min/max mutations
// (invisible to DescribeScalingActivities — see asg-scheduler.ts, which sets
// MinSize/MaxSize to 0/0 on stop) get evidenced.
//
// Every request below is called unfiltered (no group/resource name) — same
// reasoning as the activity pollers: one account/region-wide call instead of one
// per resource, and it still snapshots resources not currently in inventory.
import { createHash } from 'node:crypto';
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    DescribePoliciesCommand,
    DescribeScheduledActionsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
    ApplicationAutoScalingClient,
    DescribeScalableTargetsCommand,
    DescribeScalingPoliciesCommand,
    DescribeScheduledActionsCommand as DescribeAppScheduledActionsCommand,
    ServiceNamespace,
} from '@aws-sdk/client-application-auto-scaling';
import type { AssumedCredentials } from '../../discovery/types.js';

export interface PolicySnapshotItem {
    resourceId: string;
    configHash: string;
    policies: unknown[];
    scheduledActions: unknown[];
    minCapacity?: number;
    maxCapacity?: number;
}

function credsOf(assumed: AssumedCredentials) {
    return assumed.credentials?.accessKeyId
        ? {
              accessKeyId: assumed.credentials.accessKeyId,
              secretAccessKey: assumed.credentials.secretAccessKey,
              sessionToken: assumed.credentials.sessionToken,
          }
        : undefined;
}

function hashConfig(policies: unknown[], scheduledActions: unknown[], min?: number, max?: number): string {
    // Sort-free canonical JSON is good enough here: both arrays come from a single
    // AWS response per snapshot, so key order is stable run-to-run for an
    // unchanged config, which is all configHash needs to guarantee.
    const canonical = JSON.stringify({ policies, scheduledActions, min: min ?? null, max: max ?? null });
    return createHash('sha256').update(canonical).digest('hex');
}

export async function fetchAsgPolicySnapshots(assumed: AssumedCredentials, region: string): Promise<PolicySnapshotItem[]> {
    const client = new AutoScalingClient({ region, credentials: credsOf(assumed) });
    const [policiesRes, scheduledRes, groupsRes] = await Promise.all([
        client.send(new DescribePoliciesCommand({})),
        client.send(new DescribeScheduledActionsCommand({})),
        client.send(new DescribeAutoScalingGroupsCommand({})),
    ]);

    const policiesByGroup = new Map<string, unknown[]>();
    for (const p of policiesRes.ScalingPolicies ?? []) {
        if (!p.AutoScalingGroupName) continue;
        (policiesByGroup.get(p.AutoScalingGroupName) ?? policiesByGroup.set(p.AutoScalingGroupName, []).get(p.AutoScalingGroupName)!).push(p);
    }
    const scheduledByGroup = new Map<string, unknown[]>();
    for (const s of scheduledRes.ScheduledUpdateGroupActions ?? []) {
        if (!s.AutoScalingGroupName) continue;
        (scheduledByGroup.get(s.AutoScalingGroupName) ?? scheduledByGroup.set(s.AutoScalingGroupName, []).get(s.AutoScalingGroupName)!).push(s);
    }

    return (groupsRes.AutoScalingGroups ?? [])
        .filter((g) => !!g.AutoScalingGroupName)
        .map((g) => {
            const name = g.AutoScalingGroupName!;
            const policies = policiesByGroup.get(name) ?? [];
            const scheduledActions = scheduledByGroup.get(name) ?? [];
            return {
                resourceId: name,
                policies,
                scheduledActions,
                minCapacity: g.MinSize,
                maxCapacity: g.MaxSize,
                configHash: hashConfig(policies, scheduledActions, g.MinSize, g.MaxSize),
            };
        });
}

export async function fetchEcsPolicySnapshots(assumed: AssumedCredentials, region: string): Promise<PolicySnapshotItem[]> {
    const client = new ApplicationAutoScalingClient({ region, credentials: credsOf(assumed) });
    const [policiesRes, scheduledRes, targetsRes] = await Promise.all([
        client.send(new DescribeScalingPoliciesCommand({ ServiceNamespace: ServiceNamespace.ECS })),
        client.send(new DescribeAppScheduledActionsCommand({ ServiceNamespace: ServiceNamespace.ECS })),
        client.send(new DescribeScalableTargetsCommand({ ServiceNamespace: ServiceNamespace.ECS })),
    ]);

    const policiesByResource = new Map<string, unknown[]>();
    for (const p of policiesRes.ScalingPolicies ?? []) {
        if (!p.ResourceId) continue;
        (policiesByResource.get(p.ResourceId) ?? policiesByResource.set(p.ResourceId, []).get(p.ResourceId)!).push(p);
    }
    const scheduledByResource = new Map<string, unknown[]>();
    for (const s of scheduledRes.ScheduledActions ?? []) {
        if (!s.ResourceId) continue;
        (scheduledByResource.get(s.ResourceId) ?? scheduledByResource.set(s.ResourceId, []).get(s.ResourceId)!).push(s);
    }

    return (targetsRes.ScalableTargets ?? [])
        .filter((t) => !!t.ResourceId)
        .map((t) => {
            const id = t.ResourceId!;
            const policies = policiesByResource.get(id) ?? [];
            const scheduledActions = scheduledByResource.get(id) ?? [];
            return {
                resourceId: id,
                policies,
                scheduledActions,
                minCapacity: t.MinCapacity,
                maxCapacity: t.MaxCapacity,
                configHash: hashConfig(policies, scheduledActions, t.MinCapacity, t.MaxCapacity),
            };
        });
}

/** Upsert snapshots — writes only touch lastSeenAt when configHash is unchanged
 *  (ON CONFLICT DO UPDATE), so history only grows on an actual config change. */
export async function upsertPolicySnapshots(
    tenantId: string,
    accountId: string,
    region: string,
    scope: 'asg' | 'ecs',
    items: PolicySnapshotItem[]
): Promise<number> {
    if (!items.length) return 0;
    const { getPool } = await import('../../discovery/services/db.js');
    const client = await getPool().connect();
    let written = 0;
    try {
        for (const item of items) {
            await client.query(
                `INSERT INTO scaling_policy_snapshots
                    (id, "tenantId", "accountId", region, scope, "resourceId", "configHash",
                     policies, "scheduledActions", "minCapacity", "maxCapacity", "firstSeenAt", "lastSeenAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, now(), now())
                 ON CONFLICT ("tenantId", "accountId", region, scope, "resourceId", "configHash")
                 DO UPDATE SET "lastSeenAt" = now()`,
                [
                    tenantId, accountId, region, scope, item.resourceId, item.configHash,
                    JSON.stringify(item.policies), JSON.stringify(item.scheduledActions),
                    item.minCapacity ?? null, item.maxCapacity ?? null,
                ]
            );
            written += 1;
        }
        return written;
    } finally {
        client.release();
    }
}
