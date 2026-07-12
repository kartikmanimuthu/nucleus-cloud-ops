// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDecisions } from '../use-decisions';

describe('useDecisions', () => {
    it('fires onComplete exactly once when the last tool is decided', () => {
        const onComplete = vi.fn();
        const { result } = renderHook(() => useDecisions({ pendingToolCallIds: ['t1', 't2'], onComplete }));
        act(() => result.current.decide('t1', { approved: true }));
        expect(onComplete).not.toHaveBeenCalled();
        act(() => result.current.decide('t2', { approved: false, reason: 'nope' }));
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete.mock.calls[0][0]).toEqual([
            { toolCallId: 't1', approved: true, reason: undefined, answer: undefined },
            { toolCallId: 't2', approved: false, reason: 'nope', answer: undefined },
        ]);
    });

    it('decideRemaining decides all undecided ids at once and completes', () => {
        const onComplete = vi.fn();
        const { result } = renderHook(() => useDecisions({ pendingToolCallIds: ['t1', 't2', 't3'], onComplete }));
        act(() => result.current.decide('t2', { approved: false }));
        act(() => result.current.decideRemaining(true));
        expect(onComplete).toHaveBeenCalledTimes(1);
        const batch = onComplete.mock.calls[0][0];
        expect(batch.find((d: any) => d.toolCallId === 't2').approved).toBe(false);
        expect(batch.filter((d: any) => d.approved)).toHaveLength(2);
    });

    it('resets when the pending id set changes (new batch)', () => {
        const onComplete = vi.fn();
        const { result, rerender } = renderHook(
            ({ ids }) => useDecisions({ pendingToolCallIds: ids, onComplete }),
            { initialProps: { ids: ['t1'] } },
        );
        act(() => result.current.decide('t1', { approved: true }));
        rerender({ ids: ['t9'] });
        expect(result.current.decidedCount).toBe(0);
        expect(result.current.resolvedIds.size).toBe(0);
    });

    it('exposes resolvedIds as a new non-empty Set in the same render cycle the batch completes', () => {
        const onComplete = vi.fn();
        const { result } = renderHook(() => useDecisions({ pendingToolCallIds: ['t1'], onComplete }));
        expect(result.current.resolvedIds.size).toBe(0);
        act(() => result.current.decide('t1', { approved: true }));
        expect(result.current.resolvedIds.size).toBe(1);
        expect(result.current.resolvedIds.has('t1')).toBe(true);
    });

    it('does not fire onComplete from stale decisions when a new batch overlaps an old id', () => {
        const onComplete = vi.fn();
        const { result, rerender } = renderHook(
            ({ ids }) => useDecisions({ pendingToolCallIds: ids, onComplete }),
            { initialProps: { ids: ['t1', 't2'] } },
        );
        act(() => result.current.decide('t1', { approved: true }));
        act(() => result.current.decide('t2', { approved: true }));
        expect(onComplete).toHaveBeenCalledTimes(1);
        // New batch reusing t1 — stale decisions must not auto-fire for it
        rerender({ ids: ['t1', 't9'] });
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('reset() re-arms a completed batch so it can be resubmitted after a failed submission', () => {
        const onComplete = vi.fn();
        const { result } = renderHook(() => useDecisions({ pendingToolCallIds: ['t1', 't2'], onComplete }));
        act(() => result.current.decide('t1', { approved: true }));
        act(() => result.current.decide('t2', { approved: false }));
        expect(onComplete).toHaveBeenCalledTimes(1);

        act(() => result.current.reset());
        expect(result.current.decidedCount).toBe(0);
        expect(result.current.resolvedIds.size).toBe(0);

        act(() => result.current.decide('t1', { approved: true }));
        act(() => result.current.decide('t2', { approved: true }));
        expect(onComplete).toHaveBeenCalledTimes(2);
    });
});
