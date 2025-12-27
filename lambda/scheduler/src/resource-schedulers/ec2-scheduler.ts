// EC2 Scheduler - Start/Stop EC2 instances based on schedules
import {
    EC2Client,
    DescribeInstancesCommand,
    StartInstancesCommand,
    StopInstancesCommand,
    type Instance,
} from '@aws-sdk/client-ec2';
import { logger } from '../utils/logger.js';
import { isCurrentTimeInRange } from '../utils/time-utils.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type { Schedule, AssumedCredentials, SchedulerMetadata, ResourceActionResult } from '../types/index.js';

const SCHEDULE_TAG = process.env.SCHEDULER_TAG || 'schedule';

/**
 * Process EC2 instances for scheduling
 */
export async function processEC2Instances(
    schedules: Schedule[],
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult[]> {
    const results: ResourceActionResult[] = [];
    const ec2Client = new EC2Client({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'ec2',
    });

    log.info(`EC2 Scheduler started for ${metadata.account.name}`);

    try {
        // Fetch all EC2 instances
        const response = await ec2Client.send(new DescribeInstancesCommand({}));
        const instances: Instance[] = response.Reservations?.flatMap(r => r.Instances || []) || [];

        // Filter instances with schedule tag, excluding ECS-managed instances
        const scheduledInstances = instances.filter(instance => {
            const hasScheduleTag = instance.Tags?.some(tag => tag.Key === SCHEDULE_TAG);
            const isECSManaged = instance.Tags?.some(
                tag => tag.Key === 'AmazonECSManaged' && tag.Value === 'true'
            );
            return hasScheduleTag && !isECSManaged;
        });

        log.debug(`Found ${scheduledInstances.length} scheduled EC2 instances`);

        // Process each instance
        for (const instance of scheduledInstances) {
            const result = await processInstance(instance, schedules, ec2Client, log, metadata);
            if (result) {
                results.push(result);
            }
        }

        log.info(`EC2 Scheduler completed - ${results.length} actions taken`);
    } catch (error) {
        log.error('EC2 Scheduler error', error);
        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.ec2.error',
            action: 'scan',
            user: 'system',
            userType: 'system',
            resourceType: 'ec2',
            resourceId: metadata.account.accountId,
            status: 'error',
            details: `EC2 Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'high',
            accountId: metadata.account.accountId,
            region: metadata.region,
        });
    }

    return results;
}

async function processInstance(
    instance: Instance,
    schedules: Schedule[],
    ec2Client: EC2Client,
    log: ReturnType<typeof logger.child>,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult | null> {
    const instanceId = instance.InstanceId!;
    const scheduleTagValue = instance.Tags?.find(t => t.Key === SCHEDULE_TAG)?.Value;

    if (!scheduleTagValue) return null;

    const schedule = schedules.find(s => s.name === scheduleTagValue);
    if (!schedule) {
        log.debug(`Schedule "${scheduleTagValue}" not found for instance ${instanceId}`);
        return null;
    }

    const inRange = isCurrentTimeInRange(
        schedule.starttime,
        schedule.endtime,
        schedule.timezone,
        schedule.days
    );
    const currentState = instance.State?.Name;

    log.debug(`Processing EC2 ${instanceId}: schedule=${scheduleTagValue}, inRange=${inRange}, state=${currentState}`);

    try {
        if (inRange && currentState !== 'running') {
            // Should be running but isn't - start it
            await ec2Client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
            log.info(`Started EC2 instance ${instanceId}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.ec2.start',
                action: 'start',
                user: 'system',
                userType: 'system',
                resourceType: 'ec2',
                resourceId: instanceId,
                status: 'success',
                details: `Started EC2 instance ${instanceId}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return { resourceId: instanceId, resourceType: 'ec2', action: 'start', success: true };

        } else if (!inRange && currentState === 'running') {
            // Should be stopped but is running - stop it
            await ec2Client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
            log.info(`Stopped EC2 instance ${instanceId}`);

            await createAuditLog({
                type: 'audit_log',
                eventType: 'scheduler.ec2.stop',
                action: 'stop',
                user: 'system',
                userType: 'system',
                resourceType: 'ec2',
                resourceId: instanceId,
                status: 'success',
                details: `Stopped EC2 instance ${instanceId}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region,
            });

            return { resourceId: instanceId, resourceType: 'ec2', action: 'stop', success: true };

        } else {
            log.debug(`EC2 ${instanceId} already in desired state`);
            return { resourceId: instanceId, resourceType: 'ec2', action: 'skip', success: true };
        }
    } catch (error) {
        log.error(`Failed to process EC2 instance ${instanceId}`, error);
        return {
            resourceId: instanceId,
            resourceType: 'ec2',
            action: inRange ? 'start' : 'stop',
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
