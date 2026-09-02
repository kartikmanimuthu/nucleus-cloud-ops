/**
 * Agent Ops Service
 *
 * CRUD + event recording operations for agent-ops runs.
 * Delegates all persistence to the repository factory (USE_PG_AGENT_OPS feature flag).
 */

import { getAgentOpsRunRepository, getAgentOpsEventRepository } from '@/lib/db/repository-factory';
import { cancelRun as abortInProcessRun } from '@/lib/agent-ops/run-manager';
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
    RunListResult,
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
    knowledgeBaseIds?: string[];
    autoApprove?: boolean;
    model?: string;
}): Promise<AgentOpsRun> {
    // 'fast' is legacy-only (old Jira Automation bodies, stale checkpoints) and
    // is coerced to 'plan' here so every such run is planned. 'plan' and 'deep'
    // pass through unchanged — a caller-selected deep mode (New Run dialog,
    // scheduled task, or a tenant's channel default) must actually persist so
    // the executor dispatches it to the deep graph instead of silently
    // downgrading it to plan.
    const mode: AgentMode = params.mode === 'deep' ? 'deep' : 'plan';
    const run = await getAgentOpsRunRepository().createRun({ ...params, mode });
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
 * List runs with optional filtering, sorting, and pagination.
 */
export async function listRuns(query: RunListQuery): Promise<RunListResult> {
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

/**
 * Cancel every non-terminal run a scheduled task has already launched.
 *
 * Called when a task is paused or deleted: the sweeper stops creating NEW runs,
 * but a run kicked off by the on-time cron tick moments earlier keeps executing.
 * For each active run we (a) abort the in-process AbortController — stops execution
 * immediately when this replica happens to own the run — and (b) flip the DB status
 * to 'cancelled', which both reflects reality in the UI and is the signal the
 * executor's status poll picks up to stop a run owned by a DIFFERENT replica.
 *
 * Never throws — a failure on one run must not block cancelling the rest, nor
 * abort the pause/delete that triggered it. Returns the runIds actually cancelled.
 */
export async function cancelActiveRunsForTask(tenantId: string, taskId: string): Promise<string[]> {
    const runs = await getAgentOpsRunRepository().listActiveRunsByTask(tenantId, taskId);
    const cancelled: string[] = [];
    for (const run of runs) {
        try {
            abortInProcessRun(run.runId);
            await getAgentOpsRunRepository().updateRunStatus(tenantId, run.runId, 'cancelled');
            await recordEvent({
                runId: run.runId,
                tenantId,
                eventType: 'final',
                node: '__cancelled__',
                content: 'Run cancelled because its scheduled task was paused or deleted.',
                metadata: { reason: 'task_paused_or_deleted', taskId },
            });
            cancelled.push(run.runId);
        } catch (err) {
            console.error(`[AgentOpsService] Failed to cancel run ${run.runId} for task ${taskId}:`, err);
        }
    }
    if (cancelled.length) {
        console.log(`[AgentOpsService] Cancelled ${cancelled.length} active run(s) for task ${taskId}`);
    }
    return cancelled;
}

// ─── Event Operations ──────────────────────────────────────────────────

/**
 * Record an execution event (planning step, tool call, reflection, etc.)
 * Errors are swallowed — event recording must never abort a run.
 */
export async function recordEvent(params: {
    runId: string;
    tenantId: string;
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
export async function getRunEvents(runId: string, tenantId: string): Promise<AgentOpsEvent[]> {
    return getAgentOpsEventRepository().getRunEvents(runId, tenantId);
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
 * Resolve the run a Telegram follow-up should feed into: the chat's run that is
 * currently awaiting the user's answer (within the idle window). Once a run has
 * completed, the next message is a new task — so this only ever returns a run
 * that is actively waiting on input.
 */
export async function findResumableTelegramRun(chatId: number, idleCutoff: Date): Promise<AgentOpsRun | null> {
    return getAgentOpsRunRepository().findResumableTelegramRun(chatId, idleCutoff);
}

/**
 * End the current Telegram conversation (the /new command): cancel the run that is
 * awaiting input so the pending question is dropped and the next message starts a
 * fresh run instead of being read as the answer.
 */
export async function closeTelegramSession(tenantId: string, runId: string): Promise<void> {
    await updateRunStatus(tenantId, runId, 'cancelled');
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
    cancelActiveRunsForTask,
    recordEvent,
    getRunEvents,
    findAwaitingRunByJiraIssue,
    findAwaitingApprovalRunByJiraIssue,
    findAwaitingRunBySlackThread,
    findResumableTelegramRun,
    closeTelegramSession,
    findAwaitingApprovalRun,
};
