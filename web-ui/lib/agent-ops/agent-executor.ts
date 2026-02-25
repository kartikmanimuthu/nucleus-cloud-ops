/**
 * Agent Executor — Bridges trigger endpoints with the existing LangGraph agent.
 *
 * Provides concurrency-safe isolated execution:
 * - Unique threadId per run (prevents LangGraph state collisions)
 * - Isolated sandbox directory for file operations
 * - Independent AWS credentials context per run
 * - Records ALL execution events to DynamoDB via agentOpsService
 *
 * Event recording covers every LangGraph event:
 *   on_chain_start/end  → node lifecycle (planner, generate, reflect, revise, final, agent, tools)
 *   on_chat_model_start → LLM inference started (captured with model name)
 *   on_chat_model_stream → streaming chunks (skipped — too noisy, we capture final)
 *   on_chat_model_end   → LLM text output, tool_calls, token usage
 *   on_tool_start       → tool invocation with arguments
 *   on_tool_end         → tool execution result
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { HumanMessage } from '@langchain/core/messages';
import { createDynamicExecutorGraph } from './executor-graphs';
import { agentOpsService } from './agent-ops-service';
import { getMCPManager } from '../agent/mcp-manager';
import { AgentOpsRunModel } from './models/agent-ops-run';
import { postClarificationToSlack } from './slack-notifier';
import { postClarificationToJira } from './jira-notifier';
import type { AgentOpsRun, AgentEventType, SlackTriggerMeta, JiraTriggerMeta, JiraIntegrationConfig } from './types';

const SANDBOX_BASE = '/tmp/agent-ops';

// ─── Node → EventType mapping ───────────────────────────────────────────

/**
 * Maps LangGraph node names to human-readable event types stored in DynamoDB.
 * Planning-agent nodes: planner, generate, tools, reflect, revise, final
 * Fast-agent nodes:     agent, tools, reflect
 */
function mapNodeToEventType(node: string): AgentEventType {
    switch (node) {
        case 'planner': return 'planning';
        case 'evaluator': return 'planning';
        case 'clarify': return 'planning';
        case 'generate': return 'execution';
        case 'agent': return 'execution';
        case 'reflect': return 'reflection';
        case 'revise': return 'revision';
        case 'final': return 'final';
        case 'tools': return 'tool_call';
        default: return 'execution';
    }
}

// ─── Main Executor ──────────────────────────────────────────────────────

/**
 * Execute an agent-ops run in a fully isolated environment.
 * Called asynchronously from trigger endpoints (fire-and-forget).
 *
 * Full execution lifecycle:
 * 1. Create isolated sandbox dir
 * 2. Mark run as in_progress
 * 3. Build graph config
 * 4. Create LangGraph (plan or fast)
 * 5. Stream all events, recording each to DynamoDB
 * 6. Capture final result
 * 7. Mark run completed/failed
 * 8. Cleanup sandbox
 */
