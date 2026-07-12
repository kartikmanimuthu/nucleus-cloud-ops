import { NextResponse } from 'next/server';
import { getCheckpointer } from '@/lib/agent/agent-shared';
import { getChatHistory } from '@/lib/agent/persistence';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { AIMessage, HumanMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';

interface HistoryMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    parts?: Array<{
        type: string;
        text?: string;
        toolCallId?: string;
        toolName?: string;
        args?: Record<string, unknown>;
        result?: string;
        state?: 'call' | 'result';
    }>;
}

// Phase markers written by processStream before persistence — must match route.ts getPhaseMarker()
const PHASE_MARKERS = [
    'PLANNING_PHASE_START\n',
    'EXECUTION_PHASE_START\n',
    'REFLECTION_PHASE_START\n',
    'REVISION_PHASE_START\n',
    'FINAL_PHASE_START\n',
    'MEMORY_RECALL_PHASE_START\n',
    'MEMORY_SAVE_PHASE_START\n',
];

/**
 * Multimodal user turns are persisted as a JSON-encoded LangChain content array
 * (e.g. `[{"type":"text",...},{"type":"image_url",...}]`). Rendering that raw
 * string shows a literal JSON blob. Extract the human-readable text so the UI
 * shows the prompt; image parts are not reconstructed on reload (attachments are
 * not persisted separately) — a known limitation, but far better than raw JSON.
 */
function extractDisplayText(content: string): string {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            const texts = parsed
                .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text as string);
            const hasImage = parsed.some((p) => p && typeof p === 'object' && (p.type === 'image_url' || p.type === 'image'));
            const joined = texts.join('');
            if (joined || hasImage) return hasImage ? `${joined}${joined ? '\n\n' : ''}🖼️ [image attachment]` : joined;
        }
    } catch {
        // Not JSON — fall through and return the original content.
    }
    return content;
}

function convertPlainMessage(msg: { role: string; content: string; metadata?: Record<string, unknown> }, index: number): HistoryMessage | null {
    const { role, metadata } = msg;
    const content = (role === 'human' || role === 'ai') ? extractDisplayText(msg.content) : msg.content;
    if (!content && role !== 'ai') return null;

    if (role === 'human') {
        return { id: `history-${index}`, role: 'user', content, parts: [{ type: 'text', text: content }] };
    }
    if (role === 'ai') {
        const hasPhaseMarker = PHASE_MARKERS.some(m => content.startsWith(m));
        const parts: HistoryMessage['parts'] = content
            ? [{ type: hasPhaseMarker ? 'reasoning' : 'text', text: content }]
            : [];
        const toolCalls = metadata?.tool_calls as Array<{ id?: string; name: string; args: Record<string, unknown> }> | undefined;
        for (const tc of toolCalls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args, state: 'call' });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content, parts };
    }
    if (role === 'tool') {
        const toolCallId = metadata?.tool_call_id as string | undefined;
        return { id: `history-${index}`, role: 'tool', content, parts: [{ type: 'tool-invocation', toolCallId, result: content, state: 'result' }] };
    }
    return null;
}

function convertMessage(msg: BaseMessage, index: number): HistoryMessage | null {
    const msgType = msg._getType();
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (!content && msgType !== 'ai') return null;

    if (msgType === 'human') {
        return { id: `history-${index}`, role: 'user', content, parts: [{ type: 'text', text: content }] };
    }
    if (msgType === 'ai') {
        const aiMsg = msg as AIMessage;
        const parts: HistoryMessage['parts'] = [];
        if (content) {
            // If the content was annotated with a phase marker before saving, reconstruct
            // it as a reasoning part so the UI renders phase headers on history load.
            const hasPhaseMarker = PHASE_MARKERS.some(m => content.startsWith(m));
            parts.push({ type: hasPhaseMarker ? 'reasoning' : 'text', text: content });
        }
        for (const tc of aiMsg.tool_calls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args as Record<string, unknown>, state: 'call' });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content: content || '', parts };
    }
    if (msgType === 'tool') {
        const toolMsg = msg as ToolMessage;
        return { id: `history-${index}`, role: 'tool', content, parts: [{ type: 'tool-invocation', toolCallId: toolMsg.tool_call_id, result: content, state: 'result' }] };
    }
    return null;
}

