// Main Scheduler Service
// Orchestrates schedule-centric processing - iterates through schedules and their resources (ARN-driven)

import { logger } from '../utils/logger.js';
import { env } from '../../../env.js';
import {
    createAuditLog,
    createExecutionAuditLog,
} from './dynamodb-service.js';
import {
    getActiveTenants,
    getSchedules as getSchedulesPg,
    getScheduleById as getScheduleByIdPg,
    getAccounts as getAccountsPg,
    logExecution as logExecutionPg,
} from './pg-service.js';

// USE_PG_SCHEDULES=true routes schedule reads/writes to PostgreSQL
const USE_PG_SCHEDULES = env.USE_PG_SCHEDULES === 'true';
import {
    createExecutionRecord,
    updateExecutionRecord,
    getLastECSServiceState,
    getLastEC2InstanceState,
    getLastRDSInstanceState,
    getLastASGState,
    type CreateExecutionParams,
} from './execution-history-service.js';
import { assumeRole } from './sts-service.js';
import {
    processEC2Resource,
    processRDSResource,
    processECSResource,
    processASGResource,
    processDocDBResource,
} from '../resource-schedulers/index.js';
import { isCurrentTimeInRange } from '../utils/time-utils.js';
import type {
    Schedule,
    ScheduleResource,
    Account,
    SchedulerEvent,
    SchedulerResult,
    SchedulerMetadata,
    ScheduleExecutionMetadata,
    ExecutionStatus,
    EC2ResourceExecution,
    ECSResourceExecution,
    RDSResourceExecution,
    ASGResourceExecution,

} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Derive the execution status from action counts.
 * - `failed`  : work was attempted but nothing succeeded (0 started/stopped, >0 failed)
 * - `partial` : some succeeded, some failed
 * - `success` : no failures
 */
export function computeExecutionStatus(started: number, stopped: number, failed: number): ExecutionStatus {
    if (failed > 0 && started + stopped === 0) return 'failed';
    if (failed > 0) return 'partial';
    return 'success';
}

/**
 * Status for a completed schedule run, including the no-op case. A run that changed
 * nothing (0 started / 0 stopped / 0 failed — every resource already in the desired
 * state) is 'no_action'. Unlike a pure success, it did no work, but it is still
 * recorded so execution history faithfully reflects that the schedule ran.
 */
export function resolveRunStatus(started: number, stopped: number, failed: number): ExecutionStatus {
    if (started === 0 && stopped === 0 && failed === 0) return 'no_action';
    return computeExecutionStatus(started, stopped, failed);
}

/**
 * Record a resource as failed in the execution metadata so account/region-level
 * failures (assume-role, account-not-found, unexpected throws) surface per-resource
 * in the execution detail UI — not just in the aggregate count.
 */
export function pushFailedResource(
    meta: ScheduleExecutionMetadata,
    resource: ScheduleResource,
    action: 'start' | 'stop',
    error: string
): void {
    const base = { arn: resource.arn, resourceId: resource.id, action, status: 'failed' as const, error };
    switch (resource.type) {
        case 'ec2':
            meta.ec2.push({ ...base, last_state: { instanceState: 'unknown' } });
            break;
        case 'rds':
            meta.rds.push({ ...base, last_state: { dbInstanceStatus: 'unknown' } });
            break;
        case 'ecs':
            meta.ecs.push({ ...base, clusterArn: resource.clusterArn ?? 'unknown', last_state: { desiredCount: 0, runningCount: 0 } });
            break;
        case 'asg':
            meta.asg.push({ ...base, last_state: { minSize: 0, maxSize: 0, desiredCapacity: 0 } });
            break;
        case 'docdb':
            meta.docdb.push({ ...base, last_state: { dbInstanceStatus: 'unknown' } });
            break;
    }
}

/**
 * Run a full scan - process all active schedules
 */
