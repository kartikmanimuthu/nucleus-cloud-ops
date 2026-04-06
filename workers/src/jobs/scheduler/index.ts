import type PgBoss from 'pg-boss';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantSchedulerConfig } from './services/pg-service.js';
import type { SchedulerEvent } from './types/index.js';

function intervalToCron(minutes: number): string {
    switch (minutes) {
        case 5:  return '*/5 * * * *';
        case 15: return '*/15 * * * *';
        case 30: return '*/30 * * * *';
        case 60: return '0 * * * *';
        default: return '*/30 * * * *';
    }
}

async function registerTenantSchedule(boss: PgBoss, tenantId: string): Promise<void> {
    const queueName = `scheduler-scan:${tenantId}`;
    const { intervalMinutes } = await getTenantSchedulerConfig(tenantId);
    const cronExpr = intervalToCron(intervalMinutes);

    await boss.createQueue(queueName);
    await boss.schedule(queueName, cronExpr, { tenantId }, { tz: 'UTC' });
    await boss.work<SchedulerEvent>(queueName, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
            const event = job.data;
            const triggeredBy = event?.triggeredBy || 'system';
            const isPartialScan = event?.scheduleId || event?.scheduleName;

            console.log(`[scheduler] Processing job ${job.id}`, {
                tenantId,
                mode: isPartialScan ? 'partial' : 'full',
                triggeredBy,
            });

            if (isPartialScan) {
                const result = await runPartialScan(event, triggeredBy);
                console.log(`[scheduler] Partial scan complete`, result);
            } else {
                const result = await runFullScan(triggeredBy);
                console.log(`[scheduler] Full scan complete`, result);
            }
        }
    });

    console.log(`[scheduler] Registered ${queueName} with cron ${cronExpr} (${intervalMinutes}min)`);
}

export async function register(boss: PgBoss): Promise<void> {
    // Register per-tenant queues on startup
    const tenants = await getActiveTenants();
    for (const tenant of tenants) {
        await registerTenantSchedule(boss, tenant.id);
    }

    // Handle live interval changes sent by the web-ui settings API
    await boss.createQueue('scheduler-reschedule');
    await boss.work<{ tenantId: string; intervalMinutes: number }>(
        'scheduler-reschedule',
        { batchSize: 1 },
        async (jobs) => {
            for (const job of jobs) {
                const { tenantId, intervalMinutes } = job.data;
                const queueName = `scheduler-scan:${tenantId}`;
                const cronExpr = intervalToCron(intervalMinutes);
                try {
                    await boss.unschedule(queueName);
                    await boss.schedule(queueName, cronExpr, { tenantId }, { tz: 'UTC' });
                    console.log(`[scheduler] Rescheduled ${queueName} → ${cronExpr}`);
                } catch (err) {
                    // Queue may not exist yet for a new tenant — register fresh
                    console.warn(`[scheduler] unschedule failed for ${queueName}, registering fresh:`, err);
                    await registerTenantSchedule(boss, tenantId);
                }
            }
        }
    );

    console.log(`[scheduler] Registered ${tenants.length} tenant scheduler(s) + reschedule handler`);
}
