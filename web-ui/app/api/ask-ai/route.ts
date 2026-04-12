import { NextRequest, NextResponse } from 'next/server';
import { invokeTextToSQL } from '@/lib/agent/text-to-sql';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import type { Message } from 'ai';

// In-memory conversation store (keyed by conversationId)
// NOTE: single-process only — needs Redis or DB-backed store before horizontal scaling
const conversationStore = new Map<string, Array<{ role: string; content: string }>>();
const MAX_CONVERSATION_TURNS = 10;

export async function POST(req: NextRequest) {
    try {
        // Auth check — every data-reading route requires a session
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const tenantId = (session.user as { activeTenantId?: string }).activeTenantId || 'default';

        const body = await req.json();

        const userMessages: Message[] = body.messages || [];
        const prompt: string = body.prompt || body.query || (userMessages.at(-1)?.content as string) || "";
        const conversationId: string = body.id || body.conversationId || "";
        const filters = body.filters as { accountId?: string; region?: string; resourceType?: string } | undefined;

        console.log("[AskAI] POST request received", {
            promptLength: prompt.length,
            promptPreview: prompt.slice(0, 80),
            conversationId: conversationId.slice(0, 20),
            filters,
            tenantId,
        });

        if (!prompt) {
            return NextResponse.json({ error: "Query is required" }, { status: 400 });
        }

        // Build conversation history
        let conversationHistory: Array<{ role: string; content: string }> = [];
        if (conversationId) {
            conversationHistory = conversationStore.get(conversationId) || [];
        }
        if (userMessages.length > 1) {
            conversationHistory = userMessages.slice(0, -1).map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : '',
            }));
        }
        conversationHistory = conversationHistory.slice(-(MAX_CONVERSATION_TURNS * 2));

        // Map filters from frontend format (accountId singular) to agent format (accountIds array)
        const agentFilters = filters ? {
            accountIds: filters.accountId ? [filters.accountId] : undefined,
            region: filters.region,
            resourceType: filters.resourceType,
        } : undefined;

        // Create SSE stream
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const events = invokeTextToSQL({
                        question: prompt,
                        tenantId,
                        conversationHistory,
                        filters: agentFilters,
                    });

                    let finalAnswer = '';
                    for await (const event of events) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

                        // Capture final answer for conversation store
                        if (event.type === 'token' && typeof event.content === 'string') {
                            finalAnswer += event.content;
                        }
                    }

                    // Store conversation for multi-turn
                    if (conversationId && finalAnswer) {
                        const updated = [
                            ...conversationHistory,
                            { role: 'user', content: prompt },
                            { role: 'assistant', content: finalAnswer },
                        ].slice(-(MAX_CONVERSATION_TURNS * 2));
                        conversationStore.set(conversationId, updated);
                    }
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : 'Internal Server Error';
                    console.error("[AskAI] Stream error:", message);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`));
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        console.error("[AskAI] ERROR:", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
