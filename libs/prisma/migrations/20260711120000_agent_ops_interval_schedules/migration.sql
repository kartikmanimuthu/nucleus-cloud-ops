-- AlterTable: interval-based schedules for Agent Ops scheduled tasks
-- scheduleType: 'cron' (default, existing behavior) | 'interval'
-- intervalMinutes: fixed re-run interval, set when scheduleType = 'interval'
ALTER TABLE "scheduled_tasks"
    ADD COLUMN "scheduleType" TEXT NOT NULL DEFAULT 'cron',
    ADD COLUMN "intervalMinutes" INTEGER;
