import { describe, it, expect } from 'vitest';
import { diffScheduleSync, type ActiveTaskRow, type RegisteredEntry } from './sync.js';

const row = (taskId: string, cron = '0 9 * * *', tz = 'UTC'): ActiveTaskRow => ({
    taskId, tenantId: 'tenant-1', cronExpression: cron, timezone: tz,
});
const entry = (cron = '0 9 * * *', tz = 'UTC'): RegisteredEntry => ({
    cronExpression: cron, timezone: tz,
});

describe('diffScheduleSync', () => {
    it('adds tasks not yet registered', () => {
        const diff = diffScheduleSync([row('a'), row('b')], new Map([['a', entry()]]));
        expect(diff.toAdd.map(t => t.taskId)).toEqual(['b']);
        expect(diff.toRemove).toEqual([]);
        expect(diff.toUpdate).toEqual([]);
    });

    it('removes registered tasks that are no longer active', () => {
        const diff = diffScheduleSync([row('a')], new Map([['a', entry()], ['gone', entry()]]));
        expect(diff.toRemove).toEqual(['gone']);
        expect(diff.toAdd).toEqual([]);
    });

    it('updates tasks whose cron expression changed', () => {
        const diff = diffScheduleSync([row('a', '0 10 * * *')], new Map([['a', entry('0 9 * * *')]]));
        expect(diff.toUpdate.map(t => t.taskId)).toEqual(['a']);
    });

    it('updates tasks whose timezone changed', () => {
        const diff = diffScheduleSync([row('a', '0 9 * * *', 'Asia/Kolkata')], new Map([['a', entry()]]));
        expect(diff.toUpdate.map(t => t.taskId)).toEqual(['a']);
    });

    it('reports nothing for an unchanged registration', () => {
        const diff = diffScheduleSync([row('a')], new Map([['a', entry()]]));
        expect(diff).toEqual({ toAdd: [], toRemove: [], toUpdate: [] });
    });

    it('handles empty inputs', () => {
        expect(diffScheduleSync([], new Map())).toEqual({ toAdd: [], toRemove: [], toUpdate: [] });
    });
});
