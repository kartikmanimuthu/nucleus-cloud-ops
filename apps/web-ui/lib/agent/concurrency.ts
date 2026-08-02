/**
 * Minimal counting semaphore.
 *
 * Once the executor is allowed to emit many tool calls in one turn, ToolNode
 * runs them all concurrently. That is the point — but execute_command spawns a
 * real subprocess per call, so an unbounded 45-call turn would fork 45 shells
 * inside the web-ui container. This bounds that specific blast radius.
 */
export class Semaphore {
    private available: number;
    private readonly waiters: Array<() => void> = [];

    constructor(limit: number) {
        this.available = Math.max(1, Math.floor(limit));
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        // Deliberately NOT `await this.acquire()` here: awaiting any promise —
        // even one already resolved — yields a microtask before continuing, so
        // a caller that finds a free slot would still run `fn` one tick late.
        // Callers (and this file's own tests) rely on a free slot starting
        // `fn` synchronously within the `run()` call.
        if (this.available > 0) {
            this.available--;
        } else {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private release(): void {
        const next = this.waiters.shift();
        if (next) {
            // Hand the slot straight to the next waiter — do not increment, or a
            // third caller could take the slot we just promised away.
            next();
            return;
        }
        this.available++;
    }
}
