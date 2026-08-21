import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/**
 * Type-safe environment access for the workers process (powered by
 * @t3-oss/env-core — the framework-agnostic variant, since workers is a plain
 * Node/pg-boss process, not Next.js).
 *
 * Only DATABASE_URL is the load-bearing var, but it is kept OPTIONAL here on
 * purpose: boss.ts throws an explicit, clear error when it is missing (the real
 * worker cannot start without it), while the discovery local-runner dev CLI is
 * designed to run scans in a degraded, DB-less mode. Marking it required would
 * make any module that transitively imports this file throw at load and break
 * that dev path. Everything else is optional and keeps its existing per-call-
 * site fallback — the schema does NOT centralize defaults, because several vars
 * are read with divergent fallbacks across the codebase (e.g. AWS_REGION →
 * 'ap-south-1' in most places but 'us-east-1' in kb-sync/file-upload).
 * Centralizing would silently change behavior at those sites.
 *
 * Usage:
 *   import { env } from '@/env';   // or a relative path from the file
 *   const url = env.DATABASE_URL;
 */
export const env = createEnv({
    server: {
        NODE_ENV: z
            .enum(['development', 'test', 'production'])
            .default('development'),

        // Load-bearing but kept optional (see note above) — boss.ts enforces it
        DATABASE_URL: z.string().url().optional(),

        // AWS
        AWS_REGION: z.string().optional(),
        AWS_DEFAULT_REGION: z.string().optional(),
        AWS_PROFILE: z.string().optional(),
        AWS_ACCOUNT_ID: z.string().optional(),

        // Logging / service identity
        LOG_LEVEL: z.string().optional(),
        SERVICE_NAME: z.string().optional(),

        // Executor / horizontal scaling
        WORKER_ARCH: z.enum(['vertical', 'horizontal']).optional(),
        HORIZONTAL_CLUSTER_ARN: z.string().optional(),
        HORIZONTAL_TASK_DEF_ARN: z.string().optional(),
        HORIZONTAL_SUBNETS: z.string().optional(),
        HORIZONTAL_SECURITY_GROUP: z.string().optional(),
        HORIZONTAL_POLL_INTERVAL_MS: z.string().optional(),
        HORIZONTAL_TASK_TIMEOUT_MS: z.string().optional(),

        // Discovery
        CONCURRENT_REGIONS: z.string().optional(),
        CONCURRENT_SERVICES: z.string().optional(),
        SCANFILE_PATH: z.string().optional(),

        // Feature flags / scheduling
        USE_PG_SCHEDULES: z.string().optional(),

        // pg-boss worker poll cadence (seconds). Controls how quickly the workers
        // process picks up jobs enqueued by the web-ui — pg-boss has no cross-process
        // push, so this is the real-time-pickup floor. Default 1s, min 0.5s. See boss.ts.
        PGBOSS_POLL_INTERVAL_SECONDS: z.string().optional(),

        // Scheduler local/simulation controls (read by the scheduler job).
        // SCHEDULER_DRY_RUN=true  → describe + decide only, skip all Start/Stop/Update mutations
        //                           and skip per-resource success audit writes (safe simulation).
        // SCHEDULER_FORCE_ACTION=start|stop → override the time-window decision (test both paths).
        SCHEDULER_DRY_RUN: z.string().optional(),
        SCHEDULER_FORCE_ACTION: z.enum(['start', 'stop']).optional(),
        // Max AWS accounts scanned in parallel per schedule (default 8, clamped 1..32).
        // Read via process.env at scan time (runtime toggle) — see scheduler-service.ts.
        SCHEDULER_ACCOUNT_CONCURRENCY: z.string().optional(),

        // Fargate Spot Guard — cross-account ECS event ingestion.
        //
        // Set ONLY on the long-lived workers task definition, and only on stacks that
        // opted in via the spotGuardEnabled Pulumi config flag (sbx today). Ephemeral
        // job-runner tasks intentionally do NOT receive SPOT_GUARD_QUEUE_URL: an
        // ephemeral task must never long-poll SQS. See jobs/spot-guard/consumer.ts.
        //
        // SPOT_GUARD_ENABLED gates worker-side registration, so the image can ship
        // everywhere while the behaviour activates only where the infra exists.
        SPOT_GUARD_ENABLED: z.string().optional(),
        SPOT_GUARD_QUEUE_URL: z.string().url().optional(),
        SPOT_GUARD_BUS_NAME: z.string().optional(),
        SPOT_GUARD_POLL_WAIT_SECONDS: z.string().optional(),
        SPOT_GUARD_POLL_BATCH_SIZE: z.string().optional(),

        // Scaling Audit (SA-001) — SEBI compliance capture of ECS + ASG scaling
        // events. Gates worker-side registration, same reasoning as
        // SPOT_GUARD_ENABLED: ship everywhere, activate only where opted in.
        SCALING_AUDIT_ENABLED: z.string().optional(),

        // Health server port (ECS container health check probes this). Default 8080.
        HEALTH_PORT: z.string().optional(),

        // Per-replica local heartbeat cadence (ms). The health endpoint reports
        // unhealthy when the heartbeat goes stale (> HEALTH_STALENESS_MS, see
        // index.ts). This interval advances the heartbeat independently of
        // pg-boss's singleton monitor-states event, so every replica in an
        // autoscaled fleet stays healthy — not just the one holding the monitor
        // lock. Default 30s (4 ticks within the 120s staleness budget). See
        // health.ts.
        HEALTH_HEARTBEAT_INTERVAL_MS: z.string().optional(),

        // Misc
        PORT: z.string().optional(),
        TENANT_ID: z.string().optional(),
        DEFAULT_TENANT_ID: z.string().optional(),
        INTERNAL_API_KEY: z.string().optional(),
        WEB_UI_BASE_URL: z.string().optional(),
        BEDROCK_MODEL_ID: z.string().optional(),
        APP_BUCKET_NAME: z.string().optional(),

        // Legacy scheduler (DynamoDB-era fallback path in jobs/scheduler/services)
        APP_TABLE_NAME: z.string().optional(),
        AUDIT_TABLE_NAME: z.string().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    /**
     * Skip during Docker build / CI (no runtime secrets) and under Vitest,
     * where tests set process.env in beforeEach after module import would have
     * run createEnv().
     */
    skipValidation:
        !!process.env.SKIP_ENV_VALIDATION || process.env.NODE_ENV === 'test',
});
