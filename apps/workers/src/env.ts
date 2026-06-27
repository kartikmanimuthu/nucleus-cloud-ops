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
        RIGHT_SIZING_ENABLED: z.string().optional(),

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
