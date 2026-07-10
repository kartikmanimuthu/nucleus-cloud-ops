import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
    startHealthServer,
    markReady,
    startLocalHeartbeat,
    stopLocalHeartbeat,
} from './health.js';

/**
 * Regression coverage for the multi-replica liveness flap (see health.ts header):
 * pg-boss monitor-states is a per-database singleton, so a liveness check driven
 * only by that event starves every non-leader replica. The local heartbeat must
 * keep a replica healthy on its own clock, with no monitor-states / wip /
 * maintenance events ever firing — exactly the situation a healthy non-leader
 * replica is in.
 *
 * Real timers (short, with wide margins) rather than fake timers, because the
 * assertion goes through the real HTTP server and mixing fake timers with live
 * I/O is flaky. Total runtime ~1s.
 */

function get(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.on('error', reject);
    });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('health — per-replica local heartbeat', () => {
    const servers: http.Server[] = [];

    afterEach(() => {
        servers.forEach((s) => s.close());
        servers.length = 0;
        stopLocalHeartbeat();
    });

    /** Bind an ephemeral health server; return the actual port. */
    function start(stalenessMs = 200): number {
        const s = startHealthServer({ port: 0, stalenessMs });
        servers.push(s);
        const addr = s.address();
        return typeof addr === 'object' && addr ? addr.port : 0;
    }

    it('stays healthy on the local heartbeat alone (non-leader replica: no monitor-states)', async () => {
        const port = start(200);
        markReady();
        // Local heartbeat ONLY — never call the monitor-states / wip / maintenance
        // path. This is the non-leader replica that lost the singleton lock.
        startLocalHeartbeat(50);
        // Wait well past the 200ms staleness window; the local timer keeps it fresh.
        await wait(350);
        const res = await get(port, '/health');
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).status).toBe('ok');
    });

    it('goes unhealthy once the local heartbeat stops (simulated wedge)', async () => {
        const port = start(200);
        markReady();
        startLocalHeartbeat(50);
        await wait(150); // healthy while ticking
        stopLocalHeartbeat();
        await wait(350); // now stale → unhealthy
        const res = await get(port, '/health');
        expect(res.status).toBe(503);
        expect(JSON.parse(res.body).status).toBe('unhealthy');
    });

    it('/live is always 200 once the process is up', async () => {
        const port = start(200);
        const res = await get(port, '/live');
        expect(res.status).toBe(200);
        expect(res.body).toBe('ok');
    });
});