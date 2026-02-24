/**
 * Agent Ops Service
 * 
 * CRUD + event recording operations for agent-ops runs.
 * Uses Dynamoose ODM with single-table design.
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentOpsRunModel } from './models/agent-ops-run';
import { AgentOpsEventModel } from './models/agent-ops-event';
import { TTL_30_DAYS } from './dynamoose-config';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    AgentOpsStatus,
    AgentOpsResult,
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
}): Promise<AgentOpsRun> {
    const runId = uuidv4();
    const threadId = `agent-ops-${runId}`;
    const now = new Date().toISOString();

    const run: AgentOpsRun = {
        PK: `TENANT#${params.tenantId}`,
        SK: `RUN#${runId}`,
        GSI1PK: `SOURCE#${params.source}`,
        GSI1SK: `${now}#${runId}`,
        runId,
        tenantId: params.tenantId,
        source: params.source,
        status: 'queued',
        taskDescription: params.taskDescription,
        mode: params.mode,
        accountId: params.accountId,
        accountName: params.accountName,
        selectedSkill: params.selectedSkill,
        mcpServerIds: params.mcpServerIds,
        threadId,
        trigger: params.trigger,
        createdAt: now,
        updatedAt: now,
        ttl: TTL_30_DAYS(),
    };

    await AgentOpsRunModel.create(run);
    console.log(`[AgentOpsService] Created run: ${runId} (source: ${params.source})`);
    return run;
}

/**
 * Update the status of a run.
 * On terminal states (completed/failed), sets completedAt and computes durationMs
 * from the run's createdAt timestamp.
 */
export async function updateRunStatus(
    tenantId: string,
    runId: string,
    status: AgentOpsStatus,
    extra?: {
        result?: AgentOpsResult;
        error?: string;
    }
): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    const updateData: Record<string, unknown> = {
        status,
        updatedAt: nowIso,
    };

    if (status === 'completed' || status === 'failed') {
        updateData.completedAt = nowIso;

        // Fetch the run to compute durationMs from createdAt
        const existing = await getRun(tenantId, runId);
        if (existing?.createdAt) {
            updateData.durationMs = now.getTime() - new Date(existing.createdAt).getTime();
        }
    }

    if (extra?.result) {
        updateData.result = extra.result;
    }
    if (extra?.error) {
        updateData.error = extra.error;
    }

    await AgentOpsRunModel.update(
        { PK: `TENANT#${tenantId}`, SK: `RUN#${runId}` },
        updateData
    );
    console.log(`[AgentOpsService] Updated run ${runId} → ${status}`);
}

/**
 * Get a single run by ID.
 */
export async function getRun(tenantId: string, runId: string): Promise<AgentOpsRun | null> {
    try {
        const run = await AgentOpsRunModel.get({
            PK: `TENANT#${tenantId}`,
            SK: `RUN#${runId}`,
        });
        return (run as unknown as AgentOpsRun) || null;
    } catch {
        return null;
    }
}

/**
 * List runs using GSI1 (time-sorted by source), with optional pagination.
 *
 * GSI1PK = SOURCE#<source>  (defaults to 'slack' when no source provided)
 * GSI1SK = <ISO-timestamp>#<runId>  — sorted descending (newest first)
 */
export async function listRuns(query: RunListQuery): Promise<{
    runs: AgentOpsRun[];
    lastKey?: Record<string, unknown>;
}> {
    const limit = query.limit || 25;
    const source = query.source ?? 'slack';

    let q = AgentOpsRunModel.query('GSI1PK')
        .eq(`SOURCE#${source}`)
        .sort('descending')
        .limit(limit)
        .using('GSI1');

    if (query.lastKey) {
        q = q.startAt(query.lastKey);
    }

    const result = await q.exec();

    let runs = result.toJSON() as unknown as AgentOpsRun[];

    // Filter by tenantId and optional status in-memory (GSI1 is source-partitioned)
    runs = runs.filter(r => r.tenantId === query.tenantId);
    if (query.status) {
        runs = runs.filter(r => r.status === query.status);
    }

    return {
        runs,
        lastKey: result.lastKey,
    };
}

/**
 * List runs by source (using GSI1).
 */
export async function listRunsBySource(
    source: TriggerSource,
    limit: number = 25
): Promise<AgentOpsRun[]> {
    const result = await AgentOpsRunModel.query('GSI1PK')
        .eq(`SOURCE#${source}`)
        .sort('descending')
        .limit(limit)
        .using('GSI1')
        .exec();

    return result.toJSON() as unknown as AgentOpsRun[];
}

// ─── Event Operations ──────────────────────────────────────────────────

/**
 * Record an execution event (planning step, tool call, reflection, etc.)
 *
 * SK format: EVENT#<ISO-timestamp>#<hrtime-nanos>
 * Using process.hrtime ensures SK uniqueness even when two events fire in the same millisecond
 * from the same run, and avoids the shared global counter bug in concurrent scenarios.
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
    const now = new Date().toISOString();
    // Use high-resolution time as a nonce for uniqueness within the same millisecond
    const [, nanos] = process.hrtime();
    const nonce = String(nanos).padStart(9, '0');

    const eventItem: AgentOpsEvent = {
        PK: `RUN#${params.runId}`,
        SK: `EVENT#${now}#${nonce}`,
        runId: params.runId,
        eventType: params.eventType,
        node: params.node,
        content: params.content?.slice(0, 10000),  // Cap at 10KB per event
        toolName: params.toolName,
        toolArgs: params.toolArgs,
        toolOutput: params.toolOutput?.slice(0, 10000),
        metadata: params.metadata,
        createdAt: now,
        ttl: TTL_30_DAYS(),
    };

    try {
        await AgentOpsEventModel.create(eventItem);
    } catch (err) {
        // Log but don't throw — event recording failures must never abort a run
        console.error(`[AgentOpsService] Failed to record event (${params.eventType}/${params.node}):`, err);
    }
}

/**
 * Get all events for a run (chronological order).
 */
export async function getRunEvents(runId: string): Promise<AgentOpsEvent[]> {
    const result = await AgentOpsEventModel.query('PK')
        .eq(`RUN#${runId}`)
        .where('SK')
        .beginsWith('EVENT#')
        .sort('ascending')
        .exec();

    return result.toJSON() as unknown as AgentOpsEvent[];
}

// ─── Singleton export ──────────────────────────────────────────────────

export const agentOpsService = {
    createRun,
    updateRunStatus,
    getRun,
    listRuns,
    listRunsBySource,
    recordEvent,
    getRunEvents,
};
