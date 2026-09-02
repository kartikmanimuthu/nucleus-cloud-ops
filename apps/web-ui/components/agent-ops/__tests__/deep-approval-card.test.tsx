// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * DeepApprovalCard gates Submit until every pending action has a decision.
 *
 * POST /api/agent-ops/[runId]/decisions (toResumeMap) rejects a partial decision
 * set outright, and rejects an approved ask_user decision with an empty answer.
 * If the client's gate is looser than that contract, the user gets a guaranteed
 * 400 on submit — so the gate condition is the thing under test here, not
 * cosmetics.
 *
 * The real component is rendered (not a hand-built stand-in): only the
 * network-calling mutation hook is mocked, exactly as right-sizing-gating.test.tsx
 * mocks useUpdateRightSizingRecommendation while rendering the real page/detail
 * component. A local copy of the markup would keep passing if the real gate
 * logic were reverted to the naive "has any verdict" check, which is the exact
 * bug this test exists to catch.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mutate = vi.fn();
vi.mock('@/lib/queries/agent-ops', () => ({
    useSubmitDecisions: () => ({ mutate, isPending: false }),
}));

import { DeepApprovalCard } from '../deep-approval-card';

const byName = (name: RegExp) => screen.getAllByRole('button', { name });
const submitButton = () => screen.getByRole('button', { name: /submit & resume|left to decide/i }) as HTMLButtonElement;

const TOOL_ACTIONS = [
    { toolCallId: 'a1', toolName: 'stop_ec2_instance', args: { instanceId: 'i-1' } },
    { toolCallId: 'a2', toolName: 'stop_ec2_instance', args: { instanceId: 'i-2' } },
];

const ASK_USER_ACTION = { toolCallId: 'q1', toolName: 'ask_user', args: { question: 'Which region?' } };

describe('DeepApprovalCard — submit gating', () => {
    it('disables submit until every pending action has a decision', () => {
        render(<DeepApprovalCard runId="run-1" actions={TOOL_ACTIONS} />);

        expect(submitButton().disabled).toBe(true);

        fireEvent.click(byName(/^Approve$/)[0]); // decides a1
        expect(submitButton().disabled).toBe(true); // one of two decided — still gated

        fireEvent.click(byName(/^Reject$/)[1]); // decides a2 (index 0 would re-decide a1)
        expect(submitButton().disabled).toBe(false); // both decided — ungated
    });

    it('renders an answer textarea for ask_user, not approve/reject buttons', () => {
        render(<DeepApprovalCard runId="run-1" actions={[ASK_USER_ACTION]} />);

        expect(screen.getByPlaceholderText(/your answer/i)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Reject$/ })).toBeNull();
    });

    it('keeps submit disabled for an ask_user action approved with an empty answer', () => {
        render(<DeepApprovalCard runId="run-1" actions={[ASK_USER_ACTION]} />);

        const textarea = screen.getByPlaceholderText(/your answer/i);
        // Typing then clearing leaves a verdict object with approved:true and an
        // empty answer — the exact shape the server rejects. The gate must not
        // be fooled by the verdict merely existing.
        fireEvent.change(textarea, { target: { value: 'us-east-1' } });
        fireEvent.change(textarea, { target: { value: '' } });

        expect(submitButton().disabled).toBe(true);
    });

    it('enables submit for an ask_user action once a non-empty answer is entered', () => {
        render(<DeepApprovalCard runId="run-1" actions={[ASK_USER_ACTION]} />);

        fireEvent.change(screen.getByPlaceholderText(/your answer/i), { target: { value: 'us-east-1' } });

        expect(submitButton().disabled).toBe(false);
    });

    it('enables submit for an ask_user action declined with no answer required', () => {
        render(<DeepApprovalCard runId="run-1" actions={[ASK_USER_ACTION]} />);

        fireEvent.click(screen.getByRole('button', { name: /decline to answer/i }));

        expect(submitButton().disabled).toBe(false);
    });

    it('"Approve all" decides every action, enabling submit', () => {
        render(<DeepApprovalCard runId="run-1" actions={TOOL_ACTIONS} />);

        expect(submitButton().disabled).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: /approve all/i }));
        expect(submitButton().disabled).toBe(false);
    });

    it('submits one decision per pending action, with toolCallId/approved (and answer for ask_user)', () => {
        const actions = [...TOOL_ACTIONS, ASK_USER_ACTION];
        render(<DeepApprovalCard runId="run-42" actions={actions} />);

        fireEvent.click(byName(/^Approve$/)[0]); // a1 approved
        fireEvent.click(byName(/^Reject$/)[1]); // a2 rejected
        fireEvent.change(screen.getByPlaceholderText(/your answer/i), { target: { value: 'us-east-1' } });

        expect(submitButton().disabled).toBe(false);
        fireEvent.click(submitButton());

        expect(mutate).toHaveBeenCalledTimes(1);
        const [payload] = mutate.mock.calls[0];
        expect(payload.runId).toBe('run-42');
        expect(payload.decisions).toHaveLength(3);
        expect(payload.decisions).toEqual(
            expect.arrayContaining([
                { toolCallId: 'a1', approved: true },
                { toolCallId: 'a2', approved: false },
                { toolCallId: 'q1', approved: true, answer: 'us-east-1' },
            ]),
        );
    });
});
