// RDS Scheduler - Start/Stop RDS instances based on schedule resources (ARN-driven)
import {
    RDSClient,
    DescribeDBInstancesCommand,
    StartDBInstanceCommand,
    StopDBInstanceCommand,
} from '@aws-sdk/client-rds';
import { logger } from '../utils/logger.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type {
    Schedule,
    ScheduleResource,
    AssumedCredentials,
    SchedulerMetadata,
    RDSResourceExecution,
} from '../types/index.js';

/**
 * Process a single RDS resource for scheduling (ARN-driven)
 * @param resource - The RDS resource from the schedule
 * @param schedule - The schedule configuration
 * @param action - 'start' or 'stop' based on time window evaluation
 * @param credentials - Assumed role credentials
 * @param metadata - Execution metadata
 */
export async function processRDSResource(
    resource: ScheduleResource,
    schedule: Schedule,
    action: 'start' | 'stop',
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata
): Promise<RDSResourceExecution> {
    const rdsClient = new RDSClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'rds',
        resourceId: resource.id,
    });

    log.info(`Processing RDS resource: ${resource.id} (${resource.name || 'unnamed'})`);

    try {
        // Get current RDS instance state
        const describeResponse = await rdsClient.send(new DescribeDBInstancesCommand({
            DBInstanceIdentifier: resource.id,
        }));

        const instance = describeResponse.DBInstances?.[0];
        if (!instance) {
            throw new Error(`RDS instance ${resource.id} not found`);
        }

        const currentStatus = instance.DBInstanceStatus || 'unknown';
        const dbInstanceClass = instance.DBInstanceClass || 'unknown';

        log.debug(`RDS ${resource.id}: currentStatus=${currentStatus}, desiredAction=${action}`);

        // Determine if action is needed
        if (action === 'start' && currentStatus !== 'available' && currentStatus !== 'starting') {
            // Start the instance
            await rdsClient.send(new StartDBInstanceCommand({ DBInstanceIdentifier: resource.id }));
            log.info(`Started RDS instance ${resource.id}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.rds.start',
                action: 'start',
                user: 'system',
                userType: 'system',
                resourceType: 'rds',
                resourceId: resource.id,
                status: 'success',
                details: `Started RDS instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return {
                arn: resource.arn,
                resourceId: resource.id,
                action: 'start',
                status: 'success',
                last_state: {
                    dbInstanceStatus: currentStatus,
                    dbInstanceClass,
                },
            };

        } else if (action === 'stop' && currentStatus === 'available') {
            // Stop the instance
            await rdsClient.send(new StopDBInstanceCommand({ DBInstanceIdentifier: resource.id }));
            log.info(`Stopped RDS instance ${resource.id}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.rds.stop',
                action: 'stop',
                user: 'system',
                userType: 'system',
                resourceType: 'rds',
                resourceId: resource.id,
                status: 'success',
                details: `Stopped RDS instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return {
                arn: resource.arn,
                resourceId: resource.id,
                action: 'stop',
                status: 'success',
                last_state: {
                    dbInstanceStatus: currentStatus,
                    dbInstanceClass,
                },
            };

        } else {
            log.debug(`RDS ${resource.id} already in desired state, skipping`);
            return {
                arn: resource.arn,
                resourceId: resource.id,
                action: 'skip',
                status: 'success',
                last_state: {
                    dbInstanceStatus: currentStatus,
                    dbInstanceClass,
                },
            };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Failed to process RDS instance ${resource.id}`, error);

        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.rds.error',
            action: action,
            user: 'system',
            userType: 'system',
            resourceType: 'rds',
            resourceId: resource.id,
            status: 'error',
            details: `Failed to ${action} RDS instance ${resource.id}: ${errorMessage}`,
            severity: 'high',
            accountId: metadata.account.accountId,
            region: metadata.region,
        });

        return {
            arn: resource.arn,
            resourceId: resource.id,
            action: action,
            status: 'failed',
            error: errorMessage,
            last_state: {
                dbInstanceStatus: 'unknown',
            },
        };
    }
}

/**
 * Extract RDS DB identifier from RDS ARN
 * ARN format: arn:aws:rds:region:account:db:db-identifier
 */
export function extractRDSIdentifier(arn: string): string {
    const match = arn.match(/db:(.+)$/);
    if (!match) {
        throw new Error(`Invalid RDS ARN format: ${arn}`);
    }
    return match[1];
}

/**
 * Extract region from RDS ARN
 * ARN format: arn:aws:rds:region:account:db:db-identifier
 */
export function extractRegionFromArn(arn: string): string {
    const parts = arn.split(':');
    if (parts.length < 4) {
        throw new Error(`Invalid ARN format: ${arn}`);
    }
    return parts[3];
}
