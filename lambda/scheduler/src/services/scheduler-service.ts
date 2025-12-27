// Main Scheduler Service
// Orchestrates full and partial scans across accounts and regions

import { logger } from '../utils/logger.js';
import {
    fetchActiveSchedules,
    fetchActiveAccounts,
    fetchScheduleById,
    createAuditLog,
} from './dynamodb-service.js';
import {
    createExecutionRecord,
    updateExecutionRecord,
    type CreateExecutionParams,
} from './execution-history-service.js';
import { assumeRole } from './sts-service.js';
import {
    processEC2Instances,
    processRDSInstances,
    processECSResources,
} from '../resource-schedulers/index.js';
import type {
    Schedule,
    Account,
    SchedulerEvent,
    SchedulerResult,
    SchedulerMetadata,
    ResourceActionResult,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Run a full scan - process all active schedules across all accounts
 */
export async function runFullScan(triggeredBy: 'system' | 'web-ui' = 'system'): Promise<SchedulerResult> {
    const executionId = uuidv4();
    const startTime = Date.now();

    logger.setContext({ executionId, mode: 'full' });
    logger.info('Starting full scan');

    await createAuditLog({
        type: 'audit_log',
        eventType: 'scheduler.start',
        action: 'full_scan',
        user: 'system',
        userType: 'system',
        resourceType: 'scheduler',
        resourceId: executionId,
        status: 'info',
        details: `Full scheduler scan started: ${executionId}`,
        severity: 'info',
    });

    const schedules = await fetchActiveSchedules();
    const accounts = await fetchActiveAccounts();

    logger.info(`Found ${schedules.length} schedules and ${accounts.length} accounts`);

    if (schedules.length === 0 || accounts.length === 0) {
        logger.info('No schedules or accounts to process');
        return createResult(executionId, 'full', startTime, 0, 0, 0, 0);
    }

    const allResults: ResourceActionResult[] = [];

    // Process each account concurrently
    const accountPromises = accounts.map(account =>
        processAccount(account, schedules, executionId, triggeredBy)
    );

    const accountResults = await Promise.allSettled(accountPromises);

    for (const result of accountResults) {
        if (result.status === 'fulfilled') {
            allResults.push(...result.value);
        }
    }

    const summary = summarizeResults(allResults);

    await createAuditLog({
        type: 'audit_log',
        eventType: 'scheduler.complete',
        action: 'full_scan',
        user: 'system',
        userType: 'system',
        resourceType: 'scheduler',
        resourceId: executionId,
        status: 'success',
        details: `Full scan completed: ${summary.started} started, ${summary.stopped} stopped, ${summary.failed} failed`,
        severity: 'info',
    });

    logger.info('Full scan completed', summary);

    return createResult(
        executionId,
        'full',
        startTime,
        schedules.length,
        summary.started,
        summary.stopped,
        summary.failed
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

    if (!scheduleId) {
        throw new Error('scheduleId or scheduleName is required for partial scan');
    }

    logger.setContext({ executionId, mode: 'partial', scheduleId });
    logger.info(`Starting partial scan for schedule: ${scheduleId}`);

    // Fetch the specific schedule
    const schedule = await fetchScheduleById(scheduleId);
    if (!schedule) {
        throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const accounts = await fetchActiveAccounts();

    // Filter accounts if schedule has specific account constraint
    const targetAccounts = schedule.accountId
        ? accounts.filter(a => a.accountId === schedule.accountId)
        : accounts;

    if (targetAccounts.length === 0) {
        logger.warn('No matching accounts found for schedule');
        return createResult(executionId, 'partial', startTime, 1, 0, 0, 0);
    }

    // Create execution record
    const execParams: CreateExecutionParams = {
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        tenantId: schedule.tenantId || 'default',
        accountId: schedule.accountId || 'system',
        triggeredBy,
    };
    const execRecord = await createExecutionRecord(execParams);

    const allResults: ResourceActionResult[] = [];

    // Process accounts for this specific schedule
    const accountPromises = targetAccounts.map(account =>
        processAccount(account, [schedule], executionId, triggeredBy)
    );

    const accountResults = await Promise.allSettled(accountPromises);

    for (const result of accountResults) {
        if (result.status === 'fulfilled') {
            allResults.push(...result.value);
        }
    }

    const summary = summarizeResults(allResults);

    // Update execution record
    await updateExecutionRecord(execRecord, {
        status: summary.failed > 0 ? 'partial' : 'success',
        resourcesStarted: summary.started,
        resourcesStopped: summary.stopped,
        resourcesFailed: summary.failed,
    });

    logger.info('Partial scan completed', summary);

    return createResult(
        executionId,
        'partial',
        startTime,
        1,
        summary.started,
        summary.stopped,
        summary.failed
    );
}

/**
 * Process a single account across all its regions
 */
async function processAccount(
    account: Account,
    schedules: Schedule[],
    executionId: string,
    _triggeredBy: 'system' | 'web-ui'
): Promise<ResourceActionResult[]> {
    const results: ResourceActionResult[] = [];
    const accountDispName = account.accountName || account.name || account.accountId;

    // Parse regions if stored as string
    let regions = account.regions;
    if (typeof regions === 'string') {
        regions = (regions as string).split(',').map(r => r.trim());
    }
    if (!Array.isArray(regions) || regions.length === 0) {
        logger.warn(`No regions configured for account ${accountDispName}`);
        return results;
    }

    // Process each region concurrently
    const regionPromises = regions.map(async region => {
        try {
            const credentials = await assumeRole(account.roleArn, account.accountId, region, account.externalId);
            const metadata: SchedulerMetadata = {
                account: {
                    name: accountDispName,
                    accountId: account.accountId,
                },
                region,
                executionId,
            };

            // Run resource schedulers concurrently
            const [ec2Results, rdsResults, ecsResults] = await Promise.all([
                processEC2Instances(schedules, credentials, metadata),
                processRDSInstances(schedules, credentials, metadata),
                processECSResources(schedules, credentials, metadata),
            ]);

            return [...ec2Results, ...rdsResults, ...ecsResults];
        } catch (error) {
            logger.error(`Error processing account ${accountDispName} in ${region}`, error);
            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.account.error',
                action: 'process',
                user: 'system',
                userType: 'system',
                resourceType: 'account',
                resourceId: account.accountId,
                status: 'error',
                details: `Error processing account ${accountDispName} in ${region}: ${error instanceof Error ? error.message : String(error)}`,
                severity: 'high',
                accountId: account.accountId,
                region,
            });
            return [];
        }
    });

    const regionResults = await Promise.all(regionPromises);
    for (const regionResult of regionResults) {
        results.push(...regionResult);
    }

    return results;
}

function summarizeResults(results: ResourceActionResult[]): { started: number; stopped: number; failed: number } {
    let started = 0;
    let stopped = 0;
    let failed = 0;

    for (const result of results) {
        if (!result.success) {
            failed++;
        } else if (result.action === 'start') {
            started++;
        } else if (result.action === 'stop') {
            stopped++;
        }
    }

    return { started, stopped, failed };
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
