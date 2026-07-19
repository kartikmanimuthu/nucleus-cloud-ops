import { HumanMessage, AIMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { NextResponse } from 'next/server';
import { createUIMessageStreamResponse, UIMessageChunk } from 'ai';
import { createReflectionGraph, createFastGraph, createDeepGraph } from '@/lib/agent/graph-factory';
import { resolveModelConfig, resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { isProviderConfigError } from '@/lib/agent/provider-errors';
import { buildClientErrorText } from '@/lib/agent/stream-error';
import { autoSelectSkill } from '@/lib/agent/auto-skill-select';
import { resolveKnowledgeBaseIds } from '@/lib/agent/auto-kb-select';
import { acquireThreadLock, releaseThreadLock as releaseThreadLockDb } from '@/lib/agent/thread-lock';
import { buildPlanPart, buildPhasePart, buildInterruptParts, buildMemoryPart, humanizeReflection, humanizePlanning } from './stream-parts';
import { resolveResumedToolCallId, type ResumedPendingCall } from './resume-tool-id';
import type { PlanStep } from '@/lib/agent/agent-shared';

export const maxDuration = 300; // 5 minutes for complex multi-iteration tasks

// Server-side attachment limits (client validation in file-upload.tsx is advisory only).
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB decoded

// Validate experimental_attachments on inbound messages. Returns an error string
// (→ 400) or null if all attachments are acceptable. The agent runs on shared
// infra, so an unbounded/arbitrary data: URL would inflate the request and the
// provider payload; only bounded image attachments are accepted.
function validateAttachments(messages: Message[]): string | null {
    for (const m of messages) {
        const atts = (m as { experimental_attachments?: Array<{ url?: string; contentType?: string }> }).experimental_attachments;
        if (!atts?.length) continue;
        if (atts.length > MAX_ATTACHMENTS_PER_MESSAGE) {
            return `Too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message).`;
        }
        for (const att of atts) {
            const url = att.url ?? '';
            const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url);
            if (!match) return 'Attachments must be inline data: URLs.';
            const mime = match[1] || '';
            if (!mime.startsWith('image/')) return 'Only image attachments are supported.';
            const isBase64 = !!match[2];
            const payload = match[3] ?? '';
            const bytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
            if (bytes > MAX_ATTACHMENT_BYTES) return 'Attachment exceeds the 5MB limit.';
        }
    }
    return null;
}

// Phase types for UI segregation
type AgentPhase = 'planning' | 'execution' | 'reflection' | 'revision' | 'final' | 'memory_recall' | 'memory_save' | 'text';

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
    // Declare outside try so the catch block can always call it safely
    let releaseLock: () => void = () => { };

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
            mcpServerIds,   // MCP server IDs to activate for this session
            knowledgeBaseIds, // Knowledge Base IDs manually selected in the console
            decisions       // Per-tool approval decisions (new resume contract)
        } = await req.json();
        // Resolve userId and tenantId from session
        let resolvedUserId: string;
        let resolvedTenantId: string;
        try {
            const { getSessionUserId, getSessionTenantId } = await import("@/lib/auth-session");
            resolvedUserId = await getSessionUserId();
            resolvedTenantId = await getSessionTenantId();
        } catch {
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Assign or validate thread ID (D-12/D-13)
        let threadId: string;
        if (requestThreadId) {
            // Validate tenant ownership on namespaced threads
            if (requestThreadId.includes(':')) {
                const [embeddedTenantId] = requestThreadId.split(':');
                if (embeddedTenantId !== resolvedTenantId) {
                    return new Response(
                        JSON.stringify({ error: 'Forbidden: thread belongs to another tenant' }),
                        { status: 403, headers: { 'Content-Type': 'application/json' } }
                    );
                }
            }
            // Legacy threads (bare UUID/timestamp) — allow access for session user only
            threadId = requestThreadId;
        } else {
            // New thread — use namespaced format: tenantId:userId:timestamp
            threadId = `${resolvedTenantId}:${resolvedUserId}:${Date.now()}`;
        }
        // Langfuse expects a plain ID without the USER# prefix
        const langfuseUserId = resolvedUserId.replace(/^USER#/, '') || undefined;

        // Reject duplicate/parallel requests on the same thread across ALL instances
        // (cross-instance lock — see lib/agent/thread-lock.ts).
        const lockToken = await acquireThreadLock(threadId);
        if (lockToken === null) {
            return new Response(
                JSON.stringify({ error: "Thread is already processing a request. Please wait for it to finish." }),
                { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
        }
        releaseLock = () => { void releaseThreadLockDb(threadId, lockToken); };

        // Ensure thread exists in store (without persisting messages yet)
        const firstUserMsg = messages.find((m: Message) => m.role === 'user');
        const title = firstUserMsg?.content
            ? (typeof firstUserMsg.content === 'string' ? firstUserMsg.content.slice(0, 60) : "New Conversation")
            : "New Chat";

        // Eagerly create session metadata so the thread appears in the sidebar immediately
        try {
            const { threadStore } = await import('@/lib/store/thread-store');
            await threadStore.createThread(threadId, title, model, resolvedTenantId, resolvedUserId);
        } catch (e) {
            console.warn('[Chat API] Failed to seed session metadata:', e);
        }

        console.log(`\n🚀 [API] New Request Started`);
        console.log(`   Thread ID:    ${threadId}`);
        console.log(`   Auto-Approve: ${autoApprove}`);
        console.log(`   Model:        ${model || 'Default'}`);
        console.log(`   Mode:         ${mode}`);
        console.log(`   AWS Accounts: ${accounts?.length || 0} selected${accounts?.length ? ` (${accounts.map((a: any) => a.accountId).join(', ')})` : ' (none)'}`);
        console.log(`   Timestamp:    ${new Date().toISOString()}`);

        // Resolve model into a ResolvedModelConfig before graph creation.
        // Selection precedence: explicit picker model → tenant default provider's
        // chat model. There is NO implicit Bedrock fallback — if nothing is
        // configured we return a 400 telling the user to configure a provider.
        const modelString = model as string | undefined;
        let resolvedModel;
        try {
            resolvedModel = modelString
                ? await resolveModelConfig(modelString, resolvedTenantId)
                : await resolveDefaultModelConfig(resolvedTenantId);
        } catch (e) {
            releaseLock();
            if (isProviderConfigError(e)) {
                return new Response(
                    JSON.stringify({ error: e.message }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } },
                );
            }
            throw e;
        }

        // Hermes-style disclosure: when no skill is picked, one cheap reflector call
        // matches the message against the skill catalog. Manual selection always wins.
        let effectiveSkill: string | null = selectedSkill || null;
        if (!effectiveSkill && mode !== 'deep') {
            const lastMsg = messages[messages.length - 1];
            const lastUserText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content ?? '');
            const auto = await autoSelectSkill({ tenantId: resolvedTenantId, message: lastUserText, model: resolvedModel });
            if (auto) effectiveSkill = auto.slug;
        }

        // KB progressive disclosure: manual selection always wins. When none is picked,
        // one cheap reflector call matches the message against the tenant's KB catalog.
        let effectiveKbIds: string[] = Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds : [];
        if (effectiveKbIds.length === 0 && mode !== 'deep') {
            const lastMsg = messages[messages.length - 1];
            const lastUserText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content ?? '');
            effectiveKbIds = await resolveKnowledgeBaseIds({ tenantId: resolvedTenantId, selectedIds: null, message: lastUserText, model: resolvedModel });
        }

        // Create graph with configuration - supports multi-account
        const graphConfig = {
            model: resolvedModel,
            autoApprove: autoApprove,
            accounts: accounts,         // Pass accounts array for multi-account querying
            accountId: accountId,       // Backwards compatibility
            accountName: accountName,
            selectedSkill: effectiveSkill,  // user pick, or auto-selected (Hermes disclosure), or null
            mcpServerIds: mcpServerIds || [],       // Pass MCP server IDs for dynamic tool loading
            knowledgeBaseIds: effectiveKbIds,       // user pick, or auto-selected KB ids, or []
            userId: resolvedUserId,                 // For memory store scoping
            tenantId: resolvedTenantId,             // For tenant-scoped memory operations
        };

        let graph;
        if (mode === 'deep') {
            graph = await createDeepGraph(graphConfig);
        } else if (mode === 'fast') {
            graph = await createFastGraph(graphConfig);
        } else {
            graph = await createReflectionGraph(graphConfig);
        }

        // Build Langfuse callbacks (empty array when disabled — zero overhead)
        const { getLangfuseCallbackHandler } = await import('@/lib/agent/langfuse-config');
        const langfuseHandler = await getLangfuseCallbackHandler(threadId, langfuseUserId);
        const langfuseCallbacks = langfuseHandler ? [langfuseHandler as any] : [];

        const lastMessage = messages[messages.length - 1];
        let input: { messages: (HumanMessage | AIMessage | ToolMessage)[] } | null = null;
        const config = { configurable: { thread_id: threadId, user_id: resolvedUserId, tenant_id: resolvedTenantId } };

        // Track the toolCallId when resuming from HITL approval
        let resumedToolCallId: string | undefined;

        // Original pending tool calls that will execute on resume. processStream
        // uses these to re-emit tool parts under their ORIGINAL tool_call_ids
        // (the ids the pre-pause message's parts already use) instead of run_ids,
        // so the client can pair the resumed output with the existing cards.
        let resumedPendingCalls: ResumedPendingCall[] = [];

        // Decisions that produced ToolMessages directly (rejected tools + ask_user
        // answers/declines) never execute in the tools node, so the resumed stream
        // emits no on_tool_start/on_tool_end for them — without help their cards
        // would stay pending forever (and read as "interrupted" after reload).
        // processStream re-emits these as synthetic tool input+output parts under
        // their ORIGINAL tool_call_ids at resume-stream start.
        let syntheticDecisionResults: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown>; output: string }> = [];

        // Track pre-run message count so we only persist NEW messages from this turn
        let preRunMessageCount = 0;

        // Server-side attachment validation (client checks are advisory only).
        const attachmentError = validateAttachments(messages as Message[]);
        if (attachmentError) {
            releaseLock();
            return new Response(
                JSON.stringify({ error: attachmentError }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (Array.isArray(decisions)) {
            // Per-tool decision resume (new contract; legacy role:'tool' path below still works)
            const { buildDecisionToolMessages } = await import('./decisions');
            const { pendingToolCallsOf } = await import('@/lib/agent/guard');

            const interruptState = await graph.getState(config);
            preRunMessageCount = interruptState.values?.messages?.length ?? 0;
            const nextNodes: string[] = (interruptState.next as string[] | undefined) ?? [];
            if (!nextNodes.includes('approval_gate')) {
                releaseLock();
                return new Response(JSON.stringify({ error: 'No pending approval on this thread.' }), {
                    status: 409, headers: { 'Content-Type': 'application/json' },
                });
            }
            const pending = pendingToolCallsOf(interruptState.values);
            const result = buildDecisionToolMessages(pending, decisions);
            if (!result.ok) {
                releaseLock();
                return new Response(JSON.stringify({ error: result.error }), {
                    status: 400, headers: { 'Content-Type': 'application/json' },
                });
            }
            if (result.toolMessages.length > 0) {
                await graph.updateState(config, { messages: result.toolMessages });
            }

            // Resume-stream coherence: emitting tool-input events for the approved
            // executions requires the isResumedFromApproval path in processStream.
            const firstApprovedRealTool = pending.find(
                c => c.name !== 'ask_user' && result.approvedIds.includes(c.id),
            );
            if (firstApprovedRealTool) {
                resumedToolCallId = firstApprovedRealTool.id;
            }
            // Only approved real tools execute on resume (rejected + ask_user
            // calls already received ToolMessages above).
            resumedPendingCalls = pending
                .filter(c => c.name !== 'ask_user' && result.approvedIds.includes(c.id))
                .map(c => ({ id: c.id, name: c.name, args: c.args }));

            // Rejected tools + ask_user calls got their ToolMessages written above;
            // mirror those results into the response stream as synthetic tool parts
            // so their cards resolve durably (live AND after reload).
            const decidedContentById = new Map(
                result.toolMessages.map(tm => [
                    tm.tool_call_id,
                    typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content),
                ]),
            );
            syntheticDecisionResults = pending
                .filter(c => decidedContentById.has(c.id))
                .map(c => ({
                    toolCallId: c.id,
                    toolName: c.name,
                    args: c.args,
                    output: decidedContentById.get(c.id)!,
                }));

            // Audit every decision on a mutative call (guard verdicts live in state)
            try {
                const { AuditService } = await import('@/lib/audit-service');
                const verdicts = interruptState.values?.guardVerdicts ?? {};
                for (const call of pending) {
                    const v = verdicts[call.id];
                    if (!v?.isMutative) continue;
                    const approved = result.approvedIds.includes(call.id);
                    await AuditService.logAgentEvent({
                        eventType: 'chat_tool_approval',
                        action: approved ? 'approve_mutative_tool' : 'reject_mutative_tool',
                        userId: resolvedUserId,
                        tenantId: resolvedTenantId,
                        status: 'success',
                        details: `${approved ? 'Approved' : 'Rejected'} ${call.name} (severity ${v.severity}): ${v.action}`,
                        resourceType: 'agent_tool_call',
                        resourceId: call.id,
                        metadata: { toolName: call.name, severity: v.severity, argsPreview: JSON.stringify(call.args).slice(0, 200) },
                        correlationId: threadId,
                    });
                }
            } catch (auditErr) {
                console.warn('[Chat API] approval audit failed (non-fatal):', auditErr);
            }

            input = null; // resume from the approval_gate interrupt
        } else if (lastMessage.role === 'tool') {
            // Tool result (Human-in-the-Loop approval)
            console.log(`[API] Processing tool message. Full message:`, JSON.stringify(lastMessage));
            console.log(`[API] Extracted toolCallId: ${lastMessage.toolCallId}`);

            // Store the toolCallId for use in the stream
            resumedToolCallId = lastMessage.toolCallId;

            // Capture pre-run message count for delta persistence
            try {
                const preRunState = await graph.getState(config);
                preRunMessageCount = preRunState.values?.messages?.length ?? 0;
            } catch {
                // new thread or state unavailable — count stays 0
            }

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

            // Populate the original pending calls for the resumed stream (same
            // contract as the decisions branch above). Computed AFTER the
            // rejection ToolMessage write so only calls that will actually
            // execute remain pending.
            try {
                const { pendingToolCallsOf } = await import('@/lib/agent/guard');
                const postState = await graph.getState(config);
                resumedPendingCalls = pendingToolCallsOf(postState.values ?? { messages: [] })
                    .map(c => ({ id: c.id, name: c.name, args: c.args }));
            } catch (e) {
                console.warn('[Chat API] Could not resolve pending calls for resume (non-fatal):', e);
            }

            input = null; // Resume from interrupt
        } else {
            // Get current state
            const currentState = await graph.getState(config);
            const stateMessages = currentState.values.messages || [];
            preRunMessageCount = stateMessages.length;

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
                let content: string | Array<any> = m.content;

                // Handle multimodal content with attachments
                if ((m as any).experimental_attachments?.length > 0) {
                    const textContent = typeof m.content === 'string' ? m.content :
                        (m.parts?.filter((p) => p.type === 'text').map((p) => p.text).join('') || '');

                    content = [
                        { type: 'text', text: textContent },
                        ...(m as any).experimental_attachments.map((att: any) => ({
                            type: 'image_url',
                            image_url: { url: att.url }
                        }))
                    ];
                } else if (!content && m.parts) {
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
                        content: content as string
                    });
                }
                return new HumanMessage({ content });
            });
            input = { messages: validMessages };
        }

        if (stream) {
            // Create a dedicated abort controller for graph execution.
            // Wiring req.signal → graphAbortController lets us stop the graph
            // when the client disconnects without passing req.signal directly
            // (which caused unhandled "Error: Aborted" disruptions).
            const graphAbortController = new AbortController();
            req.signal.addEventListener('abort', () => {
                console.log('[API] Client disconnected — aborting LangGraph execution');
                graphAbortController.abort();
            });

            // @ts-ignore
            const streamEvents = await graph.streamEvents(
                input as any,
                {
                    version: "v2",
                    recursionLimit: 100,
                    // Propagate the abort signal so a client "Stop" (or disconnect)
                    // actually halts the LangGraph run. LangGraph forwards this signal
                    // to every node/model call, so aborting throws an AbortError that
                    // the stream handler catches and the `finally` block uses to release
                    // the per-thread lock promptly — otherwise the run keeps executing
                    // server-side, holding the lock, and the next "continue" POST is
                    // rejected with 409 (breaking multi-turn continuity).
                    signal: graphAbortController.signal,
                    configurable: { thread_id: threadId, user_id: resolvedUserId, tenant_id: resolvedTenantId },
                    ...(langfuseCallbacks.length > 0 ? { callbacks: langfuseCallbacks } : {}),
                }
            );

            return createUIMessageStreamResponse({
                stream: processStream(
                    streamEvents,
                    autoApprove,
                    resumedToolCallId,
                    releaseLock,

                    threadId,
                    graph,
                    { configurable: { thread_id: threadId, user_id: resolvedUserId, tenant_id: resolvedTenantId } },
                    resolvedUserId,
                    resolvedTenantId,
                    preRunMessageCount,
                    resumedPendingCalls,
                    syntheticDecisionResults
                )
            });
        } else {
            const result = await graph.invoke(
                input,
                {
                    configurable: { thread_id: threadId, user_id: resolvedUserId, tenant_id: resolvedTenantId },
                    recursionLimit: 100,
                    signal: req.signal,
                    ...(langfuseCallbacks.length > 0 ? { callbacks: langfuseCallbacks } : {}),
                }
            );

            // Extract the last message content
            const lastMsg = result.messages[result.messages.length - 1];
            let content = lastMsg.content;

            // Persist NEW messages from this turn to chat history (non-streaming path)
            {
                try {
                    const allMessages: BaseMessage[] = result.messages ?? [];
                    const newMessages = allMessages.slice(preRunMessageCount);
                    if (newMessages.length > 0) {
                        const { getChatHistory: getHistory } = await import('@/lib/agent/persistence');
                        const chatHistory = await getHistory();
                        const firstHuman = allMessages.find(m => m._getType() === 'human');
                        const sessionTitle = firstHuman
                            ? (typeof firstHuman.content === 'string' ? firstHuman.content.slice(0, 60) : 'New Chat')
                            : 'New Chat';
                        const mapped = newMessages.map(m => {
                            const role = m._getType();
                            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                            const metadata: Record<string, unknown> = {};
                            if (role === 'ai') {
                                const ai = m as AIMessage;
                                if (ai.tool_calls?.length) metadata.tool_calls = ai.tool_calls;
                            }
                            if (role === 'tool') {
                                const tm = m as ToolMessage;
                                if (tm.tool_call_id) metadata.tool_call_id = tm.tool_call_id;
                            }
                            return { role, content, metadata: Object.keys(metadata).length ? metadata : undefined };
                        });
                        await chatHistory.addMessages(resolvedTenantId, resolvedUserId, threadId, mapped, sessionTitle);
                    }
                } catch (historyErr) {
                    console.warn('[API] Failed to persist chat history (non-fatal):', historyErr);
                }
            }

            // Also include tool calls if present, though likely handled by the loop if not simple text
            releaseLock();
            return NextResponse.json({
                role: 'assistant',
                content: content,
                // Include other relevant fields if necessary
            });
        }

    } catch (error) {
        releaseLock();
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
            return 'execution';   // Fast Agent: render with execution phase header like planning agent
        case 'finalize':
            return 'final';       // Fast Agent: tool-free synthesis at the iteration cap — render in the same styled "COMPLETE" card as the planning agent's final summary
        case 'call_model':
            return 'text';        // Deep Agent main model node: same rationale
        case 'tools':
            return 'execution';   // Deep Agent tool execution
        case 'guard':
        case 'approval_gate':
            return 'execution';   // Guard risk-assessment + approval pause: render under execution
        case 'memory_recall':
            return 'memory_recall';
        case 'memory_save':
            return 'memory_save';
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
        case 'memory_recall':
            return 'MEMORY_RECALL_PHASE_START\n';
        case 'memory_save':
            return 'MEMORY_SAVE_PHASE_START\n';
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
    config?: any,
    resolvedUserId?: string,
    resolvedTenantId?: string,
    preRunMessageCount = 0,
    resumedPendingCalls: ResumedPendingCall[] = [],
    syntheticDecisionResults: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown>; output: string }> = []
): ReadableStream<UIMessageChunk> {
    return new ReadableStream({
        async start(controller) {
            let partCounter = 0;
            let currentPartId = "";
            let streamStarted = false;
            let currentPhase: AgentPhase = 'text';

            // Collect phases in order of on_chat_model_start events so we can
            // annotate persisted AI messages with phase markers for history replay.
            const phaseList: AgentPhase[] = [];

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

            // Resumed-from-approval flow: original tool_call_ids consumed so far
            // and the run_id → emitted-id mapping (on_tool_end must pair its
            // output with whatever id on_tool_start emitted the input under).
            const consumedResumedIds = new Set<string>();
            const runIdToEmittedId = new Map<string, string>();

            // Track if we've emitted any actual TEXT content (not reasoning)
            // The AI SDK requires messages to have either TEXT or pending tool calls
            // Reasoning parts and completed tool calls don't satisfy this requirement
            let hasEmittedTextContent = false;

            // Memory recall/save nodes don't add messages to graph state, so they would be
            // absent from reloaded history (present only in the live stream). Accumulate their
            // streamed text here and persist them as DISPLAY-ONLY chat messages below, so the
            // history view matches the live view. This never touches the agent's LLM context
            // (that lives in the LangGraph checkpointer, not chat_messages).
            let memoryRecallText = '';
            let memorySaveText = '';

            // Per-run accumulator for the live data-memory part: reset at the start of
            // each memory model run (on_chat_model_start) and flushed as ONE
            // buildMemoryPart at on_chat_model_end, so multiple recalls/saves within a
            // single request each get their own part. This never replaces
            // memoryRecallText/memorySaveText above, which still feed persistence.
            let memoryRunText = '';

            // Per-run accumulator for reflector-node deltas: the reflector emits raw
            // JSON token-by-token, which must never stream to the client verbatim (it
            // reads as broken JSON, not thought). Buffer it here instead of enqueueing
            // reasoning-deltas live; on_chat_model_end flushes ONE humanized reasoning
            // part built from the full buffer. Reset at the start of each reflection run.
            let reflectionBuf = '';

            // Same treatment for the planner node: its model output IS the raw JSON
            // plan array, streamed token-by-token. Buffer it and flush ONE humanized
            // reasoning part ("Drafted a N-step plan: …") at on_chat_model_end — the
            // structured plan itself reaches the client via the data-plan part.
            let planningBuf = '';

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

                // Durable terminal cards for decision outcomes that never execute as
                // tools (rejections + ask_user answers/declines): emit input+output
                // parts under the ORIGINAL tool_call_ids, in the exact format the
                // live on_tool_start/on_tool_end handlers use. The client's
                // computeToolPartVisibility makes this output-bearing part win over
                // the pre-pause input-only twin, so no double card renders.
                for (const s of syntheticDecisionResults) {
                    if (!safeEnqueue({ type: 'tool-input-start', toolCallId: s.toolCallId, toolName: s.toolName })) return;
                    if (!safeEnqueue({ type: 'tool-input-available', toolCallId: s.toolCallId, toolName: s.toolName, input: s.args })) return;
                    if (!safeEnqueue({ type: 'tool-output-available', toolCallId: s.toolCallId, output: s.output })) return;
                }

                for await (const event of stream) {
                    try {
                        const runId = event.run_id || "";

                        // The guard node's model call produces internal risk verdicts
                        // (raw JSON) that go to the guardVerdicts state channel, NOT to
                        // graph `messages` — never stream it as visible reasoning, and
                        // never count it in phaseList (it persists no AIMessage, so a
                        // push would drift the positional phase fallback).
                        const isGuardModelRun =
                            event.event.startsWith("on_chat_model_") &&
                            event.metadata?.langgraph_node === 'guard';

                        if (isGuardModelRun) {
                            // Skip start/stream/end entirely. streamStarted stays false
                            // (the previous run's on_chat_model_end already closed its
                            // part), so nothing downstream references a dangling part id.
                        }
                        else if (event.event === "on_chat_model_start") {
                            const node = event.metadata?.langgraph_node;
                            currentPhase = getPhaseFromNode(node || "");
                            phaseList.push(currentPhase);
                            safeEnqueue(buildPhasePart(currentPhase, node || '') as UIMessageChunk);

                            // Ensure unique IDs per chat model run to avoid index conflicts
                            partCounter++;
                            currentPartId = `part-${runId}-${partCounter}`;
                            streamStarted = false;

                            const isMemoryPhase = currentPhase === 'memory_recall' || currentPhase === 'memory_save';
                            const isReflectionPhase = currentPhase === 'reflection';

                            if (isMemoryPhase) {
                                // Memory narration is no longer streamed as a reasoning part —
                                // it surfaces live as ONE data-memory part at on_chat_model_end.
                                // Reset the per-run accumulator; streamStarted stays false so the
                                // stream/end handlers below know there's no dangling part to close.
                                memoryRunText = '';
                            } else if (isReflectionPhase) {
                                // Same treatment: the reflector's raw JSON must never stream as
                                // reasoning. Reset the per-run buffer; streamStarted stays false
                                // so the stream/end handlers below know there's no part to close.
                                reflectionBuf = '';
                            } else if (currentPhase === 'planning') {
                                // The planner streams the raw JSON plan array — buffered, never
                                // live. Flushed humanized at on_chat_model_end.
                                planningBuf = '';
                            } else {
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';

                                if (!safeEnqueue({ type: `${chunkType}-start` as any, id: currentPartId })) break;
                                streamStarted = true;
                                // Live sentinel-marker delta emission removed (Task 4) — the
                                // buildPhasePart data-phase part above already carries the phase
                                // to the client. Persisted history still gets the marker prefix
                                // via getPhaseMarker() in the `finally` block below.
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

                            if (text) {
                                const isMemoryPhase = currentPhase === 'memory_recall' || currentPhase === 'memory_save';
                                if (isMemoryPhase) {
                                    // Capture memory-phase text for display-only history persistence
                                    // AND the per-run accumulator that becomes the live data-memory
                                    // part below — no reasoning part is streamed for these phases.
                                    if (currentPhase === 'memory_recall') memoryRecallText += text;
                                    else memorySaveText += text;
                                    memoryRunText += text;
                                } else if (currentPhase === 'reflection') {
                                    // Buffer the reflector's raw JSON deltas — never streamed live.
                                    // Flushed as one humanized reasoning part at on_chat_model_end.
                                    reflectionBuf += text;
                                } else if (currentPhase === 'planning') {
                                    // Buffer the planner's raw JSON plan deltas — never streamed live.
                                    planningBuf += text;
                                } else if (streamStarted) {
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
                        }
                        else if (event.event === "on_chat_model_end") {
                            if (streamStarted) {
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';
                                if (!safeEnqueue({ type: `${chunkType}-end` as any, id: currentPartId })) break;
                                streamStarted = false;
                            }

                            if (currentPhase === 'memory_recall' || currentPhase === 'memory_save') {
                                // Live counterpart of the reasoning stream we silenced above: emit
                                // ONE data-memory part for this run if it produced non-blank text.
                                if (memoryRunText.trim()) {
                                    safeEnqueue(buildMemoryPart(
                                        currentPhase === 'memory_save' ? 'save' : 'recall',
                                        memoryRunText,
                                    ) as UIMessageChunk);
                                }
                                memoryRunText = '';
                            }

                            if (currentPhase === 'reflection') {
                                // Live counterpart of the buffered stream above: flush ONE
                                // reasoning part built from the FULL run's buffer, humanized —
                                // the raw reflector JSON never reaches the client. Fresh id
                                // (not currentPartId — no reasoning part was ever opened for
                                // this run, since streamStarted was never set true above).
                                if (reflectionBuf.trim()) {
                                    const reflectPartId = `reflect-${runId}-${partCounter}`;
                                    safeEnqueue({ type: 'reasoning-start', id: reflectPartId });
                                    safeEnqueue({
                                        type: 'reasoning-delta',
                                        id: reflectPartId,
                                        delta: humanizeReflection(reflectionBuf),
                                    });
                                    safeEnqueue({ type: 'reasoning-end', id: reflectPartId });
                                }
                                reflectionBuf = '';
                            }

                            if (currentPhase === 'planning') {
                                // Live counterpart of the buffered planner stream above: flush ONE
                                // humanized reasoning part ("Drafted a N-step plan: …") — the raw
                                // plan JSON never reaches the client as thinking text.
                                if (planningBuf.trim()) {
                                    const planPartId = `plan-think-${runId}-${partCounter}`;
                                    safeEnqueue({ type: 'reasoning-start', id: planPartId });
                                    safeEnqueue({
                                        type: 'reasoning-delta',
                                        id: planPartId,
                                        delta: humanizePlanning(planningBuf),
                                    });
                                    safeEnqueue({ type: 'reasoning-end', id: planPartId });
                                }
                                planningBuf = '';
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
                                // This handles cases where multiple tools were queued for execution.
                                // Emit under the ORIGINAL tool_call_id (the id the pre-pause
                                // message's parts already use) so the client updates the
                                // existing card instead of duplicating it under a run_id.
                                const originalId = resolveResumedToolCallId(
                                    resumedPendingCalls, consumedResumedIds, toolName, args, toolId,
                                );
                                runIdToEmittedId.set(runId, originalId);
                                console.log("[DEBUG] Emitting tool-input for HITL resumed tool:", originalId, toolName, "(run:", toolId, ")");
                                if (!safeEnqueue({ type: "tool-input-start", toolCallId: originalId, toolName })) break;
                                if (!safeEnqueue({ type: "tool-input-available", toolCallId: originalId, toolName, input: args || {} })) break;
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

                            // For autoApprove, use run_id (matches on_tool_start).
                            // For the HITL resumed flow, pair the output with whatever id
                            // on_tool_start emitted the input under (original tool_call_id),
                            // falling back to the ToolMessage's own tool_call_id, then run_id.
                            // For initial HITL request, use the pending tool call ID from on_chat_model_end.
                            if (!autoApprove && isResumedFromApproval) {
                                const emittedId = runIdToEmittedId.get(runId);
                                const outputToolCallId = (event.data?.output as { tool_call_id?: unknown } | undefined)?.tool_call_id;
                                toolId = emittedId
                                    || (typeof outputToolCallId === 'string' && outputToolCallId ? outputToolCallId : '')
                                    || toolId;
                            } else if (!autoApprove && !isResumedFromApproval && pendingToolCalls.has(toolName)) {
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
                        else if (event.event === "on_chain_end") {
                            // Graph-node completion: stream plan snapshots when a node changed the plan.
                            // Deviation from the brief: keyed off `event.metadata?.langgraph_node` rather
                            // than `event.name`. LangGraph sets both `runName` and `metadata.langgraph_node`
                            // to the node id for the node's own chain run (pregel/algo.js), but metadata
                            // propagates to every nested child run inside that node (e.g. internal
                            // ChannelWrite steps) while `runName`/`event.name` does not — so `event.name`
                            // would miss chain-end events whose outer runnable isn't named after the node.
                            // The `Array.isArray(output?.plan)` guard below still ensures we only ever act
                            // on the one chain-end whose output is actually the node's returned partial
                            // state (internal steps have a differently-shaped output).
                            const node = event.metadata?.langgraph_node || event.name || "";
                            const output = event.data?.output as { plan?: PlanStep[] } | undefined;
                            if (
                                threadId &&
                                ["planner", "generate", "reflect", "revise", "tools"].includes(node) &&
                                Array.isArray(output?.plan) && output!.plan.length > 0
                            ) {
                                safeEnqueue(buildPlanPart(threadId, output!.plan, node) as UIMessageChunk);
                            }
                        }
                    } catch (innerError) {
                        console.error("Stream event processing error:", innerError);
                    }
                }

                // If the run parked at the approval_gate interrupt, describe the pending
                // batch as typed parts so the client can render decision cards.
                if (threadId && graph && config) {
                    try {
                        const parked = await graph.getState(config);
                        const nextNodes: string[] = (parked?.next as string[] | undefined) ?? [];
                        if (nextNodes.includes('approval_gate')) {
                            for (const part of buildInterruptParts(parked.values ?? {}, threadId)) {
                                safeEnqueue(part as UIMessageChunk);
                            }
                        }
                    } catch (e) {
                        console.warn('[Chat API] interrupt part emission failed (non-fatal):', e);
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
                    if (isAbortError) {
                        // Client went away — just close cleanly.
                        controller.close();
                    } else {
                        // Surface the REAL backend error to the client instead of a generic
                        // "network error". The AI SDK turns an `error` stream part into
                        // `new Error(errorText)`, which the chat UI renders as error.message.
                        const errorText = buildClientErrorText(error);
                        if (safeEnqueue({ type: 'error', errorText })) {
                            // Error part delivered — close cleanly so the client shows errorText.
                            controller.close();
                        } else {
                            // Stream already torn down; fall back to erroring the controller.
                            controller.error(error);
                        }
                    }
                } catch (e) {
                    // Ignore if already closed
                }
            } finally {

                // Persist NEW messages from this turn to chat history
                if (threadId && graph && config && resolvedUserId) {
                    try {
                        const finalState = await graph.getState(config);
                        const allMessages: BaseMessage[] = finalState?.values?.messages ?? [];
                        const newMessages = allMessages.slice(preRunMessageCount);
                        console.log(`[Chat API] Final state has ${allMessages.length} messages (${newMessages.length} new) for thread ${threadId}`);
                        if (newMessages.length > 0) {
                            // Annotate new AI messages with phase markers before persisting so that
                            // the history route can reconstruct reasoning/phase parts on reload.
                            let aiIndex = 0;
                            for (const msg of newMessages) {
                                if (msg._getType() === 'ai') {
                                    // Prefer the phase tagged on the message by its originating
                                    // graph node (exact). Fall back to the positional phaseList
                                    // only for untagged messages (e.g. deep agent). The positional
                                    // mapping drifts when non-persisted model calls (memory/reflector)
                                    // add phaseList entries, so it must not be the primary source.
                                    const taggedPhase = (msg as { response_metadata?: { agentPhase?: string } }).response_metadata?.agentPhase;
                                    const phase = taggedPhase ?? phaseList[aiIndex] ?? 'text';
                                    if (phase !== 'text') {
                                        const marker = getPhaseMarker(phase);
                                        if (marker && typeof msg.content === 'string') {
                                            // reflectNode persists its already-formatted feedback
                                            // string (🔍 Reflection Analysis / ⚠️ Issues Found /
                                            // 💡 Suggestions), not raw JSON — humanizeReflection
                                            // recognizes that format and normalizes it to the SAME
                                            // prose shape as the live reasoning part above, so
                                            // history replay matches what was streamed live.
                                            const content = phase === 'reflection'
                                                ? humanizeReflection(msg.content)
                                                : msg.content;
                                            msg.content = marker + content;
                                        }
                                    }
                                    aiIndex++;
                                }
                            }

                            const { getChatHistory: getHistory } = await import('@/lib/agent/persistence');
                            const chatHistory = await getHistory();
                            const firstHuman = allMessages.find(m => m._getType() === 'human');
                            const sessionTitle = firstHuman
                                ? (typeof firstHuman.content === 'string' ? firstHuman.content.slice(0, 60) : 'New Chat')
                                : 'New Chat';
                            const mapped = newMessages.map(m => {
                                const role = m._getType();
                                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                                const metadata: Record<string, unknown> = {};
                                if (role === 'ai') {
                                    const ai = m as AIMessage;
                                    if (ai.tool_calls?.length) metadata.tool_calls = ai.tool_calls;
                                }
                                if (role === 'tool') {
                                    const tm = m as ToolMessage;
                                    if (tm.tool_call_id) metadata.tool_call_id = tm.tool_call_id;
                                }
                                return { role, content, metadata: Object.keys(metadata).length ? metadata : undefined };
                            });

                            // Insert display-only memory messages so history matches the live view.
                            // Phase markers are prepended here (these aren't graph-state messages, so
                            // they bypass the marker loop above); the history route reconstructs them
                            // as collapsible reasoning blocks.
                            if (memoryRecallText.trim()) {
                                const recallMsg = { role: 'ai', content: getPhaseMarker('memory_recall') + memoryRecallText, metadata: undefined };
                                const humanIdx = mapped.findIndex(m => m.role === 'human');
                                mapped.splice(humanIdx >= 0 ? humanIdx + 1 : 0, 0, recallMsg);
                            }
                            if (memorySaveText.trim()) {
                                mapped.push({ role: 'ai', content: getPhaseMarker('memory_save') + memorySaveText, metadata: undefined });
                            }

                            await chatHistory.addMessages(resolvedTenantId ?? 'default', resolvedUserId, threadId, mapped, sessionTitle);
                            console.log(`[Chat API] Persisted ${mapped.length} new messages for thread ${threadId} (userId=${resolvedUserId})`);
                        }
                    } catch (err) {
                        console.error('[Chat API] Failed to persist message history:', err);
                    }
                }
                // Release the per-thread lock so subsequent requests can proceed
                onDone?.();
            }
        }
    });
}
