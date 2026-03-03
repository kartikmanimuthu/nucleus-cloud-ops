/**
 * Run Manager — AbortController registry for Agent Ops background jobs.
 *
 * Provides cancel/interrupt capability for in-flight runs.
 * Singleton scoped to the Node.js process (survives across requests).
 */

const g = globalThis as typeof globalThis & {
    _agentOpsRunRegistry?: Map<string, AbortController>;
};

function getRegistry(): Map<string, AbortController> {
    if (!g._agentOpsRunRegistry) {
        g._agentOpsRunRegistry = new Map();
    }
    return g._agentOpsRunRegistry;
}

/** Register a new run and return its AbortController. */
export function registerRun(runId: string): AbortController {
    const controller = new AbortController();
    getRegistry().set(runId, controller);
    return controller;
}

/** Cancel a run by runId. Returns true if the run was found and cancelled. */
export function cancelRun(runId: string): boolean {
    const controller = getRegistry().get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
}

/** Check if a run has been aborted. */
export function isAborted(runId: string): boolean {
    return getRegistry().get(runId)?.signal.aborted ?? false;
}

/** Remove a run from the registry (call in finally block). */
export function cleanupRun(runId: string): void {
    getRegistry().delete(runId);
}

/** List all currently registered (active) run IDs. */
export function getActiveRunIds(): string[] {
    return Array.from(getRegistry().keys());
}
