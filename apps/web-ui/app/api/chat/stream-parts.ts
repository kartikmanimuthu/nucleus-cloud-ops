import { pendingToolCallsOf } from '@/lib/agent/guard';
import type { GuardVerdict, PlanStep, ReflectionState } from '@/lib/agent/agent-shared';

export interface DataPart { type: `data-${string}`; id?: string; data: unknown }

export function buildPlanPart(threadId: string, steps: PlanStep[], updatedBy: string): DataPart {
    return { type: 'data-plan', id: `plan-${threadId}`, data: { steps, updatedBy } };
}

export function buildPhasePart(phase: string, node: string): DataPart {
    return { type: 'data-phase', data: { phase, node, ts: Date.now() } };
}

/**
 * Parts describing a parked approval_gate interrupt: one data-approval batch
 * for normal tools (each row carrying its guard verdict) and one
 * data-clarification per pending ask_user call.
 */
export function buildInterruptParts(
    values: Pick<ReflectionState, 'messages' | 'guardVerdicts'>,
    threadId: string,
): DataPart[] {
    const pending = pendingToolCallsOf(values);
    if (pending.length === 0) return [];
    const verdicts: Record<string, GuardVerdict> = values.guardVerdicts ?? {};
    const parts: DataPart[] = [];
    const approvalTools: unknown[] = [];

    for (const call of pending) {
        if (call.name === 'ask_user') {
            parts.push({
                type: 'data-clarification',
                id: `clarify-${call.id}`,
                data: {
                    toolCallId: call.id,
                    question: String(call.args.question ?? 'The agent needs your input.'),
                    options: Array.isArray(call.args.options) ? call.args.options.map(String) : [],
                },
            });
        } else {
            approvalTools.push({
                toolCallId: call.id,
                toolName: call.name,
                args: call.args,
                guard: verdicts[call.id] ?? null,
            });
        }
    }
    if (approvalTools.length > 0) {
        parts.push({
            type: 'data-approval',
            id: `approval-${threadId}`,
            data: { batchId: `batch-${threadId}-${Date.now()}`, tools: approvalTools },
        });
    }
    return parts;
}
