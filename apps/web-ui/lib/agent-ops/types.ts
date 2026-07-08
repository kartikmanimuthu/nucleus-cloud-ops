/**
 * Agent Ops Type Definitions
 * 
 * Shared types for the headless agent execution system.
 */

// ─── Enumerations ──────────────────────────────────────────────────────

export type TriggerSource = 'slack' | 'jira' | 'discord' | 'telegram' | 'webhook' | 'api' | 'scheduled';

export type AgentOpsStatus = 'queued' | 'in_progress' | 'awaiting_input' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export type AgentMode = 'plan' | 'fast';

export type AgentEventType =
    | 'planning'
    | 'execution'
    | 'tool_call'
    | 'tool_result'
    | 'reflection'
    | 'revision'
    | 'final'
    | 'error';

// ─── Trigger Metadata ──────────────────────────────────────────────────

export interface SlackTriggerMeta {
    userId: string;
    userName?: string;
    channelId: string;
    channelName?: string;
    responseUrl: string;
    teamId?: string;
    threadTs?: string;      // Slack thread timestamp for HIL reply correlation
}

export interface JiraTriggerMeta {
    issueKey: string;
    projectKey: string;
    reporter: string;
    issueType?: string;
    webhookId?: string;
}

export interface ApiTriggerMeta {
    apiKeyId?: string;
    callbackUrl?: string;
    clientId?: string;
}

export interface ScheduledTriggerMeta {
    taskId: string;
    taskName: string;
    scheduledAt: string;    // ISO timestamp of the scheduled fire time
}

export interface DiscordTriggerMeta {
    userId: string;
    channelId: string;
    guildId?: string;
    interactionId: string;
    interactionToken: string;
    messageId?: string;
}

export interface TelegramTriggerMeta {
    userId: number;
    chatId: number;
    messageId?: number;
    callbackQueryId?: string;
}

export interface WebhookTriggerMeta {
    callbackUrl: string;
    webhookId?: string;
    secret?: string;
}

export type TriggerMetadata = SlackTriggerMeta | JiraTriggerMeta | DiscordTriggerMeta | TelegramTriggerMeta | WebhookTriggerMeta | ApiTriggerMeta | ScheduledTriggerMeta;

// ─── Agent Ops Run ─────────────────────────────────────────────────────

export interface AgentOpsClarification {
    question: string;       // The question posted back to the user
    missingInfo: string;    // Brief description of what information is needed
}

export interface AgentOpsApprovalRequest {
    planSteps: string[];        // Human-readable plan steps to show in Slack
    pendingTools?: string[];    // Tool names that will be called (if interrupt-before-tools)
    approvalType: 'plan' | 'tool_execution';
    slackMessageTs?: string;    // ts of the Block Kit approval message (for updating it)
}

export interface AgentOpsRun {
    PK: string;             // TENANT#<tenantId>
    SK: string;             // RUN#<runId>
    GSI1PK: string;         // SOURCE#<source>
    GSI1SK: string;         // <timestamp>#<runId>
    runId: string;
    tenantId: string;
    source: TriggerSource;
    status: AgentOpsStatus;
    taskDescription: string;
    mode: AgentMode;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    autoApprove?: boolean;  // false = interrupt before tool execution for human approval
    model?: string;         // Bedrock model ID override
    threadId: string;       // LangGraph thread ID
    mcpServerIds?: string[];
    knowledgeBaseIds?: string[];
    trigger: TriggerMetadata;
    result?: AgentOpsResult;
    clarification?: AgentOpsClarification;   // Set when status is awaiting_input
    approvalRequest?: AgentOpsApprovalRequest; // Set when status is awaiting_approval
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    durationMs?: number;
    ttl: number;
}

export interface AgentOpsResult {
    summary: string;
    toolsUsed: string[];
    iterations: number;
    artifacts?: string[];   // S3 keys
}

// ─── Agent Ops Event ───────────────────────────────────────────────────

