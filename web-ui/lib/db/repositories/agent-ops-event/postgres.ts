/**
 * AgentOpsEventPostgresRepository
 *
 * PostgreSQL implementation of IAgentOpsEventRepository using Prisma ORM.
 * recordEvent never throws — failures are logged only.
 * getRunEvents returns events in chronological order (createdAt ASC).
 */
import { getTenantClient } from '@/lib/db/pg-config';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';
import type { IAgentOpsEventRepository, RecordEventParams } from './interface';

const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function toAgentOpsEvent(r: {
    id: string;
    tenantId: string;
    runId: string;
    eventType: string;
    node: string;
    content: string | null;
    toolName: string | null;
    toolArgs: unknown;
    toolOutput: string | null;
    metadata: unknown;
    createdAt: Date;
    expiresAt: Date;
}): AgentOpsEvent {
    return {
        PK: `RUN#${r.runId}`,
        SK: `EVENT#${r.createdAt.toISOString()}#${r.id}`,
        runId: r.runId,
        eventType: r.eventType as AgentOpsEvent['eventType'],
        node: r.node,
        content: r.content ?? undefined,
        toolName: r.toolName ?? undefined,
        toolArgs: r.toolArgs as Record<string, unknown> | undefined,
        toolOutput: r.toolOutput ?? undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
        createdAt: r.createdAt.toISOString(),
        ttl: Math.floor(r.expiresAt.getTime() / 1000),
    };
}

export class AgentOpsEventPostgresRepository implements IAgentOpsEventRepository {
    async recordEvent(params: RecordEventParams): Promise<void> {
        const expiresAt = new Date(Date.now() + TTL_30_DAYS_MS);
        try {
            await getTenantClient(params.tenantId).agentOpsEvent.create({
                data: {
                    tenantId: params.tenantId,
                    runId: params.runId,
                    eventType: params.eventType,
                    node: params.node,
                    content: params.content?.slice(0, 10000) ?? null,
                    toolName: params.toolName ?? null,
                    toolArgs: (params.toolArgs as object) ?? null,
                    toolOutput: params.toolOutput?.slice(0, 10000) ?? null,
                    metadata: (params.metadata as object) ?? null,
                    expiresAt,
                },
            });
        } catch (err) {
            // Log but don't throw — event recording failures must never abort a run
            console.error(`[AgentOpsEventPostgresRepository] Failed to record event (${params.eventType}/${params.node}):`, err);
        }
    }

    async getRunEvents(runId: string, tenantId: string): Promise<AgentOpsEvent[]> {
        const records = await getTenantClient(tenantId).agentOpsEvent.findMany({
            where: { runId, tenantId },
            orderBy: { createdAt: 'asc' },
        });
        return records.map(toAgentOpsEvent);
    }
}
