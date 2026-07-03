import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * Type-safe environment access for web-ui (powered by @t3-oss/env-nextjs).
 *
 * Migration note: the app historically reads `process.env.X || 'fallback'`
 * ad-hoc across ~66 variables. To make adoption non-breaking we currently mark
 * most vars optional and gate validation behind SKIP_ENV_VALIDATION (set during
 * Docker build, where runtime secrets are absent). As call sites migrate to
 * `env.X`, individual vars can be tightened to required.
 *
 * Usage:
 *   import { env } from '@/env';
 *   const region = env.AWS_REGION;
 */
export const env = createEnv({
    /**
     * Server-only vars — never exposed to the browser bundle.
     */
    server: {
        NODE_ENV: z
            .enum(['development', 'test', 'production'])
            .default('development'),

        // Database
        DATABASE_URL: z.string().url(),

        // AWS
        AWS_REGION: z.string().optional(),
        AWS_DEFAULT_REGION: z.string().optional(),
        AWS_ACCOUNT_ID: z.string().optional(),
        HUB_ACCOUNT_ID: z.string().optional(),

        // Auth (NextAuth + Cognito)
        NEXTAUTH_SECRET: z.string().min(1),
        NEXTAUTH_URL: z.string().url().optional(),
        COGNITO_USER_POOL_ID: z.string().min(1),
        COGNITO_APP_CLIENT_ID: z.string().min(1),
        COGNITO_APP_CLIENT_SECRET: z.string().min(1),
        COGNITO_ISSUER: z.string().optional(),

        // AI / Bedrock / observability
        BEDROCK_MODEL_ID: z.string().optional(),
        ASK_AI_GENERATION_MODEL: z.string().optional(),
        TAVILY_API_KEY: z.string().optional(),
        LANGFUSE_ENABLED: z.string().optional(),
        LANGFUSE_HOST: z.string().optional(),
        LANGFUSE_PUBLIC_KEY: z.string().optional(),
        LANGFUSE_SECRET_KEY: z.string().optional(),
        LLM_AUDIT: z.string().optional(),
        SKIP_AUDIT_LOGGING: z.string().optional(),

        // Storage
        APP_BUCKET_NAME: z.string().optional(),
        ASSETS_CDN_URL: z.string().optional(),

        // Deep agent / MongoDB / DocumentDB
        MONGODB_URI: z.string().optional(),
        MONGODB_DB_NAME: z.string().optional(),
        DEEP_AGENT_DB_NAME: z.string().optional(),
        DEEP_AGENT_LOG_LEVEL: z.string().optional(),
        DOCDB_ENDPOINT: z.string().optional(),
        DOCDB_PORT: z.string().optional(),
        DOCDB_USERNAME: z.string().optional(),
        DOCDB_PASSWORD: z.string().optional(),

        // Misc runtime
        DATA_DIR: z.string().optional(),

        // Integrations
        SLACK_SIGNING_SECRET: z.string().optional(),
        JIRA_WEBHOOK_SECRET: z.string().optional(),
        JIRA_BASE_URL: z.string().optional(),
        JIRA_USER_EMAIL: z.string().optional(),
        JIRA_API_TOKEN: z.string().optional(),
        DISCORD_PUBLIC_KEY: z.string().optional(),
        TELEGRAM_BOT_TOKEN: z.string().optional(),
        TELEGRAM_SECRET_TOKEN: z.string().optional(),
        WEBHOOK_SECRET: z.string().optional(),

        // Feature flags / misc
        RIGHT_SIZING_ENABLED: z.string().optional(),
        WORKING_MEMORY_ENABLED: z.string().optional(),
        WORKING_MEMORY_TOKEN_BUDGET: z.string().optional(),
        WORKING_MEMORY_KEEP_RECENT: z.string().optional(),
        MEMORY_RECONCILE_ENABLED: z.string().optional(),
        EPISODIC_MEMORY_ENABLED: z.string().optional(),
        PROCEDURAL_MEMORY_ENABLED: z.string().optional(),
        MEMORY_LOG_VERBOSE: z.string().optional(),
        AUTO_SKILL_SELECTION_ENABLED: z.string().optional(),
        AUTO_SKILL_CREATION_ENABLED: z.string().optional(),
        AUTO_SKILL_MATURITY_THRESHOLD: z.string().optional(),
        USE_PG_SCHEDULES: z.string().optional(),
        DUAL_WRITE_SCHEDULES: z.string().optional(),
        INTERNAL_API_KEY: z.string().optional(),
        DEFAULT_TENANT_ID: z.string().optional(),
    },

    /**
     * Client vars — must be prefixed NEXT_PUBLIC_ and listed in runtimeEnv.
     */
    client: {
        NEXT_PUBLIC_AWS_REGION: z.string().optional(),
        NEXT_PUBLIC_HUB_ACCOUNT_ID: z.string().optional(),
        NEXT_PUBLIC_RIGHT_SIZING_ENABLED: z.string().optional(),
        NEXT_PUBLIC_APP_URL: z.string().optional(),
    },

    /**
     * Next.js inlines NEXT_PUBLIC_* at build time, so client vars must be
     * destructured explicitly. With experimental__runtimeEnv, server vars are
     * read from process.env automatically (no need to list each one).
     */
    experimental__runtimeEnv: {
        NEXT_PUBLIC_AWS_REGION: process.env.NEXT_PUBLIC_AWS_REGION,
        NEXT_PUBLIC_HUB_ACCOUNT_ID: process.env.NEXT_PUBLIC_HUB_ACCOUNT_ID,
        NEXT_PUBLIC_RIGHT_SIZING_ENABLED:
            process.env.NEXT_PUBLIC_RIGHT_SIZING_ENABLED,
        NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    },

    /**
     * Skip validation during Docker build / CI where runtime secrets are absent.
     * Also treats empty strings as undefined so `FOO=` behaves like unset.
     */
    /**
     * Skip validation during the Docker build / CI where runtime secrets are
     * absent (SKIP_ENV_VALIDATION), and under Vitest (NODE_ENV==='test'), where
     * tests populate process.env in beforeEach — after module import would have
     * run createEnv(). Also treats empty strings as undefined so `FOO=` is unset.
     */
    skipValidation:
        !!process.env.SKIP_ENV_VALIDATION || process.env.NODE_ENV === 'test',
    emptyStringAsUndefined: true,
});
