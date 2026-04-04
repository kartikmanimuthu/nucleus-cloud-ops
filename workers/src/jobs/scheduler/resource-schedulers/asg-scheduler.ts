// ASG Scheduler - Scale Auto Scaling Groups based on schedule resources (ARN-driven)
// Stores minSize, maxSize, desiredCapacity before stopping and restores them when starting
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { logger } from '../utils/logger.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type {
    Schedule,
    ScheduleResource,
    AssumedCredentials,
    SchedulerMetadata,
    ASGResourceExecution,
} from '../types/index.js';

/**
 * Process a single Auto Scaling Group resource for scheduling (ARN-driven)
 * When stopping: saves current minSize, maxSize, desiredCapacity to last_state for later restoration
 * When starting: uses last state values to restore the ASG to its previous scale
 * 
 * @param resource - The ASG resource from the schedule
 * @param schedule - The schedule configuration
 * @param action - 'start' or 'stop' based on time window evaluation
 * @param credentials - Assumed role credentials
 * @param metadata - Execution metadata
 * @param lastState - The last recorded state from previous stop execution (for restoration)
 */
export async function processASGResource(
    resource: ScheduleResource,
    schedule: Schedule,
    action: 'start' | 'stop',
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata,
    lastState?: { minSize: number; maxSize: number; desiredCapacity: number }
): Promise<ASGResourceExecution> {
    const asgClient = new AutoScalingClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'asg',
        resourceId: resource.id,
    });

    // Extract ASG name from resource (id should be the ASG name)
    const asgName = resource.id;
    log.info(`Processing ASG resource: ${asgName} (${resource.name || 'unnamed'})`);

    try {
        // Get current ASG state
        const describeResponse = await asgClient.send(new DescribeAutoScalingGroupsCommand({
            AutoScalingGroupNames: [asgName],
        }));

        const asg = describeResponse.AutoScalingGroups?.[0];
        if (!asg) {
            throw new Error(`Auto Scaling Group ${asgName} not found`);
        }

        const currentMinSize = asg.MinSize ?? 0;
        const currentMaxSize = asg.MaxSize ?? 0;
        const currentDesiredCapacity = asg.DesiredCapacity ?? 0;
        const instanceCount = asg.Instances?.length ?? 0;

        log.debug(`ASG ${asgName}: fetched state details`, {
            currentMinSize,
            currentMaxSize,
            currentDesiredCapacity,
            instanceCount,
            instances: asg.Instances?.map(i => ({ id: i.InstanceId, state: i.LifecycleState }))
        });

        log.debug(`ASG ${asgName}: minSize=${currentMinSize}, maxSize=${currentMaxSize}, desiredCapacity=${currentDesiredCapacity}, instances=${instanceCount}, action=${action}`);

        if (action === 'stop' && (currentDesiredCapacity > 0 || currentMinSize > 0)) {
            // Stop the ASG by setting all capacity to 0
            // IMPORTANT: Save current values in last_state for restoration
            await asgClient.send(new UpdateAutoScalingGroupCommand({
                AutoScalingGroupName: asgName,
                MinSize: 0,
                MaxSize: 0,
                DesiredCapacity: 0,
            }));
            log.info(`Stopped ASG ${asgName} (was minSize=${currentMinSize}, maxSize=${currentMaxSize}, desiredCapacity=${currentDesiredCapacity})`);
            log.debug(`ASG ${asgName}: UpdateAutoScalingGroupCommand sent for stop (0/0/0)`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.asg.stop',
                action: 'stop',
                user: 'system',
                userType: 'system',
                resourceType: 'asg',
                resourceId: asgName,
                status: 'success',
                details: `Stopped ASG ${asgName} for schedule ${schedule.name}. Previous state: minSize=${currentMinSize}, maxSize=${currentMaxSize}, desiredCapacity=${currentDesiredCapacity}`,
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
                    minSize: currentMinSize,  // Save for restoration!
                    maxSize: currentMaxSize,
                    desiredCapacity: currentDesiredCapacity,
                },
            };

        } else if (action === 'start' && currentDesiredCapacity === 0 && currentMinSize === 0) {
            // Start the ASG by restoring previous capacity
            // Use lastState from previous execution, or default to sensible values
            const targetMinSize = lastState?.minSize ?? 1;
            const targetMaxSize = lastState?.maxSize ?? 1;
            const targetDesiredCapacity = lastState?.desiredCapacity ?? 1;

            await asgClient.send(new UpdateAutoScalingGroupCommand({
                AutoScalingGroupName: asgName,
                MinSize: targetMinSize,
                MaxSize: targetMaxSize,
                DesiredCapacity: targetDesiredCapacity,
            }));
            log.info(`Started ASG ${asgName} with minSize=${targetMinSize}, maxSize=${targetMaxSize}, desiredCapacity=${targetDesiredCapacity}`);
            log.debug(`ASG ${asgName}: UpdateAutoScalingGroupCommand sent for start (${targetMinSize}/${targetMaxSize}/${targetDesiredCapacity})`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.asg.start',
                action: 'start',
                user: 'system',
                userType: 'system',
                resourceType: 'asg',
                resourceId: asgName,
                status: 'success',
                details: `Started ASG ${asgName} for schedule ${schedule.name}. Restored state: minSize=${targetMinSize}, maxSize=${targetMaxSize}, desiredCapacity=${targetDesiredCapacity}`,
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
                    minSize: currentMinSize,  // Was 0 before start
                    maxSize: currentMaxSize,
                    desiredCapacity: currentDesiredCapacity,
                },
            };

        } else {
            log.debug(`ASG ${asgName} already in desired state, skipping`);
            return {
                arn: resource.arn,
                resourceId: resource.id,
                action: 'skip',
                status: 'success',
                last_state: {
                    minSize: currentMinSize,
                    maxSize: currentMaxSize,
                    desiredCapacity: currentDesiredCapacity,
                },
            };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Failed to process ASG ${asgName}`, error);

        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.asg.error',
            action: action,
            user: 'system',
            userType: 'system',
            resourceType: 'asg',
            resourceId: asgName,
            status: 'error',
            details: `Failed to ${action} ASG ${asgName}: ${errorMessage}`,
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
                minSize: 0,
                maxSize: 0,
                desiredCapacity: 0,
            },
        };
    }
}

/**
 * Extract ASG name from ASG ARN
 * ARN format: arn:aws:autoscaling:region:account:autoScalingGroup:uuid:autoScalingGroupName/asg-name
 */
export function extractASGName(arn: string): string {
    const match = arn.match(/autoScalingGroupName\/(.+)$/);
    if (!match) {
        // Try alternate format or return the ARN as-is (might be just the name)
        const parts = arn.split('/');
        if (parts.length > 1) {
            return parts[parts.length - 1];
        }
        return arn;
    }
    return match[1];
}

/**
 * Extract region from ASG ARN
 * ARN format: arn:aws:autoscaling:region:account:autoScalingGroup:...
 */
export function extractRegionFromArn(arn: string): string {
    const parts = arn.split(':');
    if (parts.length < 4) {
        throw new Error(`Invalid ARN format: ${arn}`);
    }
    return parts[3];
}
