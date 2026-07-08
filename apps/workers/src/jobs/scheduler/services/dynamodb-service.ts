// Scheduler audit logging (PostgreSQL-backed via pg-service) + a DynamoDB document
// client retained only for the legacy "last resource state" reads in
// execution-history-service.ts. The old DynamoDB schedule/account fetch paths were
// removed once USE_PG_SCHEDULES became the permanent configuration.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '../utils/logger.js';
import { createAuditLog as createAuditLogPg } from './pg-service.js';
import type {
    Schedule,
    AuditLogEntry,
    ScheduleExecutionMetadata,
} from '../types/index.js';
import { env } from '../../../env.js';

// Environment variables
const APP_TABLE_NAME = env.APP_TABLE_NAME || 'cost-optimization-scheduler-app-table';
const AUDIT_TABLE_NAME = env.AUDIT_TABLE_NAME || 'cost-optimization-scheduler-audit-table';
const AWS_REGION = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-south-1';

// Singleton DynamoDB client
let docClient: DynamoDBDocumentClient | null = null;

export function getDynamoDBClient(): DynamoDBDocumentClient {
    if (!docClient) {
        const clientConfig: any = { region: AWS_REGION };

        // Use defaultProvider which correctly handles environment, shared config, and SSO
        // We pass the profile explicitly if it's set in the environment to be extra safe
        clientConfig.credentials = defaultProvider({
            profile: env.AWS_PROFILE,
        });

        const client = new DynamoDBClient(clientConfig);
        docClient = DynamoDBDocumentClient.from(client, {
            marshallOptions: {
                removeUndefinedValues: true,
            },
        });
    }
    return docClient;
}

/**
 * Create an audit log entry (PostgreSQL-backed).
 * Used for system cron events and scheduler lifecycle logs.
 */
export async function createAuditLog(entry: AuditLogEntry): Promise<void> {
    await createAuditLogPg({ ...entry, tenantId: entry.tenantId || 'system' });
}

/**
 * Create a summarized execution audit log entry
 * This provides a single audit record for the entire execution with complete metadata
 */
export async function createExecutionAuditLog(
    executionId: string,
    schedule: Schedule,
    metadata: ScheduleExecutionMetadata,
    summary: {
        resourcesStarted: number;
        resourcesStopped: number;
        resourcesFailed: number;
        duration: number;
    },
    userEmail?: string
): Promise<void> {
    if (!AUDIT_TABLE_NAME) {
        logger.warn('AUDIT_TABLE_NAME not configured, skipping execution audit log');
        return;
    }

    // Calculate summary counts per resource type
    const ec2Summary = {
        started: metadata.ec2.filter(r => r.action === 'start' && r.status === 'success').length,
        stopped: metadata.ec2.filter(r => r.action === 'stop' && r.status === 'success').length,
        failed: metadata.ec2.filter(r => r.status === 'failed').length,
        skipped: metadata.ec2.filter(r => r.action === 'skip').length,
    };

    const ecsSummary = {
        started: metadata.ecs.filter(r => r.action === 'start' && r.status === 'success').length,
        stopped: metadata.ecs.filter(r => r.action === 'stop' && r.status === 'success').length,
        failed: metadata.ecs.filter(r => r.status === 'failed').length,
        skipped: metadata.ecs.filter(r => r.action === 'skip').length,
    };

    const rdsSummary = {
        started: metadata.rds.filter(r => r.action === 'start' && r.status === 'success').length,
        stopped: metadata.rds.filter(r => r.action === 'stop' && r.status === 'success').length,
        failed: metadata.rds.filter(r => r.status === 'failed').length,
        skipped: metadata.rds.filter(r => r.action === 'skip').length,
    };

    const asgSummary = {
        started: metadata.asg.filter(r => r.action === 'start' && r.status === 'success').length,
        stopped: metadata.asg.filter(r => r.action === 'stop' && r.status === 'success').length,
        failed: metadata.asg.filter(r => r.status === 'failed').length,
        skipped: metadata.asg.filter(r => r.action === 'skip').length,
    };

    const overallStatus = summary.resourcesFailed > 0
        ? (summary.resourcesStarted + summary.resourcesStopped > 0 ? 'warning' : 'error')
        : 'success';

    const details = [
        `Execution ${executionId} for schedule "${schedule.name}" completed.`,
        `EC2: ${ec2Summary.started} started, ${ec2Summary.stopped} stopped, ${ec2Summary.failed} failed, ${ec2Summary.skipped} skipped.`,
        `ECS: ${ecsSummary.started} started, ${ecsSummary.stopped} stopped, ${ecsSummary.failed} failed, ${ecsSummary.skipped} skipped.`,
        `RDS: ${rdsSummary.started} started, ${rdsSummary.stopped} stopped, ${rdsSummary.failed} failed, ${rdsSummary.skipped} skipped.`,
        `ASG: ${asgSummary.started} started, ${asgSummary.stopped} stopped, ${asgSummary.failed} failed, ${asgSummary.skipped} skipped.`,
        `Duration: ${summary.duration}ms`,
    ].join(' ');

    await createAuditLog({
        type: 'audit_log',
        eventType: 'schedule.execution.completed',
        action: 'execution_complete',
        user: userEmail || 'system',
        userType: userEmail ? 'user' : 'system',
        resourceType: 'Schedule',
        resourceId: executionId,
        status: overallStatus,
        details,
        severity: summary.resourcesFailed > 0 ? 'medium' : 'low',
        tenantId: schedule.tenantId || 'system',
        metadata: {
            executionId,
            scheduleId: schedule.scheduleId,
            scheduleName: schedule.name,
            duration: summary.duration,
            summary: {
                total: {
                    started: summary.resourcesStarted,
                    stopped: summary.resourcesStopped,
                    failed: summary.resourcesFailed,
                },
                ec2: ec2Summary,
                ecs: ecsSummary,
                rds: rdsSummary,
                asg: asgSummary,
            },
            schedule_metadata: metadata,
        },
    });

    logger.info('Execution audit log created', { executionId, scheduleId: schedule.scheduleId });
}

export { APP_TABLE_NAME, AUDIT_TABLE_NAME, AWS_REGION };

