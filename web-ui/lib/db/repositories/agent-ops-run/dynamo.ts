/**
 * AgentOpsRunDynamoRepository
 *
 * DynamoDB implementation of IAgentOpsRunRepository.
 * Delegates to Dynamoose models — preserves exact GSI1 query patterns.
 */
import { v4 as uuidv4 } from 'uuid';
import { AgentOpsRunModel } from '@/lib/agent-ops/models/agent-ops-run';
import { TTL_30_DAYS } from '@/lib/agent-ops/dynamoose-config';
import type { AgentOpsRun, AgentOpsStatus, TriggerMetadata, TriggerSource } from '@/lib/agent-ops/types';
import type {
    IAgentOpsRunRepository,
    CreateRunParams,
    UpdateRunStatusExtra,
    RunListQuery,
} from './interface';

export class AgentOpsRunDynamoRepository implements IAgentOpsRunRepository {
    async createRun(params: CreateRunParams): Promise<AgentOpsRun> {
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
            autoApprove: params.autoApprove ?? false,
            model: params.model,
            threadId,
            trigger: params.trigger,
            createdAt: now,
            updatedAt: now,
            ttl: TTL_30_DAYS(),
        };

        await AgentOpsRunModel.create(run);
        return run;
    }

    async updateRunStatus(
        tenantId: string,
        runId: string,
        status: AgentOpsStatus,
        extra?: UpdateRunStatusExtra
    ): Promise<void> {
        const now = new Date();
        const nowIso = now.toISOString();
        const updateData: Record<string, unknown> = { status, updatedAt: nowIso };

        if (status === 'completed' || status === 'failed') {
            updateData.completedAt = nowIso;
            const existing = await this.getRun(tenantId, runId);
            if (existing?.createdAt) {
                updateData.durationMs = now.getTime() - new Date(existing.createdAt).getTime();
            }
        }

        if (extra?.result) updateData.result = extra.result;
        if (extra?.error) updateData.error = extra.error;
        if (extra?.clarification) updateData.clarification = extra.clarification;
        if (extra?.approvalRequest) updateData.approvalRequest = extra.approvalRequest;

        await AgentOpsRunModel.update(
            { PK: `TENANT#${tenantId}`, SK: `RUN#${runId}` },
            updateData
        );
    }

    async updateRunTrigger(tenantId: string, runId: string, trigger: TriggerMetadata): Promise<void> {
        await AgentOpsRunModel.update(
            { PK: `TENANT#${tenantId}`, SK: `RUN#${runId}` },
            { trigger, updatedAt: new Date().toISOString() }
        );
    }

    async updateApprovalMessageTs(tenantId: string, runId: string, slackMessageTs: string): Promise<void> {
        const run = await this.getRun(tenantId, runId);
        if (!run?.approvalRequest) return;
        await AgentOpsRunModel.update(
            { PK: `TENANT#${tenantId}`, SK: `RUN#${runId}` },
            {
                approvalRequest: { ...run.approvalRequest, slackMessageTs },
                updatedAt: new Date().toISOString(),
            }
        );
    }

    async getRun(tenantId: string, runId: string): Promise<AgentOpsRun | null> {
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

    async listRuns(query: RunListQuery): Promise<{ runs: AgentOpsRun[]; lastKey?: Record<string, unknown> }> {
        const limit = query.limit || 25;
        let runs: AgentOpsRun[] = [];
        let lastKey: Record<string, unknown> | undefined;

        if (query.source) {
            let q = AgentOpsRunModel.query('GSI1PK')
                .eq(`SOURCE#${query.source}`)
                .sort('descending')
                .limit(limit)
                .using('GSI1');

            if (query.lastKey) q = q.startAt(query.lastKey);

            const result = await q.exec();
            runs = result.toJSON() as unknown as AgentOpsRun[];
            lastKey = result.lastKey;
        } else {
            const sources: TriggerSource[] = ['slack', 'jira', 'api'];
            const results = await Promise.all(
                sources.map(src =>
                    AgentOpsRunModel.query('GSI1PK')
                        .eq(`SOURCE#${src}`)
                        .sort('descending')
                        .limit(limit)
                        .using('GSI1')
                        .exec()
                )
            );
            for (const res of results) {
                runs.push(...(res.toJSON() as unknown as AgentOpsRun[]));
            }
            runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            runs = runs.slice(0, limit);
        }

        if (query.tenantId && query.tenantId !== 'default' && query.tenantId !== 'all') {
            runs = runs.filter(r => r.tenantId === query.tenantId);
        }
        if (query.status) {
            runs = runs.filter(r => r.status === query.status);
        }

        return { runs, lastKey };
    }

    async listRunsBySource(source: TriggerSource, limit = 25): Promise<AgentOpsRun[]> {
        const result = await AgentOpsRunModel.query('GSI1PK')
            .eq(`SOURCE#${source}`)
            .sort('descending')
            .limit(limit)
            .using('GSI1')
            .exec();
        return result.toJSON() as unknown as AgentOpsRun[];
    }

    async findAwaitingApprovalRun(runId: string): Promise<AgentOpsRun | null> {
        const sources: TriggerSource[] = ['slack', 'jira', 'api'];
        for (const source of sources) {
            const result = await AgentOpsRunModel.query('GSI1PK')
                .eq(`SOURCE#${source}`)
                .sort('descending')
                .limit(100)
                .using('GSI1')
                .exec();
            const runs = result.toJSON() as unknown as AgentOpsRun[];
            const found = runs.find(r => r.runId === runId && r.status === 'awaiting_approval');
            if (found) return found;
        }
        return null;
    }

    async findAwaitingApprovalRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null> {
        const result = await AgentOpsRunModel.query('GSI1PK')
            .eq('SOURCE#jira')
            .sort('descending')
            .limit(50)
            .using('GSI1')
            .exec();
        const runs = result.toJSON() as unknown as AgentOpsRun[];
        return runs.find(r =>
            r.status === 'awaiting_approval' &&
            (r.trigger as any)?.issueKey === issueKey
        ) || null;
    }

    async findAwaitingRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null> {
        const result = await AgentOpsRunModel.query('GSI1PK')
            .eq('SOURCE#jira')
            .sort('descending')
            .limit(50)
            .using('GSI1')
            .exec();
        const runs = result.toJSON() as unknown as AgentOpsRun[];
        return runs.find(r =>
            r.status === 'awaiting_input' &&
            (r.trigger as any)?.issueKey === issueKey
        ) || null;
    }

    async findAwaitingRunBySlackThread(channelId: string, threadTs: string): Promise<AgentOpsRun | null> {
        const result = await AgentOpsRunModel.query('GSI1PK')
            .eq('SOURCE#slack')
            .sort('descending')
            .limit(50)
            .using('GSI1')
            .exec();
        const runs = result.toJSON() as unknown as AgentOpsRun[];
        return runs.find(r =>
            r.status === 'awaiting_input' &&
            (r.trigger as any)?.channelId === channelId &&
            (r.trigger as any)?.threadTs === threadTs
        ) || null;
    }
}
