import { NextRequest, NextResponse } from 'next/server';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { AuditService } from '@/lib/audit-service';
import { randomUUID } from 'crypto';

const ecsClient = new ECSClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const ECS_CLUSTER_NAME = process.env.ECS_CLUSTER_NAME || 'nucleus-app-ecs-cluster';
const DISCOVERY_TASK_DEF = process.env.DISCOVERY_TASK_DEFINITION_ARN || '';
const VPC_SUBNETS = (process.env.VPC_PRIVATE_SUBNETS || '').split(',').filter(Boolean);

/**
 * POST /api/inventory/sync
 * Trigger manual discovery sync for a specific account or all accounts
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json().catch(() => ({}));
        const accountId = body.accountId as string | undefined;
        const scanId = randomUUID();

        if (!DISCOVERY_TASK_DEF) {
            return NextResponse.json(
                { error: 'Discovery task definition not configured' },
                { status: 500 }
            );
        }

        if (VPC_SUBNETS.length === 0) {
            return NextResponse.json(
                { error: 'VPC subnets not configured' },
                { status: 500 }
            );
        }

        // Log scan initiation
        await AuditService.logResourceAction({
            action: 'scan_triggered',
            resourceType: 'discovery',
            resourceId: scanId,
            resourceName: accountId ? `Scan ${accountId}` : 'Full Scan',
            status: 'success',
            details: accountId
                ? `triggered manual discovery scan for account ${accountId}`
                : 'triggered manual discovery scan for all accounts',
            source: 'web-ui',
            metadata: {
                accountId: accountId || 'ALL',
                scanId
            }
        });

        // Build environment overrides
        const environment = [
            { name: 'SCAN_ID', value: scanId },
            { name: 'CORRELATION_ID', value: scanId },
        ];

        if (accountId) {
            environment.push({ name: 'ACCOUNT_ID', value: accountId });
        }

        const command = new RunTaskCommand({
            cluster: ECS_CLUSTER_NAME,
            taskDefinition: DISCOVERY_TASK_DEF,
            launchType: 'FARGATE',
            count: 1,
            overrides: {
                containerOverrides: [{
                    name: 'DiscoveryContainer',
                    environment,
                }],
            },
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets: VPC_SUBNETS,
                    assignPublicIp: 'DISABLED',
                },
            },
        });

        const result = await ecsClient.send(command);

        if (!result.tasks || result.tasks.length === 0) {
            const failures = result.failures?.map(f => f.reason).join(', ') || 'Unknown error';

            // Log failure
            await AuditService.logResourceAction({
                action: 'scan_failed',
                resourceType: 'discovery',
                resourceId: scanId,
                resourceName: accountId ? `Scan ${accountId}` : 'Full Scan',
                status: 'error',
                details: `Failed to trigger ECS task: ${failures}`,
                source: 'web-ui',
                metadata: {
                    accountId: accountId || 'ALL',
                    scanId,
                    failures
                }
            });

            return NextResponse.json(
                { error: `Failed to start discovery task: ${failures}` },
                { status: 500 }
            );
        }

        const task = result.tasks[0];

        return NextResponse.json({
            success: true,
            message: accountId
                ? `Discovery sync triggered for account ${accountId}`
                : 'Discovery sync triggered for all accounts',
            taskArn: task.taskArn,
            taskId: task.taskArn?.split('/').pop(),
            scanId,
            startedAt: new Date().toISOString(),
        });

    } catch (error: any) {
        console.error('Error triggering discovery sync:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to trigger sync' },
            { status: 500 }
        );
    }
}
