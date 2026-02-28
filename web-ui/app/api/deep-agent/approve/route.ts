// ============================================================================
// Deep Agent Module — Approve API Route
// POST /api/deep-agent/approve
//
// Receives HITL decisions (approve/edit/reject) from the UI and resumes
// the paused LangGraph execution using Command({ resume: { decisions } }).
// The response is another SSE stream of continued agent output.
//
// This route mirrors the streaming logic from chat/route.ts so that all
// subagent lifecycle events (start, delta, tool, complete), ID mapping,
// todo updates, and structured logging are fully supported.
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
    SubagentEvent,
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

    // Check for thinking in additional_kwargs (LangChain Bedrock Converse / Anthropic style)
    if (msgOrContent.additional_kwargs?.reasoningContent) {
        const rc = msgOrContent.additional_kwargs.reasoningContent;
        if (typeof rc === 'string') {
            result += `<think>\n${rc}\n</think>\n`;
        } else if (rc && typeof rc.text === 'string') {
            result += `<think>\n${rc.text}\n</think>\n`;
        }
    }
    // Deepseek uses reasoning_content
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
        decisions: decisions.map((d: any) => `${d.toolName ?? 'unknown'}:${d.decision}`),
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
                // Resume the halted graph with user decisions
                const resumeCommand = new Command({ resume: { decisions } });

                log.info('Starting resume stream', {
                    threadId,
                    streamMode: 'updates',
                    subgraphs: true,
                });

                const graphStream = await agent.stream(resumeCommand as any, {
                    ...graphConfig,
                    streamMode: 'updates',
                    subgraphs: true,
                } as any);

                const assistantId = uuidv4();
                const subagentEvents: SubagentEvent[] = [];
                let accumulatedText = '';
                let todos: TodoItem[] = [];
                let chunkCount = 0;

                // Maps a LangGraph internal namespace tool-call UUID → the outer
                // tool call ID used in subagent-start, so subagent-tool/subagent-delta
                // events carry an ID that matches the card on the client.
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
                        const nsToolCallId =
                            (namespace as string[])
                                .find((s: string) => s.startsWith('tools:'))
                                ?.split(':')[1] ?? (namespace as string[])[0] ?? 'unknown';

                        let resolvedToolCallId = nsIdToOuterId.get(nsToolCallId);
                        if (!resolvedToolCallId) {
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
                                    const content = extractText(msg);
                                    log.info('Subagent tool result', { threadId, resolvedToolCallId, toolName, resultLen: content.length });
                                    enqueue('subagent-tool', {
                                        toolCallId: resolvedToolCallId,
                                        toolName,
                                        result: truncateToolOutput(content),
                                    });

                                    // Parse subagent internal todo updates
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
                                    log.info('HITL interrupt — approval required (during resume)', {
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
                                    if (key !== 'tools') {
                                        const text = extractText(msg);
                                        if (text) {
                                            accumulatedText += text;
                                            log.debug('Text delta', { threadId, textLen: text.length });
                                            enqueue('text-delta', { text });
                                        }
                                    }

                                    // Tool calls (task delegations to subagents)
                                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                                        for (const tc of msg.tool_calls) {
                                            const isSubagentCall =
                                                tc.name === 'task' ||
                                                ['aws-ops', 'research', 'code-iac'].some((n: string) =>
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
                                                log.info('Subagent dispatched (during resume)', {
                                                    threadId,
                                                    subagentName: evt.name,
                                                    toolCallId: evt.id,
                                                    description: evt.description?.slice(0, 120),
                                                });
                                                subagentEvents.push(evt);
                                                enqueue('subagent-start', evt);
                                            } else {
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

                                                // Automatically persist todos if the main graph uses write_todos
                                                if (tc.name === 'write_todos' && tc.args?.todos && Array.isArray(tc.args.todos)) {
                                                    try {
                                                        const mapped: TodoItem[] = tc.args.todos.map((t: any, i: number) => {
                                                            const desc = typeof t === 'string' ? t : (t.description ?? t.task ?? t.title ?? JSON.stringify(t));
                                                            return {
                                                                id: t.id || `main-todo-${i}-${Date.now()}`,
                                                                description: desc,
                                                                status: t.status || 'pending',
                                                                createdAt: t.createdAt || new Date().toISOString(),
                                                                updatedAt: t.updatedAt || new Date().toISOString(),
                                                            };
                                                        });
                                                        todos = mapped;
                                                        enqueue('todo-update', { todos: mapped });
                                                        await upsertTodos(threadId, mapped);
                                                    } catch {
                                                        // ignore parser error
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Tool results from main graph
                            if (key === 'tools' && nodeData?.messages) {
                                for (const msg of nodeData.messages) {
                                    const content = extractText(msg);
                                    log.info('Tool result received (during resume)', {
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
                                        log.info('Subagent completed (during resume)', {
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
                                log.info('Top-level interrupt (during resume)', {
                                    threadId,
                                    toolCount: interrupts.actionRequests?.length ?? 0,
                                });
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
                log.info('Resume stream complete', {
                    threadId,
                    totalChunks: chunkCount,
                    textLen: accumulatedText.length,
                    subagents: subagentEvents.length,
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
