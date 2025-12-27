// ECS Scheduler - Scale ECS services based on schedule resources (ARN-driven)
// Stores desiredCount before stopping and restores it when starting
import {
    ECSClient,
    DescribeServicesCommand,
    UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { logger } from '../utils/logger.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type {
    Schedule,
    ScheduleResource,
    AssumedCredentials,
    SchedulerMetadata,
    ECSResourceExecution,
} from '../types/index.js';

/**
 * Process a single ECS service resource for scheduling (ARN-driven)
 * When stopping: saves current desiredCount to last_state for later restoration
 * When starting: uses lastDesiredCount to restore the service to its previous scale
 * 
 * @param resource - The ECS resource from the schedule
 * @param schedule - The schedule configuration
 * @param action - 'start' or 'stop' based on time window evaluation
 * @param credentials - Assumed role credentials
 * @param metadata - Execution metadata
 * @param lastDesiredCount - The desiredCount from last stop execution (for restoration)
 */
export async function processECSResource(
    resource: ScheduleResource,
    schedule: Schedule,
    action: 'start' | 'stop',
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata,
    lastDesiredCount?: number
): Promise<ECSResourceExecution> {
    const ecsClient = new ECSClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'ecs',
        resourceId: resource.id,
    });

    // Extract cluster ARN/Name and service name from resource
    let clusterArn = resource.clusterArn;
    if (!clusterArn) {
        const extractedCluster = extractClusterName(resource.arn);
        if (extractedCluster) {
            clusterArn = extractedCluster;
            log.debug(`Extracted cluster name '${clusterArn}' from service ARN`);
        }
    }

    if (!clusterArn) {
        const errorMessage = `ECS service ${resource.id} is missing clusterArn and it could not be extracted from ARN`;
        log.error(errorMessage);
        return {
            arn: resource.arn,
            resourceId: resource.id,
            clusterArn: 'unknown',
            action: action,
            status: 'failed',
            error: errorMessage,
            last_state: {
                desiredCount: 0,
                runningCount: 0,
            },
        };
    }

    const serviceName = extractServiceName(resource.arn);
    log.info(`Processing ECS service: ${serviceName} (${resource.name || 'unnamed'}) in cluster ${clusterArn}`);

    try {
        // Get current service state
        const describeResponse = await ecsClient.send(new DescribeServicesCommand({
            cluster: clusterArn,
            services: [serviceName],
        }));

        const service = describeResponse.services?.[0];
        if (!service) {
            throw new Error(`ECS service ${serviceName} not found in cluster ${clusterArn}`);
        }

        const currentDesiredCount = service.desiredCount ?? 0;
        const runningCount = service.runningCount ?? 0;
        const pendingCount = service.pendingCount ?? 0;
        const serviceStatus = service.status ?? 'unknown';

        log.debug(`ECS ${serviceName}: desiredCount=${currentDesiredCount}, runningCount=${runningCount}, action=${action}`);

        if (action === 'stop' && currentDesiredCount > 0) {
            // Stop the service by setting desiredCount to 0
            // IMPORTANT: Save current desiredCount in last_state for restoration
            await ecsClient.send(new UpdateServiceCommand({
                cluster: clusterArn,
                service: serviceName,
                desiredCount: 0,
            }));
            log.info(`Stopped ECS service ${serviceName} (was desiredCount=${currentDesiredCount})`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.ecs.stop',
                action: 'stop',
                user: 'system',
                userType: 'system',
                resourceType: 'ecs-service',
                resourceId: serviceName,
                status: 'success',
                details: `Stopped ECS service ${serviceName} for schedule ${schedule.name}. Previous desiredCount: ${currentDesiredCount}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return {
                arn: resource.arn,
                resourceId: resource.id,
                clusterArn,
                action: 'stop',
                status: 'success',
                last_state: {
                    desiredCount: currentDesiredCount,  // Save this for restoration!
                    runningCount,
                    pendingCount,
                    status: serviceStatus,
                },
            };

        } else if (action === 'start' && currentDesiredCount === 0) {
            // Start the service by restoring desiredCount
            // Use lastDesiredCount from previous execution, or default to 1
            const targetDesiredCount = lastDesiredCount && lastDesiredCount > 0 ? lastDesiredCount : 1;

            await ecsClient.send(new UpdateServiceCommand({
                cluster: clusterArn,
                service: serviceName,
                desiredCount: targetDesiredCount,
            }));
            log.info(`Started ECS service ${serviceName} with desiredCount=${targetDesiredCount}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.ecs.start',
                action: 'start',
                user: 'system',
                userType: 'system',
                resourceType: 'ecs-service',
                resourceId: serviceName,
                status: 'success',
                details: `Started ECS service ${serviceName} for schedule ${schedule.name}. Restored desiredCount: ${targetDesiredCount}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return {
                arn: resource.arn,
                resourceId: resource.id,
                clusterArn,
                action: 'start',
                status: 'success',
                last_state: {
                    desiredCount: currentDesiredCount,  // Was 0 before start
                    runningCount,
                    pendingCount,
                    status: serviceStatus,
                },
            };

        } else {
            log.debug(`ECS ${serviceName} already in desired state, skipping`);
            return {
                arn: resource.arn,
                resourceId: resource.id,
                clusterArn,
                action: 'skip',
                status: 'success',
                last_state: {
                    desiredCount: currentDesiredCount,
                    runningCount,
                    pendingCount,
                    status: serviceStatus,
                },
            };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Failed to process ECS service ${serviceName}`, error);

        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.ecs.error',
            action: action,
            user: 'system',
            userType: 'system',
            resourceType: 'ecs-service',
            resourceId: serviceName,
            status: 'error',
            details: `Failed to ${action} ECS service ${serviceName}: ${errorMessage}`,
            severity: 'high',
            accountId: metadata.account.accountId,
            region: metadata.region,
        });

        return {
            arn: resource.arn,
            resourceId: resource.id,
            clusterArn,
            action: action,
            status: 'failed',
            error: errorMessage,
            last_state: {
                desiredCount: 0,
                runningCount: 0,
            },
        };
    }
}

/**
 * Extract service name from ECS service ARN
 * ARN format: arn:aws:ecs:region:account:service/cluster-name/service-name
 */
export function extractServiceName(arn: string): string {
    const match = arn.match(/service\/[^/]+\/(.+)$/);
    if (!match) {
        // Try alternate format: arn:aws:ecs:region:account:service/service-name
        const altMatch = arn.match(/service\/(.+)$/);
        if (!altMatch) {
            throw new Error(`Invalid ECS service ARN format: ${arn}`);
        }
        return altMatch[1];
    }
    return match[1];
}

/**
 * Extract cluster name from ECS service ARN
 * ARN format: arn:aws:ecs:region:account:service/cluster-name/service-name
 */
export function extractClusterName(arn: string): string | null {
    const match = arn.match(/service\/([^/]+)\/[^/]+$/);
    if (!match) {
        return null;
    }
    return match[1];
}

/**
 * Extract region from ECS ARN
 */
export function extractRegionFromArn(arn: string): string {
    const parts = arn.split(':');
    if (parts.length < 4) {
        throw new Error(`Invalid ARN format: ${arn}`);
    }
    return parts[3];
}
