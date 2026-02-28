import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { NextResponse } from 'next/server';
import { createUIMessageStreamResponse, UIMessageChunk } from 'ai';
import { createReflectionGraph, createFastGraph, createDeepGraph } from '@/lib/agent/graph-factory';

export const maxDuration = 300; // 5 minutes for complex multi-iteration tasks

// Per-thread execution lock: prevents duplicate/parallel LangGraph executions on the same thread.
// useChat's maxSteps fires follow-up POSTs when a streaming response ends; without this guard a
// second graph execution re-plans from scratch, doubling LLM API cost and interleaving checkpoints.
const activeThreads = new Map<string, boolean>();

// Phase types for UI segregation
type AgentPhase = 'planning' | 'execution' | 'reflection' | 'revision' | 'final' | 'text';

interface Message {
    role: string;
    content: string;
    toolCallId?: string;
    toolInvocations?: Array<{
        toolName: string;
        args: Record<string, unknown>;
        toolCallId: string;
    }>;
    parts?: Array<{
        type: string;
        text: string;
    }>;
}

export async function POST(req: Request) {
    try {
        const {
            messages,
            threadId: requestThreadId,
            autoApprove = true,
            model,
            mode = 'plan',
            stream = true,
            accounts,       // Array of { accountId, accountName } for multi-account querying
            accountId,      // Deprecated: single AWS account ID for backwards compatibility
            accountName,    // Deprecated: single AWS account name
            selectedSkill,  // Skill ID for dynamic skill loading
            mcpServerIds    // MCP server IDs to activate for this session
        } = await req.json();
        const threadId = requestThreadId || Date.now().toString();

        // Reject duplicate requests on the same thread (e.g. from useChat maxSteps retries)
        if (activeThreads.has(threadId)) {
            return new Response(
                JSON.stringify({ error: "Thread is already processing a request. Please wait for it to finish." }),
                { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
        }
        activeThreads.set(threadId, true);
        const releaseThreadLock = () => activeThreads.delete(threadId);

        // Ensure thread exists in store (without persisting messages yet)
        const firstUserMsg = messages.find((m: Message) => m.role === 'user');
        const title = firstUserMsg?.content
            ? (typeof firstUserMsg.content === 'string' ? firstUserMsg.content.slice(0, 60) : "New Conversation")
            : "New Chat";

        if (process.env.MONGODB_URI) {
            const agentStore = await import('@/lib/db/agent-chat-history-store');
            const existing = await agentStore.getThread(threadId);
            if (!existing) {
                await agentStore.createThread(threadId, title, model, mode === 'fast' ? 'fast' : 'plan');
            }
        } else {
            const { threadStore } = await import('@/lib/store/thread-store');
            const existing = await threadStore.getThread(threadId);
            if (!existing) {
                await threadStore.createThread(threadId, title, model);
            }
        }

        console.log(`\n🚀 [API] New Request Started`);
        console.log(`   Thread ID:    ${threadId}`);
        console.log(`   Auto-Approve: ${autoApprove}`);
        console.log(`   Model:        ${model || 'Default'}`);
        console.log(`   Mode:         ${mode}`);
        console.log(`   AWS Accounts: ${accounts?.length || 0} selected${accounts?.length ? ` (${accounts.map((a: any) => a.accountId).join(', ')})` : ' (none)'}`);
        console.log(`   Timestamp:    ${new Date().toISOString()}`);

        // Create graph with configuration - supports multi-account
        const graphConfig = {
            model: model || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            autoApprove: autoApprove,
            accounts: accounts,         // Pass accounts array for multi-account querying
            accountId: accountId,       // Backwards compatibility
            accountName: accountName,
            selectedSkill: selectedSkill || null,  // Pass selectedSkill for dynamic loading
            mcpServerIds: mcpServerIds || [],       // Pass MCP server IDs for dynamic tool loading
        };

        let graph;
        if (mode === 'deep') {
            graph = await createDeepGraph(graphConfig);
        } else if (mode === 'fast') {
            graph = await createFastGraph(graphConfig);
        } else {
            graph = await createReflectionGraph(graphConfig);
        }

        const lastMessage = messages[messages.length - 1];
        let input: { messages: (HumanMessage | AIMessage | ToolMessage)[] } | null = null;
        const config = { configurable: { thread_id: threadId } };

        // Track the toolCallId when resuming from HITL approval
        let resumedToolCallId: string | undefined;

        if (lastMessage.role === 'tool') {
            // Tool result (Human-in-the-Loop approval)
            console.log(`[API] Processing tool message. Full message:`, JSON.stringify(lastMessage));
            console.log(`[API] Extracted toolCallId: ${lastMessage.toolCallId}`);

            // Store the toolCallId for use in the stream
            resumedToolCallId = lastMessage.toolCallId;

            // "Approved" means "Execute the real tool"
            // So we DO NOT add this message to the state, we just resume
            if (lastMessage.content === 'Approved') {
                console.log(`✅ [API] User Approved Execution logic. Resuming...`);
            }
            // Any other content (e.g. "Cancelled by user") is treated as a mock result
            // So we ADD it to state, effectively skipping the real tool execution
            else {
                console.log(`⚠️ [API] User Rejected/Cancelled. Providing Feedback: "${lastMessage.content.substring(0, 50)}..."`);
                const toolMessage = new ToolMessage({
                    tool_call_id: lastMessage.toolCallId || '',
                    content: lastMessage.content
                });
                await graph.updateState(config, { messages: [toolMessage] });
            }

            input = null; // Resume from interrupt
        } else {
            // Get current state
            const currentState = await graph.getState(config);
            const stateMessages = currentState.values.messages || [];

            let messagesToProcess = messages;

            if (stateMessages.length > 0) {
                const lastClientMessage = messages[messages.length - 1];
                if (lastClientMessage.role === 'user') {
                    messagesToProcess = [lastClientMessage];
                } else {
                    console.warn("[API] Unexpected: Last message is not user on a running thread.");
                    messagesToProcess = messages;
                }
            }

            // Convert Vercel AI SDK messages to LangChain messages
            const validMessages = messagesToProcess.map((m: Message) => {
                let content = m.content;
                if (!content && m.parts) {
                    content = m.parts
                        .filter((p) => p.type === 'text')
                        .map((p) => p.text)
                        .join('');
                }
                content = content || "";

                if (m.role === 'user') {
                    return new HumanMessage({ content });
                } else if (m.role === 'assistant') {
                    const toolCalls = m.toolInvocations?.map((ti) => ({
                        name: ti.toolName,
                        args: ti.args,
                        id: ti.toolCallId,
                        type: "tool_call" as const
                    })) || [];

                    return new AIMessage({
                        content: content,
                        tool_calls: toolCalls
                    });
                } else if (m.role === 'tool') {
                    return new ToolMessage({
                        tool_call_id: m.toolCallId || '',
                        content: content
                    });
                }
                return new HumanMessage({ content });
            });
            input = { messages: validMessages };
        }

        if (stream) {
            // Note: We intentionally DON'T pass req.signal to streamEvents.
            // Passing the request's AbortSignal directly causes "Error: Aborted" 
            // to be thrown when clients disconnect, which disrupts graph execution.
            // Instead, we handle disconnection gracefully in safeEnqueue().
            // @ts-ignore
            const streamEvents = await graph.streamEvents(
                input as any,
                {
                    version: "v2",
                    configurable: { thread_id: threadId },
                    recursionLimit: 100, // Higher limit for complex tasks with many tool calls
                }
            );

            return createUIMessageStreamResponse({
                stream: processStream(
                    streamEvents,
                    autoApprove,
                    resumedToolCallId,
                    releaseThreadLock,
                    threadId,
                    graph,
                    { configurable: { thread_id: threadId } }
                )
            });
        } else {
            const result = await graph.invoke(
                input,
                {
                    configurable: { thread_id: threadId },
                    recursionLimit: 100,
                    signal: req.signal,
                }
            );

            // Extract the last message content
            const lastMsg = result.messages[result.messages.length - 1];
            let content = lastMsg.content;

            // Also include tool calls if present, though likely handled by the loop if not simple text
            releaseThreadLock();
            return NextResponse.json({
                role: 'assistant',
                content: content,
                // Include other relevant fields if necessary
            });
        }

    } catch (error) {
        releaseThreadLock();
        console.error('[API Error]:', error);
        return new Response(
            JSON.stringify({
                error: error instanceof Error ? error.message : 'Internal server error'
            }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getPhaseFromNode(node: string): AgentPhase {
    switch (node) {
        case 'planner':
            return 'planning';
        case 'generate':
            return 'execution';
        case 'reflect':
            return 'reflection';
        case 'revise':
            return 'revision';
        case 'final':
            return 'final';
        case 'agent':
            return 'execution';
        case 'call_model':
            return 'execution';   // Deep Agent main model node
        case 'tools':
            return 'execution';   // Deep Agent tool execution
        default:
            return 'text';
    }
}

function getPhaseMarker(phase: AgentPhase): string {
    switch (phase) {
        case 'planning':
            return 'PLANNING_PHASE_START\n';
        case 'execution':
            return 'EXECUTION_PHASE_START\n';
        case 'reflection':
            return 'REFLECTION_PHASE_START\n';
        case 'revision':
            return 'REVISION_PHASE_START\n';
        case 'final':
            return 'FINAL_PHASE_START\n';
        default:
            return '';
    }
}

interface StreamEvent {
    event: string;
    run_id?: string;
    name?: string; // Added this line
    metadata?: {
        langgraph_node?: string;
    };
    data?: {
        chunk?: {
            content: string | Array<{ type: string; text: string }>;
            id?: string;
            tool_call_chunks?: Array<any>;
        };
        output?: {
            tool_calls?: Array<{
                id?: string;
                name: string;
                args: Record<string, unknown>;
            }>;
        };
        input?: any;
        args?: any;
    };
}

function processStream(
    stream: AsyncIterable<StreamEvent>,
    autoApprove: boolean,
    resumedToolCallId?: string,
    onDone?: () => void,
    threadId?: string,
    graph?: any,
    config?: any
): ReadableStream<UIMessageChunk> {
    return new ReadableStream({
        async start(controller) {
            let partCounter = 0;
            let currentPartId = "";
            let streamStarted = false;
            let currentPhase: AgentPhase = 'text';

            // Flag to track if we're resuming from a HITL approval
            // and need to use the original toolCallId
            let isResumedFromApproval = !!resumedToolCallId;
            let approvedToolId = resumedToolCallId;

            // Debug logging
            console.log("[DEBUG] processStream called with:", {
                autoApprove,
                resumedToolCallId,
                isResumedFromApproval,
                approvedToolId
            });

            // Track pending tool calls for HITL flow within the same request
            // Maps tool name to the original toolCallId from on_chat_model_end
            const pendingToolCalls = new Map<string, string>();

            // Track if we've emitted any actual TEXT content (not reasoning)
            // The AI SDK requires messages to have either TEXT or pending tool calls
            // Reasoning parts and completed tool calls don't satisfy this requirement
            let hasEmittedTextContent = false;

            const safeEnqueue = (chunk: UIMessageChunk) => {
                try {
                    controller.enqueue(chunk);
                    return true;
                } catch (e) {
                    return false;
                }
            };

            try {
                if (!safeEnqueue({ type: 'start' })) return;

                // When resuming from HITL approval, emit text content first
                // The tool-input events will be emitted in on_tool_start for each tool
                if (isResumedFromApproval && approvedToolId) {
                    console.log("[DEBUG] HITL resume - emitting initial text for toolId:", approvedToolId);

                    // Emit a text part first to ensure the message has content
                    const resumePartId = `part-resume-${Date.now()}`;
                    if (!safeEnqueue({ type: 'text-start', id: resumePartId })) return;
                    if (!safeEnqueue({ type: 'text-delta', id: resumePartId, delta: 'Executing approved tool(s)...\n' })) return;
                    if (!safeEnqueue({ type: 'text-end', id: resumePartId })) return;
                    hasEmittedTextContent = true;
                }

                for await (const event of stream) {
                    try {
                        const runId = event.run_id || "";

                        if (event.event === "on_chat_model_start") {
                            const node = event.metadata?.langgraph_node;
                            currentPhase = getPhaseFromNode(node || "");

                            // Ensure unique IDs per chat model run to avoid index conflicts
                            partCounter++;
                            currentPartId = `part-${runId}-${partCounter}`;
                            streamStarted = false;

                            const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';

                            if (!safeEnqueue({ type: `${chunkType}-start` as any, id: currentPartId })) break;
                            streamStarted = true;

                            const phaseMarker = getPhaseMarker(currentPhase);
                            if (phaseMarker) {
                                safeEnqueue({
                                    type: `${chunkType}-delta` as any,
                                    id: currentPartId,
                                    delta: phaseMarker,
                                });
                                // Only count as text content if it's actually a text part
                                if (chunkType === 'text') {
                                    hasEmittedTextContent = true;
                                }
                            }
                        }
                        else if (event.event === "on_chat_model_stream") {
                            const content = event.data?.chunk?.content;
                            let text = "";
                            if (typeof content === "string") {
                                text = content;
                            } else if (Array.isArray(content)) {
                                text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
                            }

                            if (text && streamStarted) {
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';
                                if (!safeEnqueue({
                                    type: `${chunkType}-delta` as any,
                                    id: currentPartId,
                                    delta: text,
                                })) break;
                                // Only count as text content if it's actually a text part
                                if (chunkType === 'text') {
                                    hasEmittedTextContent = true;
                                }
                            }
                        }
                        else if (event.event === "on_chat_model_end") {
                            if (streamStarted) {
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';
                                if (!safeEnqueue({ type: `${chunkType}-end` as any, id: currentPartId })) break;
                                streamStarted = false;
                            }

                            if (!autoApprove) {
                                const toolCalls = event.data?.output?.tool_calls;
                                if (toolCalls && toolCalls.length > 0) {
                                    for (const toolCall of toolCalls) {
                                        const toolId = toolCall.id || `tool-${Date.now()}`;
                                        // Store the mapping for later use in on_tool_end
                                        pendingToolCalls.set(toolCall.name, toolId);
                                        if (!safeEnqueue({ type: "tool-input-start", toolCallId: toolId, toolName: toolCall.name })) break;
                                        if (!safeEnqueue({ type: "tool-input-available", toolCallId: toolId, toolName: toolCall.name, input: toolCall.args })) break;
                                    }
                                }
                            }
                        }
                        else if (event.event === "on_tool_start") {
                            console.log("[DEBUG] on_tool_start event:", JSON.stringify({
                                run_id: event.run_id,
                                name: event.name,
                                metadata: event.metadata,
                                tags: (event as any).tags
                            }));
                            const toolName = event.name || "";
                            const args = event.data?.input || event.data?.args;
                            const toolId = runId || `t-${Date.now()}`;

                            if (autoApprove) {
                                // For autoApprove mode, emit tool-input events with run_id
                                if (!safeEnqueue({ type: "tool-input-start", toolCallId: toolId, toolName })) break;
                                if (!safeEnqueue({ type: "tool-input-available", toolCallId: toolId, toolName, input: args || {} })) break;
                            } else if (isResumedFromApproval) {
                                // For HITL mode when resuming from approval:
                                // We need to emit tool-input for EVERY tool, not just the first one
                                // This handles cases where multiple tools were queued for execution
                                console.log("[DEBUG] Emitting tool-input for HITL resumed tool:", toolId, toolName);
                                if (!safeEnqueue({ type: "tool-input-start", toolCallId: toolId, toolName })) break;
                                if (!safeEnqueue({ type: "tool-input-available", toolCallId: toolId, toolName, input: args || {} })) break;
                            }
                            // For initial HITL request (not resumed), tool-input events 
                            // are emitted in on_chat_model_end, so we skip here
                        }
                        else if (event.event === "on_tool_end") {
                            console.log("[DEBUG] on_tool_end event:", JSON.stringify({
                                run_id: event.run_id,
                                name: event.name,
                                metadata: event.metadata,
                                tags: (event as any).tags
                            }));

                            const toolName = event.name || "";
                            let toolId = runId || "";

                            // For HITL resumed flow and autoApprove, use run_id (matches on_tool_start)
                            // For initial HITL request, use the pending tool call ID from on_chat_model_end
                            if (!autoApprove && !isResumedFromApproval && pendingToolCalls.has(toolName)) {
                                toolId = pendingToolCalls.get(toolName)!;
                                pendingToolCalls.delete(toolName);
                            }

                            if (toolId) {
                                const output = event.data?.output;
                                const outputContent = typeof output === 'object' && output !== null && 'content' in output
                                    ? (output as { content: string }).content
                                    : (typeof output === 'string' ? output : JSON.stringify(output));

                                if (!safeEnqueue({ type: "tool-output-available", toolCallId: toolId, output: outputContent })) break;
                            }
                        }
                    } catch (innerError) {
                        console.error("Stream event processing error:", innerError);
                    }
                }

                // If we haven't emitted any content yet, emit a minimal text part
                // This is required because the AI SDK expects messages to have either text or tool calls
                if (!hasEmittedTextContent) {
                    console.log("[DEBUG] No content emitted, adding placeholder text");
                    const emptyPartId = `part-empty-${Date.now()}`;
                    safeEnqueue({ type: 'text-start', id: emptyPartId });
                    safeEnqueue({ type: 'text-delta', id: emptyPartId, delta: ' ' });
                    safeEnqueue({ type: 'text-end', id: emptyPartId });
                }

                // Only close if we haven't encountered a write error (which implies cancellation)
                if (safeEnqueue({ type: 'finish' })) {
                    try {
                        controller.close();
                    } catch (e) {
                        // Ignore if already closed
                    }
                }
            } catch (error) {
                // Check if this is an abort error (which is expected when client disconnects)
                const isAbortError = error instanceof Error &&
                    (error.message === 'Aborted' || error.name === 'AbortError');

                if (isAbortError) {
                    console.log("Stream aborted (client disconnected or timeout)");
                } else {
                    console.error("Main stream error:", error);
                }

                try {
                    // For abort errors, just close cleanly; for real errors, signal error
                    if (isAbortError) {
                        controller.close();
                    } else {
                        controller.error(error);
                    }
                } catch (e) {
                    // Ignore if already closed
                }
            } finally {
                // Persist complete message history to MongoDB if configured
                if (process.env.MONGODB_URI && threadId && graph && config) {
                    try {
                        const finalState = await graph.getState(config);
                        if (finalState && finalState.values && finalState.values.messages) {
                            const agentStore = await import('@/lib/db/agent-chat-history-store');

                            // Convert all LangChain messages to AgentMessage format
                            const convertedMessages: any[] = [];
                            const langChainMessages = finalState.values.messages;
                            let msgOrder = 0;

                            for (const msg of langChainMessages) {
                                const msgType = msg._getType?.() || 'unknown';
                                msgOrder++;
                                const msgId = `msg-${threadId}-${msgOrder}`;
                                const content = typeof msg.content === 'string'
                                    ? msg.content
                                    : JSON.stringify(msg.content);

                                let agentMsg: any = {
                                    id: msgId,
                                    content,
                                    timestamp: new Date().toISOString(),
                                };

                                if (msgType === 'human') {
                                    agentMsg.role = 'user';
                                    agentMsg.parts = [{ type: 'text', text: content }];
                                } else if (msgType === 'ai') {
                                    agentMsg.role = 'assistant';
                                    agentMsg.parts = [{ type: 'text', text: content }];
                                    // Include tool calls if present
                                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                                        agentMsg.toolCalls = msg.tool_calls.map((tc: any) => ({
                                            name: tc.name,
                                            args: tc.args,
                                            id: tc.id,
                                        }));
                                    }
                                } else if (msgType === 'tool') {
                                    agentMsg.role = 'tool';
                                    agentMsg.toolCallId = msg.tool_call_id;
                                    agentMsg.toolName = msg.name;
                                    agentMsg.parts = [{ type: 'tool-invocation', toolCallId: msg.tool_call_id, result: content, state: 'result' }];
                                } else {
                                    continue; // Skip unknown message types
                                }

                                convertedMessages.push(agentMsg);
                            }

                            // Replace all messages for this thread at once (avoids duplicates)
                            if (convertedMessages.length > 0) {
                                await agentStore.replaceMessages(threadId, convertedMessages);
                                console.log(`[Chat API] Persisted ${convertedMessages.length} messages for thread ${threadId}`);
                            }
                        }
                    } catch (err) {
                        console.warn('[Chat API] Failed to persist full message history to MongoDB:', err);
                    }
                }
                // Release the per-thread lock so subsequent requests can proceed
                onDone?.();
            }
        }
    });
}
