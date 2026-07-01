// Working-memory configuration. Read process.env directly (not the typed `env`
// object) so Vitest can mutate values per-test — env.ts skips validation under
// NODE_ENV==='test' but caches at import time.
export function workingMemoryEnabled(): boolean {
    const v = process.env.WORKING_MEMORY_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export function tokenBudget(): number {
    const n = Number(process.env.WORKING_MEMORY_TOKEN_BUDGET);
    return Number.isFinite(n) && n > 0 ? n : 60000;
}

export function keepRecent(): number {
    const n = Number(process.env.WORKING_MEMORY_KEEP_RECENT);
    return Number.isFinite(n) && n > 0 ? n : 8;
}
