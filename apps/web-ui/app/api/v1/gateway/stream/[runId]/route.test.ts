import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/gateway/event-bus', () => ({ getGatewayEventBus: vi.fn() }));

import { getServerSession } from 'next-auth';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';
import { GET } from './route';

const makeParams = (runId: string) => ({ params: Promise.resolve({ runId }) });

function makeRequest(headers: Record<string, string> = {}) {
    const controller = new AbortController();
    return {
        headers: { get: (k: string) => headers[k] ?? null },
        signal: controller.signal,
        abort: () => controller.abort(),
    } as any;
}

async function readSSE(res: Response, limit = 1): Promise<string[]> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (let i = 0; i < limit; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
    }
    await reader.cancel().catch(() => {});
    return chunks;
}

describe('GET /api/v1/gateway/stream/[runId]', () => {
    let subscribe: ReturnType<typeof vi.fn>;
    let unsubscribe: ReturnType<typeof vi.fn>;
    let handler: (event: any) => void;

    beforeEach(() => {
        vi.clearAllMocks();
        unsubscribe = vi.fn();
        subscribe = vi.fn((_runId: string, cb: (event: any) => void) => {
            handler = cb;
            return unsubscribe;
        });
        vi.mocked(getGatewayEventBus).mockReturnValue({ subscribe } as any);
        vi.mocked(getServerSession).mockResolvedValue(null as any);
    });

    it('returns 401 when there is no session, auth header, or api key', async () => {
        const res = await GET(makeRequest(), makeParams('run-1'));
        expect(res.status).toBe(401);
    });

    it('allows a request authenticated by session', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        const res = await GET(makeRequest(), makeParams('run-1'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('allows a request authenticated by an x-api-key header', async () => {
        const res = await GET(makeRequest({ 'x-api-key': 'k' }), makeParams('run-1'));
        expect(res.status).toBe(200);
    });

    it('subscribes to the event bus for the given runId and streams events as SSE', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);
        const res = await GET(makeRequest(), makeParams('run-1'));

        expect(subscribe).toHaveBeenCalledWith('run-1', expect.any(Function));

        handler({ type: 'run:progress', runId: 'run-1', timestamp: new Date('2026-01-01T00:00:00Z'), data: { pct: 50 } });
        const [chunk] = await readSSE(res, 1);
        expect(chunk).toContain('"type":"run:progress"');
        expect(chunk).toContain('"pct":50');
    });

    it('closes the stream and unsubscribes when a terminal event arrives', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);
        const res = await GET(makeRequest(), makeParams('run-1'));

        handler({ type: 'run:completed', runId: 'run-1', timestamp: new Date(), data: {} });
        await res.text();
        expect(unsubscribe).toHaveBeenCalled();
    });

    it('unsubscribes and closes when the client disconnects', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);
        const req = makeRequest();
        await GET(req, makeParams('run-1'));

        req.abort();
        expect(unsubscribe).toHaveBeenCalled();
    });
});
