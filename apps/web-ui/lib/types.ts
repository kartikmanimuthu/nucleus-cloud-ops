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

    // ── Fargate Spot Guard ────────────────────────────────────────────────────
    /** Customer deployed their onboarding stack with EnableSpotAutomation=true. */
    spotAutomationEnabled?: boolean;
    /**
     * Whether the customer-side EventBridge forwarding rule is actually in place.
     *
     * Deliberately SEPARATE from connectionStatus. That field has two independent
     * writers — web-ui validateAccount and the workers discovery job, which derives it
     * from lastSyncStatus — so any Spot value written there would be clobbered by the
     * next nightly discovery scan. It is also semantically wrong: a customer who has
     * not opted in does not have a broken connection and must not show as an error.
     *
     *   not_configured — flag off, or never probed
     *   pending        — flag on but the forwarding rule is missing/disabled
     *   ready          — rule exists, ENABLED, and targets our bus
     *   error          — probe failed for some other reason
     */
    spotAutomationStatus?: 'not_configured' | 'pending' | 'ready' | 'error';
    spotAutomationCheckedAt?: string;
    spotAutomationError?: string;
    /** Onboarding template version deployed, read from the role's tags. */
    templateVersion?: number;

    // ── Scaling Audit ───────────────────────────────────────────────────────────
    /** Per-account opt-in for the daily scaling-audit poll (mirrors spotAutomationEnabled). */
    scalingAuditEnabled?: boolean;

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
    eventType: string;       // domain.entity.action (e.g., account.account.created)
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
    source: 'platform' | 'system' | 'agent' | 'external';
    // Compliance fields (SOC 2 / NIST AU-3)
    changeSet?: { before?: Record<string, any>; after?: Record<string, any> };
    requestId?: string;
    apiRoute?: string;
    httpMethod?: string;
    dataClassification?: string;
    retentionDays?: number;
}
