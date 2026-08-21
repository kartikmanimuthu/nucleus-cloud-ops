// workers/src/jobs/spot-guard/consumer.test.ts
//
// Tests for the SQS bridge's pure surface. The loop itself needs AWS and is covered by
// the sandbox smoke test; eventIdentity is pure and is worth pinning down because it is
// the duplicate-collapse key for an at-least-once pipeline.
import { describe, it, expect } from 'vitest';
import { eventIdentity } from './consumer.js';
import type { EcsEventEnvelope } from './types.js';

const taskEvent = (over: Partial<EcsEventEnvelope['detail']> = {}): EcsEventEnvelope => ({
    id: 'eb-generated-id-1',
    account: '111111111111',
    'detail-type': 'ECS Task State Change',
    time: '2026-07-25T10:00:00Z',
    detail: {
        clusterArn: 'arn:aws:ecs:ap-south-1:111111111111:cluster/c1',
        taskArn: 'arn:aws:ecs:ap-south-1:111111111111:task/c1/abc123',
        lastStatus: 'RUNNING',
        startedAt: '2026-07-25T10:00:00Z',
        ...over,
    },
});

describe('eventIdentity', () => {
    it('is stable for the same logical transition delivered twice', () => {
        expect(eventIdentity(taskEvent())).toBe(eventIdentity(taskEvent()));
    });

    it('ignores the EventBridge envelope id', () => {
        // A forwarded event is re-emitted on the hub bus, so envelope.id is NOT stable
        // across the spoke -> hub hop. Keying on it would fail to collapse duplicates.
        const a = taskEvent();
        const b = { ...taskEvent(), id: 'completely-different-id' };
        expect(eventIdentity(a)).toBe(eventIdentity(b));
    });

    it('distinguishes RUNNING from STOPPED for the same task', () => {
        const running = taskEvent({ lastStatus: 'RUNNING' });
        const stopped = taskEvent({ lastStatus: 'STOPPED', stoppedAt: '2026-07-25T11:00:00Z' });
        expect(eventIdentity(running)).not.toBe(eventIdentity(stopped));
    });

    it('distinguishes different tasks in the same service', () => {
        const t1 = taskEvent({ taskArn: 'arn:aws:ecs:ap-south-1:111111111111:task/c1/aaa' });
        const t2 = taskEvent({ taskArn: 'arn:aws:ecs:ap-south-1:111111111111:task/c1/bbb' });
        expect(eventIdentity(t1)).not.toBe(eventIdentity(t2));
    });

    it('distinguishes the same account across different detail-types', () => {
        const task = taskEvent();
        const failure: EcsEventEnvelope = {
            account: '111111111111',
            'detail-type': 'ECS Service Action',
            detail: {
                clusterArn: 'arn:aws:ecs:ap-south-1:111111111111:cluster/c1',
                eventName: 'SERVICE_TASK_PLACEMENT_FAILURE',
            },
        };
        expect(eventIdentity(task)).not.toBe(eventIdentity(failure));
    });

    it('never exceeds the pg-boss singletonKey length budget', () => {
        const huge = taskEvent({
            taskArn: `arn:aws:ecs:ap-south-1:111111111111:task/${'x'.repeat(500)}`,
        });
        expect(eventIdentity(huge).length).toBeLessThanOrEqual(200);
    });

    it('degrades gracefully on an envelope with no detail at all', () => {
        // Malformed input must not throw here — the loop would treat a throw as an
        // enqueue failure and (correctly) leave the message for redelivery, so a
        // permanently malformed event would churn to the DLQ instead of being keyed.
        expect(() => eventIdentity({} as EcsEventEnvelope)).not.toThrow();
        expect(eventIdentity({} as EcsEventEnvelope)).toContain('unknown');
    });
});
