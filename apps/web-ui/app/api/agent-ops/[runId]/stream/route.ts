/**
 * Agent Ops — Run Event Stream (SSE)
 *
 * GET /api/agent-ops/[runId]/stream
 *
 * DB-backed: polls the event log server-side and pushes frames, so it works
 * regardless of which ECS replica is executing the run (the in-process event
 * bus is not replica-safe). Closes itself on terminal run status.
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'AgentOps' },
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_MS = 1500;
const HEARTBEAT_MS = 15_000;
const MAX_LIFETIME_MS = 15 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export async function GET(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    const { runId } = await params;

    let tenantId: string;
    try {
        tenantId = await getSessionTenantId();
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const initialRun = await agentOpsService.getRun(tenantId, runId);
    if (!initialRun) {
        return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const encoder = new TextEncoder();
    const signal = (req as { signal?: AbortSignal }).signal;

    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: string, data: unknown) =>
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            const startedAt = Date.now();
            let lastBeat = Date.now();
            let cursor = 0;
            let lastStatusJson = '';

            try {
                for (;;) {
                    if (signal?.aborted || Date.now() - startedAt > MAX_LIFETIME_MS) break;

                    const [run, events] = await Promise.all([
                        agentOpsService.getRun(tenantId, runId),
                        agentOpsService.getRunEvents(runId, tenantId),
                    ]);

                    for (; cursor < events.length; cursor++) {
                        send('run-event', events[cursor]);
                    }

                    if (run) {
                        const statusJson = JSON.stringify({ s: run.status, r: run.result, e: run.error });
                        if (statusJson !== lastStatusJson) {
                            lastStatusJson = statusJson;
                            send('status', run);
                        }
                        if (TERMINAL.has(run.status)) break;
                    }

                    if (Date.now() - lastBeat > HEARTBEAT_MS) {
                        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
                        lastBeat = Date.now();
                    }
                    await new Promise(r => setTimeout(r, POLL_MS));
                }
            } catch (err) {
                console.error('[Agent Ops API] Stream error:', err);
            } finally {
                try { controller.close(); } catch { /* already closed */ }
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
