import { describe, it, expect, beforeEach } from 'vitest';
import { recordNodeTiming, summarizeRun, logRunSummary, __resetRunTimingsForTests } from './run-timings';

beforeEach(() => __resetRunTimingsForTests());

describe('run timings', () => {
    it('aggregates calls per node', () => {
        recordNodeTiming('t1', 'EXECUTOR', 1000, 500, 100);
        recordNodeTiming('t1', 'EXECUTOR', 2000, 600, 150);
        recordNodeTiming('t1', 'REFLECTOR', 500, 200, 50);

        const summary = summarizeRun('t1')!;

        expect(summary.totalLlmMs).toBe(3500);
        expect(summary.totalTokensIn).toBe(1300);
        expect(summary.totalTokensOut).toBe(300);
        expect(summary.byNode.EXECUTOR).toEqual({ calls: 2, ms: 3000, tokensIn: 1100, tokensOut: 250 });
        expect(summary.byNode.REFLECTOR.calls).toBe(1);
    });

    it('keeps runs isolated by threadId', () => {
        recordNodeTiming('t1', 'EXECUTOR', 1000, 10, 10);
        recordNodeTiming('t2', 'EXECUTOR', 5000, 20, 20);

        expect(summarizeRun('t1')!.totalLlmMs).toBe(1000);
        expect(summarizeRun('t2')!.totalLlmMs).toBe(5000);
    });

    it('ignores calls with no threadId rather than throwing', () => {
        expect(() => recordNodeTiming(undefined, 'EXECUTOR', 100, 1, 1)).not.toThrow();
        expect(summarizeRun('t1')).toBeNull();
    });

    it('discards the run after logging its summary', () => {
        recordNodeTiming('t1', 'EXECUTOR', 100, 1, 1);
        logRunSummary('t1');
        expect(summarizeRun('t1')).toBeNull();
    });

    it('returns null for an unknown thread', () => {
        expect(summarizeRun('never-seen')).toBeNull();
    });
});
