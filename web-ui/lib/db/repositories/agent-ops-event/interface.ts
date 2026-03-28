/**
 * IAgentOpsEventRepository
 *
 * Contract for agent ops event persistence.
 * Implemented by AgentOpsEventDynamoRepository and AgentOpsEventPostgresRepository.
 * The feature flag USE_PG_AGENT_OPS controls which implementation is active.
 */
import type { AgentOpsEvent, AgentEventType } from '@/lib/agent-ops/types';

export interface RecordEventParams {
    runId: string;
    eventType: AgentEventType;
    node: string;
    content?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
    metadata?: Record<string, unknown>;
}

export interface IAgentOpsEventRepository {
    recordEvent(params: RecordEventParams): Promise<void>;
    getRunEvents(runId: string, tenantId: string): Promise<AgentOpsEvent[]>;
}
