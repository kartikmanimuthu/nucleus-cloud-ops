/**
 * AgentOpsRunPostgresRepository
 *
 * PostgreSQL implementation of IAgentOpsRunRepository using Prisma ORM.
 *
 * Key improvements over DynamoDB path (AOPS-06):
 * - findAwaitingApprovalRun: single WHERE query instead of scanning 3 sources x 100 records
 * - findAwaiting*ByJiraIssue: Prisma JSON path filtering on trigger column
 * - listRuns: server-side WHERE/ORDER BY/LIMIT instead of in-memory filter
 *
 * Multi-tenant safety: every query scoped by tenantId.
 */
import { v4 as uuidv4 } from 'uuid';
import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import type { AgentOpsRun, AgentOpsStatus, TriggerMetadata, TriggerSource, RunListResult } from '@/lib/agent-ops/types';
import type {
    IAgentOpsRunRepository,
    CreateRunParams,
    UpdateRunStatusExtra,
    RunListQuery,
} from './interface';

const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function toAgentOpsRun(r: {
    id: string;
    tenantId: string;
    runId: string;
    source: string;
    status: string;
    taskDescription: string;
    mode: string;
    accountId: string | null;
    accountName: string | null;
    selectedSkill: string | null;
    autoApprove: boolean;
    model: string | null;
    threadId: string;
    mcpServerIds: string[];
    knowledgeBaseIds: string[];
    trigger: unknown;
    result: unknown;
    clarification: unknown;
    approvalRequest: unknown;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
    durationMs: number | null;
    expiresAt: Date;
}): AgentOpsRun {
    return {
        PK: `TENANT#${r.tenantId}`,
        SK: `RUN#${r.runId}`,
        GSI1PK: `SOURCE#${r.source}`,
        GSI1SK: `${r.createdAt.toISOString()}#${r.runId}`,
        runId: r.runId,
        tenantId: r.tenantId,
        source: r.source as AgentOpsRun['source'],
        status: r.status as AgentOpsStatus,
        taskDescription: r.taskDescription,
        mode: r.mode as AgentOpsRun['mode'],
        accountId: r.accountId ?? undefined,
        accountName: r.accountName ?? undefined,
        selectedSkill: r.selectedSkill ?? undefined,
        autoApprove: r.autoApprove,
        model: r.model ?? undefined,
        threadId: r.threadId,
        mcpServerIds: r.mcpServerIds,
        knowledgeBaseIds: r.knowledgeBaseIds,
        trigger: r.trigger as AgentOpsRun['trigger'],
        result: r.result as AgentOpsRun['result'],
        clarification: r.clarification as AgentOpsRun['clarification'],
        approvalRequest: r.approvalRequest as AgentOpsRun['approvalRequest'],
        error: r.error ?? undefined,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        completedAt: r.completedAt?.toISOString(),
        durationMs: r.durationMs ?? undefined,
        ttl: Math.floor(r.expiresAt.getTime() / 1000),
    };
}

export class AgentOpsRunPostgresRepository implements IAgentOpsRunRepository {
    async createRun(params: CreateRunParams): Promise<AgentOpsRun> {
        const runId = uuidv4();
        const threadId = `agent-ops-${runId}`;
        const expiresAt = new Date(Date.now() + TTL_30_DAYS_MS);

        const record = await getTenantClient(params.tenantId).agentOpsRun.create({
            data: {
                tenantId: params.tenantId,
                runId,
                source: params.source,
                status: 'queued',
                taskDescription: params.taskDescription,
                mode: params.mode,
                accountId: params.accountId ?? null,
                accountName: params.accountName ?? null,
                selectedSkill: params.selectedSkill ?? null,
                autoApprove: params.autoApprove ?? false,
                model: params.model ?? null,
                threadId,
                mcpServerIds: params.mcpServerIds ?? [],
                knowledgeBaseIds: params.knowledgeBaseIds ?? [],
                trigger: (params.trigger as object) ?? {},
                expiresAt,
            },
        });

        return toAgentOpsRun(record);
    }

    async updateRunStatus(
        tenantId: string,
        runId: string,
        status: AgentOpsStatus,
        extra?: UpdateRunStatusExtra
    ): Promise<void> {
        const now = new Date();
        const updateData: Record<string, unknown> = { status, updatedAt: now };

        if (status === 'completed' || status === 'failed') {
            updateData.completedAt = now;
            const existing = await this.getRun(tenantId, runId);
            if (existing?.createdAt) {
                updateData.durationMs = now.getTime() - new Date(existing.createdAt).getTime();
            }
        }

        if (extra?.result) updateData.result = extra.result as object;
        if (extra?.error) updateData.error = extra.error;
        if (extra?.clarification) updateData.clarification = extra.clarification as object;
        if (extra?.approvalRequest) updateData.approvalRequest = extra.approvalRequest as object;

        await getTenantClient(tenantId).agentOpsRun.updateMany({
            where: { tenantId, runId },
            data: updateData,
        });
    }

    async updateRunTrigger(tenantId: string, runId: string, trigger: TriggerMetadata): Promise<void> {
        await getTenantClient(tenantId).agentOpsRun.updateMany({
            where: { tenantId, runId },
            data: { trigger: trigger as object, updatedAt: new Date() },
        });
    }

