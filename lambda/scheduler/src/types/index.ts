// Type definitions for the scheduler Lambda

import type { Handler } from 'aws-lambda';

// Lambda Event Types
export interface SchedulerEvent {
    /** Schedule ID for partial scan */
    scheduleId?: string;
    /** Schedule name for partial scan (alternative to scheduleId) */
    scheduleName?: string;
    /** Force execution regardless of time window */
    force?: boolean;
    /** Source of the invocation */
    triggeredBy?: 'system' | 'web-ui';
    /** Optional tenant ID for partial scan */
    tenantId?: string;
}

export interface SchedulerResult {
    success: boolean;
    executionId: string;
    mode: 'full' | 'partial';
    schedulesProcessed: number;
    resourcesStarted: number;
    resourcesStopped: number;
    resourcesFailed: number;
    duration: number;
    errors?: string[];
}

// DynamoDB Entity Types
export interface Schedule {
    id?: string;             // UI convenience
    scheduleId: string;      // Database attribute
    name: string;            // Display name
    type: 'schedule';
    starttime: string;
    endtime: string;
    timezone: string;
    active: boolean;
    days: string[];
    description?: string;
    tenantId?: string;
    accountId?: string;
    resources?: ScheduleResource[];
    createdAt?: string;
    updatedAt?: string;
}

export interface ScheduleResource {
    id: string;
    type: 'ec2' | 'ecs' | 'rds';
    name?: string;
    arn: string;
    clusterArn?: string;  // Required for ECS services
}

export interface Account {
    accountId: string;       // Database attribute (also SK)
    name?: string;           // Optional, maps from accountName
    accountName?: string;    // Database attribute
    roleArn: string;
    externalId?: string;
    regions: string[] | string;
    active: boolean;
    tenantId?: string;
}

// Execution History
export interface ExecutionRecord {
    executionId: string;
    scheduleId: string;
    scheduleName: string;
    tenantId: string;
    accountId: string;
    status: ExecutionStatus;
    triggeredBy: 'system' | 'web-ui';
    startTime: string;
    endTime?: string;
    duration?: number;
    resourcesStarted: number;
    resourcesStopped: number;
    resourcesFailed: number;
    errorMessage?: string;
    details?: Record<string, unknown>;
    schedule_metadata?: ScheduleExecutionMetadata;
    ttl: number;
}

export type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'partial';

// Schedule Execution Metadata - grouped by resource type
export interface ScheduleExecutionMetadata {
    ec2: EC2ResourceExecution[];
    ecs: ECSResourceExecution[];
    rds: RDSResourceExecution[];
}

export interface EC2ResourceExecution {
    arn: string;
    resourceId: string;
    action: 'start' | 'stop' | 'skip';
    status: 'success' | 'failed';
    error?: string;
    last_state: {
        instanceState: string;
        instanceType?: string;
    };
}

export interface ECSResourceExecution {
    arn: string;
    resourceId: string;
    clusterArn: string;
    action: 'start' | 'stop' | 'skip';
    status: 'success' | 'failed';
    error?: string;
    last_state: {
        desiredCount: number;
        runningCount: number;
        pendingCount?: number;
        status?: string;
    };
}

export interface RDSResourceExecution {
    arn: string;
    resourceId: string;
    action: 'start' | 'stop' | 'skip';
    status: 'success' | 'failed';
    error?: string;
    last_state: {
        dbInstanceStatus: string;
        dbInstanceClass?: string;
    };
}

// Audit Log
export interface AuditLogEntry {
    type: 'audit_log';
    eventType: string;
    action: string;
    user: string;
    userType: 'system' | 'user';
    resourceType: string;
    resourceId: string;
    status: 'success' | 'error' | 'warning' | 'info';
    details: string;
    severity: 'low' | 'medium' | 'high' | 'info';
    accountId?: string;
    region?: string;
    metadata?: Record<string, unknown>;
}

// STS Credentials
export interface AssumedCredentials {
    credentials: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken: string;
    };
    region: string;
}

// Metadata passed to resource schedulers
export interface SchedulerMetadata {
    account: {
        name: string;
        accountId: string;
    };
    region: string;
    executionId: string;
    scheduleId?: string;
    scheduleName?: string;
}

// Resource action result
export interface ResourceActionResult {
    resourceId: string;
    resourceArn?: string;
    resourceType: 'ec2' | 'rds' | 'ecs' | 'asg';
    action: 'start' | 'stop' | 'skip';
    success: boolean;
    error?: string;
    scheduleId?: string;
    scheduleName?: string;
}

// Handler type
export type SchedulerHandler = Handler<SchedulerEvent, SchedulerResult>;
