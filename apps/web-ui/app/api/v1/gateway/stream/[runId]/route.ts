// web-ui/app/api/v1/gateway/stream/[runId]/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';

export const dynamic = 'force-dynamic';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ runId: string }> },
) {
    const { runId } = await params;

    const session = await getServerSession(authOptions);
    const authHeader = req.headers.get('authorization');
    const apiKey = req.headers.get('x-api-key');

    if (!session && !authHeader && !apiKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const eventBus = getGatewayEventBus();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            const unsubscribe = eventBus.subscribe(runId, (event) => {
                try {
                    const data = JSON.stringify({
                        type: event.type,
                        runId: event.runId,
                        timestamp: event.timestamp.toISOString(),
                        data: event.data,
                    });
                    controller.enqueue(encoder.encode(`data: ${data}\n\n`));

                    if (
                        event.type === 'run:completed' ||
                        event.type === 'run:failed' ||
                        event.type === 'run:cancelled'
                    ) {
                        controller.close();
                        unsubscribe();
                    }
                } catch {
                    unsubscribe();
                }
            });

            req.signal.addEventListener('abort', () => {
                unsubscribe();
                try { controller.close(); } catch { /* already closed */ }
            });
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
