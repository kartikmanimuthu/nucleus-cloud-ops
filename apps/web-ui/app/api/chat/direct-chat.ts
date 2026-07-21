import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { NextResponse } from 'next/server';
import { createUIMessageStreamResponse, UIMessageChunk } from 'ai';
import { createAgentModels } from '@/lib/agent/model-factory';
import { buildBaseIdentity } from '@/lib/agent/prompt-templates';
import { contentToText, type ResolvedModelConfig } from '@/lib/agent/agent-shared';

/**
 * direct-chat.ts — the conversational fast path in front of the agent workflow.
 *
 * When triage classifies a message as 'direct' (greeting/thanks/capability
 * question), this responder streams a single plain LLM reply: no graph, no
 * memory recall, no planner, no tools, no plan rail. One small completion —
 * true chatbot latency. The reply renders as a plain answer row in the UI
 * (no phase parts), and both messages persist to chat history so the thread
 * reloads correctly.
 *
 * Continuity note: this exchange bypasses the LangGraph checkpointer, so it
 * enters graph state only when a later task turn starts a fresh graph thread
 * (the client sends full history then). For the conversational content this
 * path handles, that trade-off is intentional.
 */

interface ClientMessage {
    role: string;
    content: string;
    parts?: Array<{ type: string; text: string }>;
}

const DIRECT_HISTORY_WINDOW = 12;

function textOf(m: ClientMessage): string {
    if (typeof m.content === 'string' && m.content) return m.content;
    return m.parts?.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
}

function buildDirectMessages(messages: ClientMessage[]): BaseMessage[] {
    return messages
        .slice(-DIRECT_HISTORY_WINDOW)
        .filter(m => (m.role === 'user' || m.role === 'assistant') && textOf(m).trim())
        .map(m => (m.role === 'user'
            ? new HumanMessage({ content: textOf(m) })
            : new AIMessage({ content: textOf(m) })));
}

function buildDirectSystemPrompt(): SystemMessage {
    return new SystemMessage(`${buildBaseIdentity()}

## Conversational Reply Mode

The user's message is conversational — a greeting, thanks, a question about your capabilities, or something answerable from the conversation itself. Reply naturally and briefly. No tools are available in this mode, and none are needed.

- Be warm and direct; a greeting gets a short greeting back, not a paragraph.
- If asked what you can do: you operate AWS across the tenant's connected accounts — inventory and health checks, incident triage, cost analysis and right-sizing, resource scheduling, log/metric investigation, and recurring scheduled tasks. Invite the user to describe a task in plain language.
- If the message references earlier findings in this conversation, answer from that visible history only — never invent data, resource IDs, or metrics.
- If the request actually needs live data or an action, say you're ready to run it as a task and ask them to confirm or elaborate — do not fabricate results.`);
}

export async function respondDirect(params: {
    messages: ClientMessage[];
    resolvedModel: ResolvedModelConfig;
    threadId: string;
    tenantId: string;
    userId: string;
    stream: boolean;
    releaseLock: () => void;
    signal?: AbortSignal;
}): Promise<Response> {
    const { messages, resolvedModel, threadId, tenantId, userId, stream, releaseLock, signal } = params;

    const history = buildDirectMessages(messages);
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUser ? textOf(lastUser) : '';
    const sessionTitle = userText.slice(0, 60) || 'New Chat';
    const lcInput = [buildDirectSystemPrompt(), ...history];
    const { main: model } = createAgentModels(resolvedModel);

    // Persist the exchange so thread reload shows it (the workflow path persists
    // from graph state; here we bypass the graph, so persist explicitly).
    async function persistExchange(assistantText: string) {
        try {
            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            await chatHistory.addMessages(
                tenantId,
                userId,
                threadId,
                [
                    { role: 'human', content: userText },
                    { role: 'ai', content: assistantText },
                ],
                sessionTitle,
            );
        } catch (e) {
            console.warn('[DirectChat] Failed to persist chat history (non-fatal):', e);
        }
    }

    if (!stream) {
        try {
            const resp = await model.invoke(lcInput, signal ? { signal } : undefined);
            const text = contentToText(resp.content);
            await persistExchange(text);
            return NextResponse.json({ role: 'assistant', content: text });
        } finally {
            releaseLock();
        }
    }

    const uiStream = new ReadableStream<UIMessageChunk>({
        async start(controller) {
            let closed = false;
            const enqueue = (chunk: UIMessageChunk): boolean => {
                if (closed) return false;
                try {
                    controller.enqueue(chunk);
                    return true;
                } catch {
                    closed = true;
                    return false;
                }
            };
            const partId = `direct-${Date.now()}`;
            let fullText = '';
            try {
                enqueue({ type: 'start' });
                enqueue({ type: 'text-start', id: partId });
                const iterator = await model.stream(lcInput, signal ? { signal } : undefined);
                for await (const chunk of iterator) {
                    const delta = contentToText(chunk.content);
                    if (!delta) continue;
                    fullText += delta;
                    if (!enqueue({ type: 'text-delta', id: partId, delta })) break;
                }
                enqueue({ type: 'text-end', id: partId });
                enqueue({ type: 'finish' });
            } catch (err: any) {
                const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''));
                if (aborted) {
                    console.log('[DirectChat] Client aborted — closing stream.');
                } else {
                    console.error('[DirectChat] Stream failed:', err);
                    // Best-effort user-visible error before closing.
                    enqueue({ type: 'text-delta', id: partId, delta: `\n⚠️ Reply failed: ${err?.message ?? 'unknown error'}` });
                    enqueue({ type: 'text-end', id: partId });
                    enqueue({ type: 'finish' });
                }
            } finally {
                if (fullText.trim()) await persistExchange(fullText);
                releaseLock();
                if (!closed) {
                    try { controller.close(); } catch { /* already closed */ }
                }
            }
        },
    });

    return createUIMessageStreamResponse({ stream: uiStream });
}
