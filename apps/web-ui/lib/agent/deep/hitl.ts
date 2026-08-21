import type { ToolDecision } from '@/app/api/chat/decisions';

/**
 * HITL translation for deep mode.
 *
 * Interrupts are read from `state.tasks[].interrupts[]` — the authoritative source. An earlier
 * version inferred them from the last AI message's tool_calls, which worked only for
 * parent-level interrupts: when a subagent pauses, the parent's message shows `task`, not the
 * gated call, so nothing was ever surfaced and the run hung with no way to approve.
 *
 * A run can hold SEVERAL concurrent interrupts (one per parallel subagent), and each carries
 * SEVERAL actionRequests. Resume is therefore a two-level structure, per the LangGraph docs:
 * "When resuming multiple interrupts with a single invocation, map each interrupt ID to its
 * resume value."
 */

export interface PendingAction {
    /** `${interruptId}#${index}` — opaque to the client, and round-trips back to the pair. */
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    interruptId: string;
    index: number;
}

// The docs specify four decisions; 'respond' is the documented one for ask_user-style
// tools ("the tool's real implementation is the human's reply"). No published langchain
// release implements it yet, so patches/langchain@1.5.2.patch adds it exactly as
// documented. See docs/superpowers/specs/2026-08-12-deep-agent-open-items.md.
export type DeepDecision =
    | { type: 'approve' }
    | { type: 'reject'; message: string }
    | { type: 'respond'; message: string };

/** Keyed by interrupt id; decisions are positional within that interrupt's actionRequests. */
export type ResumeMap = Record<string, { decisions: DeepDecision[] }>;

export type DeepResumeResult =
    | { ok: true; resume: ResumeMap }
    | { ok: false; error: string };

interface ActionRequestLike { name?: string; args?: Record<string, unknown> }
interface InterruptLike { id?: string; value?: { actionRequests?: ActionRequestLike[] } }
interface StateLike {
    tasks?: Array<{ interrupts?: InterruptLike[] }>;
    config?: { configurable?: { checkpoint_id?: unknown } };
}

/**
 * A LangGraph interrupt id is `XXH3(checkpoint_namespace)` (langgraph interrupt.js) — a hash of
 * the TASK'S PATH and nothing else. No round counter, no payload. So a task that pauses again
 * after being resumed produces the IDENTICAL id, and `${interruptId}#${index}` collided 1:1 with
 * the round the user had just decided: the client saw those ids as already-decided, sent no
 * decision for them, and the resume was rejected as incomplete. Measured on a real thread — 18
 * actions approved, then 22 offered of which 14 reused the previous round's ids.
 *
 * The checkpoint id changes every round, so prefixing it makes each round's actions distinct.
 */
export function actionId(interruptId: string, index: number, checkpointId = ''): string {
    return `${checkpointId ? `${checkpointId}:` : ''}${interruptId}#${index}`;
}

function parseActionId(id: string): { interruptId: string; index: number } | null {
    const at = id.lastIndexOf('#');
    if (at <= 0) return null;
    const index = Number(id.slice(at + 1));
    if (!Number.isInteger(index) || index < 0) return null;
    const head = id.slice(0, at);
    const colon = head.lastIndexOf(':');
    return { interruptId: colon >= 0 ? head.slice(colon + 1) : head, index };
}

export function hasPendingInterrupt(state: StateLike): boolean {
    return (state.tasks ?? []).some(t => (t.interrupts?.length ?? 0) > 0);
}

/**
 * Every action awaiting a decision, flattened across all pending interrupts, in a stable order.
 * No filtering by tool name: the interrupt payload already contains exactly the gated calls.
 */
export function pendingActions(state: StateLike): PendingAction[] {
    const out: PendingAction[] = [];
    const checkpointId = typeof state.config?.configurable?.checkpoint_id === 'string'
        ? state.config.configurable.checkpoint_id
        : '';
    for (const task of state.tasks ?? []) {
        for (const interrupt of task.interrupts ?? []) {
            const interruptId = interrupt.id;
            if (!interruptId) continue;
            const requests = interrupt.value?.actionRequests ?? [];
            requests.forEach((req, index) => {
                out.push({
                    toolCallId: actionId(interruptId, index, checkpointId),
                    toolName: String(req.name ?? ''),
                    args: req.args ?? {},
                    interruptId,
                    index,
                });
            });
        }
    }
    return out;
}

export function toResumeMap(pending: PendingAction[], decisions: ToolDecision[]): DeepResumeResult {
    const byId = new Map(decisions.map(d => [d.toolCallId, d]));
    const pendingIds = new Set(pending.map(p => p.toolCallId));

    const unknown = decisions.filter(d => !pendingIds.has(d.toolCallId));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown toolCallId(s): ${unknown.map(d => d.toolCallId).join(', ')}` };
    }
    const undecided = pending.filter(p => !byId.has(p.toolCallId));
    if (undecided.length > 0) {
        return {
            ok: false,
            error: `Undecided tool call(s): ${undecided.map(p => `${p.toolName} (${p.toolCallId})`).join(', ')} — every pending tool needs a decision.`,
        };
    }

    const resume: ResumeMap = {};
    for (const call of pending) {
        const d = byId.get(call.toolCallId)!;
        let decision: DeepDecision;

        if (call.toolName === 'ask_user') {
            if (d.approved) {
                const answer = d.answer?.trim();
                if (!answer) return { ok: false, error: `ask_user (${call.toolCallId}) requires a non-empty answer.` };
                decision = { type: 'respond', message: answer };
            } else {
                decision = { type: 'respond', message: 'The user declined to answer. Proceed with your best judgment or finish and state the open question.' };
            }
        } else if (d.approved) {
            decision = { type: 'approve' };
        } else {
            const reason = d.reason?.trim();
            decision = {
                type: 'reject',
                message: `Rejected by user${reason ? ` — reason: ${reason}` : ''}. Do not retry this exact action; adapt or ask.`,
            };
        }

        (resume[call.interruptId] ??= { decisions: [] }).decisions[call.index] = decision;
    }
    return { ok: true, resume };
}

/** The decision text a rejected / answered action should show, since it never executes. */
export function syntheticOutput(action: PendingAction, decision: ToolDecision): string {
    if (action.toolName === 'ask_user') {
        return decision.approved
            ? (decision.answer?.trim() || 'The user declined to answer.')
            : 'The user declined to answer.';
    }
    const reason = decision.reason?.trim();
    return `Rejected by user${reason ? ` — reason: ${reason}` : ''}.`;
}

export function parseActionIdForTest(id: string) {
    return parseActionId(id);
}