export interface AgentOpsEvent {
    PK: string;             // RUN#<runId>
    SK: string;             // EVENT#<timestamp>#<sequence>
    runId: string;
    eventType: AgentEventType;
    node: string;           // LangGraph node name
    content?: string;       // LLM response text
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    ttl: number;
}

// ─── Scheduled Task ────────────────────────────────────────────────────

export type ScheduledTaskStatus = 'active' | 'paused' | 'deleted';

export interface ScheduledTaskNotification {
    type: 'none' | 'slack' | 'jira' | 'telegram';
    channelId?: string;      // slack
    channelName?: string;    // slack (display only)
    chatId?: string;         // telegram
    projectKey?: string;     // jira
    issueKey?: string;       // jira
}

export interface ScheduledTask {
    PK: string;             // TENANT#<tenantId>
    SK: string;             // SCHED#<taskId>
    GSI1PK: string;         // TYPE#SCHEDULED_TASK
    GSI1SK: string;         // <tenantId>#<taskId>
    taskId: string;
    tenantId: string;
    name: string;
    description: string;
    cronExpression: string;
    timezone: string;
    taskStatus: ScheduledTaskStatus;
    mode: AgentMode;
    autoApprove: boolean;
    model?: string;
    accountId?: string;
    accountName?: string;
    mcpServerIds?: string[];
    knowledgeBaseIds?: string[];
    notification: ScheduledTaskNotification;
    lastRunId?: string;
    lastRunAt?: string;
    lastRunStatus?: AgentOpsStatus;
    nextRunAt?: string;
    runCount: number;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    ttl?: number;
}

// ─── API Request / Response ────────────────────────────────────────────

export interface TriggerRequest {
    taskDescription: string;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    mode?: AgentMode;
    autoApprove?: boolean;
    model?: string;
    mcpServerIds?: string[];
}

export interface ResumeRequest {
    userInput: string;
    tenantId: string;
}


export interface TriggerResponse {
    runId: string;
    status: AgentOpsStatus;
    message: string;
}

export interface RunListQuery {
    tenantId?: string;
    source?: TriggerSource;
    status?: AgentOpsStatus;
    limit?: number;
    lastKey?: Record<string, unknown>;
}

// ─── Integration Config ─────────────────────────────────────────────────

export interface SlackIntegrationConfig {
    signingSecret: string;
    botToken?: string;
    enabled: boolean;
    autoApprove?: boolean;  // false = HITL approval gates active (default)
}

export interface JiraIntegrationConfig {
    webhookSecret: string;
    baseUrl?: string;
    userEmail?: string;
    apiToken?: string;
    botAccountId?: string;  // Jira account ID of the bot user (for mention detection + loop prevention)
    enabled: boolean;
    autoApprove?: boolean;  // false = HITL approval gates active (default)
}

// ─── Integration Settings ──────────────────────────────────────────────

export interface SlackIntegrationConfig {
    signingSecret: string;   // HMAC signing secret from Slack app settings
    botToken?: string;       // xoxb-... bearer token for proactive messages
    enabled: boolean;
    autoApprove?: boolean;   // false = HITL approval gates active (default)
}

export interface JiraIntegrationConfig {
    webhookSecret: string;   // Shared secret sent as Bearer token in Automation rule
    baseUrl?: string;        // e.g. https://your-org.atlassian.net
    userEmail?: string;      // Atlassian account email for Basic Auth
    apiToken?: string;       // Atlassian API token
    botAccountId?: string;   // Jira account ID of the bot user (for mention detection + loop prevention)
    enabled: boolean;
    autoApprove?: boolean;   // false = HITL approval gates active (default)
}

export interface DiscordIntegrationConfig {
    applicationId: string;
    publicKey: string;
    botToken: string;
    enabled: boolean;
    autoApprove?: boolean;
}

export interface TelegramIntegrationConfig {
    botToken: string;
    secretToken: string;
    enabled: boolean;
    autoApprove?: boolean;
}

export interface WebhookIntegrationConfig {
    webhookSecret: string;
    enabled: boolean;
    autoApprove?: boolean;
}
