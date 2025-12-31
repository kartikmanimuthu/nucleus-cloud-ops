// EC2 Scheduler - Start/Stop EC2 instances based on schedule resources (ARN-driven)
import {
    EC2Client,
    DescribeInstancesCommand,
    StartInstancesCommand,
    StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { logger } from '../utils/logger.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type {
    Schedule,
    ScheduleResource,
    AssumedCredentials,
    SchedulerMetadata,
    EC2ResourceExecution,
} from '../types/index.js';

/**
 * Process a single EC2 resource for scheduling (ARN-driven)
 * @param resource - The EC2 resource from the schedule
 * @param schedule - The schedule configuration
 * @param action - 'start' or 'stop' based on time window evaluation
 * @param credentials - Assumed role credentials
 * @param metadata - Execution metadata
 * @param lastState - The last recorded state from previous execution (for start restoration)
 */
export async function processEC2Resource(
    resource: ScheduleResource,
    schedule: Schedule,
    action: 'start' | 'stop',
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata,
    lastState?: { instanceState: string; instanceType?: string }
): Promise<EC2ResourceExecution> {
    const ec2Client = new EC2Client({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'ec2',
        resourceId: resource.id,
    });

    log.info(`Processing EC2 resource: ${resource.id} (${resource.name || 'unnamed'})`);

    try {
        // Get current instance state
        const describeResponse = await ec2Client.send(new DescribeInstancesCommand({
            InstanceIds: [resource.id],
        }));

        const instance = describeResponse.Reservations?.[0]?.Instances?.[0];
        if (!instance) {
            throw new Error(`EC2 instance ${resource.id} not found`);
        }

        const currentState = instance.State?.Name || 'unknown';
        const instanceType = instance.InstanceType || 'unknown';

        log.debug(`EC2 ${resource.id}: currentState=${currentState}, desiredAction=${action}, lastState=${lastState?.instanceState || 'none'}`);

        // Determine if action is needed
        if (action === 'start' && currentState !== 'running' && currentState !== 'pending') {
            // For start action, verify the instance was previously managed by the scheduler
            // by checking if we have a last recorded state (indicating scheduler stopped it previously)
            // If no lastState, still proceed (first-time management or new resource added)
            if (lastState) {
                log.info(`EC2 ${resource.id}: Restoring from scheduler-managed state (was ${lastState.instanceState})`);
            }

            // Start the instance
            await ec2Client.send(new StartInstancesCommand({ InstanceIds: [resource.id] }));
            log.info(`Started EC2 instance ${resource.id}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.ec2.start',
                action: 'start',
                user: 'system',
                userType: 'system',
                resourceType: 'ec2',
                resourceId: resource.id,
                status: 'success',
                details: `Started EC2 instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
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
                    instanceState: currentState,
                    instanceType,
                },
            };

        } else if (action === 'stop' && currentState === 'running') {
            // Stop the instance - capture current state for later restoration
            await ec2Client.send(new StopInstancesCommand({ InstanceIds: [resource.id] }));
            log.info(`Stopped EC2 instance ${resource.id} (saving state: instanceState=${currentState}, instanceType=${instanceType})`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.ec2.stop',
                action: 'stop',
                user: 'system',
                userType: 'system',
                resourceType: 'ec2',
                resourceId: resource.id,
                status: 'success',
                details: `Stopped EC2 instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
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
                    instanceState: currentState,
                    instanceType,
                },
            };

        } else {
            log.debug(`EC2 ${resource.id} already in desired state, skipping`);
            return {
                arn: resource.arn,
                resourceId: resource.id,
                action: 'skip',
                status: 'success',
                last_state: {
                    instanceState: currentState,
                    instanceType,
                },
            };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Failed to process EC2 instance ${resource.id}`, error);

        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.ec2.error',
            action: action,
            user: 'system',
            userType: 'system',
            resourceType: 'ec2',
            resourceId: resource.id,
            status: 'error',
            details: `Failed to ${action} EC2 instance ${resource.id}: ${errorMessage}`,
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
                instanceState: 'unknown',
            },
        };
    }
}

/**
 * Extract instance ID from EC2 ARN
 * ARN format: arn:aws:ec2:region:account:instance/instance-id
 */
export function extractEC2InstanceId(arn: string): string {
    const match = arn.match(/instance\/(.+)$/);
    if (!match) {
        throw new Error(`Invalid EC2 ARN format: ${arn}`);
    }
    return match[1];
}

/**
 * Extract region from EC2 ARN
 * ARN format: arn:aws:ec2:region:account:instance/instance-id
 */
export function extractRegionFromArn(arn: string): string {
    const parts = arn.split(':');
    if (parts.length < 4) {
        throw new Error(`Invalid ARN format: ${arn}`);
    }
    return parts[3];
}