export async function executeAgentRun(run: AgentOpsRun): Promise<void> {
    const { runId, tenantId, taskDescription, mode, accountId, accountName, selectedSkill, threadId, workspaceId, mcpServerIds } = run as any;
    const startTime = Date.now();

    // 1. Create isolated sandbox directory (prevents file-tool collisions between concurrent runs)
    const sandboxDir = path.join(SANDBOX_BASE, runId);
    await fs.mkdir(sandboxDir, { recursive: true });
    console.log(`[AgentExecutor] ▶ Run ${runId} starting (mode: ${mode})`);
    console.log(`[AgentExecutor]   Sandbox: ${sandboxDir}`);
    console.log(`[AgentExecutor]   Task: "${taskDescription.slice(0, 100)}"`);

    try {
        // 2. Mark run in_progress (records start)
        await agentOpsService.updateRunStatus(tenantId, runId, 'in_progress');

        // Load MCP server configs from DynamoDB (merged with defaults) and connect
        const mcpManager = getMCPManager();
        if (mcpServerIds && mcpServerIds.length > 0) {
            try {
                const { TenantConfigService } = await import('../tenant-config-service');
                const { mergeConfigs } = await import('../agent/mcp-config');
                const savedJson = await TenantConfigService.getConfig('mcp-servers');
                const allConfigs = mergeConfigs(savedJson);
                await mcpManager.connectServers(mcpServerIds, allConfigs);
                console.log(`[AgentExecutor] Connected MCP servers: ${mcpServerIds.join(', ')}`);
            } catch (mcpErr) {
                console.warn(`[AgentExecutor] MCP server connection failed (non-fatal):`, mcpErr);
            }
        }



        // Record initial "started" event
        await agentOpsService.recordEvent({
            runId,
            eventType: 'planning',
            node: '__start__',
            content: `Agent run started. Task: ${taskDescription}`,
            metadata: { accountId, accountName },
        });

        // 3. Build GraphConfig matching the expected agent inputs
        const graphConfig = {
            model: 'global.anthropic.claude-sonnet-4-6',
            autoApprove: true,
            accounts: accountId ? [{ accountId, accountName: accountName || accountId }] : [],
            accountId,
            accountName,
            mcpServerIds: mcpServerIds || [],
        };

        // 4. Create the unified dynamic graph
        console.log(`[AgentExecutor] Creating Dynamic Executor Graph...`);
        const graph = await createDynamicExecutorGraph(graphConfig);

        // Display compiled Graph Mermaid visualization
        try {
            const mermaidGraph = graph.getGraph().drawMermaid();
            console.log(`\n================================================================================`);
            console.log(`📊 Compiled LangGraph Workflow (DynamicExecutorGraph):`);
            console.log(`================================================================================`);
            console.log(mermaidGraph);
            console.log(`================================================================================\n`);
        } catch (err) {
            console.warn(`[AgentExecutor] Failed to generate mermaid graph:`, err);
        }

        // 6. Build input for the graph
        const graphInput = {
            messages: [new HumanMessage(taskDescription)],
        };

        // Unique threadId for checkpointer isolation (each run gets its own LangGraph state)
        const graphRunConfig = {
            configurable: { thread_id: threadId },
            recursionLimit: 50,
        };

        // ─── Event tracking state ─────────────────────────────────────
        const toolsUsed = new Set<string>();
        let iterationCount = 0;
        let finalContent = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        // streamEvents returns an AsyncIterable (NOT a Promise — do NOT await it)
        // Cast to `any` here: LangGraph's compiled graph is a union of two incompatible
        // compiled graph types (planning vs fast), whose streamEvents signatures don't unify.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eventStream = (graph as any).streamEvents(graphInput, {
            version: 'v2',
            ...graphRunConfig,
        }) as AsyncIterable<any>;

        // ─── 6. Process every LangGraph streaming event ───────────────
        for await (const event of eventStream) {
            try {
                const processed = await processLangGraphEvent(runId, event, toolsUsed);
                if (processed) {
                    iterationCount += processed.iterationDelta || 0;
                    totalInputTokens += processed.inputTokens || 0;
                    totalOutputTokens += processed.outputTokens || 0;
                    if (processed.finalContent) {
                        finalContent = processed.finalContent;
                    }
                }
            } catch (eventError) {
                // Never let event recording failures abort the run
                console.error(`[AgentExecutor] Event recording error (non-fatal):`, eventError);
            }
        }

        // ─── 7. Check for awaiting_input (clarification needed) ──────
        // After streaming completes, inspect final graph state to see if
        // the clarifyNode set nextAction='awaiting_input'.
        let finalGraphState: any = null;
        try {
            finalGraphState = await (graph as any).getState({ configurable: { thread_id: threadId } });
        } catch {
            // Non-fatal — we'll fall through to normal completion
        }

        const stateValues = finalGraphState?.values as any;
        if (stateValues?.nextAction === 'awaiting_input' && stateValues?.clarificationQuestion) {
            const clarificationQuestion = stateValues.clarificationQuestion as string;
            const missingInfo = stateValues.evaluation?.missingInfo as string | null;

            console.log(`[AgentExecutor] ❓ Run ${runId} awaiting user input`);
            console.log(`[AgentExecutor]   Question: "${clarificationQuestion}"`);

            await agentOpsService.updateRunStatus(tenantId, runId, 'awaiting_input', {
                clarification: { question: clarificationQuestion, missingInfo: missingInfo || 'Additional information' },
            });

            await agentOpsService.recordEvent({
                runId,
                eventType: 'final',
                node: 'clarify',
                content: clarificationQuestion,
                metadata: { missingInfo },
            });

            // Post clarification question back to the originating channel/issue
            try {
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                if (freshRun) {
                    if (freshRun.source === 'slack') {
                        const slackTrigger = freshRun.trigger as SlackTriggerMeta;
                        await postClarificationToSlack(clarificationQuestion, freshRun.runId, slackTrigger.responseUrl);
                    } else if (freshRun.source === 'jira') {
                        const { TenantConfigService } = await import('../tenant-config-service');
                        const jiraConfig = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira').catch(() => undefined);
                        const jiraTrigger = freshRun.trigger as JiraTriggerMeta;
                        if (jiraTrigger.issueKey) {
                            await postClarificationToJira(clarificationQuestion, freshRun.runId, jiraTrigger.issueKey, jiraConfig ?? undefined);
                        }
                    }
                }
            } catch (notifyErr) {
                console.warn(`[AgentExecutor] Failed to post clarification (non-fatal):`, notifyErr);
            }

            return; // Do not proceed to 'completed'
        }

        // ─── 8. Mark completed and record result ──────────────────────
        const durationMs = Date.now() - startTime;

        const resultSummary = finalContent || 'Agent execution completed (no explicit final summary).';

        await agentOpsService.updateRunStatus(tenantId, runId, 'completed', {
            result: {
                summary: resultSummary,
                toolsUsed: Array.from(toolsUsed),
                iterations: iterationCount,
            },
        });

        // Write duration as a separate update (Dynamoose doesn't merge partial updates well)
        await AgentOpsRunModel.update(
            { PK: `TENANT#${tenantId}`, SK: `RUN#${runId}` },
            { durationMs }
        );

        // Record completion event
        await agentOpsService.recordEvent({
            runId,
            eventType: 'final',
            node: '__end__',
            content: resultSummary.slice(0, 5000),
            metadata: {
                durationMs,
                iterations: iterationCount,
                toolsUsed: Array.from(toolsUsed),
                totalInputTokens,
                totalOutputTokens,
            },
        });

        console.log(`[AgentExecutor] ✅ Run ${runId} completed in ${durationMs}ms`);
        console.log(`[AgentExecutor]   Iterations: ${iterationCount}, Tools used: ${toolsUsed.size}, Tokens: ${totalInputTokens}→${totalOutputTokens}`);

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        console.error(`[AgentExecutor] ❌ Run ${runId} failed:`, errorMsg);

        await agentOpsService.updateRunStatus(tenantId, runId, 'failed', {
            error: errorMsg,
        });

        await agentOpsService.recordEvent({
            runId,
            eventType: 'error',
            node: 'executor',
            content: errorMsg,
            metadata: { stack: errorStack?.slice(0, 2000) },
        });
    } finally {
        // 8. Always clean up the sandbox directory
        try {
            await fs.rm(sandboxDir, { recursive: true, force: true });
            console.log(`[AgentExecutor] Sandbox cleaned: ${sandboxDir}`);
        } catch {
            console.warn(`[AgentExecutor] Sandbox cleanup failed (non-fatal): ${sandboxDir}`);
        }
    }
}

