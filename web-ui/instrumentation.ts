export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { initializeScheduler } = await import('./lib/agent-ops/scheduler-engine');
        await initializeScheduler();
    }
}
