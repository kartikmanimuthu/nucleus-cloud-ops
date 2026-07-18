import type { ReflectionState } from './agent-shared';
import { pendingToolCallsOf } from './guard';

/**
 * After the guard node: decide whether pending tool calls may execute directly
 * or must pause at the approval_gate interrupt.
 *
 * approval_gate when ANY of:
 *  - a pending call is ask_user (clarification always pauses)
 *  - a pending call is mutative (guard policy: even with auto-approve on)
 *  - a pending call has NO verdict (fail-closed)
 *  - autoApprove is off (user asked to review everything)
 */
export function routeAfterGuard(state: ReflectionState, autoApprove: boolean): 'approval_gate' | 'tools' {
    const pending = pendingToolCallsOf(state);
    if (pending.length === 0) return 'tools'; // nothing to gate; tools node no-ops
    if (!autoApprove) return 'approval_gate';
    for (const call of pending) {
        if (call.name === 'ask_user') return 'approval_gate';
        const verdict = state.guardVerdicts?.[call.id];
        if (!verdict || verdict.isMutative) return 'approval_gate';
    }
    return 'tools';
}
