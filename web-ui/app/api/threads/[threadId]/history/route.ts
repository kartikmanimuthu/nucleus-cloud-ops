import { NextResponse } from 'next/server';
import { getCheckpointer } from '@/lib/agent/agent-shared';
import { AIMessage, HumanMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import * as agentStore from '@/lib/db/agent-chat-history-store';

interface HistoryMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    parts?: Array<{
        type: 'text' | 'tool-invocation';
        text?: string;
        toolCallId?: string;
        toolName?: string;
        args?: Record<string, unknown>;
        result?: string;
        state?: 'call' | 'result';
    }>;
}

/**
 * Convert LangGraph BaseMessage to AI SDK compatible format
 */
function convertMessage(msg: BaseMessage, index: number): HistoryMessage | null {
    const msgType = msg._getType();
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    // Skip empty messages
    if (!content && msgType !== 'ai') {
        return null;
    }

    if (msgType === 'human') {
        return {
            id: `history-${index}`,
            role: 'user',
            content: content,
            parts: [{ type: 'text', text: content }]
        };
    }

    if (msgType === 'ai') {
        const aiMsg = msg as AIMessage;
        const parts: HistoryMessage['parts'] = [];

        // Add text content if present
        if (content) {
            parts.push({ type: 'text', text: content });
        }

        // Add tool calls if present
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
            for (const toolCall of aiMsg.tool_calls) {
                parts.push({
                    type: 'tool-invocation',
                    toolCallId: toolCall.id || `tool-${index}-${toolCall.name}`,
                    toolName: toolCall.name,
                    args: toolCall.args as Record<string, unknown>,
                    state: 'call'
                });
            }
        }

        // Skip if no content and no tool calls
        if (parts.length === 0) {
            return null;
        }

        return {
            id: `history-${index}`,
            role: 'assistant',
            content: content || '',
            parts
        };
    }

    if (msgType === 'tool') {
        const toolMsg = msg as ToolMessage;
        return {
            id: `history-${index}`,
            role: 'tool' as const,
            content: content,
            parts: [{
                type: 'tool-invocation',
                toolCallId: toolMsg.tool_call_id,
                result: content,
                state: 'result'
            }]
        };
    }

    return null;
}

/**
 * GET /api/threads/[threadId]/history
 * Retrieves the conversation history for a given thread.
 * MongoDB-first: tries agent_threads collection, falls back to LangGraph checkpoint.
 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> }
) {
    try {
        const { threadId } = await params;

        if (!threadId) {
            return NextResponse.json({ error: 'Thread ID is required' }, { status: 400 });
        }

        console.log(`[History API] Fetching history for thread: ${threadId}`);

        // MongoDB-first: try loading from agent_threads collection
        if (process.env.MONGODB_URI) {
            try {
                const thread = await agentStore.getThread(threadId);
                if (thread && thread.messages.length > 0) {
                    console.log(`[History API] Loaded ${thread.messages.length} messages from MongoDB for thread: ${threadId}`);
                    return NextResponse.json({ messages: thread.messages });
                }
            } catch (err) {
                console.warn(`[History API] MongoDB lookup failed, falling back to checkpoint:`, err);
            }
        }

        // Fallback: extract from LangGraph checkpoint
        const checkpointer = await getCheckpointer();
        const config = { configurable: { thread_id: threadId } };
        const checkpoint = await checkpointer.getTuple(config);

        if (!checkpoint) {
            console.log(`[History API] No checkpoint found for thread: ${threadId}`);
            return NextResponse.json({ messages: [] });
        }

        // Extract messages from checkpoint state
        const state = checkpoint.checkpoint;
        const channelValues = state.channel_values as Record<string, unknown>;
        const rawMessages = channelValues?.messages as BaseMessage[] | undefined;

        if (!rawMessages || rawMessages.length === 0) {
            console.log(`[History API] No messages in checkpoint for thread: ${threadId}`);
            return NextResponse.json({ messages: [] });
        }

        console.log(`[History API] Found ${rawMessages.length} raw messages for thread: ${threadId}`);

        // Convert to AI SDK format, filtering out nulls
        const messages: HistoryMessage[] = [];
        for (let i = 0; i < rawMessages.length; i++) {
            const converted = convertMessage(rawMessages[i], i);
            if (converted) {
                messages.push(converted);
            }
        }

        // Merge consecutive tool results into their corresponding AI messages
        const mergedMessages = mergeToolResults(messages);

        console.log(`[History API] Returning ${mergedMessages.length} processed messages for thread: ${threadId}`);

        return NextResponse.json({ messages: mergedMessages });
    } catch (error) {
        console.error('[History API] Error fetching history:', error);
        return NextResponse.json(
            { error: 'Failed to fetch conversation history' },
            { status: 500 }
        );
    }
}

/**
 * Merge tool result messages into their corresponding AI message's tool-invocation parts
 * This creates a cleaner UI representation matching how new conversations display
 */
function mergeToolResults(messages: HistoryMessage[]): HistoryMessage[] {
    const result: HistoryMessage[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i];

        if (msg.role === 'assistant' && msg.parts) {
            // Clone the message to avoid mutation
            const clonedMsg = { ...msg, parts: [...msg.parts] };

            // Look ahead for tool messages that match our tool calls
            let j = i + 1;
            while (j < messages.length && messages[j].role === 'tool') {
                const toolMsg = messages[j];
                const toolResult = toolMsg.parts?.find(p => p.state === 'result');

                if (toolResult && toolResult.toolCallId) {
                    // Find the matching tool call in our parts and add the result
                    const matchingPart = clonedMsg.parts?.find(
                        p => p.type === 'tool-invocation' && p.toolCallId === toolResult.toolCallId
                    );
                    if (matchingPart) {
                        matchingPart.result = toolResult.result;
                        matchingPart.state = 'result';
                    }
                }
                j++;
            }

            result.push(clonedMsg);
            i = j; // Skip the tool messages we've processed
        } else if (msg.role !== 'tool') {
            // Add non-tool messages directly (user messages, etc.)
            result.push(msg);
            i++;
        } else {
            // Skip orphan tool messages (shouldn't happen but handle gracefully)
            i++;
        }
    }

    return result;
}
