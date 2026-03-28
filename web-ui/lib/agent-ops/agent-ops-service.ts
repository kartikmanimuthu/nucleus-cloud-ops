/**
 * Agent Ops Service
 *
 * CRUD + event recording operations for agent-ops runs.
 * Delegates all persistence to the repository factory (USE_PG_AGENT_OPS feature flag).
 */

import { getAgentOpsRunRepository, getAgentOpsEventRepository } from '@/lib/db/repository-factory';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    AgentOpsStatus,
    AgentOpsResult,
    AgentOpsClarification,
    AgentOpsApprovalRequest,
    AgentEventType,
    TriggerSource,
    TriggerMetadata,
    AgentMode,
    RunListQuery,
} from './types';

// ─── Run Operations ────────────────────────────────────────────────────

/**
 * Create a new agent-ops run record.
 */
export async function createRun(params: {
    tenantId: string;
    source: TriggerSource;
    taskDescription: string;
    mode: AgentMode;
    trigger: TriggerMetadata;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    mcpServerIds?: string[];
    autoApprove?: boolean;
    model?: string;
}): Promise<AgentOpsRun> {
    const run = await getAgentOpsRunRepository().createRun(params);
    console.log(`[AgentOpsService] Created run: ${run.runId} (source: ${params.source})`);
    return run;
}

/**
 * Update the status of a run.
 * On terminal states (completed/failed), the repository sets completedAt and durationMs.
 */
export async function updateRunStatus(
    tenantId: string,
    runId: string,
    status: AgentOpsStatus,
    extra?: {
        result?: AgentOpsResult;
        error?: string;
        clarification?: AgentOpsClarification;
        approvalRequest?: AgentOpsApprovalRequest;
    }
): Promise<void> {
    await getAgentOpsRunRepository().updateRunStatus(tenantId, runId, status, extra);
    console.log(`[AgentOpsService] Updated run ${runId} → ${status}`);
}

/**
 * Update the trigger metadata of a run.
 */
export async function updateRunTrigger(
    tenantId: string,
    runId: string,
    trigger: TriggerMetadata
): Promise<void> {
    await getAgentOpsRunRepository().updateRunTrigger(tenantId, runId, trigger);
    console.log(`[AgentOpsService] Updated trigger metadata for run ${runId}`);
}

/**
 * Get a single run by ID.
 */
export async function getRun(tenantId: string, runId: string): Promise<AgentOpsRun | null> {
    return getAgentOpsRunRepository().getRun(tenantId, runId);
}

/**
 * List runs with optional filtering and pagination.
 */
export async function listRuns(query: RunListQuery): Promise<{
    runs: AgentOpsRun[];
    lastKey?: Record<string, unknown>;
}> {
    return getAgentOpsRunRepository().listRuns(query);
}

/**
 * List runs by source.
 */
export async function listRunsBySource(
    source: TriggerSource,
    limit: number = 25
): Promise<AgentOpsRun[]> {
    return getAgentOpsRunRepository().listRunsBySource(source, limit);
}

// ─── Event Operations ──────────────────────────────────────────────────

/**
 * Record an execution event (planning step, tool call, reflection, etc.)
 * Errors are swallowed — event recording must never abort a run.
 */
export async function recordEvent(params: {
    runId: string;
    eventType: AgentEventType;
    node: string;
    content?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    try {
        await getAgentOpsEventRepository().recordEvent(params);
    } catch (err) {
        // Log but don't throw — event recording failures must never abort a run
        console.error(`[AgentOpsService] Failed to record event (${params.eventType}/${params.node}):`, err);
    }
}

/**
 * Get all events for a run (chronological order).
 */
export async function getRunEvents(runId: string): Promise<AgentOpsEvent[]> {
    return getAgentOpsEventRepository().getRunEvents(runId, 'default');
}

// ─── Human-in-Loop Lookup Helpers ─────────────────────────────────────

/**
 * Find a run with status 'awaiting_approval' triggered by a given Jira issue key.
 */
export async function findAwaitingApprovalRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null> {
    return getAgentOpsRunRepository().findAwaitingApprovalRunByJiraIssue(issueKey);
}

/**
 * Find a run with status 'awaiting_input' triggered by a given Jira issue key.
 */
export async function findAwaitingRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null> {
    return getAgentOpsRunRepository().findAwaitingRunByJiraIssue(issueKey);
}

/**
 * Find a run with status 'awaiting_input' triggered in a given Slack channel+thread.
 */
export async function findAwaitingRunBySlackThread(
    channelId: string,
    threadTs: string
): Promise<AgentOpsRun | null> {
    return getAgentOpsRunRepository().findAwaitingRunBySlackThread(channelId, threadTs);
}

/**
 * Update the slackMessageTs on an existing approvalRequest (after posting Block Kit message).
 */
export async function updateApprovalMessageTs(
    tenantId: string,
    runId: string,
    slackMessageTs: string
): Promise<void> {
    return getAgentOpsRunRepository().updateApprovalMessageTs(tenantId, runId, slackMessageTs);
}

/**
 * Find a run with status 'awaiting_approval' by runId (cross-tenant lookup).
 * PostgreSQL repo uses a single WHERE query instead of scanning 3 sources x 100 records (AOPS-06).
 */
export async function findAwaitingApprovalRun(runId: string): Promise<AgentOpsRun | null> {
    return getAgentOpsRunRepository().findAwaitingApprovalRun(runId);
}


export const agentOpsService = {
    createRun,
    updateRunStatus,
    updateRunTrigger,
    updateApprovalMessageTs,
    getRun,
    listRuns,
    listRunsBySource,
    recordEvent,
    getRunEvents,
    findAwaitingRunByJiraIssue,
    findAwaitingApprovalRunByJiraIssue,
    findAwaitingRunBySlackThread,
    findAwaitingApprovalRun,
};
