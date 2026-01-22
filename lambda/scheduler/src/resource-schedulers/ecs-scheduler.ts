// ECS Scheduler - Scale ECS services based on schedule resources (ARN-driven)
// Stores desiredCount before stopping and restores it when starting
import {
    ECSClient,
    DescribeServicesCommand,
    UpdateServiceCommand,
    ListServicesCommand,
    DescribeClustersCommand,
    DescribeCapacityProvidersCommand,
    ListContainerInstancesCommand,
    DescribeContainerInstancesCommand,
} from '@aws-sdk/client-ecs';
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    UpdateAutoScalingGroupCommand,
    DescribeAutoScalingInstancesCommand,
    SetInstanceProtectionCommand,
} from '@aws-sdk/client-auto-scaling';
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
// Define ASG State type for local usage
interface ASGState {
    name: string;
    minSize: number;
    maxSize: number;
    desiredCapacity: number;
}

export async function processECSResource(
    resource: ScheduleResource,
    schedule: Schedule,
    action: 'start' | 'stop',
    credentials: AssumedCredentials,
    metadata: SchedulerMetadata,
    lastDesiredCount?: number,
    lastAsgState?: ASGState[]
): Promise<ECSResourceExecution> {
    const ecsClient = new ECSClient({
        credentials: credentials.credentials,
        region: credentials.region,
    });

    // Initialize ASG client (lazy loaded if needed, but we'll specific init here for cleaner code)
    const asgClient = new AutoScalingClient({
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

        let capturedAsgState: ASGState[] | undefined;

        if (action === 'stop') {
            let serviceStopped = false;
            let asgStopped = false;

            // 1. Stop Service if needed
            if (currentDesiredCount > 0) {
                await ecsClient.send(new UpdateServiceCommand({
                    cluster: clusterArn,
                    service: serviceName,
                    desiredCount: 0,
                }));
                log.info(`Stopped ECS service ${serviceName} (was desiredCount=${currentDesiredCount})`);
                serviceStopped = true;

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
            }

            // 2. Check if cluster is idle (or will be) and manage ASGs
            // We pass the current serviceName to exclude it from the "active" check,
            // treating it as 0 logic even if AWS API hasn't updated yet.
            const idle = await isClusterIdle(clusterArn, serviceName, ecsClient);

            if (idle) {
                log.info(`Cluster ${clusterArn} appears idle. Checking for associated Capacity Providers/ASGs to stop.`);
                const asgs = await getClusterASGs(clusterArn, ecsClient, asgClient);

                if (asgs.length > 0) {
                    capturedAsgState = [];
                    for (const asgName of asgs) {
                        try {
                            // Get current ASG state
                            const asgResp = await asgClient.send(new DescribeAutoScalingGroupsCommand({
                                AutoScalingGroupNames: [asgName]
                            }));
                            const asg = asgResp.AutoScalingGroups?.[0];
                            if (asg) {
                                // Capture state only if capacity > 0 (to avoid overwriting valid state with 0s)
                                // OR if we don't care because we aggregate later.
                                // Better to capture what we see.
                                const state: ASGState = {
                                    name: asgName,
                                    minSize: asg.MinSize ?? 0,
                                    maxSize: asg.MaxSize ?? 0,
                                    desiredCapacity: asg.DesiredCapacity ?? 0
                                };

                                log.info(`ASG ${asgName} state: Min=${state.minSize}, Max=${state.maxSize}, Desired=${state.desiredCapacity}`);

                                // Check for Scale-In Protected Instances and disable protection
                                if (asg.Instances && asg.Instances.length > 0) {
                                    const protectedInstances = asg.Instances.filter(i => i.ProtectedFromScaleIn);
                                    if (protectedInstances.length > 0) {
                                        log.info(`Found ${protectedInstances.length} instances protected from scale-in. Disabling protection...`);
                                        try {
                                            await asgClient.send(new SetInstanceProtectionCommand({
                                                AutoScalingGroupName: asgName,
                                                InstanceIds: protectedInstances.map(i => i.InstanceId!),
                                                ProtectedFromScaleIn: false
                                            }));
                                            log.info(`Successfully disabled scale-in protection for ${protectedInstances.length} instances`);
                                        } catch (protErr) {
                                            log.error(`Failed to disable scale-in protection`, protErr);
                                        }
                                    }
                                }

                                if (state.desiredCapacity > 0 || state.minSize > 0) {
                                    capturedAsgState.push(state);

                                    // Stop ASG
                                    await asgClient.send(new UpdateAutoScalingGroupCommand({
                                        AutoScalingGroupName: asgName,
                                        MinSize: 0,
                                        MaxSize: 0,
                                        DesiredCapacity: 0
                                    }));
                                    log.info(`Stopped backing ASG ${asgName} for idle cluster`);
                                    asgStopped = true;

                                    await createAuditLog({
                                        type: 'audit_log',
                                        eventType: 'scheduler.asg.stop',
                                        action: 'stop',
                                        user: 'system',
                                        userType: 'system',
                                        resourceType: 'asg',
                                        resourceId: asgName,
                                        status: 'success',
                                        details: `Stopped backing ASG ${asgName} as ECS Cluster ${clusterArn} became idle`,
                                        severity: 'medium',
                                        accountId: metadata.account.accountId,
                                        region: metadata.region,
                                    });
                                } else {
                                    log.info(`ASG ${asgName} already stopped (0/0/0)`);
                                }
                            }
                        } catch (err) {
                            log.error(`Failed to process backing ASG ${asgName}`, err);
                        }
                    }
                } else {
                    log.info(`No backing ASGs found for cluster ${clusterArn}`);
                }
            } else {
                log.debug(`Cluster ${clusterArn} is not idle (other services active), skipping ASG shutdown.`);
            }

            if (serviceStopped || asgStopped) {
                return {
                    arn: resource.arn,
                    resourceId: resource.id,
                    clusterArn,
                    action: 'stop',
                    status: 'success',
                    last_state: {
                        desiredCount: currentDesiredCount,
                        runningCount,
                        pendingCount,
                        status: serviceStatus,
                        asg_state: capturedAsgState // Will be undefined if we didn't stop ASGs, or empty if they were already 0
                    },
                };
            } else {
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
                        asg_state: undefined
                    },
                };
            }


        } else if (action === 'start') {
            // Check if we need to start (either ECS is 0, or backing ASG is 0 despite ECS being > 0)
            // We proceed with start logic (idempotent) to ensure ASGs are healthy

            if (lastAsgState && lastAsgState.length > 0) {
                log.info(`Restoring ${lastAsgState.length} backing ASGs before starting service`);
                for (const state of lastAsgState) {
                    try {
                        await asgClient.send(new UpdateAutoScalingGroupCommand({
                            AutoScalingGroupName: state.name,
                            MinSize: state.minSize,
                            MaxSize: state.maxSize,
                            DesiredCapacity: state.desiredCapacity
                        }));
                        log.info(`Restored backing ASG ${state.name} to min=${state.minSize}, max=${state.maxSize}, desired=${state.desiredCapacity}`);

                        await createAuditLog({
                            type: 'audit_log',
                            eventType: 'scheduler.asg.start',
                            action: 'start',
                            user: 'system',
                            userType: 'system',
                            resourceType: 'asg',
                            resourceId: state.name,
                            status: 'success',
                            details: `Restored backing ASG ${state.name} before starting ECS Service ${serviceName}`,
                            severity: 'medium',
                            accountId: metadata.account.accountId,
                            region: metadata.region,
                        });
                    } catch (err) {
                        log.error(`Failed to restore backing ASG ${state.name}`, err);
                        // Continue even if ASG fails? Yes, try to start service anyway.
                    }
                }

                // Wait a moment for ASG to register? 
                // In a synchronous Lambda, waiting for instances to come up might timeout.
                // We rely on ECS Service logic to place tasks when instances become available.
            } else {
                // Fallback: If no state is captured, check if there are backing ASGs and ensure they have capacity
                log.info(`No captured ASG state found for service ${serviceName}. Checking for backing ASGs to apply default capacity.`);
                const currentAsgs = await getClusterASGs(clusterArn, ecsClient, asgClient);

                if (currentAsgs.length > 0) {
                    for (const asgName of currentAsgs) {
                        try {
                            // Check current state
                            const asgResp = await asgClient.send(new DescribeAutoScalingGroupsCommand({
                                AutoScalingGroupNames: [asgName]
                            }));
                            const asg = asgResp.AutoScalingGroups?.[0];

                            if (asg && asg.DesiredCapacity === 0) {
                                // Default fallback: Ensure at least 1 instance
                                // Ensure valid bounds: Min <= 1 <= Max
                                const newMin = (asg.MinSize ?? 0) === 0 ? 1 : (asg.MinSize ?? 0);
                                const newMax = (asg.MaxSize ?? 0) < newMin ? newMin : (asg.MaxSize ?? 0);

                                await asgClient.send(new UpdateAutoScalingGroupCommand({
                                    AutoScalingGroupName: asgName,
                                    MinSize: newMin,
                                    MaxSize: newMax,
                                    DesiredCapacity: 1
                                }));
                                log.info(`Applied default capacity (1) to backing ASG ${asgName} (Fallback: was 0/0/0)`);

                                await createAuditLog({
                                    type: 'audit_log',
                                    eventType: 'scheduler.asg.start',
                                    action: 'start',
                                    user: 'system',
                                    userType: 'system',
                                    resourceType: 'asg',
                                    resourceId: asgName,
                                    status: 'warning',
                                    details: `Restored backing ASG ${asgName} with fallback default (1) as no state was captured`,
                                    severity: 'medium',
                                    accountId: metadata.account.accountId,
                                    region: metadata.region,
                                });
                            }
                        } catch (err) {
                            log.error(`Failed to apply fallback capacity to ASG ${asgName}`, err);
                        }
                    }
                }
            }

            // Start the service by restoring desiredCount
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
                    desiredCount: currentDesiredCount,
                    runningCount,
                    pendingCount,
                    status: serviceStatus,
                    asg_state: lastAsgState // Preserve the state
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
                    asg_state: lastAsgState
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

// --- Helper Functions ---

/**
 * Check if a cluster is idle (has no running or desired tasks),
 * excluding the service we just stopped.
 */
async function isClusterIdle(clusterArn: string, excludedServiceName: string, ecsClient: ECSClient): Promise<boolean> {
    try {
        const services = await listAllServiceArns(ecsClient, clusterArn);
        if (services.length === 0) return true;

        // Process services in batches of 10 for DescribeServices
        const batchSize = 10;
        for (let i = 0; i < services.length; i += batchSize) {
            const batch = services.slice(i, i + batchSize);
            const resp = await ecsClient.send(new DescribeServicesCommand({
                cluster: clusterArn,
                services: batch
            }));

            for (const svc of resp.services || []) {
                const name = svc.serviceName || '';
                const arn = svc.serviceArn || '';

                // Skip the service we explicitly excluded (the one we just stopped)
                if (name === excludedServiceName || arn.endsWith(`/${excludedServiceName}`)) {
                    continue;
                }

                // If any other service has desiredCount > 0 or runningCount > 0, the cluster is NOT idle
                if ((svc.desiredCount || 0) > 0 || (svc.runningCount || 0) > 0) {
                    return false;
                }
            }
        }

        return true;
    } catch (error) {
        logger.error(`Error checking if cluster ${clusterArn} is idle`, error);
        // Fail safe: assume NOT idle to avoid accidental shutdown
        return false;
    }
}

/**
 * Get all ASG names associated with a cluster's Capacity Providers AND running container instances.
 */
async function getClusterASGs(clusterArn: string, ecsClient: ECSClient, asgClient: AutoScalingClient): Promise<string[]> {
    const asgNames = new Set<string>();

    try {
        // Method 1: Capacity Providers (The modern/correct way)
        const clusterResp = await ecsClient.send(new DescribeClustersCommand({
            clusters: [clusterArn]
        }));

        const cluster = clusterResp.clusters?.[0];
        if (cluster && cluster.capacityProviders && cluster.capacityProviders.length > 0) {
            const customCPs = cluster.capacityProviders.filter(cp => cp !== 'FARGATE' && cp !== 'FARGATE_SPOT');

            if (customCPs.length > 0) {
                const cpResp = await ecsClient.send(new DescribeCapacityProvidersCommand({
                    capacityProviders: customCPs
                }));

                for (const cp of cpResp.capacityProviders || []) {
                    if (cp.autoScalingGroupProvider && cp.autoScalingGroupProvider.autoScalingGroupArn) {
                        const arn = cp.autoScalingGroupProvider.autoScalingGroupArn;
                        // Extract name from ARN
                        const match = arn.match(/autoScalingGroupName\/(.+)$/);
                        asgNames.add(match ? match[1] : arn);
                    }
                }
            }
        }

        // Method 2: Container Instances (The legacy/fallback way)
        // If an ASG is just attached to the cluster but not a CP, we find it by looking at the instances.
        const containerInstances = await listAllContainerInstances(ecsClient, clusterArn);

        if (containerInstances.length > 0) {
            // Describe them to get EC2 Instance IDs
            // Process in batches of 100 (API limit)
            const batchSize = 100;
            const ec2InstanceIds: string[] = [];

            for (let i = 0; i < containerInstances.length; i += batchSize) {
                const batch = containerInstances.slice(i, i + batchSize);
                const descResp = await ecsClient.send(new DescribeContainerInstancesCommand({
                    cluster: clusterArn,
                    containerInstances: batch
                }));

                for (const ci of descResp.containerInstances || []) {
                    if (ci.ec2InstanceId) {
                        ec2InstanceIds.push(ci.ec2InstanceId);
                    }
                }
            }

            // Now check which ASG these instances belong to
            if (ec2InstanceIds.length > 0) {
                const asgBatchSize = 50;
                for (let i = 0; i < ec2InstanceIds.length; i += asgBatchSize) {
                    const batch = ec2InstanceIds.slice(i, i + asgBatchSize);

                    try {
                        const asgInstResp = await asgClient.send(new DescribeAutoScalingInstancesCommand({
                            InstanceIds: batch
                        }));


                        for (const inst of asgInstResp.AutoScalingInstances || []) {
                            if (inst.AutoScalingGroupName) {
                                asgNames.add(inst.AutoScalingGroupName);
                            }
                        }
                    } catch (err) {
                        logger.error(`Error describing ASG instances for batch`, err);
                    }
                }
            }
        }

    } catch (error) {
        logger.error(`Error finding ASGs for cluster ${clusterArn}`, error);
    }

    const result = Array.from(asgNames);
    if (result.length > 0) {
        logger.info(`Found backing ASGs for cluster ${clusterArn}`, { asgNames: result });
    } else {
        logger.info(`No backing ASGs found for cluster ${clusterArn}`);
    }
    return result;
}

/**
 * Helper to list all container instances (ACTIVE and DRAINING)
 */
async function listAllContainerInstances(ecsClient: ECSClient, clusterArn: string): Promise<string[]> {
    const arns: string[] = [];

    // Check ACTIVE
    let nextToken: string | undefined;
    do {
        const response: any = await ecsClient.send(new ListContainerInstancesCommand({
            cluster: clusterArn,
            maxResults: 100,
            nextToken,
            status: 'ACTIVE'
        }));
        if (response.containerInstanceArns) arns.push(...response.containerInstanceArns);
        nextToken = response.nextToken;
    } while (nextToken);

    // Check DRAINING
    nextToken = undefined;
    try {
        do {
            const response: any = await ecsClient.send(new ListContainerInstancesCommand({
                cluster: clusterArn,
                maxResults: 100,
                nextToken,
                status: 'DRAINING'
            }));
            if (response.containerInstanceArns) arns.push(...response.containerInstanceArns);
            nextToken = response.nextToken;
        } while (nextToken);
    } catch (err) {
        // Ignore
    }

    return arns;

}

/**
 * List all service ARNs in a cluster with pagination.
 */
async function listAllServiceArns(ecsClient: ECSClient, clusterArn: string): Promise<string[]> {
    const services: string[] = [];
    let nextToken: string | undefined;

    do {
        const response: any = await ecsClient.send(new ListServicesCommand({
            cluster: clusterArn,
            maxResults: 100,
            nextToken,
        }));

        if (response.serviceArns) {
            services.push(...response.serviceArns);
        }
        nextToken = response.nextToken;
    } while (nextToken);

    return services;
}

export function extractServiceName(arn: string): string {
    const match = arn.match(/service\/[^/]+\/(.+)$/);
    if (!match) {
        const altMatch = arn.match(/service\/(.+)$/);
        if (!altMatch) {
            throw new Error(`Invalid ECS service ARN format: ${arn}`);
        }
        return altMatch[1];
    }
    return match[1];
}

export function extractClusterName(arn: string): string | null {
    const match = arn.match(/service\/([^/]+)\/[^/]+$/);
    if (!match) {
        return null;
    }
    return match[1];
}

export function extractRegionFromArn(arn: string): string {
    const parts = arn.split(':');
    if (parts.length < 4) {
        throw new Error(`Invalid ARN format: ${arn}`);
    }
    return parts[3];
}
