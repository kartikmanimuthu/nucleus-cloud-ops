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
// This exposes an HTTP endpoint that an ECS container health check probes. It goes
// unhealthy when the pg-boss monitoring loop stops emitting (see observability.ts,
// which calls heartbeat() on every monitor-states tick) — proving the supervisor
// is alive end-to-end, not merely that the process exists. ECS then replaces the
// task, which is our recovery mechanism.

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

        // Health/readiness: the pg-boss supervisor loop is actively ticking.
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
