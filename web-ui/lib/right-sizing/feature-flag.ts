/**
 * RIGHT_SIZING_ENABLED feature flag (RS-003).
 *
 * Gates the Right Sizing module's nav entry, API routes, and worker scheduling.
 * Env-driven, following the platform convention (cf. USE_PG_SCHEDULES).
 *
 * The same env var is read directly by the workers package
 * (process.env.RIGHT_SIZING_ENABLED === 'true') so both runtimes agree.
 */
export function isRightSizingEnabled(): boolean {
    return process.env.RIGHT_SIZING_ENABLED === 'true';
}

/** Server-side convenience: also exposed to client via NEXT_PUBLIC_ variant when set. */
export function isRightSizingEnabledPublic(): boolean {
    return (
        process.env.RIGHT_SIZING_ENABLED === 'true' ||
        process.env.NEXT_PUBLIC_RIGHT_SIZING_ENABLED === 'true'
    );
}
