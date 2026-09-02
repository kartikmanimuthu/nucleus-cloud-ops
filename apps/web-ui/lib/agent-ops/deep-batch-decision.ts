/**
 * Batch → per-action decision fan-out for deep runs.
 *
 * Channel adapters (Slack, Jira, Discord, Telegram, webhook) offer one
 * approve/reject button for the whole run. Deep interrupts are per-action, so a
 * batch verdict is applied uniformly to every pending action. This keeps every
 * adapter working with zero changes; the web UI uses the per-action route instead.
 *
 * ask_user is special: 'approve' is not a valid outcome for it (the tool's real
 * implementation IS the human's reply), so a batch approve becomes a 'respond'
 * that tells the agent nobody answered.
 */
import type { DeepDecision, PendingAction, ResumeMap } from '@/lib/agent/deep/hitl';
import type { AgentOpsRun } from './types';

const NO_ANSWER = 'No answer was provided (bulk approval from a channel). Proceed with your best judgment or finish and state the open question.';

const NO_PENDING_ACTIONS_ERROR = 'Deep run has no pending actions recorded.';

export type DeepPendingResult =
    | { ok: true; actions: PendingAction[] }
    | { ok: false; error: string };

/**
 * Single source of truth for reading a deep run's pending-action set off
 * `run.approvalRequest`, and for deciding whether it is usable. Every
 * channel-approval entry point (the web-UI /approve route, and both the
 * approve and reject cases of GatewayService.handleResume) must agree on
 * this cast and this empty-check — they diverged once before (the route
 * resumed on reject while the gateway cancelled), and duplicating the
 * check across call sites is exactly how that trap gets rebuilt one layer
 * down. Callers own their own response shaping; this only owns the data.
 */
export function resolveDeepPendingActions(run: AgentOpsRun): DeepPendingResult {
    const actions = (run.approvalRequest?.pendingActions ?? []) as PendingAction[];
    if (actions.length === 0) {
        return { ok: false, error: NO_PENDING_ACTIONS_ERROR };
    }
    return { ok: true, actions };
}

export function fanOutDecision(actions: PendingAction[], action: 'approve' | 'reject'): ResumeMap {
    const resume: ResumeMap = {};

    for (const item of actions) {
        let decision: DeepDecision;
        if (item.toolName === 'ask_user') {
            decision = {
                type: 'respond',
                message: action === 'approve' ? NO_ANSWER : 'The user declined to answer.',
            };
        } else if (action === 'approve') {
            decision = { type: 'approve' };
        } else {
            decision = {
                type: 'reject',
                message: 'Rejected by user from the originating channel. Do not retry this exact action; adapt or ask.',
            };
        }
        (resume[item.interruptId] ??= { decisions: [] }).decisions[item.index] = decision;
    }

    return resume;
}
