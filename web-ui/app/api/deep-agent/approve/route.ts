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

                for await (const [namespace, chunk] of graphStream as any) {
                    const isSubagent = Array.isArray(namespace) && namespace.length > 0;
                    const chunkKeys = Object.keys(chunk || {});

                    for (const key of chunkKeys) {
                        const nodeData = (chunk as any)[key];

                        if (isSubagent) {
                            if (nodeData?.messages) {
                                for (const msg of nodeData.messages ?? []) {
                                    const text =
                                        typeof msg?.content === 'string'
                                            ? msg.content
                                            : Array.isArray(msg?.content)
                                                ? msg.content.map((c: any) => c?.text ?? '').join('')
                                                : '';
                                    if (text) enqueue('subagent-delta', { text });
                                }
                            }
                        } else {
                            if (nodeData?.messages) {
                                for (const msg of nodeData.messages ?? []) {
                                    // Only emit text-delta for AI messages, not tool results
                                    if (key !== 'tools') {
                                        const text = extractText(msg?.content);
                                        if (text) {
                                            accumulatedText += text;
                                            enqueue('text-delta', { text });
                                        }
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
                                    const content =
                                        typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content);
                                    enqueue('tool-result', {
                                        toolCallId: msg?.tool_call_id,
                                        toolName: msg?.name,
                                        result: content?.slice(0, 8000) ?? '',
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