    async updateApprovalMessageTs(tenantId: string, runId: string, slackMessageTs: string): Promise<void> {
        const run = await this.getRun(tenantId, runId);
        if (!run?.approvalRequest) return;
        await getTenantClient(tenantId).agentOpsRun.updateMany({
            where: { tenantId, runId },
            data: {
                approvalRequest: { ...(run.approvalRequest as object), slackMessageTs },
                updatedAt: new Date(),
            },
        });
    }

    async getRun(tenantId: string, runId: string): Promise<AgentOpsRun | null> {
        const record = await getTenantClient(tenantId).agentOpsRun.findFirst({
            where: { tenantId, runId },
        });
        return record ? toAgentOpsRun(record) : null;
    }

    async listRuns(query: RunListQuery): Promise<RunListResult> {
        const page = query.page ?? 1;
        const limit = query.limit || 25;
        const skip = (page - 1) * limit;
        if (!query.tenantId) throw new Error('listRuns: tenantId is required');
        const where: Record<string, unknown> = { tenantId: query.tenantId };

        if (query.source) where.source = query.source;
        if (query.status) where.status = query.status;
        // JSON-path filter on the trigger payload — same shape listActiveRunsByTask uses.
        if (query.taskId) where.trigger = { path: ['taskId'], equals: query.taskId };

        const orderBy = this.buildOrderBy(query.sortBy, query.sortDir);

        const [records, total] = await Promise.all([
            getTenantClient(query.tenantId).agentOpsRun.findMany({
                where,
                orderBy,
                skip,
                take: limit,
            }),
            getTenantClient(query.tenantId).agentOpsRun.count({ where }),
        ]);

        const runs = records.map(toAgentOpsRun);
        const stats = await this.computeStats(query.tenantId, where);

        return { runs, total, stats };
    }

    private buildOrderBy(
        sortBy?: RunListQuery['sortBy'],
        sortDir?: RunListQuery['sortDir']
    ): Record<string, 'asc' | 'desc'> {
        if (!sortBy) return { createdAt: 'desc' };
        const dir = sortDir ?? 'desc';
        const column = sortBy === 'taskDescription' ? 'taskDescription' : sortBy;
        return { [column]: dir };
    }

    private async computeStats(tenantId: string, baseWhere: Record<string, unknown>): Promise<RunListResult['stats']> {
        const db = getTenantClient(tenantId);
        const [total, inProgress, completed, failed] = await Promise.all([
            db.agentOpsRun.count({ where: baseWhere }),
            db.agentOpsRun.count({ where: { ...baseWhere, status: 'in_progress' } }),
            db.agentOpsRun.count({ where: { ...baseWhere, status: 'completed' } }),
            db.agentOpsRun.count({ where: { ...baseWhere, status: 'failed' } }),
        ]);
        return { total, inProgress, completed, failed };
    }

    async listActiveRunsByTask(tenantId: string, taskId: string): Promise<AgentOpsRun[]> {
        const records = await getTenantClient(tenantId).agentOpsRun.findMany({
            where: {
                tenantId,
                source: 'scheduled',
                status: { in: ['queued', 'in_progress', 'awaiting_input', 'awaiting_approval'] },
                trigger: { path: ['taskId'], equals: taskId },
            },
            orderBy: { createdAt: 'desc' },
        });
        return records.map(toAgentOpsRun);
    }

    // Cross-tenant: webhook handlers need to find runs across tenants
    async listRunsBySource(source: TriggerSource, limit = 25): Promise<AgentOpsRun[]> {
        const records = await getPrismaClient().agentOpsRun.findMany({
            where: { source },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
        return records.map(toAgentOpsRun);
    }

    // Cross-tenant: AOPS-06 — Slack/Jira webhooks look up runs by runId without knowing tenantId
    async findAwaitingApprovalRun(runId: string): Promise<AgentOpsRun | null> {
        const record = await getPrismaClient().agentOpsRun.findFirst({
            where: { runId, status: 'awaiting_approval' },
        });
        return record ? toAgentOpsRun(record) : null;
    }

    // Cross-tenant: Jira webhook handler resolves run by issue key across all tenants
    async findAwaitingApprovalRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null> {
        const record = await getPrismaClient().agentOpsRun.findFirst({
            where: {
                status: 'awaiting_approval',
                source: 'jira',
                trigger: { path: ['issueKey'], equals: issueKey },
            },
        });
        return record ? toAgentOpsRun(record) : null;
    }

    // Cross-tenant: Jira webhook handler resolves run by issue key across all tenants
    async findAwaitingRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null> {
        const record = await getPrismaClient().agentOpsRun.findFirst({
            where: {
                status: 'awaiting_input',
                source: 'jira',
                trigger: { path: ['issueKey'], equals: issueKey },
            },
        });
        return record ? toAgentOpsRun(record) : null;
    }

    // Cross-tenant: Slack webhook handler resolves run by channel+thread across all tenants
    async findAwaitingRunBySlackThread(channelId: string, threadTs: string): Promise<AgentOpsRun | null> {
        const record = await getPrismaClient().agentOpsRun.findFirst({
            where: {
                status: 'awaiting_input',
                source: 'slack',
                trigger: { path: ['channelId'], equals: channelId },
            },
        });
        if (!record) return null;
        // Verify threadTs matches (secondary filter on JSON)
        const trigger = record.trigger as Record<string, unknown>;
        if (trigger?.threadTs !== threadTs) return null;
        return toAgentOpsRun(record);
    }
}
