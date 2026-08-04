import { NextResponse } from 'next/server';
import { getCheckpointer } from '@/lib/agent/agent-shared';
import { getChatHistory } from '@/lib/agent/persistence';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { AIMessage, HumanMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { normalizeLegacyContent } from '@/lib/agent-chat/legacy-normalizer';
import { reconstructAiContentParts } from '@/lib/agent-chat/ai-content-parts';
import { dropDuplicateAnswers } from './dedupe-answers';
import { parseUsageMetadata } from '@/lib/agent-chat/token-usage';
import { humanizePlanning, stripWorkingMemoryPrelude } from '@/app/api/chat/stream-parts';

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
        data?: Record<string, unknown>;
    }>;
}

/**
 * Reconstructs the typed parts for one persisted assistant content block
 * (see route.ts's `finally` block, which prefixes stored AI message content
 * with a phase marker via getPhaseMarker() before persistence).
 * normalizeLegacyContent is the sole holder of the marker->phase mapping;
 * this function only decides which typed part shape each phase renders as:
 *  - memory_recall / memory_save -> a data-phase part + a data-memory part
 *    (the new Mission Control UI's memory row), replacing the old reasoning
 *    part reconstruction.
 *  - text (no marker) -> a bare text part — this IS the answer, no phase
 *    context needed.
 *  - final -> a data-phase part + a text part (still the answer, but tagged
 *    with the phase it closed out under).
 *  - planning / execution / reflection / revision -> a data-phase part + a
 *    reasoning part with the stripped text.
 *
 * NOTE (legacy client degradation, accepted for this migration): the legacy
 * chat-interface.tsx still parses phase from a sentinel-prefixed reasoning
 * part's own text (parsePhaseFromContent). Since the text here is already
 * stripped, reloaded threads render those blocks under the generic "text"
 * phase styling (no colored phase banner) in the legacy UI — the new UI
 * (later tasks) reads data-phase instead and is unaffected. Reloaded
 * memory_recall/memory_save blocks go further: the legacy UI does not render
 * data-memory parts at all (only the new UI, via buildTranscript, does), so
 * those blocks disappear entirely from a RELOADED thread in the legacy UI
 * (they were visible, with a phase banner, before this change). Live-streamed
 * memory blocks already dropped from the legacy view when Task 2 switched
 * live memory narration to data-memory-only, so this only affects history
 * replay parity, not new behavior in the live stream.
 */
function buildPhaseParts(content: string): HistoryMessage['parts'] {
    const { phase, text } = normalizeLegacyContent(content);

    if (phase === 'memory_recall' || phase === 'memory_save') {
        return [
            { type: 'data-phase', data: { phase, node: 'history', ts: 0 } },
            { type: 'data-memory', data: { op: phase === 'memory_save' ? 'save' : 'recall', summary: text, count: null } },
        ];
    }
    if (phase === 'text') {
        return [{ type: 'text', text }];
    }
    // Same classification the live stream applies (see route.ts's runMode):
    // execution/final prose streams live as visible TEXT (answers AND
    // inter-tool narration — the Claude-style grammar), so reloads render it
    // as text too; planner/reviser blocks persist the raw JSON plan →
    // humanized reasoning; reflection stays reasoning.
    const isAnswer = phase === 'final' || phase === 'execution';
    return [
        { type: 'data-phase', data: { phase, node: 'history', ts: 0 } },
        isAnswer
            ? { type: 'text', text: stripWorkingMemoryPrelude(text) }
            : { type: 'reasoning', text: phase === 'planning' || phase === 'revision' ? humanizePlanning(text) : text },
    ];
}

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
        const toolCalls = metadata?.tool_calls as Array<{ id?: string; name: string; args: Record<string, unknown> }> | undefined;
        // Content-block arrays (extended-thinking) are reconstructed block-by-block; everything else keeps the marker path.
        const reconstructed = reconstructAiContentParts(msg.content);
        const parts: HistoryMessage['parts'] = reconstructed !== null
            ? [...reconstructed]
            : (content ? [...(buildPhaseParts(content) ?? [])] : []);
        const displayContent = reconstructed !== null
            ? reconstructed.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : content;
        for (const tc of toolCalls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args, state: 'call' });
        }
        const usage = parseUsageMetadata(metadata?.usage_metadata);
        if (usage && parts.length > 0) {
            parts.push({ type: 'data-usage', data: { input: usage.input, output: usage.output } });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content: displayContent, parts };
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
        const reconstructed = reconstructAiContentParts(aiMsg.content);
        const parts: HistoryMessage['parts'] = reconstructed !== null
            ? [...reconstructed]
            : (content ? [...(buildPhaseParts(content) ?? [])] : []);
        const displayContent = reconstructed !== null
            ? reconstructed.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : (content || '');
        for (const tc of aiMsg.tool_calls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args as Record<string, unknown>, state: 'call' });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content: displayContent, parts };
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

/**
 * Coalesce consecutive assistant messages into ONE message per turn.
 *
 * Persistence stores each agent phase block (memory recall, planning,
 * execution, reflection, final answer, …) as its own chat-history row, so a
 * single live turn — which streams as ONE assistant UIMessage with many
 * parts — would otherwise reload as a stack of separate assistant messages,
 * each rendered as its own AgentTurn (own avatar, own "Show work" toggle).
 * Merging the parts back into one message makes a reloaded thread render
 * with the same one-turn-per-run grammar as the live stream.
 */
function coalesceAssistantTurns(messages: HistoryMessage[]): HistoryMessage[] {
    const result: HistoryMessage[] = [];
    for (const msg of messages) {
        const prev = result[result.length - 1];
        if (msg.role === 'assistant' && prev?.role === 'assistant') {
            prev.parts = [...(prev.parts ?? []), ...(msg.parts ?? [])];
            prev.content = [prev.content, msg.content].filter(Boolean).join('\n\n');
        } else {
            result.push({ ...msg, parts: [...(msg.parts ?? [])] });
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
                const channelValues = (checkpoint.checkpoint.channel_values ?? {}) as Partial<import('@/lib/agent/agent-shared').ReflectionState>;
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
                return NextResponse.json({ messages: coalesceAssistantTurns(mergeToolResults(dropDuplicateAnswers(converted))), plan, pendingInterrupt });
            }
        } catch (err) {
            console.warn('[History API] Chat history lookup failed, falling back to checkpoint:', err);
        }

        // Fallback: extract from LangGraph checkpoint (ownership already verified above)
        if (!checkpoint) return NextResponse.json({ messages: [], plan, pendingInterrupt });

        const rawMessages = (checkpoint.checkpoint.channel_values as any)?.messages as BaseMessage[] | undefined;
        if (!rawMessages?.length) return NextResponse.json({ messages: [], plan, pendingInterrupt });

        const converted = rawMessages.map((m, i) => convertMessage(m, i)).filter(Boolean) as HistoryMessage[];
        return NextResponse.json({ messages: coalesceAssistantTurns(mergeToolResults(dropDuplicateAnswers(converted))), plan, pendingInterrupt });
    } catch (error) {
        console.error('[History API] Error:', error);
        return NextResponse.json({ error: 'Failed to fetch conversation history' }, { status: 500 });
    }
}
