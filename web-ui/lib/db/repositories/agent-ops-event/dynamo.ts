/**
 * AgentOpsEventDynamoRepository
 *
 * DynamoDB implementation of IAgentOpsEventRepository.
 * PK=RUN#<runId>, SK=EVENT#<timestamp>#<nonce>
 */
import { AgentOpsEventModel } from '@/lib/agent-ops/models/agent-ops-event';
import { TTL_30_DAYS } from '@/lib/agent-ops/dynamoose-config';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';
import type { IAgentOpsEventRepository, RecordEventParams } from './interface';

export class AgentOpsEventDynamoRepository implements IAgentOpsEventRepository {
    async recordEvent(params: RecordEventParams): Promise<void> {
        const now = new Date().toISOString();
        const [, nanos] = process.hrtime();
        const nonce = String(nanos).padStart(9, '0');

        const eventItem: AgentOpsEvent = {
            PK: `RUN#${params.runId}`,
            SK: `EVENT#${now}#${nonce}`,
            runId: params.runId,
            eventType: params.eventType,
            node: params.node,
            content: params.content?.slice(0, 10000),
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
            console.error(`[AgentOpsEventDynamoRepository] Failed to record event (${params.eventType}/${params.node}):`, err);
        }
    }

    async getRunEvents(runId: string, _tenantId: string): Promise<AgentOpsEvent[]> {
        const result = await AgentOpsEventModel.query('PK')
            .eq(`RUN#${runId}`)
            .where('SK')
            .beginsWith('EVENT#')
            .sort('ascending')
            .exec();

        return result.toJSON() as unknown as AgentOpsEvent[];
    }
}
