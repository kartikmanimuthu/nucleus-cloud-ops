// TypeScript interfaces for the DynamoDB data
export interface Schedule {
    name: string;
    type: 'schedule';
    starttime: string;
    endtime: string;
    timezone: string;
    active: boolean;
    days: string[];
    description?: string;
    tenantId?: string; // Tenant ID for multi-tenant schema
    accountId?: string; // Account ID this schedule applies to (required in new schema)
    resources?: Array<{ // Selected resources
        id: string;
        type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb';
        name?: string;
        arn?: string; // AWS ARN for the resource
        clusterArn?: string; // ECS cluster ARN (for ECS services)
    }>;
    lastExecution?: string;
    executionCount?: number;
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
    updatedBy?: string;
}

export interface AccountMetadata {
    type: 'account_metadata';
    tenantId?: string; // Tenant ID for multi-tenant schema
    accountId: string;
    name: string;
    roleArn: string;
    externalId?: string; // Correctly added optional externalId
    regions: string[];
    active: boolean;
    description?: string;
    connectionStatus?: 'connected' | 'error' | 'warning' | 'validating' | 'unknown';
    connectionError?: string;
    lastValidated?: string;
    resourceCount?: number;
    schedulesCount?: number;
    monthlySavings?: number;
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
    updatedBy?: string;
    tags?: Array<{ key: string; value: string }>;
}

// Enhanced types for UI display
export interface UISchedule extends Omit<Schedule, 'type'> {
    id: string;
    accounts: string[];
    resourceTypes: string[];
    resourceTags?: string;
    excludeTags?: string;
    lastExecution?: string;
    nextExecution?: string;
    executionCount?: number;
    successRate?: number;
    estimatedSavings?: number;
}

export interface UIAccount extends Omit<AccountMetadata, 'type'> {
    id: string;
    externalId?: string;
}

// Next.js Search Params type for URL parameters
export interface SearchParams {
    [key: string]: string | string[] | undefined;
}

// Audit Log types
export interface AuditLog {
    id: string;
    type: 'audit_log';
    timestamp: string;
    eventType: string;
    action: string;
    user: string;
    userType: 'system' | 'user' | 'admin' | 'external';
    resource: string;
    resourceType: string;
    resourceId: string;
    status: 'success' | 'error' | 'warning' | 'info' | 'pending';
    severity: 'low' | 'medium' | 'high' | 'critical' | 'info';
    details: string;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
    correlationId?: string;
    executionId?: string;
    region?: string;
    accountId?: string;
    duration?: number;
    errorCode?: string;
    source: 'web-ui' | 'lambda' | 'system' | 'api';
}
