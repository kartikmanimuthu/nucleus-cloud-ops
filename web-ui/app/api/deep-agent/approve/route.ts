// ============================================================================
// Deep Agent Module — Approve API Route
// POST /api/deep-agent/approve
//
// Receives HITL decisions (approve/edit/reject) from the UI and resumes
// the paused LangGraph execution using Command({ resume: { decisions } }).
// The response is another SSE stream of continued agent output.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { Command } from '@langchain/langgraph';
import { createDeepAgentGraph } from '../../../../lib/deep-agent/deep-agent-graph';
import {
    appendMessage,
    upsertTodos,
} from '../../../../lib/deep-agent/db/chat-history-store';
import { v4 as uuidv4 } from 'uuid';
import type {
    DeepAgentApproveRequest,
    DeepAgentMessage,
    TodoItem,
} from '../../../../lib/deep-agent/types';
import { createLogger } from '../../../../lib/deep-agent/logger';

const log = createLogger('ApproveRoute');

// ---------------------------------------------------------------------------
// Helpers (same as chat/route.ts)
// ---------------------------------------------------------------------------

function extractText(msgOrContent: any): string {
    if (!msgOrContent) return '';
    const content = msgOrContent.content ?? msgOrContent;

    let result = '';

    if (msgOrContent.additional_kwargs?.reasoningContent) {
        const rc = msgOrContent.additional_kwargs.reasoningContent;
        if (typeof rc === 'string') {
            result += `<think>\n${rc}\n</think>\n`;
        } else if (rc && typeof rc.text === 'string') {
            result += `<think>\n${rc.text}\n</think>\n`;
        }
    }
    if (msgOrContent.additional_kwargs?.reasoning_content) {
        result += `<think>\n${msgOrContent.additional_kwargs.reasoning_content}\n</think>\n`;
    }

    if (typeof content === 'string') {
        result += content;
    } else if (Array.isArray(content)) {
        result += content
            .map((c: any) => {
                if (c.type === 'thinking' || c.type === 'reasoning_content') {
                    const t = c.text ?? c.thinking ?? c.reasoning_content ?? c.content ?? '';
                    if (t) return `<think>\n${t}\n</think>\n`;
                }
                return c?.text ?? c?.content ?? '';
            })
            .filter(Boolean)
            .join('');
    }
    return result;
}

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
    let body: DeepAgentApproveRequest & { config: any };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { threadId, decisions, config } = body;

    if (!threadId || !decisions || !config) {
        return NextResponse.json(
            { error: 'threadId, decisions, and config are required' },
            { status: 400 },
        );
    }

    log.info('POST /api/deep-agent/approve', {
        threadId,
        decisionCount: decisions.length,
        model: config.model,
        autoApprove: config.autoApprove,
    });

    const graphConfig = { configurable: { thread_id: threadId } };

    let agent: Awaited<ReturnType<typeof createDeepAgentGraph>>['agent'];
    try {
        log.info('Creating DeepAgent graph for resume...', { threadId });
        const result = await createDeepAgentGraph(config);
        agent = result.agent;
        log.info('DeepAgent graph created for resume', { threadId });
    } catch (err: any) {
        log.error('Graph creation failed during resume', { threadId, error: err.message, stack: err.stack });
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
                const resumeCommand = new Command({ resume: { decisions } });

                log.info('Starting resume stream', { threadId, streamMode: 'updates' });

                const graphStream = await agent.stream(resumeCommand as any, {
                    ...graphConfig,
                    streamMode: 'updates',
                    subgraphs: true,
                } as any);

                const assistantId = uuidv4();
                let accumulatedText = '';
                let todos: TodoItem[] = [];
                let chunkCount = 0;

                for await (const [namespace, chunk] of graphStream as any) {
                    chunkCount++;
                    const isSubgraph = Array.isArray(namespace) && namespace.length > 0;

                    log.debug('Stream chunk received', {
                        threadId,
                        chunkIndex: chunkCount,
                        isSubgraph,
                        namespace: isSubgraph ? namespace : '(main)',
                        keys: Object.keys(chunk || {}),
                    });

                    // Only process main-graph chunks
                    if (isSubgraph) continue;

                    const chunkKeys = Object.keys(chunk || {});

                    for (const key of chunkKeys) {
                        const nodeData = (chunk as any)[key];

                        // __interrupt__ — HITL approval required
                        if (key === '__interrupt__' || chunk?.__interrupt__) {
                            const interrupts =
                                chunk?.__interrupt__?.[0]?.value ?? nodeData?.[0]?.value;
                            if (interrupts) {
                                log.info('HITL interrupt during resume', {
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

                        if (nodeData?.messages) {
                            for (const msg of nodeData.messages) {
                                if (!msg) continue;

                                // Text delta — skip tool-result nodes
                                if (key !== 'tools') {
                                    const text = extractText(msg);
                                    if (text) {
                                        accumulatedText += text;
                                        log.debug('Text delta', { threadId, textLen: text.length });
                                        enqueue('text-delta', { text });
                                    }
                                }

                                // Tool calls
                                if (msg.tool_calls && msg.tool_calls.length > 0) {
                                    for (const tc of msg.tool_calls) {
                                        log.info('Tool call (during resume)', {
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

                                        // Persist todos when the agent calls write_todos
                                        if (tc.name === 'write_todos' && tc.args?.todos && Array.isArray(tc.args.todos)) {
                                            try {
                                                const mapped: TodoItem[] = tc.args.todos.map((t: any, i: number) => {
                                                    const desc = typeof t === 'string' ? t : (t.description ?? t.task ?? t.title ?? JSON.stringify(t));
                                                    return {
                                                        id: t.id || `todo-${Date.now()}-${i}`,
                                                        title: desc,
                                                        status: t.status || 'pending',
                                                        createdAt: t.createdAt || new Date().toISOString(),
                                                        updatedAt: t.updatedAt || new Date().toISOString(),
                                                    };
                                                });
                                                todos = mapped;
                                                enqueue('todo-update', { todos: mapped });
                                                await upsertTodos(threadId, mapped);
                                            } catch {
                                                // ignore parse error
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Tool results
                        if (key === 'tools' && nodeData?.messages) {
                            for (const msg of nodeData.messages) {
                                const content = extractText(msg);
                                log.info('Tool result (during resume)', {
                                    threadId,
                                    toolName: msg?.name,
                                    toolCallId: msg?.tool_call_id,
                                    resultLen: content.length,
                                });
                                enqueue('tool-result', {
                                    toolCallId: msg?.tool_call_id,
                                    toolName: msg?.name,
                                    result: truncateToolOutput(content),
                                });
                            }
                        }

                        // Todo updates from graph state
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

                // --- Persist assistant message ---
                if (accumulatedText) {
                    const assistantMsg: DeepAgentMessage = {
                        id: assistantId,
                        role: 'assistant',
                        content: accumulatedText,
                        timestamp: new Date().toISOString(),
                    };
                    await appendMessage(threadId, assistantMsg);
                }

                enqueue('done', { threadId });
                log.info('Resume stream complete', {
                    threadId,
                    totalChunks: chunkCount,
                    textLen: accumulatedText.length,
                    todos: todos.length,
                });
            } catch (err: any) {
                log.error('Resume streaming error', { threadId, error: err.message, stack: err.stack });
                console.error('[DeepAgent] Approve stream error:', err);
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
