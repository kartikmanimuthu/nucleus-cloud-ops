// ============================================================================
// Deep Agent Module — Chat API Route
// POST /api/deep-agent/chat
//
// Handles:
//  1. New message: creates/resumes graph, streams events with subgraph support
//  2. HITL resume: receives decisions from approval dialog, resumes execution
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { Command } from '@langchain/langgraph';
import { v4 as uuidv4 } from 'uuid';
import { createDeepAgentGraph } from '../../../../lib/deep-agent/deep-agent-graph';
import {
    createThread,
    getThread,
    appendMessage,
    upsertTodos,
    updateThread,
} from '../../../../lib/deep-agent/db/chat-history-store';
import type {
    DeepAgentChatRequest,
    DeepAgentMessage,
    TodoItem,
    SubagentEvent,
} from '../../../../lib/deep-agent/types';
import { createLogger } from '../../../../lib/deep-agent/logger';

const log = createLogger('ChatRoute');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return JSON.stringify(value);
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((c: any) => c?.text ?? c?.content ?? '')
            .filter(Boolean)
            .join('');
    }
    return '';
}

// Truncate large tool outputs for streaming to avoid UI hangs
const MAX_TOOL_OUTPUT = 8000;
function truncateToolOutput(text: string): string {
    if (text.length > MAX_TOOL_OUTPUT) {
        return `${text.slice(0, MAX_TOOL_OUTPUT)}\n...[truncated — ${text.length} total chars]`;
    }
    return text;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
    let body: DeepAgentChatRequest;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { threadId: reqThreadId, message, config, resume } = body;

    if (!config) {
        return NextResponse.json({ error: 'config is required' }, { status: 400 });
    }

    const threadId = reqThreadId || uuidv4();
    const graphConfig = { configurable: { thread_id: threadId } };

    log.info('POST /api/deep-agent/chat', {
        threadId,
        isResume: !!resume,
        message: message ? `${message.slice(0, 80)}${message.length > 80 ? '…' : ''}` : '(none)',
        model: config.model,
        autoApprove: config.autoApprove,
        mcpServerIds: config.mcpServerIds ?? [],
    });

    // --- Ensure thread exists in MongoDB ---
    let existingThread = await getThread(threadId);
    if (!existingThread) {
        await createThread(
            threadId,
            message?.slice(0, 80) || 'New conversation',
            config.model,
        );
    }

    // --- Persist user message ---
    if (message && !resume) {
        const userMsg: DeepAgentMessage = {
            id: uuidv4(),
            role: 'user',
            content: message,
            timestamp: new Date().toISOString(),
        };
        await appendMessage(threadId, userMsg);
    }

    // --- Create the deep agent graph ---
    let agent: Awaited<ReturnType<typeof createDeepAgentGraph>>['agent'];
    let skillFiles: Awaited<ReturnType<typeof createDeepAgentGraph>>['skillFiles'];
    try {
        log.info('Creating DeepAgent graph...', { threadId });
        const result = await createDeepAgentGraph(config);
        agent = result.agent;
        skillFiles = result.skillFiles;
        log.info('DeepAgent graph created', { threadId, skillFiles: Object.keys(skillFiles) });
    } catch (err: any) {
        log.error('Graph creation failed', { threadId, error: err.message, stack: err.stack });
        console.error('[DeepAgent] Graph creation error:', err);
        return NextResponse.json({ error: `Agent creation failed: ${err.message}` }, { status: 500 });
    }

    // ---------------------------------------------------------------------------
    // Streaming response
    // ---------------------------------------------------------------------------

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;

    function enqueue(event: string, data: unknown): void {
        try {
            const payload = `data: ${JSON.stringify({ event, data })}\n\n`;
            controller?.enqueue(encoder.encode(payload));
        } catch {
            /* client disconnected */
        }
    }

    const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
            controller = ctrl;

            try {
                // Build invoke input
                let invokeInput: unknown;
                if (resume) {
                    invokeInput = new Command({ resume: { decisions: resume.decisions } });
                } else {
                    invokeInput = {
                        messages: [{ role: 'user', content: message }],
                        // Seed skill files into the virtual filesystem
                        ...(Object.keys(skillFiles).length > 0 ? { files: skillFiles } : {}),
                    };
                }

                // --- Stream with subgraph support ---
                log.info('Starting agent stream', {
                    threadId,
                    isResume: !!resume,
                    streamMode: 'updates',
                    subgraphs: true,
                });

                const graphStream = await agent.stream(invokeInput as any, {
                    ...graphConfig,
                    streamMode: 'updates',
                    subgraphs: true,
                } as any);

                const assistantId = uuidv4();
                const subagentEvents: SubagentEvent[] = [];
                let accumulatedText = '';
                let todos: TodoItem[] = [];
                let chunkCount = 0;

                // Map LangGraph internal namespace key → outer Anthropic tool-use ID.
                // LangGraph assigns its own UUIDs to subgraph invocations that differ from
                // the Anthropic tool_call_id used when the main agent dispatched the subagent.
                // We resolve this by associating the first namespace chunk we see from each
                // subgraph with the oldest pending outer tool call ID (FIFO order).
                const namespaceToOuterId = new Map<string, string>();
                const pendingSubagentIds: string[] = [];

                for await (const [namespace, chunk] of graphStream as any) {
                    chunkCount++;
                    const isSubagent = Array.isArray(namespace) && namespace.length > 0;

                    log.debug('Stream chunk received', {
                        threadId,
                        chunkIndex: chunkCount,
                        isSubagent,
                        namespace: isSubagent ? namespace : '(main)',
                        keys: Object.keys(chunk || {}),
                    });

                    if (isSubagent) {
                        // Resolve namespace → outer tool call ID
                        const nsKey = (namespace as string[]).join('|');
                        if (!namespaceToOuterId.has(nsKey) && pendingSubagentIds.length > 0) {
                            namespaceToOuterId.set(nsKey, pendingSubagentIds.shift()!);
                        }
                        const resolvedId = namespaceToOuterId.get(nsKey) ?? nsKey;

                        const chunkKeys = Object.keys(chunk || {});

                        for (const key of chunkKeys) {
                            const nodeData = (chunk as any)[key];

                            // Subagent text delta (call_model node)
                            if (key === 'call_model' && nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    if (msg?.content) {
                                        const text = extractText(msg.content);
                                        if (text) {
                                            log.debug('Subagent text delta', { threadId, resolvedId, textLen: text.length });
                                            enqueue('subagent-delta', { toolCallId: resolvedId, text });
                                        }
                                    }
                                }
                            }

                            // Subagent tool results (tools node)
                            if (key === 'tools' && nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    const toolName = msg?.name || 'tool';
                                    const content = extractText(msg?.content);
                                    log.info('Subagent tool result', { threadId, resolvedId, toolName, resultLen: content.length });
                                    enqueue('subagent-tool', {
                                        toolCallId: resolvedId,
                                        toolName,
                                        result: truncateToolOutput(content),
                                    });
                                }
                            }
                        }
                    } else {
                        // Main agent events
                        const chunkKeys = Object.keys(chunk || {});

                        for (const key of chunkKeys) {
                            const nodeData = (chunk as any)[key];

                            // __interrupt__ — HITL approval required
                            if (key === '__interrupt__' || chunk?.__interrupt__) {
                                const interrupts =
                                    chunk?.__interrupt__?.[0]?.value ?? nodeData?.[0]?.value;
                                if (interrupts) {
                                    log.info('HITL interrupt — approval required', {
                                        threadId,
                                        toolCount: interrupts.actionRequests?.length ?? 0,
                                        tools: interrupts.actionRequests?.map((r: any) => r.name),
                                    });
                                    enqueue('approval-required', {
                                        threadId,
                                        actionRequests: interrupts.actionRequests,
                                        reviewConfigs: interrupts.reviewConfigs,
                                        timestamp: new Date().toISOString(),
                                    });
                                }
                                continue;
                            }

                            // Main agent output
                            if (nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    if (!msg) continue;

                                    // Text delta
                                    const text = extractText(msg.content);
                                    if (text) {
                                        accumulatedText += text;
                                        enqueue('text-delta', { text });
                                    }

                                    // Tool calls (task delegations to subagents)
                                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                                        for (const tc of msg.tool_calls) {
                                            const isSubagentCall =
                                                tc.name === 'task' ||
                                                ['aws-ops', 'research', 'code-iac'].some(n =>
                                                    tc.name?.includes(n),
                                                );

                                            if (isSubagentCall) {
                                                const evt: SubagentEvent = {
                                                    id: tc.id || uuidv4(),
                                                    name: tc.args?.subagent_type || tc.name,
                                                    description: tc.args?.description || tc.args?.task || '',
                                                    status: 'pending',
                                                    startedAt: new Date().toISOString(),
                                                };
                                                log.info('Subagent dispatched', {
                                                    threadId,
                                                    subagentName: evt.name,
                                                    toolCallId: evt.id,
                                                    description: evt.description?.slice(0, 120),
                                                });
                                                subagentEvents.push(evt);
                                                pendingSubagentIds.push(evt.id); // track for namespace→id mapping
                                                enqueue('subagent-start', evt);
                                            } else {
                                                // Regular tool call
                                                log.info('Tool call', {
                                                    threadId,
                                                    toolName: tc.name,
                                                    toolCallId: tc.id,
                                                    args: JSON.stringify(tc.args ?? {}).slice(0, 200),
                                                });
                                                enqueue('tool-call', {
                                                    toolCallId: tc.id,
                                                    toolName: tc.name,
                                                    args: tc.args,
                                                });
                                            }
                                        }
                                    }
                                }
                            }

                            // Tool results
                            if (key === 'tools' && nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    const content = extractText(msg?.content);
                                    log.info('Tool result received', {
                                        threadId,
                                        toolName: msg?.name,
                                        toolCallId: msg?.tool_call_id,
                                        resultLen: content.length,
                                        wasTruncated: content.length > MAX_TOOL_OUTPUT,
                                    });
                                    enqueue('tool-result', {
                                        toolCallId: msg?.tool_call_id,
                                        toolName: msg?.name,
                                        result: truncateToolOutput(content),
                                    });

                                    // Mark subagent complete if this was a subagent call
                                    const subagent = subagentEvents.find(e => e.id === msg?.tool_call_id);
                                    if (subagent) {
                                        subagent.status = 'complete';
                                        subagent.completedAt = new Date().toISOString();
                                        subagent.result = truncateToolOutput(content);
                                        log.info('Subagent completed', {
                                            threadId,
                                            subagentName: subagent.name,
                                            toolCallId: subagent.id,
                                            resultLen: content.length,
                                        });
                                        enqueue('subagent-complete', subagent);
                                    }
                                }
                            }

                            // Todo updates from write_todos tool
                            if (nodeData?.todos) {
                                todos = nodeData.todos;
                                enqueue('todo-update', { todos });
                                await upsertTodos(threadId, todos);
                            }
                        }

                        // Check for interrupts at the top level of the chunk
                        if ((chunk as any)?.__interrupt__) {
                            const interrupts = (chunk as any).__interrupt__[0]?.value;
                            if (interrupts) {
                                enqueue('approval-required', {
                                    threadId,
                                    actionRequests: interrupts.actionRequests,
                                    reviewConfigs: interrupts.reviewConfigs,
                                    timestamp: new Date().toISOString(),
                                });
                            }
                        }
                    }
                }

                // --- Persist assistant message ---
                if (accumulatedText || subagentEvents.length > 0) {
                    const assistantMsg: DeepAgentMessage = {
                        id: assistantId,
                        role: 'assistant',
                        content: accumulatedText,
                        subagentEvents: subagentEvents.length > 0 ? subagentEvents : undefined,
                        timestamp: new Date().toISOString(),
                    };
                    await appendMessage(threadId, assistantMsg);
                }

                enqueue('done', { threadId });
                log.info('Stream complete', {
                    threadId,
                    totalChunks: chunkCount,
                    textLen: accumulatedText.length,
                    subagents: subagentEvents.length,
                    todos: todos.length,
                });
            } catch (err: any) {
                log.error('Streaming error', { threadId, error: err.message, stack: err.stack });
                console.error('[DeepAgent] Streaming error:', err);
                enqueue('error', { message: err.message || 'Stream error' });
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Thread-Id': threadId,
        },
    });
}