export async function runFullScan(
    triggeredBy: 'system' | 'web-ui' = 'system',
    tenantIdFilter?: string
): Promise<SchedulerResult> {
    const executionId = uuidv4();
    const startTime = Date.now();

    logger.setContext({ executionId, mode: 'full' });
    logger.info(`Starting full scan${tenantIdFilter ? ` (scoped to tenant ${tenantIdFilter})` : ''}`);

    let totalStarted = 0;
    let totalStopped = 0;
    let totalFailed = 0;
    let totalSchedulesProcessed = 0;
    const aggregatedErrors: string[] = [];
    const processedSchedules: Array<{
        scheduleId: string;
        scheduleName: string;
        started: number;
        stopped: number;
        failed: number;
        status: 'success' | 'partial' | 'error';
    }> = [];

    let processedTenantIds: string[] = [];

    {
        // Iterate all active tenants (optionally scoped to one tenant)
        const allTenants = await getActiveTenants();
        const tenants = tenantIdFilter ? allTenants.filter(t => t.id === tenantIdFilter) : allTenants;
        logger.info(`Found ${tenants.length} active tenants${tenantIdFilter ? ` (filtered from ${allTenants.length})` : ''}`);

        if (tenants.length === 0) {
            logger.info('No active tenants to process');
            return createResult(executionId, 'full', startTime, 0, 0, 0, 0, []);
        }

        // D-09: Process tenants sequentially
        for (const tenant of tenants) {
            logger.info(`Processing tenant: ${tenant.name} (${tenant.id})`);
            const schedules = (await getSchedulesPg(tenant.id)).filter(s => s.type === 'schedule');
            const accounts = await getAccountsPg(tenant.id);
            logger.info(`Tenant ${tenant.name}: ${schedules.length} active schedules, ${accounts.length} accounts`);

            if (schedules.length === 0 || accounts.length === 0) {
                continue;
            }
            processedTenantIds.push(tenant.id);

            // Process this tenant's schedules with bounded concurrency (each schedule
            // typically maps to a single account, so the sequential loop was the real
            // bottleneck — ~N × per-schedule latency). Shared counters/arrays are safe
            // to mutate here: Node interleaves these tasks only at await points.
            let scheduleIdx = 0;
            await mapWithConcurrency(schedules, getAccountScanConcurrency(), async (schedule) => {
                const n = ++scheduleIdx;
                logger.info(`[${tenant.name}] schedule ${n}/${schedules.length}: ${schedule.name}`);
                const outcome = await scanOneSchedule(schedule, accounts, triggeredBy, `for tenant ${tenant.id}`);
                totalStarted += outcome.started;
                totalStopped += outcome.stopped;
                totalFailed += outcome.failed;
                totalSchedulesProcessed++;
                aggregatedErrors.push(...outcome.errors.map(e => `[${schedule.name}] ${e}`));
                processedSchedules.push({ scheduleId: schedule.scheduleId, scheduleName: schedule.name, ...outcome.counts });
            });
        }
    }

    const overallStatus = totalFailed > 0 ? (totalStarted + totalStopped > 0 ? 'warning' : 'error') : 'success';

    // Write per-tenant audit logs so each tenant can see the full scan in their audit grid
    for (const tenantId of processedTenantIds) {
        await createAuditLog({
            type: 'audit_log',
            eventType: 'schedule.execution.completed',
            action: 'full_scan',
            user: 'system',
            userType: 'system',
            resourceType: 'Schedule',
            resourceId: executionId,
            status: overallStatus,
            details: `Full scan completed: ${totalStarted} started, ${totalStopped} stopped, ${totalFailed} failed`
                + (aggregatedErrors.length > 0 ? `. ${aggregatedErrors.length} error(s) — first: ${aggregatedErrors[0]}` : ''),
            severity: totalFailed > 0 ? (totalStarted + totalStopped > 0 ? 'medium' : 'high') : 'low',
            tenantId,
            metadata: {
                executionId,
                schedulesProcessed: totalSchedulesProcessed,
                resourcesStarted: totalStarted,
                resourcesStopped: totalStopped,
                resourcesFailed: totalFailed,
                errorCount: aggregatedErrors.length,
                errors: aggregatedErrors.slice(0, 50),
                scheduleDetails: processedSchedules,
            },
        });
    }

    logger.info('Full scan completed', { totalStarted, totalStopped, totalFailed, errorCount: aggregatedErrors.length });
    if (aggregatedErrors.length > 0) {
        logger.error(`Full scan finished with ${aggregatedErrors.length} error(s):\n  - ${aggregatedErrors.slice(0, 50).join('\n  - ')}`);
    }

    return createResult(
        executionId,
        'full',
        startTime,
        totalSchedulesProcessed,
        totalStarted,
        totalStopped,
        totalFailed,
        processedTenantIds,
        aggregatedErrors
    );
}

