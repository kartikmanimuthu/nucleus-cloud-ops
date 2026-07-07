import { describe, it, expect } from 'vitest';
import { computeExecutionStatus, resolveRunStatus, pushFailedResource, mapWithConcurrency } from './scheduler-service.js';
import type { ScheduleExecutionMetadata, ScheduleResource } from '../types/index.js';

function emptyMeta(): ScheduleExecutionMetadata {
    return { ec2: [], ecs: [], rds: [], asg: [], docdb: [] };
}

describe('computeExecutionStatus', () => {
    it('returns success when there are no failures', () => {
        expect(computeExecutionStatus(0, 0, 0)).toBe('success');
        expect(computeExecutionStatus(3, 2, 0)).toBe('success');
    });

    it('returns failed when work was attempted but nothing succeeded', () => {
        expect(computeExecutionStatus(0, 0, 5)).toBe('failed');
    });

    it('returns partial when some succeeded and some failed', () => {
        expect(computeExecutionStatus(1, 0, 2)).toBe('partial');
        expect(computeExecutionStatus(0, 4, 1)).toBe('partial');
    });
});

describe('resolveRunStatus', () => {
    it('returns no_action for a run that changed nothing (so no-op runs are still recorded)', () => {
        expect(resolveRunStatus(0, 0, 0)).toBe('no_action');
    });

    it('matches computeExecutionStatus whenever any work happened', () => {
        expect(resolveRunStatus(3, 0, 0)).toBe('success');
        expect(resolveRunStatus(0, 2, 0)).toBe('success');
        expect(resolveRunStatus(0, 0, 5)).toBe('failed');
        expect(resolveRunStatus(1, 0, 2)).toBe('partial');
    });
});

describe('pushFailedResource', () => {
    const cases: Array<{ type: ScheduleResource['type']; bucket: keyof ScheduleExecutionMetadata }> = [
        { type: 'ec2', bucket: 'ec2' },
        { type: 'rds', bucket: 'rds' },
        { type: 'ecs', bucket: 'ecs' },
        { type: 'asg', bucket: 'asg' },
        { type: 'docdb', bucket: 'docdb' },
    ];

    for (const { type, bucket } of cases) {
        it(`records a ${type} failure in the ${bucket} bucket with the error message`, () => {
            const meta = emptyMeta();
            const resource: ScheduleResource = {
                id: `res-${type}`,
                type,
                arn: `arn:aws:${type}:ap-south-1:111122223333:thing/res-${type}`,
            };
            pushFailedResource(meta, resource, 'stop', 'boom');
            expect(meta[bucket]).toHaveLength(1);
            const entry = meta[bucket][0] as { status: string; action: string; error?: string; resourceId: string };
            expect(entry.status).toBe('failed');
            expect(entry.action).toBe('stop');
            expect(entry.error).toBe('boom');
            expect(entry.resourceId).toBe(`res-${type}`);
        });
    }

    it('defaults ECS clusterArn to "unknown" when not provided', () => {
        const meta = emptyMeta();
        pushFailedResource(meta, { id: 's', type: 'ecs', arn: 'arn:aws:ecs:...' }, 'start', 'err');
        expect(meta.ecs[0].clusterArn).toBe('unknown');
    });
});

describe('mapWithConcurrency', () => {
    it('processes every item exactly once', async () => {
        const items = Array.from({ length: 50 }, (_, i) => i);
        const seen: number[] = [];
        await mapWithConcurrency(items, 8, async (n) => { seen.push(n); });
        expect(seen.sort((a, b) => a - b)).toEqual(items);
    });

    it('never exceeds the concurrency limit in flight', async () => {
        const items = Array.from({ length: 30 }, (_, i) => i);
        let inFlight = 0;
        let peak = 0;
        await mapWithConcurrency(items, 5, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await Promise.resolve(); // yield so tasks overlap
            inFlight--;
        });
        expect(peak).toBeLessThanOrEqual(5);
        expect(peak).toBeGreaterThan(1); // actually ran concurrently
    });

    it('handles an empty list without spawning workers', async () => {
        let calls = 0;
        await mapWithConcurrency([], 8, async () => { calls++; });
        expect(calls).toBe(0);
    });
});
