// Main Scheduler Service
// Orchestrates schedule-centric processing - iterates through schedules and their resources (ARN-driven)

import { logger } from '../utils/logger.js';
import {
    fetchActiveSchedules,
    fetchActiveAccounts,
    fetchScheduleById,
    createAuditLog,
    createExecutionAuditLog,
    DEFAULT_TENANT_ID,
} from './dynamodb-service.js';
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
    Account,
    SchedulerEvent,
    SchedulerResult,
    SchedulerMetadata,
    ScheduleExecutionMetadata,
    EC2ResourceExecution,
    ECSResourceExecution,
    RDSResourceExecution,
    ASGResourceExecution,

} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Run a full scan - process all active schedules
 */
export async function runFullScan(triggeredBy: 'system' | 'web-ui' = 'system'): Promise<SchedulerResult> {
    const executionId = uuidv4();
    const startTime = Date.now();

    logger.setContext({ executionId, mode: 'full' });
    logger.info('Starting full scan');

    const schedules = await fetchActiveSchedules();
    const accounts = await fetchActiveAccounts();

    logger.info(`Found ${schedules.length} active schedules and ${accounts.length} active accounts`);

    if (schedules.length === 0) {
        logger.info('No active schedules to process');
        return createResult(executionId, 'full', startTime, 0, 0, 0, 0);
    }

    let totalStarted = 0;
    let totalStopped = 0;
    let totalFailed = 0;
    const processedSchedules: Array<{
        scheduleId: string;
        scheduleName: string;
        started: number;
        stopped: number;
        failed: number;
        status: 'success' | 'partial' | 'error';
    }> = [];

    // Process each schedule
    for (const schedule of schedules) {
        try {
            const result = await processSchedule(schedule, accounts, triggeredBy);
            totalStarted += result.started;
            totalStopped += result.stopped;
            totalFailed += result.failed;
            processedSchedules.push({
                scheduleId: schedule.scheduleId,
                scheduleName: schedule.name,
                started: result.started,
                stopped: result.stopped,
                failed: result.failed,
                status: result.failed > 0 ? 'partial' : 'success',
            });
        } catch (error) {
            logger.error(`Error processing schedule ${schedule.scheduleId}`, error);
            totalFailed++;
            processedSchedules.push({
                scheduleId: schedule.scheduleId,
                scheduleName: schedule.name,
                started: 0,
                stopped: 0,
                failed: 1,
                status: 'error',
            });
        }
    }

    const overallStatus = totalFailed > 0 ? (totalStarted + totalStopped > 0 ? 'warning' : 'error') : 'success';

    await createAuditLog({
        type: 'audit_log',
        eventType: 'scheduler.complete',
        action: 'full_scan',
        user: 'system',
        userType: 'system',
        resourceType: 'scheduler',
        resourceId: executionId,
        status: overallStatus,
        details: `Full scan completed: ${totalStarted} started, ${totalStopped} stopped, ${totalFailed} failed`,
        severity: totalFailed > 0 ? 'medium' : 'info',
        metadata: {
            schedulesProcessed: schedules.length,
            resourcesStarted: totalStarted,
            resourcesStopped: totalStopped,
            resourcesFailed: totalFailed,
            scheduleDetails: processedSchedules,
        },
    });

    logger.info('Full scan completed', { totalStarted, totalStopped, totalFailed });

    return createResult(
        executionId,
        'full',
        startTime,
        schedules.length,
        totalStarted,
        totalStopped,
        totalFailed
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

    logger.setContext({ executionId, mode: 'partial', scheduleId, user: userEmail || 'system' });
    logger.info(`Starting partial scan for schedule: ${scheduleId}`);

    // Fetch the specific schedule
    const schedule = await fetchScheduleById(scheduleId, event.tenantId);
    if (!schedule) {
        // Log audit for schedule not found error
        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.error',
            action: 'partial_scan',
            user: userEmail || 'system',
            userType: userEmail ? 'user' : 'system',
            resourceType: 'scheduler',
            resourceId: scheduleId,
            status: 'error',
            details: `Partial scan failed: Schedule not found: ${scheduleId}`,
            severity: 'high',
            metadata: {
                scheduleId,
                triggeredBy,
            },
        });
        throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const accounts = await fetchActiveAccounts();

    try {
        const result = await processSchedule(schedule, accounts, triggeredBy, userEmail);

        const overallStatus = result.failed > 0 ? (result.started + result.stopped > 0 ? 'warning' : 'error') : 'success';

        // Log audit for partial scan completion (similar to full_scan)
        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.complete',
            action: 'partial_scan',
            user: userEmail || 'system',
            userType: userEmail ? 'user' : 'system',
            resourceType: 'scheduler',
            resourceId: executionId,
            status: overallStatus,
            details: `Partial scan completed for "${schedule.name}": ${result.started} started, ${result.stopped} stopped, ${result.failed} failed`,
            severity: result.failed > 0 ? 'medium' : 'info',
            metadata: {
                scheduleId: schedule.scheduleId,
                scheduleName: schedule.name,
                resourcesStarted: result.started,
                resourcesStopped: result.stopped,
                resourcesFailed: result.failed,
                triggeredBy,
            },
        });

        logger.info('Partial scan completed', result);

        return createResult(
            executionId,
            'partial',
            startTime,
            1,
            result.started,
            result.stopped,
            result.failed
        );
    } catch (error) {
        // Log audit for partial scan failure
        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.error',
            action: 'partial_scan',
            user: userEmail || 'system',
            userType: userEmail ? 'user' : 'system',
            resourceType: 'scheduler',
            resourceId: executionId,
            status: 'error',
            details: `Partial scan failed for "${schedule.name}": ${error instanceof Error ? error.message : String(error)}`,
            severity: 'high',
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
): Promise<{ started: number; stopped: number; failed: number }> {
    const resources = schedule.resources || [];
    const scheduleStartTime = Date.now();

    logger.info(`Processing schedule: ${schedule.name} (${schedule.scheduleId}) with ${resources.length} resources`);

    if (resources.length === 0) {
        logger.info(`Schedule ${schedule.name} has no resources, skipping`);
        return { started: 0, stopped: 0, failed: 0 };
    }

    // Determine the action based on time window
    const inRange = isCurrentTimeInRange(
        schedule.starttime,
        schedule.endtime,
        schedule.timezone,
        schedule.days
    );
    const action: 'start' | 'stop' = inRange ? 'start' : 'stop';

    logger.info(`Schedule ${schedule.name}: inRange=${inRange}, action=${action}`);

    // Prepare execution params (but don't create record yet)
    const execParams: CreateExecutionParams = {
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        tenantId: schedule.tenantId || DEFAULT_TENANT_ID,
        accountId: schedule.accountId || 'system',
        triggeredBy,
    };

    // Generate execution ID upfront for metadata consistency
    const executionId = uuidv4();

    // Group resources by account (extract from ARN)
    const resourcesByAccount = groupResourcesByAccount(resources, accounts);

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

    // Process resources by account
    for (const [accountId, accountResources] of resourcesByAccount) {
        const account = accounts.find((a) => a.accountId === accountId);
        if (!account) {
            logger.warn(`Account ${accountId} not found in active accounts, skipping resources`);
            failed += accountResources.resources.length;
            continue;
        }

        // Group resources by region
        const resourcesByRegion = groupResourcesByRegion(accountResources.resources);

        for (const [region, regionResources] of resourcesByRegion) {
            try {
                const credentials = await assumeRole(account.roleArn, account.accountId, region, account.externalId);
                const metadata: SchedulerMetadata = {
                    account: {
                        name: account.accountName || account.name || account.accountId,
                        accountId: account.accountId,
                    },
                    region,
                    executionId: executionId,
                    scheduleId: schedule.scheduleId,
                    scheduleName: schedule.name,
                };

                // Process each resource
                for (const resource of regionResources) {
                    try {
                        if (resource.type === 'ec2') {
                            // For EC2 start, get last state to verify resource was managed by scheduler
                            let lastState: { instanceState: string; instanceType?: string } | undefined;
                            if (action === 'start') {
                                const savedState = await getLastEC2InstanceState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    schedule.tenantId
                                );
                                lastState = savedState || undefined;
                                if (lastState) {
                                    logger.debug(`EC2 ${resource.id}: Found last state - instanceState=${lastState.instanceState}`);
                                }
                            }
                            const result = await processEC2Resource(resource, schedule, action, credentials, metadata, lastState);
                            scheduleMetadata.ec2.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
                        } else if (resource.type === 'rds') {
                            // For RDS start, get last state to verify resource was managed by scheduler
                            let lastState: { dbInstanceStatus: string; dbInstanceClass?: string } | undefined;
                            if (action === 'start') {
                                const savedState = await getLastRDSInstanceState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    schedule.tenantId
                                );
                                lastState = savedState || undefined;
                                if (lastState) {
                                    logger.debug(`RDS ${resource.id}: Found last state - dbInstanceStatus=${lastState.dbInstanceStatus}`);
                                }
                            }
                            const result = await processRDSResource(resource, schedule, action, credentials, metadata, lastState);
                            scheduleMetadata.rds.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
                        } else if (resource.type === 'ecs') {
                            // For ECS start, get last desiredCount from previous execution
                            let lastDesiredCount: number | undefined;
                            let lastAsgState: any;
                            if (action === 'start') {
                                const lastState = await getLastECSServiceState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    schedule.tenantId
                                );
                                lastDesiredCount = lastState?.desiredCount;
                                lastAsgState = lastState?.asg_state;
                            }
                            const result = await processECSResource(resource, schedule, action, credentials, metadata, lastDesiredCount, lastAsgState);
                            scheduleMetadata.ecs.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
                        } else if (resource.type === 'asg') {
                            // For ASG start, get last state from previous execution
                            let lastState: { minSize: number; maxSize: number; desiredCapacity: number } | undefined;
                            if (action === 'start') {
                                const savedState = await getLastASGState(
                                    schedule.scheduleId,
                                    resource.arn,
                                    schedule.tenantId
                                );
                                lastState = savedState || undefined;
                                if (lastState) {
                                    logger.debug(`ASG ${resource.id}: Found last state - desiredCapacity=${lastState.desiredCapacity}`);
                                }
                            }
                            const result = await processASGResource(resource, schedule, action, credentials, metadata, lastState);
                            scheduleMetadata.asg.push(result);

                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
                        } else if (resource.type === 'docdb') {
                            // For DocumentDB, we currently don't use lastState for simple Start/Stop
                            const result = await processDocDBResource(resource, schedule, action, credentials, metadata, undefined);
                            scheduleMetadata.docdb.push(result);
                            updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
                        }
                    } catch (error) {
                        logger.error(`Error processing resource ${resource.arn}`, error);
                        failed++;
                    }
                }
            } catch (error) {
                logger.error(`Failed to assume role for account ${accountId} in region ${region}`, error);
                failed += regionResources.length;
            }
        }
    }

    // Only create and update execution record if actions were actually performed
    const hasActions = started > 0 || stopped > 0 || failed > 0;

    if (hasActions) {
        // Create execution record now that we know actions were performed
        const execRecord = await createExecutionRecord(execParams);

        // Update execution record with final results and metadata
        const duration = Date.now() - scheduleStartTime;
        await updateExecutionRecord(execRecord, {
            status: failed > 0 ? 'partial' : 'success',
            resourcesStarted: started,
            resourcesStopped: stopped,
            resourcesFailed: failed,
            schedule_metadata: scheduleMetadata,
        });

        // Create summarized audit log for this execution
        await createExecutionAuditLog(execRecord.executionId, schedule, scheduleMetadata, {
            resourcesStarted: started,
            resourcesStopped: stopped,
            resourcesFailed: failed,
            duration,
        }, userEmail);

        logger.info(`Schedule ${schedule.name} execution recorded: ${started} started, ${stopped} stopped, ${failed} failed`);
    } else {
        logger.info(`Schedule ${schedule.name}: No actions performed (all resources in desired state), skipping execution record`);
    }

    return { started, stopped, failed };
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
 * Update counts based on resource execution result
 */
function updateCounts(
    result: EC2ResourceExecution | ECSResourceExecution | RDSResourceExecution | ASGResourceExecution,
    _action: 'start' | 'stop',
    counters: { started: () => void; stopped: () => void; failed: () => void }
): void {
    if (result.status === 'failed') {
        counters.failed();
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
    resourcesFailed: number
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
    };
}
