import { NextResponse } from 'next/server';
import { getCheckpointer } from '@/lib/agent/agent-shared';
import { getChatHistory } from '@/lib/agent/persistence';
import { getSessionUserId } from '@/lib/auth-session';
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
];

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

        // DynamoDB chat history first
        if (process.env.DYNAMODB_CHAT_HISTORY_TABLE) {
            let userId: string;
            try { userId = await getSessionUserId(); } catch {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            try {
                const chatHistory = await getChatHistory();
                const msgs = await chatHistory.getMessages(userId, threadId);
                if (msgs.length > 0) {
                    const converted = msgs.map((m, i) => convertMessage(m, i)).filter(Boolean) as HistoryMessage[];
                    return NextResponse.json({ messages: mergeToolResults(converted) });
                }
            } catch (err) {
                console.warn('[History API] Chat history lookup failed, falling back to checkpoint:', err);
            }
        }

        // Fallback: extract from LangGraph checkpoint
        const checkpointer = await getCheckpointer();
        const checkpoint = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
        if (!checkpoint) return NextResponse.json({ messages: [] });

        const rawMessages = (checkpoint.checkpoint.channel_values as any)?.messages as BaseMessage[] | undefined;
        if (!rawMessages?.length) return NextResponse.json({ messages: [] });

        const converted = rawMessages.map((m, i) => convertMessage(m, i)).filter(Boolean) as HistoryMessage[];
        return NextResponse.json({ messages: mergeToolResults(converted) });
    } catch (error) {
        console.error('[History API] Error:', error);
        return NextResponse.json({ error: 'Failed to fetch conversation history' }, { status: 500 });
    }
}
