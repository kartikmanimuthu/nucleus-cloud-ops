import { describe, it, expect, vi } from 'vitest';

const { mockGetRun, mockGetRunEvents } = vi.hoisted(() => ({
    mockGetRun: vi.fn(),
    mockGetRunEvents: vi.fn(),
}));

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: mockGetRun, getRunEvents: mockGetRunEvents },
}));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('t1'),
}));

import { GET } from '../../app/api/agent-ops/[runId]/stream/route';

async function readAll(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
    }
    return out;
}

describe('GET /api/agent-ops/[runId]/stream', () => {
    it('streams events then closes on terminal status', async () => {
        const run = { runId: 'r1', tenantId: 't1', status: 'completed' };
        const events = [
            { SK: 'EVENT#1#0', runId: 'r1', eventType: 'planning', node: '__start__', createdAt: 'x' },
            { SK: 'EVENT#2#0', runId: 'r1', eventType: 'final', node: '__end__', createdAt: 'y' },
        ];
        mockGetRun.mockResolvedValue(run);
        mockGetRunEvents.mockResolvedValue(events);

        const req = new Request('http://test/api/agent-ops/r1/stream');
        const res = await GET(req as never, { params: Promise.resolve({ runId: 'r1' }) });

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        const body = await readAll(res);          // resolves ⇒ stream closed (terminal)
        expect(body).toContain('event: run-event');
        expect(body).toContain('EVENT#1#0');
        expect(body).toContain('EVENT#2#0');
        expect(body).toContain('event: status');
        expect(body).toContain('"status":"completed"');
    });

    it('404s when the run does not exist', async () => {
        mockGetRun.mockResolvedValue(null);
        const req = new Request('http://test/api/agent-ops/r0/stream');
        const res = await GET(req as never, { params: Promise.resolve({ runId: 'r0' }) });
        expect(res.status).toBe(404);
    });
});
