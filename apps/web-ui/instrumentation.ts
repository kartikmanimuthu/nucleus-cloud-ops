export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        // Validate environment at server startup (fail-fast). Importing ./env
        // runs @t3-oss/env-nextjs createEnv(), which throws if a required var is
        // missing. Skipped during the Docker build via SKIP_ENV_VALIDATION (no
        // runtime secrets there); enforced when the ECS container boots.
        await import('./env');

        const { initializeScheduler } = await import('./lib/agent-ops/scheduler-engine');
        await initializeScheduler();
    }
}
