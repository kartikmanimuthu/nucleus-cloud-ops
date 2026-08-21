// workers/src/jobs/scaling-audit/services/watermark.ts
//
// Pure function: given a batch of freshly-fetched activities and the previous
// watermark, compute the new watermark. Isolated from db-writer/index.ts so the
// core invariant — never advance past a non-terminal activity — is unit-testable
// without a database or AWS mocks.
import type { RawScalingActivity } from '../types.js';

/**
 * Codes not in this set are treated as non-terminal (conservative default —
 * unknown codes must never let the watermark advance past them).
 *
 * Covers both APIs' vocabularies:
 *   - ASG (autoscaling):                    Successful | Failed | Cancelled
 *   - Application Auto Scaling (ecs):       Successful | Failed | Overridden | Unfulfilled
 *
 * `Unfulfilled` is Application Auto Scaling's TERMINAL outcome for a desired-count
 * change it could not place (e.g. ECS never placed the task). It is final — AWS
 * never revisits it — so omitting it pinned the ecs watermark permanently: the
 * mark held at that activity forever, and every subsequent poll re-fetched the
 * whole window from it until the activity aged out of AWS's ~6-week retention.
 * Observed live in sbx, where the ecs mark sat on an Unfulfilled activity.
 */
const TERMINAL_STATUS_CODES = new Set(['Successful', 'Failed', 'Cancelled', 'Overridden', 'Unfulfilled']);

/**
 * Whether AWS has finished with this activity.
 *
 * Exported so the writer's "don't persist mid-flight rows" filter and the
 * watermark hold-back below share ONE definition. They must never diverge: if the
 * writer deferred an activity that the watermark advanced past, the activity would
 * be skipped permanently and silently lost from the compliance record.
 */
export function isTerminalStatus(statusCode: string | null | undefined): boolean {
    return TERMINAL_STATUS_CODES.has(statusCode ?? '');
}

export interface WatermarkMark {
    at: Date | null;
    id: string | null;
}

/**
 * Compute the next watermark for a scope from one poll's activities.
 *
 * If any activity in the batch is still in-flight (non-terminal statusCode), the
 * new mark holds at the OLDEST such activity's StartTime — never at the newest
 * seen — so a later poll re-reads it through to completion instead of skipping
 * past it. Only when every activity is terminal does the mark advance to the
 * newest StartTime seen.
 */
export function computeWatermarkAdvance(events: RawScalingActivity[], previous: WatermarkMark, newestActivitySeenAt: Date | null): WatermarkMark {
    const inFlight = events.filter((e) => !isTerminalStatus(e.statusCode));

    if (inFlight.length > 0) {
        const oldest = inFlight.reduce((min, e) => (e.startedAt < min.startedAt ? e : min), inFlight[0]);
        return { at: oldest.startedAt, id: oldest.activityId };
    }

    if (newestActivitySeenAt) {
        const newest = events.find((e) => e.startedAt.getTime() === newestActivitySeenAt.getTime());
        return { at: newestActivitySeenAt, id: newest?.activityId ?? previous.id };
    }

    return previous;
}
