// workers/src/jobs/agent-ops-scheduler/sync.ts
/**
 * Pure diff between the active ScheduledTask rows in the database and the
 * schedules this worker process has registered with pg-boss. Drives the
 * periodic re-sync so tasks created/paused/edited after worker startup take
 * effect without a restart.
 */

export interface ActiveTaskRow {
    taskId: string;
    tenantId: string;
    cronExpression: string;
    timezone: string;
}

export interface RegisteredEntry {
    cronExpression: string;
    timezone: string;
}

export interface ScheduleSyncDiff {
    toAdd: ActiveTaskRow[];
    toRemove: string[];
    toUpdate: ActiveTaskRow[];
}

export function diffScheduleSync(
    active: ActiveTaskRow[],
    registered: Map<string, RegisteredEntry>,
): ScheduleSyncDiff {
    const activeIds = new Set(active.map(t => t.taskId));

    const toAdd = active.filter(t => !registered.has(t.taskId));
    const toUpdate = active.filter(t => {
        const reg = registered.get(t.taskId);
        return reg !== undefined
            && (reg.cronExpression !== t.cronExpression || reg.timezone !== t.timezone);
    });
    const toRemove = Array.from(registered.keys()).filter(id => !activeIds.has(id));

    return { toAdd, toRemove, toUpdate };
}
