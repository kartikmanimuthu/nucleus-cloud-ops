// web-ui/lib/agent-ops/record-and-emit.ts
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import type { GatewayEventBus } from '@/lib/gateway/event-bus';
import type { AgentEventType, AgentOpsEvent } from './types';

export interface RecordEventParams {
    runId: string;
    tenantId: string;
    eventType: AgentEventType;
    node: string;
    content?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Event types worth narrating to a channel. Everything else (memory, evaluation,
 * raw execution text) is internal chatter that would only add noise to a chat
 * checklist — it still gets persisted, just not broadcast.
 */
const STEP_BOUNDARY_EVENT_TYPES = new Set<AgentEventType>([
    'planning',
    'tool_call',
    'tool_result',
    'reflection',
]);

export function isStepBoundary(eventType: AgentEventType): boolean {
    return STEP_BOUNDARY_EVENT_TYPES.has(eventType);
}

/**
 * Persist an agent-ops event and, for step boundaries, broadcast it on the
 * gateway bus so channel adapters can narrate progress live.
 *
 * The emitted AgentOpsEvent is synthesized from the same params rather than
 * re-read from Postgres: recordEvent returns void, and bus consumers only read
 * the semantic fields (eventType / node / toolName / content).
 */
export async function recordAndEmit(
    eventBus: GatewayEventBus | undefined,
    params: RecordEventParams,
): Promise<void> {
    await agentOpsService.recordEvent(params);
    if (!eventBus || !isStepBoundary(params.eventType)) return;

    try {
        eventBus.emit({
            type: 'run:event',
            runId: params.runId,
            tenantId: params.tenantId,
            timestamp: new Date(),
            data: {
                event: {
                    ...params,
                    PK: `RUN#${params.runId}`,
                    SK: '',
                    createdAt: new Date().toISOString(),
                    ttl: 0,
                } as AgentOpsEvent,
            },
        });
    } catch (err) {
        // Narration is best-effort — never let it disturb a run.
        console.error('[recordAndEmit] Failed to emit run:event (non-fatal):', err);
    }
}
