// workers/src/jobs/spot-guard/bus-policy.ts
//
// Owner of the Spot Guard event bus resource policy (SG-005) — the allowlist of
// customer AWS accounts permitted to PutEvents onto the hub bus.
//
// WHY THIS LIVES IN THE WORKER AND NOT IN PULUMI
// The allowlist changes at runtime: accounts are onboarded and removed, and
// Account.spotAutomationEnabled is toggled from the UI. A Pulumi-managed
// aws.cloudwatch.EventBusPolicy would revert every one of those changes on the next
// `pulumi up`, silently cutting off every customer added since the last deploy. So
// infra/compute/index.ts deliberately declares NO bus policy, and this module is the
// single writer.
//
// WHY IT REBUILDS THE WHOLE DOCUMENT EVERY TIME
// events:PutPermission with a `Policy` argument REPLACES the entire bus policy. A
// read-modify-write would lose statements whenever two onboardings raced. Rebuilding
// from Postgres makes the write idempotent and self-healing: whatever the bus policy
// says, one run brings it to match the database.
//
// SECURITY POSTURE — what this allowlist does and does not buy
// The `account` field on a delivered EventBridge event is stamped by EventBridge from
// the authenticated caller and is NOT settable by the sender (PutEventsRequestEntry has
// no Account field), and EventBridge refuses to relay an event a second hop. So an
// unauthorized sender can only inject events attributed to ITSELF, which the consumer
// drops when the account resolves to no tenant. That makes this allowlist a
// cost/DoS and blast-radius control, NOT the integrity control. Integrity comes from
// the consumer: account→tenant resolution, the ARN/account cross-check, and the fact
// that every mutation goes through that tenant's own assumed role.
import {
    EventBridgeClient,
    PutPermissionCommand,
    RemovePermissionCommand,
    DescribeEventBusCommand,
} from '@aws-sdk/client-eventbridge';
import { getPool } from '../discovery/services/db.js';
import { createLogger } from '../../lib/logger.js';
import { env } from '../../env.js';

const log = createLogger('spot-guard-bus-policy');

/** Single managed statement. Reused as the RemovePermission target. */
const STATEMENT_ID = 'NucleusSpotGuardSpokes';

/**
 * EventBridge caps a bus resource policy at 10,240 characters, enforced with
 * PolicyLengthExceededException.
 *
 * Sizing decided the design. One statement per account (the shape
 * PutPermission's scalar Principal argument produces) costs ~225 chars including the
 * expanded arn:aws:iam::<id>:root principal and the bus ARN → ~45 accounts, which is
 * a disqualifying ceiling for a SaaS product. One statement whose
 * aws:PrincipalAccount condition holds the list costs ~276 chars plus ~15 per account
 * → ~660 accounts, roughly 14x better. Hence the single-statement shape below.
 */
const POLICY_SIZE_LIMIT = 10_240;

/** Warn well before the hard limit — see the log call for why. */
const POLICY_SIZE_WARN_PCT = 80;

let client: EventBridgeClient | null = null;
function getClient(): EventBridgeClient {
    // Region comes from the ambient task role / AWS_REGION, same as
    // lib/observability.ts and executor/horizontal.ts.
    if (!client) client = new EventBridgeClient({});
    return client;
}

/**
 * Every distinct AWS account that at least one active tenant has onboarded AND
 * enabled Spot automation for.
 *
 * DELIBERATELY CROSS-TENANT. The unit of authorization here is an AWS account, not a
 * tenant: `accounts` is unique on [tenantId, accountId], so the same AWS account can be
 * registered by more than one tenant, and DISTINCT collapses that to one allowlist
 * entry. Raw pg because the getTenantClient() extension neither applies to nor should
 * apply to this query.
 */
async function listSpotEnabledAccountIds(): Promise<string[]> {
    const dbClient = await getPool().connect();
    try {
        const { rows } = await dbClient.query<{ accountId: string }>(
            `SELECT DISTINCT "accountId"
               FROM accounts
              WHERE active = true
                AND "spotAutomationEnabled" = true
              ORDER BY "accountId" ASC`,
        );
        return rows.map((r) => r.accountId);
    } finally {
        dbClient.release();
    }
}

export function buildBusPolicyDocument(busArn: string, accountIds: string[]): string {
    return JSON.stringify({
        Version: '2012-10-17',
        Statement: [
            {
                Sid: STATEMENT_ID,
                Effect: 'Allow',
                // Principal "*" narrowed by a condition is AWS's own documented idiom
                // for this (their example uses aws:PrincipalOrgID). We substitute
                // aws:PrincipalAccount because Nucleus customers are NOT in the hub's
                // AWS Organization — they are separate companies — so no OrgID exists
                // to match on.
                Principal: '*',
                Action: 'events:PutEvents',
                Resource: busArn,
                Condition: {
                    StringEquals: { 'aws:PrincipalAccount': accountIds },
                },
            },
        ],
    });
}

/**
 * Reconcile the bus policy to match the database. Idempotent; safe to run on every
 * worker start, on every account mutation, and on the hourly safety-net cron.
 */
export async function handleBusPolicyReconcile(): Promise<void> {
    const busName = env.SPOT_GUARD_BUS_NAME;
    if (!busName) {
        // Expected on any stack that has not opted in (prod today) — not an error.
        log.debug('SPOT_GUARD_BUS_NAME unset — bus policy reconcile skipped');
        return;
    }

    const accountIds = await listSpotEnabledAccountIds();
    const eb = getClient();

    // An empty allowlist cannot be expressed: StringEquals with [] is invalid, and a
    // Principal "*" statement with no condition would open the bus to the world.
    // Remove the statement instead, which restores the fail-closed default of
    // hub-account principals only.
    if (accountIds.length === 0) {
        try {
            await eb.send(new RemovePermissionCommand({ EventBusName: busName, StatementId: STATEMENT_ID }));
            log.info('Bus policy: no Spot-enabled accounts — statement removed (bus is now hub-only)');
        } catch (err) {
            const name = (err as { name?: string }).name;
            // Nothing to remove is the steady state before the first onboarding.
            if (name === 'ResourceNotFoundException') {
                log.info('Bus policy: no Spot-enabled accounts and no statement present — nothing to do');
                return;
            }
            throw err;
        }
        return;
    }

    const { Arn: busArn } = await eb.send(new DescribeEventBusCommand({ Name: busName }));
    if (!busArn) throw new Error(`DescribeEventBus returned no ARN for bus ${busName}`);

    const policy = buildBusPolicyDocument(busArn, accountIds);
    const pct = Math.round((policy.length / POLICY_SIZE_LIMIT) * 100);

    // Alarm BEFORE the hard limit. Hitting PolicyLengthExceededException would strand
    // the NEXT onboarded customer with no events arriving and no obvious cause — a
    // failure that looks like "Spot Guard is broken for one customer" rather than
    // "the allowlist is full". The escape hatch is documented in the plan: swap the
    // StringEquals list for a constant-size ArnLike on aws:PrincipalArn.
    if (pct >= POLICY_SIZE_WARN_PCT) {
        log.error('Bus policy approaching the EventBridge 10240-char limit', {
            metric: 'spotguard.bus_policy.size_pct',
            pct,
            bytes: policy.length,
            accounts: accountIds.length,
        });
    }

    await eb.send(new PutPermissionCommand({ EventBusName: busName, Policy: policy }));
    log.info('Bus policy reconciled', { accounts: accountIds.length, bytes: policy.length, pct });
}
