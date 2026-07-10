// workers/src/lib/health.ts
//
// Minimal dependency-free liveness server for the workers ECS task.
//
// The workers service has no ALB in front of it, so a wedged pg-boss supervisor
// (e.g. a DB failover it never recovers from, or a stuck event loop) is invisible
// to ECS — the container stays "running" while every tenant's scheduling,
// discovery, right-sizing and agent-ops crons silently stop. That is the opposite
// of a zero-downtime guarantee.
//
// This exposes an HTTP endpoint that an ECS container health check probes. /health
// is healthy while (a) the boss has finished starting (markReady) and (b) the
// heartbeat is fresh (see startLocalHeartbeat + observability.ts). ECS then
// replaces a task whose heartbeat goes stale — that is our recovery mechanism.
//
// Multi-replica / autoscale note — why the heartbeat is driven locally:
// pg-boss's monitor-states event is a per-database SINGLETON. onMonitor() only
// emits after winning a row lock (trySetMonitorTimeCommand), so across N replicas
// sharing one database exactly one replica emits monitor-states each tick. A
// liveness check driven solely by that event therefore starves every non-leader
// replica's heartbeat → /health goes unhealthy on healthy tasks → ECS kills and
// replaces them → the replacement races the lock again → a ~5min flap cycle that
// leaves you ~1 effective replica. (This was the production symptom on
// desiredCount:2.)
//
// The fix: startLocalHeartbeat() ticks on a per-replica setInterval, advancing the
// heartbeat as long as this replica's own event loop turns over — the real
// "wedged process" signal, independent of the singleton. monitor-states / wip /
// maintenance (observability.ts) still bump the heartbeat as a bonus when they
// fire. DB / supervisor *faults* (as opposed to a wedged loop) are caught
// separately by the boss 'error' tripwire (registerErrorTripwire), which exits the
// process for ECS to restart. So the two failure modes are covered by distinct
// mechanisms and neither depends on holding the singleton monitor lock.

import http from 'node:http';
import { createLogger } from './logger.js';

const log = createLogger('health');

let lastHeartbeat = Date.now();
let ready = false;

/** Called by the monitoring loop each time pg-boss proves it is alive. */
export function heartbeat(): void {
    lastHeartbeat = Date.now();
}

/** Flip to ready once all queues are registered and the boss is started. */
export function markReady(): void {
    ready = true;
    heartbeat();
}

let heartbeatTimer: NodeJS.Timeout | undefined;

/**
 * Start a per-replica local heartbeat on a setInterval, advancing
 * `lastHeartbeat` independently of pg-boss's singleton monitor-states event.
 *
 * This is what makes the liveness check correct across an autoscaled fleet:
 * every replica's heartbeat stays fresh on its own clock, not just the one
 * replica holding the monitor lock (see the module header for the full
 * rationale). A wedged event loop stops the interval → heartbeat goes stale →
 * ECS replaces the task.
 *
 * Idempotent — calling twice replaces the previous timer. The timer is
 * `.unref()`-ed so it never keeps the process alive on its own; callers should
 * `stopLocalHeartbeat()` during graceful shutdown.
 */
export function startLocalHeartbeat(intervalMs: number): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        lastHeartbeat = Date.now();
    }, intervalMs);
    heartbeatTimer.unref?.();
}

/** Stop the local heartbeat interval (graceful shutdown). */
export function stopLocalHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
    }
}

export interface HealthServerOptions {
    port: number;
    /** Max age of the last heartbeat before /health reports unhealthy. */
    stalenessMs: number;
}

export function startHealthServer(opts: HealthServerOptions): http.Server {
    const server = http.createServer((req, res) => {
        const url = req.url ?? '/';

        // Liveness: the process is up and its event loop can serve a request.
        if (url === '/live') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
            return;
        }

        // Health/readiness: the boss is ready and the heartbeat is fresh. The
        // heartbeat is advanced per-replica (startLocalHeartbeat) plus bonus bumps
        // from pg-boss monitor-states / wip / maintenance (observability.ts).
        const age = Date.now() - lastHeartbeat;
        const healthy = ready && age <= opts.stalenessMs;
        res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            status: healthy ? 'ok' : 'unhealthy',
            ready,
            heartbeatAgeMs: age,
            stalenessMs: opts.stalenessMs,
        }));
    });

    server.on('error', (err) => {
        // A health server that cannot bind is itself a fatal condition — surface it.
        log.error('Health server error', { error: err instanceof Error ? err.message : String(err) });
    });

    server.listen(opts.port, () => {
        log.info('Health server listening', { port: opts.port, stalenessMs: opts.stalenessMs });
    });

    return server;
}
