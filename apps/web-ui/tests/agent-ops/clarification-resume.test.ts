/**
 * Regression test for the clarification-resume loop.
 *
 * Live failure: a run asked a clarification (evaluation.mode='end'), the user
 * answered, and the resume re-invoked the graph on the SAME thread. The
 * evaluator's "already evaluated" guard saw the checkpointed evaluation and
 * returned instantly — never calling the LLM, never reading the user's reply —
 * and routeFromEvaluator routed to clarify again off the stale mode='end'.
 * The run re-asked the identical question forever, whatever the user answered.
 */

import { describe, it, expect } from 'vitest';
import { isReusableEvaluation } from '../../lib/agent-ops/executor-state';
import type { RequestEvaluation } from '../../lib/agent-ops/executor-state';

function evaluation(overrides: Partial<RequestEvaluation>): RequestEvaluation {
    return {
        mode: 'plan', skillId: null, accountId: null, requiresApproval: false,
        reasoning: '', clarificationQuestion: null, missingInfo: null,
        skillName: null, knowledgeBaseIds: [],
        ...overrides,
    } as RequestEvaluation;
}

describe('isReusableEvaluation', () => {
    it('is false when there is no evaluation yet — evaluator must run', () => {
        expect(isReusableEvaluation(null)).toBe(false);
        expect(isReusableEvaluation(undefined as unknown as null)).toBe(false);
    });

    it('is true for an executable plan decision — approval resume reuses it', () => {
        expect(isReusableEvaluation(evaluation({ mode: 'plan', requiresApproval: true }))).toBe(true);
    });

    it("is FALSE for a stale clarification decision (mode='end') — the user's reply must be re-evaluated", () => {
        expect(isReusableEvaluation(evaluation({
            mode: 'end',
            clarificationQuestion: 'Could you clarify the purpose of this message?',
        }))).toBe(false);
    });
});