/**
 * Run a partial scan - process a specific schedule only
 */
export async function runPartialScan(
    event: SchedulerEvent,
    triggeredBy: 'system' | 'web-ui' = 'web-ui'
): Promise<SchedulerResult> {
    const executionId = uuidv4();
    const startTime = Date.now();
    const scheduleId = event.scheduleId || event.scheduleName;
    const userEmail = event.userEmail;

    if (!scheduleId) {
        throw new Error('scheduleId or scheduleName is required for partial scan');
    }

    if (!event.tenantId) {
        throw new Error('tenantId is required for partial scan');
    }

    logger.setContext({ executionId, mode: 'partial', scheduleId, user: userEmail || 'system' });
    logger.info(`Starting partial scan for schedule: ${scheduleId}`);

    // Fetch the specific schedule from PostgreSQL
    const schedule = await getScheduleByIdPg(scheduleId, event.tenantId);
    if (!schedule) {
        // Log audit for schedule not found error
        await createAuditLog({
            type: 'audit_log',
            eventType: 'schedule.execution.failed',
            action: 'partial_scan',
            user: userEmail || 'system',
            userType: userEmail ? 'user' : 'system',
            resourceType: 'Schedule',
            resourceId: scheduleId,
            status: 'error',
            details: `Partial scan failed: Schedule not found: ${scheduleId}`,
            severity: 'high',
            tenantId: event.tenantId,
            metadata: {
                scheduleId,
                triggeredBy,
            },
        });
        throw new Error(`Schedule not found: ${scheduleId}`);
    }

    logger.debug('Fetched schedule for partial scan', { schedule });

    const accounts = await getAccountsPg(event.tenantId);
    logger.debug(`Fetched ${accounts.length} active accounts for partial scan`);

    try {
        const result = await processSchedule(schedule, accounts, triggeredBy, userEmail);

        const overallStatus = result.failed > 0 ? (result.started + result.stopped > 0 ? 'warning' : 'error') : 'success';

        // Log audit for partial scan completion (similar to full_scan)
        await createAuditLog({
            type: 'audit_log',
            eventType: 'schedule.execution.completed',
            action: 'partial_scan',
            user: userEmail || 'system',
            userType: userEmail ? 'user' : 'system',
            resourceType: 'Schedule',
            resourceId: executionId,
            status: overallStatus,
            details: `Partial scan completed for "${schedule.name}": ${result.started} started, ${result.stopped} stopped, ${result.failed} failed`
                + (result.errors.length > 0 ? `. ${result.errors.length} error(s) — first: ${result.errors[0]}` : ''),
            severity: result.failed > 0 ? (result.started + result.stopped > 0 ? 'medium' : 'high') : 'low',
            tenantId: event.tenantId,
            metadata: {
                executionId,
                scheduleId: schedule.scheduleId,
                scheduleName: schedule.name,
                resourcesStarted: result.started,
                resourcesStopped: result.stopped,
                resourcesFailed: result.failed,
                errorCount: result.errors.length,
                errors: result.errors.slice(0, 50),
                triggeredBy,
            },
        });

        logger.info('Partial scan completed', { ...result, errorCount: result.errors.length });
        if (result.errors.length > 0) {
            logger.error(`Partial scan for "${schedule.name}" finished with ${result.errors.length} error(s):\n  - ${result.errors.join('\n  - ')}`);
        }

        return createResult(
            executionId,
            'partial',
            startTime,
            1,
            result.started,
            result.stopped,
            result.failed,
            [event.tenantId],
            result.errors
        );
    } catch (error) {
        // Log audit for partial scan failure
        await createAuditLog({
            type: 'audit_log',
            eventType: 'schedule.execution.failed',
            action: 'partial_scan',
            user: userEmail || 'system',
            userType: userEmail ? 'user' : 'system',
            resourceType: 'Schedule',
            resourceId: executionId,
            status: 'error',
            details: `Partial scan failed for "${schedule.name}": ${error instanceof Error ? error.message : String(error)}`,
            severity: 'high',
            tenantId: event.tenantId,
            metadata: {
                scheduleId: schedule.scheduleId,
                scheduleName: schedule.name,
                triggeredBy,
                error: error instanceof Error ? error.message : String(error),
            },
        });
        logger.error(`Partial scan failed for schedule ${scheduleId}`, error);
        throw error;
    }
}