function mergeToolResults(messages: HistoryMessage[]): HistoryMessage[] {
    const result: HistoryMessage[] = [];
    let i = 0;
    while (i < messages.length) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.parts) {
            const cloned = { ...msg, parts: [...msg.parts] };
            let j = i + 1;
            while (j < messages.length && messages[j].role === 'tool') {
                const toolResult = messages[j].parts?.find((p) => p.state === 'result');
                if (toolResult?.toolCallId) {
                    const match = cloned.parts?.find((p) => p.type === 'tool-invocation' && p.toolCallId === toolResult.toolCallId);
                    if (match) { match.result = toolResult.result; match.state = 'result'; }
                }
                j++;
            }
            result.push(cloned);
            i = j;
        } else if (msg.role !== 'tool') {
            result.push(msg);
            i++;
        } else {
            i++;
        }
    }
    return result;
}

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ threadId: string }> }
) {
    try {
        const { threadId } = await params;
        if (!threadId) return NextResponse.json({ error: 'Thread ID is required' }, { status: 400 });

        let sessionUserId: string;
        let sessionTenantId: string;
        try {
            sessionUserId = await getSessionUserId();
            sessionTenantId = await getSessionTenantId();
        } catch {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Reject namespaced threads whose embedded tenant segment isn't ours.
        if (threadId.includes(':')) {
            const [embeddedTenantId] = threadId.split(':');
            if (embeddedTenantId !== sessionTenantId) {
                return NextResponse.json({ error: 'Forbidden: thread belongs to another tenant' }, { status: 403 });
            }
        }

        // Tenant-scoped ownership gate. This guards BOTH the chat-history read and
        // the checkpoint fallback below: PostgresSaver checkpoints are keyed only by
        // thread_id (no tenant column), so without this a request could otherwise
        // read another tenant's checkpoint via a guessable bare/un-namespaced ID.
        // Chat sessions are seeded eagerly at chat start, so any thread with history
        // has a ChatSession row; a thread absent from this tenant returns empty.
        {
            const { threadStore } = await import('@/lib/store/thread-store');
            const owned = await threadStore.getThread(threadId, sessionTenantId);
            if (!owned) return NextResponse.json({ messages: [] });
        }

        // Fetch the checkpoint tuple once — used both for the live run state
        // (plan + parked interrupt) and, if chat history is empty, as the
        // message-history fallback below. Non-fatal: a checkpointer error here
        // must not prevent the chat-history path from still answering.
        let checkpoint: Awaited<ReturnType<Awaited<ReturnType<typeof getCheckpointer>>['getTuple']>> | null = null;
        let plan: import('../run-state').ThreadRunState['plan'] = null;
        let pendingInterrupt: import('../run-state').ThreadRunState['pendingInterrupt'] = null;
        try {
            const checkpointer = await getCheckpointer();
            checkpoint = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
            if (checkpoint?.checkpoint) {
                const { extractThreadRunState } = await import('../run-state');
                const channelValues = (checkpoint.checkpoint.channel_values ?? {}) as any;
                const rs = extractThreadRunState(channelValues, threadId);
                plan = rs.plan;
                pendingInterrupt = rs.pendingInterrupt;
            }
        } catch (err) {
            console.warn('[History API] run-state extraction failed (non-fatal):', err);
        }

        // Chat history lookup (tenant-scoped; intra-tenant chats are shared by design)
        try {
            const chatHistory = await getChatHistory();
            const msgs = await chatHistory.getMessages(sessionTenantId, sessionUserId, threadId);
            if (msgs.length > 0) {
                const converted = msgs.map((m, i) => convertPlainMessage(m, i)).filter(Boolean) as HistoryMessage[];
                return NextResponse.json({ messages: mergeToolResults(converted), plan, pendingInterrupt });
            }
        } catch (err) {
            console.warn('[History API] Chat history lookup failed, falling back to checkpoint:', err);
        }

        // Fallback: extract from LangGraph checkpoint (ownership already verified above)
        if (!checkpoint) return NextResponse.json({ messages: [], plan, pendingInterrupt });

        const rawMessages = (checkpoint.checkpoint.channel_values as any)?.messages as BaseMessage[] | undefined;
        if (!rawMessages?.length) return NextResponse.json({ messages: [], plan, pendingInterrupt });

        const converted = rawMessages.map((m, i) => convertMessage(m, i)).filter(Boolean) as HistoryMessage[];
        return NextResponse.json({ messages: mergeToolResults(converted), plan, pendingInterrupt });
    } catch (error) {
        console.error('[History API] Error:', error);
        return NextResponse.json({ error: 'Failed to fetch conversation history' }, { status: 500 });
    }
}
