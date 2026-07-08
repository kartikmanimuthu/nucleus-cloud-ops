// Type definitions for the scheduler worker

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
    /** User email for audit logging (when triggered by web-ui) */
    userEmail?: string;
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
    /** Tenant IDs that had actual work (schedules > 0 and accounts > 0). Used for per-tenant audit logging. */
    processedTenantIds?: string[];
    /** Tenant IDs the scan evaluated, whether or not they had work. Caller uses this to update lastRunAt so empty tenants aren't re-checked every tick. */
    checkedTenantIds?: string[];
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
    type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb';
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

// 'no_action' = the schedule was evaluated but every resource was already in the
// desired state, so nothing was started/stopped/failed. We still record the run so
// execution history reflects that the schedule ran.
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'partial' | 'no_action';

// Schedule Execution Metadata - grouped by resource type
export interface ScheduleExecutionMetadata {
    ec2: EC2ResourceExecution[];
    ecs: ECSResourceExecution[];
    rds: RDSResourceExecution[];
    asg: ASGResourceExecution[];
    docdb: RDSResourceExecution[];
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
        asg_state?: {
            name: string;
            minSize: number;
            maxSize: number;
            desiredCapacity: number;
        }[];
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

export interface ASGResourceExecution {
    arn: string;
    resourceId: string;
    action: 'start' | 'stop' | 'skip';
    status: 'success' | 'failed';
    error?: string;
    last_state: {
        minSize: number;
        maxSize: number;
        desiredCapacity: number;
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
    tenantId?: string;
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
    /**
     * When true, resource schedulers perform read-only describe + decision logic
     * but skip the actual Start/Stop/Update mutation (and the success audit write).
     * Used for safe local simulation. Error paths (describe failures) still run.
     */
    dryRun?: boolean;
}

// Resource action result
export interface ResourceActionResult {
    resourceId: string;
    resourceArn?: string;
    resourceType: 'ec2' | 'rds' | 'ecs' | 'asg' | 'docdb';
    action: 'start' | 'stop' | 'skip';
    success: boolean;
    error?: string;
    scheduleId?: string;
    scheduleName?: string;
}