type ScheduleOutcome = {
    started: number;
    stopped: number;
    failed: number;
    errors: string[];
    counts: { started: number; stopped: number; failed: number; status: 'success' | 'partial' | 'error' };
};

/**
 * Run one schedule and normalize the result (including a fatal throw) into a
 * uniform outcome the full-scan accumulator can fold in. Isolating the try/catch
 * here lets both the PG and Dynamo scan loops run schedules concurrently without
 * duplicating the error-handling shape.
 */
async function scanOneSchedule(
    schedule: Schedule,
    accounts: Account[],
    triggeredBy: 'system' | 'web-ui',
    errorContext = ''
): Promise<ScheduleOutcome> {
    logger.debug(`Processing schedule: ${schedule.scheduleId} (${schedule.name})`, { schedule });
    try {
        const result = await processSchedule(schedule, accounts, triggeredBy);
        const status: 'success' | 'partial' | 'error' =
            result.failed > 0 ? (result.started + result.stopped > 0 ? 'partial' : 'error') : 'success';
        return {
            started: result.started,
            stopped: result.stopped,
            failed: result.failed,
            errors: result.errors,
            counts: { started: result.started, stopped: result.stopped, failed: result.failed, status },
        };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Error processing schedule ${schedule.scheduleId}${errorContext ? ' ' + errorContext : ''}`, error);
        return {
            started: 0,
            stopped: 0,
            failed: 1,
            errors: [`Fatal: ${errMsg}`],
            counts: { started: 0, stopped: 0, failed: 1, status: 'error' },
        };
    }
}

/**
 * Process a single schedule and all its resources
 *
 * Key behaviors:
 * - Creates execution record only if actual actions (start/stop) are performed
 * - Retrieves and uses last recorded state for intelligent state restoration
 * - Creates a summarized audit log entry for the execution
 */
async function processSchedule(
    schedule: Schedule,
    accounts: Account[],
    triggeredBy: 'system' | 'web-ui',
    userEmail?: string
): Promise<{ started: number; stopped: number; failed: number; errors: string[] }> {
    const resources = schedule.resources || [];
    const scheduleStartTime = Date.now();

    if (!schedule.tenantId) {
        logger.warn(`Schedule ${schedule.scheduleId} has no tenantId, skipping`);
        return { started: 0, stopped: 0, failed: 0, errors: [] };
    }
    const tenantId: string = schedule.tenantId;

    logger.info(`Processing schedule: ${schedule.name} (${schedule.scheduleId}) with ${resources.length} resources`);

    if (resources.length === 0) {
        logger.info(`Schedule ${schedule.name} has no resources, skipping`);
        return { started: 0, stopped: 0, failed: 0, errors: [] };
    }

    // Determine the action based on time window. SCHEDULER_FORCE_ACTION overrides
    // the window (for testing); SCHEDULER_DRY_RUN makes resource ops read-only.
    const inRange = isCurrentTimeInRange(
        schedule.starttime,
        schedule.endtime,
        schedule.timezone,
        schedule.days
    );
    // Read as runtime toggles (not frozen env) so a local runner can set them
    // just before invoking a scan. Documented in env.ts.
    const forceRaw = process.env.SCHEDULER_FORCE_ACTION;
    const forcedAction: 'start' | 'stop' | undefined =
        forceRaw === 'start' || forceRaw === 'stop' ? forceRaw : undefined;
    const action: 'start' | 'stop' = forcedAction ?? (inRange ? 'start' : 'stop');
    const dryRun = process.env.SCHEDULER_DRY_RUN === 'true';

    logger.info(`Schedule ${schedule.name}: inRange=${inRange}, action=${action}${forcedAction ? ' (FORCED)' : ''}${dryRun ? ' [DRY RUN]' : ''}`);
    logger.debug(`Time check details for ${schedule.name}`, {
        starttime: schedule.starttime,
        endtime: schedule.endtime,
        timezone: schedule.timezone,
        days: schedule.days,
        inRange,
        action
    });

    // Prepare execution params (but don't create record yet)
    const execParams: CreateExecutionParams = {
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        tenantId,
        accountId: schedule.accountId || 'system',
        triggeredBy,
    };

    // Generate execution ID upfront for metadata consistency
    const executionId = uuidv4();

    // Group resources by account (extract from ARN)
    const resourcesByAccount = groupResourcesByAccount(resources, accounts);
    logger.debug(`Grouped resources by account for ${schedule.name}`, {
        accountCount: resourcesByAccount.size,
        accounts: Array.from(resourcesByAccount.keys())
    });

    // Initialize execution metadata
    const scheduleMetadata: ScheduleExecutionMetadata = {
        ec2: [],
        ecs: [],
        rds: [],
        asg: [],
        docdb: [],
    };

    let started = 0;
    let stopped = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process resources by account, with bounded concurrency across accounts so a
    // schedule spanning ~100 accounts scans in a few seconds instead of ~100s
    // sequentially. The shared counters/arrays mutated below are safe to touch from
    // these tasks: Node runs them on a single thread and only interleaves at await
    // points, so the synchronous `x++` / `arr.push(...)` never race.
    const accountEntries = Array.from(resourcesByAccount.entries());
    const totalAccounts = accountEntries.length;
    let accountsCompleted = 0;
    await mapWithConcurrency(accountEntries, getAccountScanConcurrency(), async ([accountId, accountResources]) => {
        logger.info(`[${schedule.name}] scanning account ${accountId} (${accountResources.resources.length} resource(s))`);
        logger.debug(`Processing resources for account ${accountId}`, {
            resourceCount: accountResources.resources.length
        });

        const account = accounts.find((a) => a.accountId === accountId);
        if (!account) {
            const errMsg = `Account ${accountId} not found among active accounts (referenced by ${accountResources.resources.length} resource(s) in schedule "${schedule.name}")`;
            logger.error(errMsg);
            failed += accountResources.resources.length;
            errors.push(errMsg);
            for (const r of accountResources.resources) {
                pushFailedResource(scheduleMetadata, r, action, errMsg);
            }
            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.account.error',
                action,
                user: userEmail || 'system',
                userType: userEmail ? 'user' : 'system',
                resourceType: 'account',
                resourceId: accountId,
                status: 'error',
                details: errMsg,
                severity: 'high',
                tenantId,
                accountId,
                metadata: { scheduleId: schedule.scheduleId, scheduleName: schedule.name, executionId },
            });
            return;
        }

        // Group resources by region
        const resourcesByRegion = groupResourcesByRegion(accountResources.resources);
        logger.debug(`Grouped resources by region for account ${accountId}`, {
            regions: Array.from(resourcesByRegion.keys())
        });

        for (const [region, regionResources] of resourcesByRegion) {
            logger.debug(`Processing region ${region} for account ${accountId}`, {
                resourceCount: regionResources.length
            });

            try {
                const credentials = await assumeRole(account.roleArn, account.accountId, region, account.externalId);
                logger.debug(`Successfully assumed role for ${accountId} in ${region}`);

                const metadata: SchedulerMetadata = {
                    account: {
                        name: account.accountName || account.name || account.accountId,
                        accountId: account.accountId,
                    },
                    region,
                    executionId: executionId,
                    scheduleId: schedule.scheduleId,
                    scheduleName: schedule.name,
                    dryRun,
                };

                // Process each resource
                for (const resource of regionResources) {
                    logger.debug(`Processing resource ${resource.arn} (${resource.type})`);
                    try {
                        if (resource.type === 'ec2') {

                            // For EC2 start, get last state to verify resource was managed by scheduler
                            let lastState: { instanceState: string; instanceType?: string } | undefined;
                            if (action === 'start') {
                                const savedState = await getLastEC2InstanceState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    tenantId
                                );
                                lastState = savedState || undefined;
                                if (lastState) {
                                    logger.debug(`EC2 ${resource.id}: Found last state - instanceState=${lastState.instanceState}`);
                                }
                            }
                            const result = await processEC2Resource(resource, schedule, action, credentials, metadata, lastState);
                            scheduleMetadata.ec2.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ }, errors, `${resource.type.toUpperCase()} ${resource.id} (${accountId}/${region})`);
                        } else if (resource.type === 'rds') {
                            // For RDS start, get last state to verify resource was managed by scheduler
                            let lastState: { dbInstanceStatus: string; dbInstanceClass?: string } | undefined;
                            if (action === 'start') {
                                const savedState = await getLastRDSInstanceState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    tenantId
                                );
                                lastState = savedState || undefined;
                                if (lastState) {
                                    logger.debug(`RDS ${resource.id}: Found last state - dbInstanceStatus=${lastState.dbInstanceStatus}`);
                                }
                            }
                            const result = await processRDSResource(resource, schedule, action, credentials, metadata, lastState);
                            scheduleMetadata.rds.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ }, errors, `${resource.type.toUpperCase()} ${resource.id} (${accountId}/${region})`);
                        } else if (resource.type === 'ecs') {
                            // For ECS start, get last desiredCount from previous execution
                            let lastDesiredCount: number | undefined;
                            let lastAsgState: any;
                            if (action === 'start') {
                                const lastState = await getLastECSServiceState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    tenantId
                                );
                                lastDesiredCount = lastState?.desiredCount;
                                lastAsgState = lastState?.asg_state;
                            }
                            const result = await processECSResource(resource, schedule, action, credentials, metadata, lastDesiredCount, lastAsgState);
                            scheduleMetadata.ecs.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ }, errors, `${resource.type.toUpperCase()} ${resource.id} (${accountId}/${region})`);
                        } else if (resource.type === 'asg') {
                            // For ASG start, get last state from previous execution
                            let lastState: { minSize: number; maxSize: number; desiredCapacity: number } | undefined;
                            if (action === 'start') {
                                const savedState = await getLastASGState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    tenantId
                                );
                                lastState = savedState || undefined;
                                if (lastState) {
                                    logger.debug(`ASG ${resource.id}: Found last state - desiredCapacity=${lastState.desiredCapacity}`);
                                }
                            }
                            const result = await processASGResource(resource, schedule, action, credentials, metadata, lastState);
                            scheduleMetadata.asg.push(result);

                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ }, errors, `${resource.type.toUpperCase()} ${resource.id} (${accountId}/${region})`);
                        } else if (resource.type === 'docdb') {
                            // For DocumentDB, we currently don't use lastState for simple Start/Stop
                            const result = await processDocDBResource(resource, schedule, action, credentials, metadata, undefined);
                            scheduleMetadata.docdb.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ }, errors, `${resource.type.toUpperCase()} ${resource.id} (${accountId}/${region})`);
                        }
                    } catch (error) {
                        const errMsg = error instanceof Error ? error.message : String(error);
                        logger.error(`Error processing resource ${resource.arn}`, error);
                        failed++;
                        errors.push(`${resource.type.toUpperCase()} ${resource.id} (${accountId}/${region}): ${errMsg}`);
                        pushFailedResource(scheduleMetadata, resource, action, errMsg);
                    }
                }
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error(`Failed to assume role for account ${accountId} in region ${region}`, error);
                failed += regionResources.length;
                errors.push(`AssumeRole failed for account ${accountId} in ${region}: ${errMsg}`);
                for (const r of regionResources) {
                    pushFailedResource(scheduleMetadata, r, action, `AssumeRole failed: ${errMsg}`);
                }
                await createAuditLog({
                    type: 'audit_log',
                    eventType: 'scheduler.assume_role.error',
                    action,
                    user: userEmail || 'system',
                    userType: userEmail ? 'user' : 'system',
                    resourceType: 'account',
                    resourceId: accountId,
                    status: 'error',
                    details: `Failed to assume role for account ${accountId} in ${region} (${regionResources.length} resource(s) affected): ${errMsg}`,
                    severity: 'high',
                    tenantId,
                    accountId,
                    region,
                    metadata: { scheduleId: schedule.scheduleId, scheduleName: schedule.name, executionId, roleArn: account.roleArn },
                });
            }
        }

        accountsCompleted++;
        logger.info(`[${schedule.name}] account ${accountId} done (${accountsCompleted}/${totalAccounts})`);
    });

    const hasActions = started > 0 || stopped > 0 || failed > 0;
    const duration = Date.now() - scheduleStartTime;
    // A no-op run (nothing to start/stop/fail — every resource already in the desired
    // state) still gets recorded so execution history reflects that the schedule ran;
    // it just carries the 'no_action' status instead of a success/partial/failed one.
    const status: ExecutionStatus = resolveRunStatus(started, stopped, failed);
    // Aggregated error summary for the execution row (top-level errorMessage).
    // Per-resource detail lives in scheduleMetadata; this is the rolled-up view.
    const errorMessage = errors.length > 0 ? errors.slice(0, 10).join(' | ') : undefined;

    // ALWAYS write a schedule_executions row (incl. no-op runs) so the UI's execution
    // history is a faithful record of every evaluation, not just runs that changed a
    // resource. Reuse the single `executionId` so a summary audit log (below, actioned
    // runs only) can be joined to this row.
    if (USE_PG_SCHEDULES) {
        try {
            await logExecutionPg({
                tenantId: execParams.tenantId,
                executionId,
                scheduleId: execParams.scheduleId,
                accountId: execParams.accountId ?? 'unknown',
                status,
                executionTime: new Date().toISOString(),
                resourcesStarted: started,
                resourcesStopped: stopped,
                resourcesFailed: failed,
                duration,
                errorMessage,
                scheduleMetadata,
            });
            logger.info(`[pg-service] Execution record written to PostgreSQL for schedule ${schedule.name} (status=${status})`);
        } catch (pgError) {
            logger.warn('[scheduler-service] Failed to write execution to PostgreSQL (non-fatal)', { error: String(pgError) });
        }
    }

    // Audit trail + DynamoDB execution record are for actual resource modifications
    // only — a no-op changes nothing, so it produces no audit noise.
    if (hasActions) {
        // Create execution record now that we know actions were performed (shares executionId)
        const execRecord = await createExecutionRecord({ ...execParams, executionId });

        // Update execution record with final results and metadata
        await updateExecutionRecord(execRecord, {
            status,
            resourcesStarted: started,
            resourcesStopped: stopped,
            resourcesFailed: failed,
            errorMessage,
            schedule_metadata: scheduleMetadata,
        });

        // Create summarized audit log for this execution
        await createExecutionAuditLog(execRecord.executionId, schedule, scheduleMetadata, {
            resourcesStarted: started,
            resourcesStopped: stopped,
            resourcesFailed: failed,
            duration,
        }, userEmail);

        logger.info(`Schedule ${schedule.name} execution recorded: ${started} started, ${stopped} stopped, ${failed} failed (status=${status})`);
        if (errors.length > 0) {
            logger.error(`Schedule "${schedule.name}" completed with ${errors.length} error(s):\n  - ${errors.join('\n  - ')}`);
        }
    } else {
        logger.info(`Schedule ${schedule.name}: no actions performed (all resources already in desired state) — recorded as no_action`);
    }

    return { started, stopped, failed, errors };
}

/**
 * Group resources by AWS account ID (extracted from ARN)
 */
function groupResourcesByAccount(
    resources: Schedule['resources'],
    _accounts: Account[]
): Map<string, { resources: NonNullable<Schedule['resources']> }> {
    const map = new Map<string, { resources: NonNullable<Schedule['resources']> }>();

    for (const resource of resources || []) {
        const accountId = extractAccountIdFromArn(resource.arn);
        if (!accountId) {
            logger.warn(`Could not extract account ID from ARN: ${resource.arn}`);
            continue;
        }

        if (!map.has(accountId)) {
            map.set(accountId, { resources: [] });
        }
        map.get(accountId)!.resources.push(resource);
    }

    return map;
}

/**
 * Group resources by AWS region (extracted from ARN)
 */
function groupResourcesByRegion(
    resources: NonNullable<Schedule['resources']>
): Map<string, NonNullable<Schedule['resources']>> {
    const map = new Map<string, NonNullable<Schedule['resources']>>();

    for (const resource of resources) {
        const region = extractRegionFromArn(resource.arn);
        if (!region) {
            logger.warn(`Could not extract region from ARN: ${resource.arn}`);
            continue;
        }

        if (!map.has(region)) {
            map.set(region, []);
        }
        map.get(region)!.push(resource);
    }

    return map;
}

/**
 * Extract AWS account ID from ARN
 * ARN format: arn:aws:service:region:account-id:resource
 */
function extractAccountIdFromArn(arn: string): string | null {
    const parts = arn.split(':');
    if (parts.length < 5) {
        return null;
    }
    return parts[4];
}

/**
 * Extract region from ARN
 * ARN format: arn:aws:service:region:account-id:resource
 */
function extractRegionFromArn(arn: string): string | null {
    const parts = arn.split(':');
    if (parts.length < 4) {
        return null;
    }
    return parts[3];
}

/**
 * Per-schedule account-scan concurrency, read at runtime (like the dry-run
 * toggles) so it can be tuned without a rebuild. Default 8, clamped to [1, 32].
 */
function getAccountScanConcurrency(): number {
    const raw = Number(process.env.SCHEDULER_ACCOUNT_CONCURRENCY);
    if (!Number.isFinite(raw) || raw < 1) return 8;
    return Math.min(Math.floor(raw), 32);
}

/**
 * Run `fn` over `items` with at most `limit` tasks in flight at once.
 * A worker pool pulls from a shared cursor; rejections propagate via Promise.all
 * (the per-account body already try/catches its own AWS work, so tasks resolve).
 */
export async function mapWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>
): Promise<void> {
    let cursor = 0;
    const poolSize = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: poolSize }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            await fn(items[idx]);
        }
    });
    await Promise.all(workers);
}

/**
 * Update counts based on resource execution result
 */
function updateCounts(
    result: EC2ResourceExecution | ECSResourceExecution | RDSResourceExecution | ASGResourceExecution,
    _action: 'start' | 'stop',
    counters: { started: () => void; stopped: () => void; failed: () => void },
    errors: string[],
    label: string
): void {
    if (result.status === 'failed') {
        counters.failed();
        // Resource schedulers report failures via a 'failed' result (they don't
        // throw), so collect the per-resource error into the aggregated list here.
        errors.push(`${label}: ${result.error || 'unknown error'}`);
    } else if (result.action === 'start') {
        counters.started();
    } else if (result.action === 'stop') {
        counters.stopped();
    }
    // 'skip' action doesn't increment any counter
}

function createResult(
    executionId: string,
    mode: 'full' | 'partial',
    startTime: number,
    schedulesProcessed: number,
    resourcesStarted: number,
    resourcesStopped: number,
    resourcesFailed: number,
    processedTenantIds?: string[],
    errors?: string[]
): SchedulerResult {
    return {
        success: resourcesFailed === 0,
        executionId,
        mode,
        schedulesProcessed,
        resourcesStarted,
        resourcesStopped,
        resourcesFailed,
        duration: Date.now() - startTime,
        processedTenantIds,
        errors: errors && errors.length > 0 ? errors : undefined,
    };
}
