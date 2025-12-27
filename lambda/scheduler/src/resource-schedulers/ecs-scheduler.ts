// ECS Scheduler - Scale ECS services and clusters based on schedules
import {
    ECSClient,
    ListClustersCommand,
    DescribeClustersCommand,
    ListServicesCommand,
    DescribeServicesCommand,
    UpdateServiceCommand,
    ListTagsForResourceCommand,
    DescribeCapacityProvidersCommand,
} from '@aws-sdk/client-ecs';
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { logger } from '../utils/logger.js';
import { isCurrentTimeInRange } from '../utils/time-utils.js';
import { createAuditLog } from '../services/dynamodb-service.js';
import type { Schedule, AssumedCredentials, SchedulerMetadata, ResourceActionResult } from '../types/index.js';

const SCHEDULE_TAG = process.env.SCHEDULER_TAG || 'schedule';

/**
 * Process ECS clusters and services for scheduling
 */
export async function processECSResources(
    schedules: Schedule[],
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult[]> {
    const results: ResourceActionResult[] = [];

    const ecsClient = new ECSClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const asgClient = new AutoScalingClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    const log = logger.child({
        executionId: metadata.executionId,
        accountId: metadata.account.accountId,
        region: metadata.region,
        service: 'ecs',
    });

    log.info(`ECS Scheduler started for ${metadata.account.name}`);

    try {
        // List all ECS clusters
        const clustersResponse = await ecsClient.send(new ListClustersCommand({}));
        const clusterArns = clustersResponse.clusterArns || [];

        log.debug(`Found ${clusterArns.length} ECS clusters`);

        // Process each cluster
        for (const clusterArn of clusterArns) {
            const clusterResults = await processCluster(
                clusterArn,
                schedules,
                ecsClient,
                asgClient,
                log,
                metadata
            );
            results.push(...clusterResults);
        }

        log.info(`ECS Scheduler completed - ${results.length} actions taken`);
    } catch (error) {
        log.error('ECS Scheduler error', error);
        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.ecs.error',
            action: 'scan',
            user: 'system',
            userType: 'system',
            resourceType: 'ecs',
            resourceId: metadata.account.accountId,
            status: 'error',
            details: `ECS Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'high',
            accountId: metadata.account.accountId,
            region: metadata.region,
        });
    }

    return results;
}

async function processCluster(
    clusterArn: string,
    schedules: Schedule[],
    ecsClient: ECSClient,
    asgClient: AutoScalingClient,
    log: ReturnType<typeof logger.child>,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult[]> {
    const results: ResourceActionResult[] = [];

    try {
        // Get cluster tags
        const tagsResponse = await ecsClient.send(new ListTagsForResourceCommand({
            resourceArn: clusterArn,
        }));
        const tags = tagsResponse.tags || [];

        const scheduleTagValue = tags.find(t => t.key === SCHEDULE_TAG)?.value;
        if (!scheduleTagValue) {
            log.debug(`Cluster ${clusterArn} has no schedule tag, skipping`);
            return results;
        }

        const schedule = schedules.find(s => s.name === scheduleTagValue);
        if (!schedule) {
            log.debug(`Schedule "${scheduleTagValue}" not found for cluster ${clusterArn}`);
            return results;
        }

        const inRange = isCurrentTimeInRange(
            schedule.starttime,
            schedule.endtime,
            schedule.timezone,
            schedule.days
        );
        const desiredCapacity = inRange ? 1 : 0;

        // Process services in this cluster
        const servicesResults = await processClusterServices(
            clusterArn,
            schedules,
            ecsClient,
            log,
            metadata
        );
        results.push(...servicesResults);

        // Process ASGs for this cluster
        const asgResults = await processClusterASGs(
            clusterArn,
            desiredCapacity,
            ecsClient,
            asgClient,
            log,
            metadata
        );
        results.push(...asgResults);

    } catch (error) {
        log.error(`Error processing cluster ${clusterArn}`, error);
    }

    return results;
}

async function processClusterServices(
    clusterArn: string,
    schedules: Schedule[],
    ecsClient: ECSClient,
    log: ReturnType<typeof logger.child>,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult[]> {
    const results: ResourceActionResult[] = [];

    try {
        const servicesResponse = await ecsClient.send(new ListServicesCommand({
            cluster: clusterArn,
        }));
        const serviceArns = servicesResponse.serviceArns || [];

        for (const serviceArn of serviceArns) {
            const result = await processService(
                clusterArn,
                serviceArn,
                schedules,
                ecsClient,
                log,
                metadata
            );
            if (result) {
                results.push(result);
            }
        }
    } catch (error) {
        log.error(`Error processing services for cluster ${clusterArn}`, error);
    }

    return results;
}

async function processService(
    clusterArn: string,
    serviceArn: string,
    schedules: Schedule[],
    ecsClient: ECSClient,
    log: ReturnType<typeof logger.child>,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult | null> {
    try {
        // Get service tags
        const tagsResponse = await ecsClient.send(new ListTagsForResourceCommand({
            resourceArn: serviceArn,
        }));
        const scheduleTagValue = tagsResponse.tags?.find(t => t.key === SCHEDULE_TAG)?.value;

        if (!scheduleTagValue) return null;

        const schedule = schedules.find(s => s.name === scheduleTagValue);
        if (!schedule) return null;

        // Get current service details
        const serviceName = serviceArn.split('/').pop()!;
        const serviceDetails = await ecsClient.send(new DescribeServicesCommand({
            cluster: clusterArn,
            services: [serviceName],
        }));
        const service = serviceDetails.services?.[0];
        if (!service) return null;

        const inRange = isCurrentTimeInRange(
            schedule.starttime,
            schedule.endtime,
            schedule.timezone,
            schedule.days
        );
        const desiredCount = inRange ? 1 : 0;

        if (service.desiredCount === desiredCount) {
            log.debug(`ECS service ${serviceName} already at desired count ${desiredCount}`);
            return { resourceId: serviceName, resourceType: 'ecs', action: 'skip', success: true };
        }

        // Update service count
        await ecsClient.send(new UpdateServiceCommand({
            cluster: clusterArn,
            service: serviceName,
            desiredCount,
        }));

        log.info(`Updated ECS service ${serviceName} to count ${desiredCount}`);

        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.ecs.service.update',
            action: desiredCount > 0 ? 'start' : 'stop',
            user: 'system',
            userType: 'system',
            resourceType: 'ecs-service',
            resourceId: serviceName,
            status: 'success',
            details: `Updated ECS service ${serviceName} to count ${desiredCount}`,
            severity: 'medium',
            accountId: metadata.account.accountId,
            region: metadata.region,
        });

        return {
            resourceId: serviceName,
            resourceType: 'ecs',
            action: desiredCount > 0 ? 'start' : 'stop',
            success: true
        };
    } catch (error) {
        const serviceName = serviceArn.split('/').pop()!;
        log.error(`Error processing ECS service ${serviceName}`, error);
        return {
            resourceId: serviceName,
            resourceType: 'ecs',
            action: 'stop',
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function processClusterASGs(
    clusterArn: string,
    desiredCapacity: number,
    ecsClient: ECSClient,
    asgClient: AutoScalingClient,
    log: ReturnType<typeof logger.child>,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult[]> {
    const results: ResourceActionResult[] = [];

    try {
        // Get cluster capacity providers
        const clusterDetails = await ecsClient.send(new DescribeClustersCommand({
            clusters: [clusterArn],
        }));
        const cluster = clusterDetails.clusters?.[0];
        const capacityProviders = cluster?.capacityProviders || [];

        if (capacityProviders.length === 0) return results;

        // Get ASG ARNs from capacity providers
        const cpDetails = await ecsClient.send(new DescribeCapacityProvidersCommand({
            capacityProviders,
        }));

        for (const cp of cpDetails.capacityProviders || []) {
            const asgArn = cp.autoScalingGroupProvider?.autoScalingGroupArn;
            if (!asgArn) continue;

            const asgName = asgArn.split('/').pop()!;
            const result = await updateASG(asgName, desiredCapacity, asgClient, log, metadata);
            if (result) {
                results.push(result);
            }
        }
    } catch (error) {
        log.error(`Error processing ASGs for cluster ${clusterArn}`, error);
    }

    return results;
}

async function updateASG(
    asgName: string,
    desiredCapacity: number,
    asgClient: AutoScalingClient,
    log: ReturnType<typeof logger.child>,
    metadata: SchedulerMetadata
): Promise<ResourceActionResult | null> {
    try {
        // Get current ASG state
        const asgResponse = await asgClient.send(new DescribeAutoScalingGroupsCommand({
            AutoScalingGroupNames: [asgName],
        }));
        const asg = asgResponse.AutoScalingGroups?.[0];

        if (!asg || asg.DesiredCapacity === desiredCapacity) {
            return { resourceId: asgName, resourceType: 'asg', action: 'skip', success: true };
        }

        // Update ASG
        await asgClient.send(new UpdateAutoScalingGroupCommand({
            AutoScalingGroupName: asgName,
            DesiredCapacity: desiredCapacity,
            MinSize: desiredCapacity,
        }));

        log.info(`Updated ASG ${asgName} to capacity ${desiredCapacity}`);

        await createAuditLog({
            type: 'audit_log',
            eventType: 'scheduler.asg.update',
            action: desiredCapacity > 0 ? 'start' : 'stop',
            user: 'system',
            userType: 'system',
            resourceType: 'asg',
            resourceId: asgName,
            status: 'success',
            details: `Updated ASG ${asgName} to capacity ${desiredCapacity}`,
            severity: 'medium',
            accountId: metadata.account.accountId,
            region: metadata.region,
        });

        return {
            resourceId: asgName,
            resourceType: 'asg',
            action: desiredCapacity > 0 ? 'start' : 'stop',
            success: true
        };
    } catch (error) {
        log.error(`Error updating ASG ${asgName}`, error);
        return {
            resourceId: asgName,
            resourceType: 'asg',
            action: 'stop',
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
