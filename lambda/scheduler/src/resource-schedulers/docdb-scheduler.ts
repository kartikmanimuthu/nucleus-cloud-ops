// DocumentDB Scheduler - Start/Stop DocumentDB clusters based on schedule resources (ARN-driven)
import {
    RDSClient,
    DescribeDBClustersCommand,
    StartDBClusterCommand,
    StopDBClusterCommand,
} from '@aws-sdk/client-rds';
import { logger } from '../utils/logger.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type {
    Schedule,
    ScheduleResource,
    AssumedCredentials,
    SchedulerMetadata,
    RDSResourceExecution, // Reusing RDS type for now, or create separate if needed
} from '../types/index.js';

/**
 * Process a single DocumentDB resource for scheduling
 * @param resource - The DocumentDB resource (Cluster) from the schedule
 * @param schedule - The schedule configuration
 * @param action - 'start' or 'stop' based on time window evaluation
 * @param credentials - Assumed role credentials
 * @param metadata - Execution metadata
 * @param lastState - The last recorded state
 */
export async function processDocDBResource(
    resource: ScheduleResource,
    schedule: Schedule,
    action: 'start' | 'stop',
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata,
    lastState?: { dbClusterStatus: string }
): Promise<RDSResourceExecution> {
    const rdsClient = new RDSClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'docdb',
        resourceId: resource.id,
    });

    log.info(`Processing DocDB resource: ${resource.id} (${resource.name || 'unnamed'})`);

    try {
        // Get current DocumentDB Cluster instance state
        const describeResponse = await rdsClient.send(new DescribeDBClustersCommand({
            DBClusterIdentifier: resource.id,
        }));

        const cluster = describeResponse.DBClusters?.[0];
        if (!cluster) {
            throw new Error(`DocumentDB cluster ${resource.id} not found`);
        }

        const currentStatus = cluster.Status || 'unknown';

        log.debug(`DocDB ${resource.id}: currentStatus=${currentStatus}, desiredAction=${action}, lastState=${lastState?.dbClusterStatus || 'none'}`);

        // Determine if action is needed
        if (action === 'start' && currentStatus !== 'available' && currentStatus !== 'starting') {
            // Start the cluster
            await rdsClient.send(new StartDBClusterCommand({ DBClusterIdentifier: resource.id }));
            log.info(`Started DocDB cluster ${resource.id}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.docdb.start',
                action: 'start',
                user: 'system',
                userType: 'system',
                resourceType: 'docdb',
                resourceId: resource.id,
                status: 'success',
                details: `Started DocDB cluster ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
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
                    dbInstanceStatus: currentStatus, // reusing property name for compatibility or define new type
                },
            };

        } else if (action === 'stop' && currentStatus === 'available') {
            // Stop the cluster
            await rdsClient.send(new StopDBClusterCommand({ DBClusterIdentifier: resource.id }));
            log.info(`Stopped DocDB cluster ${resource.id}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.docdb.stop',
                action: 'stop',
                user: 'system',
                userType: 'system',
                resourceType: 'docdb',
                resourceId: resource.id,
                status: 'success',
                details: `Stopped DocDB cluster ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
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
                },
            };

        } else {
            log.debug(`DocDB ${resource.id} already in desired state, skipping`);
            return {
                arn: resource.arn,
                resourceId: resource.id,
                action: 'skip',
                status: 'success',
                last_state: {
                    dbInstanceStatus: currentStatus,
                },
            };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Failed to process DocDB cluster ${resource.id}`, error);

        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.docdb.error',
            action: action,
            user: 'system',
            userType: 'system',
            resourceType: 'docdb',
            resourceId: resource.id,
            status: 'error',
            details: `Failed to ${action} DocDB cluster ${resource.id}: ${errorMessage}`,
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
