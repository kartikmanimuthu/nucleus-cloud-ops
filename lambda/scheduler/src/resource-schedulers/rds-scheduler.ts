// RDS Scheduler - Start/Stop RDS instances based on schedules
import {
    RDSClient,
    DescribeDBInstancesCommand,
    StartDBInstanceCommand,
    StopDBInstanceCommand,
    ListTagsForResourceCommand,
    type DBInstance,
} from '@aws-sdk/client-rds';
import { logger } from '../utils/logger.js';
import { isCurrentTimeInRange } from '../utils/time-utils.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type { Schedule, AssumedCredentials, SchedulerMetadata, ResourceActionResult } from '../types/index.js';

const SCHEDULE_TAG = process.env.SCHEDULER_TAG || 'schedule';

/**
 * Process RDS instances for scheduling
 */
export async function processRDSInstances(
    schedules: Schedule[],
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult[]> {
    const results: ResourceActionResult[] = [];
    const rdsClient = new RDSClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'rds',
    });

    log.info(`RDS Scheduler started for ${metadata.account.name}`);

    try {
        // Fetch all RDS instances
        const response = await rdsClient.send(new DescribeDBInstancesCommand({}));
        const instances = response.DBInstances || [];

        log.debug(`Found ${instances.length} RDS instances`);

        // Process each instance
        for (const instance of instances) {
            const result = await processInstance(instance, schedules, rdsClient, log, metadata);
            if (result) {
                results.push(result);
            }
        }

        log.info(`RDS Scheduler completed - ${results.length} actions taken`);
    } catch (error) {
        log.error('RDS Scheduler error', error);
        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.rds.error',
            action: 'scan',
            user: 'system',
            userType: 'system',
            resourceType: 'rds',
            resourceId: metadata.account.accountId,
            status: 'error',
            details: `RDS Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'high',
            accountId: metadata.account.accountId,
            region: metadata.region,
        });
    }

    return results;
}

async function processInstance(
    instance: DBInstance,
    schedules: Schedule[],
    rdsClient: RDSClient,
    log: ReturnType<typeof logger.child>,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult | null> {
    const instanceId = instance.DBInstanceIdentifier!;
    const instanceArn = instance.DBInstanceArn!;

    try {
        // Fetch tags for this instance
        const tagsResponse = await rdsClient.send(new ListTagsForResourceCommand({
            ResourceName: instanceArn,
        }));

        const scheduleTagValue = tagsResponse.TagList?.find(t => t.Key === SCHEDULE_TAG)?.Value;
        if (!scheduleTagValue) return null;

        const schedule = schedules.find(s => s.name === scheduleTagValue);
        if (!schedule) {
            log.debug(`Schedule "${scheduleTagValue}" not found for RDS ${instanceId}`);
            return null;
        }

        const inRange = isCurrentTimeInRange(
            schedule.starttime,
            schedule.endtime,
            schedule.timezone,
            schedule.days
        );
        const currentStatus = instance.DBInstanceStatus;

        log.debug(`Processing RDS ${instanceId}: schedule=${scheduleTagValue}, inRange=${inRange}, status=${currentStatus}`);

        if (inRange && currentStatus !== 'available' && currentStatus !== 'starting') {
            // Should be running but isn't - start it
            await rdsClient.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            log.info(`Started RDS instance ${instanceId}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.rds.start',
                action: 'start',
                user: 'system',
                userType: 'system',
                resourceType: 'rds',
                resourceId: instanceId,
                status: 'success',
                details: `Started RDS instance ${instanceId}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return { resourceId: instanceId, resourceType: 'rds', action: 'start', success: true };

        } else if (!inRange && currentStatus === 'available') {
            // Should be stopped but is available - stop it
            await rdsClient.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            log.info(`Stopped RDS instance ${instanceId}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.rds.stop',
                action: 'stop',
                user: 'system',
                userType: 'system',
                resourceType: 'rds',
                resourceId: instanceId,
                status: 'success',
                details: `Stopped RDS instance ${instanceId}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return { resourceId: instanceId, resourceType: 'rds', action: 'stop', success: true };

        } else {
            log.debug(`RDS ${instanceId} already in desired state`);
            return { resourceId: instanceId, resourceType: 'rds', action: 'skip', success: true };
        }
    } catch (error) {
        log.error(`Failed to process RDS instance ${instanceId}`, error);
        return {
            resourceId: instanceId,
            resourceType: 'rds',
            action: 'stop',
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
