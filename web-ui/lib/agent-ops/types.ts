/**
 * Agent Ops Type Definitions
 * 
 * Shared types for the headless agent execution system.
 */

// ─── Enumerations ──────────────────────────────────────────────────────

export type TriggerSource = 'slack' | 'jira' | 'api';

export type AgentOpsStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

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

export type TriggerMetadata = SlackTriggerMeta | JiraTriggerMeta | ApiTriggerMeta;

// ─── Agent Ops Run ─────────────────────────────────────────────────────

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
    threadId: string;       // LangGraph thread ID
    mcpServerIds?: string[];
    trigger: TriggerMetadata;
    result?: AgentOpsResult;
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

// ─── API Request / Response ────────────────────────────────────────────

export interface TriggerRequest {
    taskDescription: string;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    mode?: AgentMode;
    mcpServerIds?: string[];
}


export interface TriggerResponse {
    runId: string;
    status: AgentOpsStatus;
    message: string;
}

export interface RunListQuery {
    tenantId: string;
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
}

export interface JiraIntegrationConfig {
    webhookSecret: string;
    baseUrl?: string;
    userEmail?: string;
    apiToken?: string;
    enabled: boolean;
}

// ─── Integration Settings ──────────────────────────────────────────────

export interface SlackIntegrationConfig {
    signingSecret: string;   // HMAC signing secret from Slack app settings
    botToken?: string;       // xoxb-... bearer token for proactive messages
    enabled: boolean;
}

export interface JiraIntegrationConfig {
    webhookSecret: string;   // Shared secret sent as Bearer token in Automation rule
    baseUrl?: string;        // e.g. https://your-org.atlassian.net
    userEmail?: string;      // Atlassian account email for Basic Auth
    apiToken?: string;       // Atlassian API token
    enabled: boolean;
}
