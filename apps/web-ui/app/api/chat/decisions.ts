import { ToolMessage } from '@langchain/core/messages';
import type { PendingToolCall } from '@/lib/agent/guard';

export interface ToolDecision {
    toolCallId: string;
    approved: boolean;
    /** Human reason attached to rejections (fed back to the model). */
    reason?: string;
    /** Required answer text for approved ask_user calls. */
    answer?: string;
}

export type DecisionsResult =
    | { ok: true; toolMessages: ToolMessage[]; approvedIds: string[]; rejectedIds: string[] }
    | { ok: false; error: string };

/**
 * Validate a decision batch against the pending interrupt and produce the
 * ToolMessages to write BEFORE resume. Approved normal tools produce nothing —
 * the tools node executes them. Rejected tools and ask_user calls produce
 * results so withUnresolvedToolCallsOnly() excludes them from execution.
 */
export function buildDecisionToolMessages(pending: PendingToolCall[], decisions: ToolDecision[]): DecisionsResult {
    const byId = new Map(decisions.map(d => [d.toolCallId, d]));
    const pendingIds = new Set(pending.map(p => p.id));

    const unknown = decisions.filter(d => !pendingIds.has(d.toolCallId));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown toolCallId(s): ${unknown.map(d => d.toolCallId).join(', ')}` };
    }
    const undecided = pending.filter(p => !byId.has(p.id));
    if (undecided.length > 0) {
        return { ok: false, error: `Undecided tool call(s): ${undecided.map(p => `${p.name} (${p.id})`).join(', ')} — every pending tool needs a decision.` };
    }

    const toolMessages: ToolMessage[] = [];
    const approvedIds: string[] = [];
    const rejectedIds: string[] = [];

    for (const call of pending) {
        const d = byId.get(call.id)!;
        if (call.name === 'ask_user') {
            if (d.approved) {
                if (!d.answer || !d.answer.trim()) {
                    return { ok: false, error: `ask_user (${call.id}) requires a non-empty answer.` };
                }
                toolMessages.push(new ToolMessage({ tool_call_id: call.id, content: d.answer.trim() }));
                approvedIds.push(call.id);
            } else {
                toolMessages.push(new ToolMessage({
                    tool_call_id: call.id,
                    content: 'The user declined to answer. Proceed with your best judgment or finish and state the open question.',
                }));
                rejectedIds.push(call.id);
            }
        } else if (d.approved) {
            approvedIds.push(call.id); // no ToolMessage — tools node executes it
        } else {
            const reason = d.reason?.trim();
            toolMessages.push(new ToolMessage({
                tool_call_id: call.id,
                content: `Rejected by user${reason ? ` — reason: ${reason}` : ''}. Do not retry this exact action; adapt or ask.`,
            }));
            rejectedIds.push(call.id);
        }
    }
    return { ok: true, toolMessages, approvedIds, rejectedIds };
}
