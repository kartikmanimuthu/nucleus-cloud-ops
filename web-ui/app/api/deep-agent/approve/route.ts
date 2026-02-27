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
import { appendMessage } from '../../../../lib/deep-agent/db/chat-history-store';
import { v4 as uuidv4 } from 'uuid';
import type {
    DeepAgentApproveRequest,
    DeepAgentMessage,
} from '../../../../lib/deep-agent/types';

// Attempt to infer subagent name from a LangGraph namespace array.
// Namespace entries look like "subgraph_name:uuid" or "tools:uuid".
function inferSubagentName(namespace: string[]): string {
    for (const part of namespace) {
        if (part.startsWith('tools:')) continue;
        const name = part.split(':')[0];
        if (name && name !== 'tools') return name;
    }
    return 'aws-ops'; // safe fallback
}

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

    const graphConfig = { configurable: { thread_id: threadId } };

    let agent: Awaited<ReturnType<typeof createDeepAgentGraph>>['agent'];
    try {
        const result = await createDeepAgentGraph(config);
        agent = result.agent;
    } catch (err: any) {
        return NextResponse.json({ error: `Agent creation failed: ${err.message}` }, { status: 500 });
    }

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;

    function enqueue(event: string, data: unknown): void {
        try {
            controller?.enqueue(encoder.encode(`data: ${JSON.stringify({ event, data })}\n\n`));
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

                const graphStream = await agent.stream(resumeCommand as any, {
                    ...graphConfig,
                    streamMode: 'updates',
                    subgraphs: true,
                } as any);

                let accumulatedText = '';

                // Namespace → synthetic outer ID mapping (same pattern as chat/route.ts).
                // During resume the original subagent outer IDs are not available, so we
                // generate a fresh UUID per subgraph namespace and emit a synthetic
                // subagent-start so the UI can create a card in the new assistant message.
                const namespaceToOuterId = new Map<string, string>();
                const announcedNamespaces = new Set<string>();

                function extractText(content: unknown): string {
                    if (typeof content === 'string') return content;
                    if (Array.isArray(content)) {
                        return (content as any[]).map(c => c?.text ?? c?.content ?? '').filter(Boolean).join('');
                    }
                    return '';
                }

                for await (const [namespace, chunk] of graphStream as any) {
                    const isSubagent = Array.isArray(namespace) && namespace.length > 0;
                    const chunkKeys = Object.keys(chunk || {});

                    if (isSubagent) {
                        // Resolve or create the outer ID for this subgraph namespace
                        const nsKey = (namespace as string[]).join('|');
                        if (!namespaceToOuterId.has(nsKey)) {
                            namespaceToOuterId.set(nsKey, uuidv4());
                        }
                        const resolvedId = namespaceToOuterId.get(nsKey)!;

                        // Announce once so the UI creates a SubagentCard in the new message
                        if (!announcedNamespaces.has(nsKey)) {
                            announcedNamespaces.add(nsKey);
                            enqueue('subagent-start', {
                                id: resolvedId,
                                name: inferSubagentName(namespace as string[]),
                                description: 'Resuming after approval…',
                                status: 'running',
                                startedAt: new Date().toISOString(),
                            });
                        }

                        for (const key of chunkKeys) {
                            const nodeData = (chunk as any)[key];

                            // Subagent text delta
                            if (key === 'call_model' && nodeData?.messages) {
                                for (const msg of nodeData.messages ?? []) {
                                    const text = extractText(msg?.content);
                                    if (text) enqueue('subagent-delta', { toolCallId: resolvedId, text });
                                }
                            }

                            // Subagent tool results
                            if (key === 'tools' && nodeData?.messages) {
                                for (const msg of nodeData.messages ?? []) {
                                    const toolName = msg?.name || 'tool';
                                    const content = extractText(msg?.content);
                                    if (content) {
                                        enqueue('subagent-tool', {
                                            toolCallId: resolvedId,
                                            toolName,
                                            result: content.slice(0, 8000),
                                        });
                                    }
                                }
                            }
                        }
                    } else {
                        for (const key of chunkKeys) {
                            const nodeData = (chunk as any)[key];

                            if (nodeData?.messages) {
                                for (const msg of nodeData.messages ?? []) {
                                    const text = extractText(msg?.content);
                                    if (text) {
                                        accumulatedText += text;
                                        enqueue('text-delta', { text });
                                    }

                                    if (msg?.tool_calls?.length > 0) {
                                        for (const tc of msg.tool_calls) {
                                            enqueue('tool-call', {
                                                toolCallId: tc.id,
                                                toolName: tc.name,
                                                args: tc.args,
                                            });
                                        }
                                    }
                                }
                            }

                            if (key === 'tools' && nodeData?.messages) {
                                for (const msg of nodeData.messages ?? []) {
                                    const content = extractText(msg?.content) || JSON.stringify(msg?.content ?? '');
                                    enqueue('tool-result', {
                                        toolCallId: msg?.tool_call_id,
                                        toolName: msg?.name,
                                        result: content.slice(0, 8000),
                                    });
                                }
                            }

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
                }

                // Mark any announced subagents as complete
                for (const [nsKey, resolvedId] of namespaceToOuterId) {
                    if (announcedNamespaces.has(nsKey)) {
                        enqueue('subagent-complete', {
                            id: resolvedId,
                            status: 'complete',
                            completedAt: new Date().toISOString(),
                        });
                    }
                }

                // Persist resumed assistant output
                if (accumulatedText) {
                    const msg: DeepAgentMessage = {
                        id: uuidv4(),
                        role: 'assistant',
                        content: accumulatedText,
                        timestamp: new Date().toISOString(),
                    };
                    await appendMessage(threadId, msg);
                }

                enqueue('done', { threadId });
            } catch (err: any) {
                console.error('[DeepAgent] Approve stream error:', err);
                enqueue('error', { message: err.message });
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
        },
    });
}