// ─── Event Processor ────────────────────────────────────────────────────

interface EventProcessingResult {
    iterationDelta?: number;
    inputTokens?: number;
    outputTokens?: number;
    finalContent?: string;
}

/**
 * Processes a single LangGraph streamEvents v2 event and writes it to DynamoDB.
 *
 * LangGraph v2 event structure:
 *   event:    string  — the event kind
 *   name:     string  — node name or chain name
 *   data:     object  — event-specific payload
 *   metadata: object  — { langgraph_node, langgraph_step, ... }
 *
 * Events we care about:
 *   on_chain_start     → node lifecycle start (captures planner/generate/reflect etc)
 *   on_chain_end       → node lifecycle end (captures output state)
 *   on_chat_model_start → LLM call started
 *   on_chat_model_end  → LLM response with content + tool_calls + token usage
 *   on_tool_start      → tool invoked with arguments
 *   on_tool_end        → tool result received
 */
async function processLangGraphEvent(
    runId: string,
    event: any,
    toolsUsed: Set<string>
): Promise<EventProcessingResult> {
    const result: EventProcessingResult = {};

    // The node name is in event.metadata.langgraph_node for node-level events
    // For tool events, the tool name is in event.name
    const node = event.metadata?.langgraph_node || event.name || 'unknown';

    switch (event.event) {
        // ── Node lifecycle: capture when key agent nodes start ────────
        case 'on_chain_start': {
            // Record significant node starts (skip generic chain wrappers)
            const significantNodes = ['evaluator', 'clarify', 'planner', 'generate', 'reflect', 'final', 'tools'];
            if (significantNodes.includes(node)) {
                let eventType = mapNodeToEventType(node);
                if (node === 'evaluator') {
                    eventType = 'planning'; // Overload planning as we don't have evaluation yet
                }
                await agentOpsService.recordEvent({
                    runId,
                    eventType,
                    node,
                    content: `Node "${node}" started`,
                    metadata: {
                        step: event.metadata?.langgraph_step,
                        checkpoint: event.metadata?.checkpoint_id,
                    },
                });

                // Track iterations for planner/generate/agent nodes
                if (node === 'generate' || node === 'agent') {
                    result.iterationDelta = 1;
                }
            }
            break;
        }

        // ── Node lifecycle end: capture output for key nodes ──────────
        case 'on_chain_end': {
            // For the 'final' node, extract the final summary message
            if (node === 'final') {
                const output = event.data?.output;
                if (output?.messages && Array.isArray(output.messages)) {
                    const lastMsg = output.messages[output.messages.length - 1];
                    if (lastMsg?.content) {
                        const content = typeof lastMsg.content === 'string'
                            ? lastMsg.content
                            : JSON.stringify(lastMsg.content);
                        result.finalContent = content;
                    }
                }
            }

            // Capture reflection output (plan status updates, analysis)
            if (node === 'reflect') {
                const output = event.data?.output;
                if (output?.reflection) {
                    await agentOpsService.recordEvent({
                        runId,
                        eventType: 'reflection',
                        node,
                        content: String(output.reflection).slice(0, 5000),
                        metadata: {
                            isComplete: output.isComplete,
                            errors: output.errors,
                        },
                    });
                }
            }

            // Capture planner output (the plan itself)
            if (node === 'planner') {
                const output = event.data?.output;
                if (output?.plan && Array.isArray(output.plan)) {
                    const planText = output.plan
                        .map((s: any, i: number) => `${i + 1}. ${s.step}`)
                        .join('\n');
                    await agentOpsService.recordEvent({
                        runId,
                        eventType: 'planning',
                        node,
                        content: `Plan created:\n${planText}`,
                        metadata: {
                            stepCount: output.plan.length,
                            steps: output.plan,
                        },
                    });
                }
            }
            break;
        }

        // ── LLM call started: capture which model and which node ──────
        case 'on_chat_model_start': {
            const eventType = mapNodeToEventType(node);
            const modelName = event.name || 'unknown-model';
            const inputMessages = event.data?.messages;
            let inputPreview = '';

            if (inputMessages && Array.isArray(inputMessages) && inputMessages.length > 0) {
                // Get the last message as a preview of what the LLM is seeing
                const lastGroup = inputMessages[inputMessages.length - 1];
                if (Array.isArray(lastGroup) && lastGroup.length > 0) {
                    const lastMsg = lastGroup[lastGroup.length - 1];
                    const content = lastMsg?.content || lastMsg?.text || '';
                    inputPreview = (typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 500);
                }
            }

            await agentOpsService.recordEvent({
                runId,
                eventType,
                node,
                content: `LLM call started${inputPreview ? ` — context: ${inputPreview}` : ''}`,
                metadata: {
                    model: modelName,
                    step: event.metadata?.langgraph_step,
                },
            });
            break;
        }

        // ── LLM response: the richest event — text content + tool calls + tokens ─
        case 'on_chat_model_end': {
            const output = event.data?.output;
            if (!output) break;

            // Extract token usage
            const usageMetadata = output.usage_metadata || output.response_metadata?.usage;
            if (usageMetadata) {
                result.inputTokens = usageMetadata.input_tokens || usageMetadata.prompt_tokens || 0;
                result.outputTokens = usageMetadata.output_tokens || usageMetadata.completion_tokens || 0;
            }

            const eventType = mapNodeToEventType(node);

            // Case A: LLM generated tool calls
            const toolCalls = output.tool_calls || [];
            if (toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    toolsUsed.add(tc.name);
                    await agentOpsService.recordEvent({
                        runId,
                        eventType: 'tool_call',
                        node,
                        toolName: tc.name,
                        toolArgs: tc.args || tc.input || {},
                        content: `Tool call: ${tc.name}(${JSON.stringify(tc.args || tc.input || {}).slice(0, 1000)})`,
                        metadata: {
                            toolCallId: tc.id,
                            inputTokens: result.inputTokens,
                            outputTokens: result.outputTokens,
                            model: event.name,
                        },
                    });
                }
            }

            // Case B: LLM generated text content (might exist alongside tool calls)
            const rawContent = output.content;
            if (rawContent) {
                const contentStr = typeof rawContent === 'string'
                    ? rawContent
                    : JSON.stringify(rawContent);

                if (contentStr.trim().length > 0) {
                    // Capture final content if from final or agent node
                    if (node === 'final' || (node === 'generate' && !toolCalls.length)) {
                        result.finalContent = contentStr;
                    }

                    // Record the text response
                    await agentOpsService.recordEvent({
                        runId,
                        eventType,
                        node,
                        content: contentStr.slice(0, 10000),
                        metadata: {
                            inputTokens: result.inputTokens,
                            outputTokens: result.outputTokens,
                            model: event.name,
                            hasToolCalls: toolCalls.length > 0,
                        },
                    });
                }
            }

            // If neither content nor tool_calls (edge case), record a minimal event
            if (!rawContent && toolCalls.length === 0) {
                await agentOpsService.recordEvent({
                    runId,
                    eventType,
                    node,
                    content: 'LLM responded (no text content or tool calls)',
                    metadata: {
                        inputTokens: result.inputTokens,
                        outputTokens: result.outputTokens,
                        model: event.name,
                    },
                });
            }
            break;
        }

        // ── Tool start: tool about to be invoked ──────────────────────
        case 'on_tool_start': {
            const toolName = event.name || 'unknown-tool';
            const toolInput = event.data?.input || {};
            toolsUsed.add(toolName);

            await agentOpsService.recordEvent({
                runId,
                eventType: 'tool_call',
                node: node || toolName,
                toolName,
                toolArgs: typeof toolInput === 'object' ? toolInput : { input: toolInput },
                content: `Executing tool: ${toolName}`,
                metadata: {
                    step: event.metadata?.langgraph_step,
                },
            });
            break;
        }

        // ── Tool end: tool result received ────────────────────────────
        case 'on_tool_end': {
            const toolName = event.name || 'unknown-tool';
            const output = event.data?.output;

            // Extract string output from various possible shapes
            let outputStr: string;
            if (typeof output === 'string') {
                outputStr = output;
            } else if (output && typeof output === 'object') {
                if ('content' in output) {
                    outputStr = typeof output.content === 'string'
                        ? output.content
                        : JSON.stringify(output.content);
                } else {
                    outputStr = JSON.stringify(output);
                }
            } else {
                outputStr = String(output ?? '');
            }

            await agentOpsService.recordEvent({
                runId,
                eventType: 'tool_result',
                node: node || toolName,
                toolName,
                toolOutput: outputStr.slice(0, 10000),
                content: `Tool result from ${toolName}: ${outputStr.slice(0, 500)}`,
                metadata: {
                    step: event.metadata?.langgraph_step,
                    outputLength: outputStr.length,
                },
            });
            break;
        }

        // All other event types (on_chain_stream, on_chat_model_stream, etc.)
        // are intentionally ignored to avoid DynamoDB write amplification
        default:
            break;
    }

    return result;
}
