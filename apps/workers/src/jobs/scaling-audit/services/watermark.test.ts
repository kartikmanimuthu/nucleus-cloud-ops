import { describe, it, expect } from 'vitest';
import { computeWatermarkAdvance, isTerminalStatus } from './watermark.js';
import type { RawScalingActivity } from '../types.js';

function activity(partial: Partial<RawScalingActivity>): RawScalingActivity {
    return {
        activityId: 'act-default',
        resourceId: 'res-1',
        cause: 'test cause',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        rawPayload: {},
        ...partial,
    };
}

describe('computeWatermarkAdvance', () => {
    it('advances to the newest activity when everything is terminal', () => {
        const events = [
            activity({ activityId: 'a1', statusCode: 'Successful', startedAt: new Date('2026-01-01T00:00:00Z') }),
            activity({ activityId: 'a2', statusCode: 'Successful', startedAt: new Date('2026-01-02T00:00:00Z') }),
        ];
        const next = computeWatermarkAdvance(events, { at: null, id: null }, new Date('2026-01-02T00:00:00Z'));
        expect(next.at).toEqual(new Date('2026-01-02T00:00:00Z'));
        expect(next.id).toBe('a2');
    });

    it('holds at the oldest in-flight activity when any activity is non-terminal', () => {
        const events = [
            activity({ activityId: 'a1', statusCode: 'Successful', startedAt: new Date('2026-01-01T00:00:00Z') }),
            activity({ activityId: 'a2', statusCode: 'InProgress', startedAt: new Date('2026-01-02T00:00:00Z') }),
            activity({ activityId: 'a3', statusCode: 'WaitingForInstanceWarmup', startedAt: new Date('2026-01-03T00:00:00Z') }),
        ];
        const next = computeWatermarkAdvance(events, { at: null, id: null }, new Date('2026-01-03T00:00:00Z'));
        // Holds at a2 (oldest of the two in-flight), NOT a3 (newest overall).
        expect(next.at).toEqual(new Date('2026-01-02T00:00:00Z'));
        expect(next.id).toBe('a2');
    });

    it('treats an unknown/unrecognized statusCode as non-terminal (conservative default)', () => {
        const events = [activity({ activityId: 'a1', statusCode: 'SomeFutureAwsStatusCode', startedAt: new Date('2026-01-01T00:00:00Z') })];
        const next = computeWatermarkAdvance(events, { at: null, id: null }, new Date('2026-01-01T00:00:00Z'));
        expect(next.id).toBe('a1'); // held back, not advanced past
        expect(next.at).toEqual(new Date('2026-01-01T00:00:00Z'));
    });

    it('returns the previous mark unchanged when there are no events and nothing seen', () => {
        const previous = { at: new Date('2025-12-01T00:00:00Z'), id: 'old-id' };
        const next = computeWatermarkAdvance([], previous, null);
        expect(next).toEqual(previous);
    });

    it('advances past an Unfulfilled activity — it is terminal for Application Auto Scaling', () => {
        // Regression: Unfulfilled was absent from the terminal set, so the ecs
        // watermark pinned itself to such an activity forever and every later poll
        // re-fetched the whole window from it. Seen live in sbx.
        const events = [
            activity({ activityId: 'a1', statusCode: 'Successful', startedAt: new Date('2026-01-01T00:00:00Z') }),
            activity({ activityId: 'a2', statusCode: 'Unfulfilled', startedAt: new Date('2026-01-02T00:00:00Z') }),
        ];
        const next = computeWatermarkAdvance(events, { at: null, id: null }, new Date('2026-01-02T00:00:00Z'));
        expect(next.at).toEqual(new Date('2026-01-02T00:00:00Z'));
        expect(next.id).toBe('a2');
    });
});

describe('CloudTrail-sourced rows', () => {
    // A CloudTrail event carries no statusCode of its own. If the client left it
    // undefined, isTerminalStatus() would call it non-terminal, index.ts would
    // defer the row forever and the mark would pin — exactly the 'Unfulfilled'
    // bug, reintroduced through a new door. The client therefore derives a
    // terminal status; these pin that contract.
    it('advances the mark for a successful CloudTrail row', () => {
        const events = [activity({ activityId: 'ct-1', statusCode: 'Successful', startedAt: new Date('2026-02-01T00:00:00Z') })];
        const next = computeWatermarkAdvance(events, { at: null, id: null }, new Date('2026-02-01T00:00:00Z'));
        expect(next.id).toBe('ct-1');
    });

    it('advances the mark for a DENIED CloudTrail row (errorCode -> Failed, still terminal)', () => {
        // A rejected UpdateService attempt is audit-relevant evidence and is final.
        const events = [activity({ activityId: 'ct-denied', statusCode: 'Failed', startedAt: new Date('2026-02-02T00:00:00Z') })];
        const next = computeWatermarkAdvance(events, { at: null, id: null }, new Date('2026-02-02T00:00:00Z'));
        expect(next.id).toBe('ct-denied');
    });

    it('would PIN if a source ever left statusCode undefined — the trap this guards', () => {
        const events = [activity({ activityId: 'ct-bad', statusCode: undefined, startedAt: new Date('2026-02-03T00:00:00Z') })];
        const next = computeWatermarkAdvance(events, { at: null, id: null }, new Date('2026-02-03T00:00:00Z'));
        expect(next.id).toBe('ct-bad'); // held, never advanced past
        expect(isTerminalStatus(undefined)).toBe(false);
    });
});

describe('isTerminalStatus', () => {
    it.each(['Successful', 'Failed', 'Cancelled', 'Overridden', 'Unfulfilled'])('treats %s as terminal', (code) => {
        expect(isTerminalStatus(code)).toBe(true);
    });

    it.each(['Pending', 'InProgress', 'PreInService', 'WaitingForInstanceWarmup', 'SomeFutureAwsCode', '', null, undefined])(
        'treats %s as non-terminal',
        (code) => {
            expect(isTerminalStatus(code as string | null | undefined)).toBe(false);
        }
    );

    it('agrees with computeWatermarkAdvance about what is in flight', () => {
        // The writer defers exactly the activities this predicate calls non-terminal,
        // and the watermark holds at exactly those. If the two ever disagreed, a
        // deferred activity could be skipped permanently — so pin the coupling.
        const nonTerminal = activity({ activityId: 'held', statusCode: 'Pending', startedAt: new Date('2026-01-05T00:00:00Z') });
        const terminal = activity({ activityId: 'done', statusCode: 'Unfulfilled', startedAt: new Date('2026-01-06T00:00:00Z') });
        expect(isTerminalStatus(nonTerminal.statusCode)).toBe(false);
        expect(isTerminalStatus(terminal.statusCode)).toBe(true);

        const next = computeWatermarkAdvance([nonTerminal, terminal], { at: null, id: null }, new Date('2026-01-06T00:00:00Z'));
        // Held at the non-terminal one, so a later poll re-reads it.
        expect(next.id).toBe('held');
    });
});
