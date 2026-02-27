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

                // Maps a LangGraph internal namespace tool-call UUID → the outer Anthropic
                // tool call ID used in subagent-start, so subagent-tool/subagent-delta
                // events carry an ID that matches the card on the client.
                // Key: namespace toolCallId (e.g. "d7e5192d-...")
                // Value: outer subagent event id (e.g. "tooluse_...")
                const nsIdToOuterId = new Map<string, string>();

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
                        // Resolve namespace tool-call UUID → outer subagent id.
                        // The namespace array looks like ["subgraph_name:uuid", "tools:uuid"].
                        // We extract the `tools:` segment UUID as the namespace key.
                        const nsToolCallId =
                            (namespace as string[])
                                .find((s: string) => s.startsWith('tools:'))
                                ?.split(':')[1] ?? (namespace as string[])[0] ?? 'unknown';

                        // If we already mapped this namespace to an outer ID use it;
                        // otherwise do a FIFO match with the next pending subagent event.
                        let resolvedToolCallId = nsIdToOuterId.get(nsToolCallId);
                        if (!resolvedToolCallId) {
                            // Find the oldest pending/running subagent that has not yet
                            // been associated with any namespace chunk.
                            const unmapped = subagentEvents.find(
                                se => se.status !== 'complete' && se.status !== 'error' &&
                                    ![...nsIdToOuterId.values()].includes(se.id),
                            );
                            if (unmapped) {
                                nsIdToOuterId.set(nsToolCallId, unmapped.id);
                                resolvedToolCallId = unmapped.id;
                                log.debug('Namespace mapped to outer subagent', {
                                    threadId, nsToolCallId, outerId: unmapped.id,
                                });
                            } else {
                                // Fallback — use namespace UUID directly; client will
                                // do secondary resolution against the running subagent.
                                resolvedToolCallId = nsToolCallId;
                            }
                        }

                        const chunkKeys = Object.keys(chunk || {});

                        for (const key of chunkKeys) {
                            const nodeData = (chunk as any)[key];

                            // Subagent text delta (call_model node)
                            if (key === 'call_model' && nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    if (msg?.content) {
                                        const text = extractText(msg.content);
                                        if (text) {
                                            log.debug('Subagent text delta', { threadId, resolvedToolCallId, textLen: text.length });
                                            enqueue('subagent-delta', { toolCallId: resolvedToolCallId, text });
                                        }
                                    }
                                }
                            }

                            // Subagent tool results (tools node)
                            if (key === 'tools' && nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    const toolName = msg?.name || 'tool';
                                    const content = extractText(msg?.content);
                                    log.info('Subagent tool result', { threadId, resolvedToolCallId, toolName, resultLen: content.length });
                                    enqueue('subagent-tool', {
                                        toolCallId: resolvedToolCallId,
                                        toolName,
                                        result: truncateToolOutput(content),
                                    });

                                    // Parse subagent internal todo updates and surface
                                    // them in the main todo panel.
                                    const todoMatch = content.match(/Updated todo list to (\[[\s\S]*?\])(?:\s|$)/);
                                    if (todoMatch) {
                                        try {
                                            const rawItems: Array<{ content: string; status: string }> =
                                                JSON.parse(todoMatch[1]);
                                            const mapped: TodoItem[] = rawItems.map((t, i) => ({
                                                id: `subagent-todo-${i}`,
                                                title: t.content,
                                                status: (
                                                    t.status === 'completed' ? 'done'
                                                        : t.status === 'in_progress' ? 'in_progress'
                                                            : 'pending'
                                                ) as TodoItem['status'],
                                                createdAt: new Date().toISOString(),
                                                updatedAt: new Date().toISOString(),
                                            }));
                                            todos = mapped;
                                            enqueue('todo-update', { todos: mapped });
                                            await upsertTodos(threadId, mapped);
                                        } catch {
                                            /* ignore parse errors */
                                        }
                                    }
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

                            // Main agent messages
                            if (nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    if (!msg) continue;

                                    // Text delta — only from AI messages; skip tool-result nodes
                                    // to prevent raw JSON from bleeding into the assistant bubble.
                                    if (key !== 'tools') {
                                        const text = extractText(msg.content);
                                        if (text) {
                                            accumulatedText += text;
                                            enqueue('text-delta', { text });
                                        }
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

                            // Tool results from main graph
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

                            // Todo updates from main graph write_todos tool
                            if (nodeData?.todos) {
                                todos = nodeData.todos;
                                enqueue('todo-update', { todos });
                                await upsertTodos(threadId, todos);
                            }
                        }

                        // Top-level interrupt check
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
