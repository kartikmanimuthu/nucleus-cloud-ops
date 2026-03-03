/**
 * Agent Executor — Bridges trigger endpoints with the Agent Ops LangGraph.
 *
 * Key capabilities:
 * - Isolated sandbox per run (prevents file-tool collisions)
 * - AbortController-based cancel/stop via run-manager
 * - DynamoDB checkpointer (short-term state) + store (long-term memory)
 * - Full LangGraph event streaming → DynamoDB event log
 * - Clarification (awaiting_input) and interrupt (tool approval) support
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
import { registerRun, cleanupRun, isAborted } from './run-manager';
import type { AgentOpsRun, AgentEventType, SlackTriggerMeta, JiraTriggerMeta, JiraIntegrationConfig } from './types';

const SANDBOX_BASE = '/tmp/agent-ops';

// ─── Node → EventType mapping ────────────────────────────────────────────────

function mapNodeToEventType(node: string): AgentEventType {
    switch (node) {
        case 'planner':
        case 'evaluator':
        case 'clarify':   return 'planning';
        case 'generate':
        case 'agent':     return 'execution';
        case 'reflect':   return 'reflection';
        case 'revise':    return 'revision';
        case 'final':     return 'final';
        case 'tools':     return 'tool_call';
        default:          return 'execution';
    }
}

// ─── Derive userId from trigger metadata ─────────────────────────────────────

function deriveUserId(run: AgentOpsRun): string {
    const trigger = run.trigger as any;
    if (run.source === 'slack' && trigger?.userId) return `slack-${trigger.userId}`;
    if (run.source === 'jira' && trigger?.reporter) return `jira-${trigger.reporter}`;
    if (run.source === 'api' && trigger?.clientId) return `api-${trigger.clientId}`;
    return `tenant-${run.tenantId}`;
}

// ─── Main Executor ────────────────────────────────────────────────────────────

export async function executeAgentRun(run: AgentOpsRun): Promise<void> {
    const { runId, tenantId, taskDescription, accountId, accountName, threadId, mcpServerIds } = run as any;
    const autoApprove = (run as any).autoApprove ?? true;
    const startTime = Date.now();

    // Register AbortController for cancel support
    const abortController = registerRun(runId);

    const sandboxDir = path.join(SANDBOX_BASE, runId);
    await fs.mkdir(sandboxDir, { recursive: true });
    console.log(`[AgentExecutor] ▶ Run ${runId} starting`);

    try {
        await agentOpsService.updateRunStatus(tenantId, runId, 'in_progress');

        // ── Connect MCP servers ───────────────────────────────────────────────
        const mcpManager = getMCPManager();
        let activeMcpServerIds: string[] = mcpServerIds || [];

        try {
            const { TenantConfigService } = await import('../tenant-config-service');
            const { mergeConfigs } = await import('../agent/mcp-config');
            const savedJson = await TenantConfigService.getConfig('mcp-servers', tenantId);
            const allConfigs = mergeConfigs(savedJson);
            if (activeMcpServerIds.length === 0) {
                activeMcpServerIds = allConfigs.filter(c => c.enabled).map(c => c.id);
            }
            if (activeMcpServerIds.length > 0) {
                await mcpManager.connectServers(activeMcpServerIds, allConfigs);
            }
        } catch (mcpErr) {
            console.warn(`[AgentExecutor] MCP connection failed (non-fatal):`, mcpErr);
        }

        await agentOpsService.recordEvent({
            runId, eventType: 'planning', node: '__start__',
            content: `Agent run started. Task: ${taskDescription}`,
            metadata: { accountId, accountName },
        });

        // ── Build graph ───────────────────────────────────────────────────────
        const graphConfig = {
            model: (run as any).model || 'global.anthropic.claude-sonnet-4-6',
            autoApprove,
            accounts: accountId ? [{ accountId, accountName: accountName || accountId }] : [],
            accountId,
            accountName,
            mcpServerIds: activeMcpServerIds,
            tenantId,
            userId: deriveUserId(run),
        };

        const graph = await createDynamicExecutorGraph(graphConfig);

        try {
            console.log(`\n📊 Graph:\n${graph.getGraph().drawMermaid()}\n`);
        } catch { /* non-fatal */ }

        const graphInput = { messages: [new HumanMessage(taskDescription)] };
        const graphRunConfig = { configurable: { thread_id: threadId }, recursionLimit: 50 };

        // ── Event tracking ────────────────────────────────────────────────────
        const toolsUsed = new Set<string>();
        let iterationCount = 0;
        let finalContent = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eventStream = (graph as any).streamEvents(graphInput, {
            version: 'v2',
            ...graphRunConfig,
            signal: abortController.signal,
        }) as AsyncIterable<any>;

        for await (const event of eventStream) {
            // Check for cancellation on every event
            if (isAborted(runId)) {
                console.log(`[AgentExecutor] 🛑 Run ${runId} cancelled`);
                break;
            }

            try {
                const processed = await processLangGraphEvent(runId, event, toolsUsed);
                if (processed) {
                    iterationCount += processed.iterationDelta || 0;
                    totalInputTokens += processed.inputTokens || 0;
                    totalOutputTokens += processed.outputTokens || 0;
                    if (processed.finalContent) finalContent = processed.finalContent;
                }
            } catch (eventError) {
                console.error(`[AgentExecutor] Event recording error (non-fatal):`, eventError);
            }
        }

        // ── Handle cancellation ───────────────────────────────────────────────
        if (isAborted(runId)) {
            await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
            await agentOpsService.recordEvent({
                runId, eventType: 'final', node: '__cancelled__',
                content: 'Run was cancelled by user.',
                metadata: { durationMs: Date.now() - startTime },
            });
            return;
        }

        // ── Check final graph state ───────────────────────────────────────────
        let finalGraphState: any = null;
        try {
            finalGraphState = await (graph as any).getState({ configurable: { thread_id: threadId } });
        } catch { /* non-fatal */ }

        const stateValues = finalGraphState?.values as any;

        // ── Handle clarification needed ───────────────────────────────────────
        if (stateValues?.nextAction === 'awaiting_input' && stateValues?.clarificationQuestion) {
            const question = stateValues.clarificationQuestion as string;
            const missingInfo = stateValues.evaluation?.missingInfo as string | null;

            await agentOpsService.updateRunStatus(tenantId, runId, 'awaiting_input', {
                clarification: { question, missingInfo: missingInfo || 'Additional information' },
            });
            await agentOpsService.recordEvent({
                runId, eventType: 'final', node: 'clarify',
                content: question, metadata: { missingInfo },
            });

            try {
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                if (freshRun?.source === 'slack') {
                    await postClarificationToSlack(question, freshRun, (freshRun.trigger as SlackTriggerMeta).responseUrl);
                } else if (freshRun?.source === 'jira') {
                    const { TenantConfigService } = await import('../tenant-config-service');
                    const jiraConfig = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira').catch(() => undefined);
                    const jiraTrigger = freshRun.trigger as JiraTriggerMeta;
                    if (jiraTrigger.issueKey) {
                        await postClarificationToJira(question, runId, jiraTrigger.issueKey, jiraConfig ?? undefined);
                    }
                }
            } catch (notifyErr) {
                console.warn(`[AgentExecutor] Clarification notify failed (non-fatal):`, notifyErr);
            }
            return;
        }

        // ── Handle tool interrupt (awaiting approval) ─────────────────────────
        if (!autoApprove && finalGraphState?.tasks?.length > 0) {
            const pendingTools = finalGraphState.tasks
                .filter((t: any) => t.interrupts?.length > 0)
                .map((t: any) => t.name);

            if (pendingTools.length > 0) {
                await agentOpsService.updateRunStatus(tenantId, runId, 'awaiting_input', {
                    clarification: {
                        question: `Approval required for tools: ${pendingTools.join(', ')}`,
                        missingInfo: 'tool_approval',
                    },
                });
                await agentOpsService.recordEvent({
                    runId, eventType: 'final', node: 'interrupt',
                    content: `Awaiting approval for: ${pendingTools.join(', ')}`,
                    metadata: { pendingTools },
                });
                return;
            }
        }

        // ── Mark completed ────────────────────────────────────────────────────
        const durationMs = Date.now() - startTime;
        const resultSummary = finalContent || 'Agent execution completed.';

        await agentOpsService.updateRunStatus(tenantId, runId, 'completed', {
            result: { summary: resultSummary, toolsUsed: Array.from(toolsUsed), iterations: iterationCount },
        });
        await AgentOpsRunModel.update(
            { PK: `TENANT#${tenantId}`, SK: `RUN#${runId}` },
            { durationMs }
        );
        await agentOpsService.recordEvent({
            runId, eventType: 'final', node: '__end__',
            content: resultSummary.slice(0, 5000),
            metadata: { durationMs, iterations: iterationCount, toolsUsed: Array.from(toolsUsed), totalInputTokens, totalOutputTokens },
        });

        console.log(`[AgentExecutor] ✅ Run ${runId} completed in ${durationMs}ms | Tokens: ${totalInputTokens}→${totalOutputTokens}`);

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // AbortError = user-initiated cancel — don't mark as failed
        const isAbortError = errorMsg === 'This operation was aborted'
            || (error instanceof Error && error.name === 'AbortError')
            || isAborted(runId);

        if (isAbortError) {
            console.log(`[AgentExecutor] 🛑 Run ${runId} cancelled (abort caught)`);
            await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
            await agentOpsService.recordEvent({
                runId, eventType: 'final', node: '__cancelled__',
                content: 'Run was cancelled by user.',
                metadata: { durationMs: Date.now() - startTime },
            });
        } else {
            console.error(`[AgentExecutor] ❌ Run ${runId} failed:`, errorMsg);
            await agentOpsService.updateRunStatus(tenantId, runId, 'failed', { error: errorMsg });
            await agentOpsService.recordEvent({
                runId, eventType: 'error', node: 'executor',
                content: errorMsg,
                metadata: { stack: (error instanceof Error ? error.stack : '')?.slice(0, 2000) },
            });
        }
    } finally {
        cleanupRun(runId);
        try {
            await fs.rm(sandboxDir, { recursive: true, force: true });
        } catch { /* non-fatal */ }
    }
}

// ─── Event Processor ─────────────────────────────────────────────────────────

interface EventProcessingResult {
    iterationDelta?: number;
    inputTokens?: number;
    outputTokens?: number;
    finalContent?: string;
}

async function processLangGraphEvent(
    runId: string,
    event: any,
    toolsUsed: Set<string>
): Promise<EventProcessingResult> {
    const result: EventProcessingResult = {};
    const node = event.metadata?.langgraph_node || event.name || 'unknown';

    switch (event.event) {
        // ── Node lifecycle end: capture structured output for key nodes ───────
        case 'on_chain_end': {
            if (node === 'final') {
                const lastMsg = event.data?.output?.messages?.slice(-1)[0];
                if (lastMsg?.content) {
                    result.finalContent = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
                }
            }
            if (node === 'reflect' && event.data?.output?.reflection) {
                await agentOpsService.recordEvent({
                    runId, eventType: 'reflection', node,
                    content: String(event.data.output.reflection).slice(0, 5000),
                    metadata: { isComplete: event.data.output.isComplete, errors: event.data.output.errors },
                });
            }
            if (node === 'planner' && Array.isArray(event.data?.output?.plan)) {
                const planText = event.data.output.plan.map((s: any, i: number) => `${i + 1}. ${s.step}`).join('\n');
                await agentOpsService.recordEvent({
                    runId, eventType: 'planning', node,
                    content: `Plan created:\n${planText}`,
                    metadata: { stepCount: event.data.output.plan.length, steps: event.data.output.plan },
                });
            }
            if (node === 'evaluator' && event.data?.output?.evaluation) {
                const eval_ = event.data.output.evaluation;
                await agentOpsService.recordEvent({
                    runId, eventType: 'planning', node,
                    content: JSON.stringify(eval_, null, 2),
                    metadata: { mode: eval_.mode, skillId: eval_.skillId },
                });
            }
            break;
        }

        // ── LLM response: tool calls + thinking text + token usage ────────────
        case 'on_chat_model_end': {
            const output = event.data?.output;
            if (!output) break;

            const usage = output.usage_metadata || output.response_metadata?.usage;
            if (usage) {
                result.inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
                result.outputTokens = usage.output_tokens || usage.completion_tokens || 0;
            }

            const toolCalls = output.tool_calls || [];
            for (const tc of toolCalls) {
                toolsUsed.add(tc.name);
                await agentOpsService.recordEvent({
                    runId, eventType: 'tool_call', node,
                    toolName: tc.name,
                    toolArgs: tc.args || tc.input || {},
                    content: `Tool call: ${tc.name}(${JSON.stringify(tc.args || {}).slice(0, 1000)})`,
                    metadata: { toolCallId: tc.id, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
                });
            }

            // Extract text content — handles both string and mixed content arrays (text + tool_use blocks)
            const rawContent = output.content;
            let textContent = '';
            if (typeof rawContent === 'string') {
                textContent = rawContent.trim();
            } else if (Array.isArray(rawContent)) {
                // Bedrock returns [{type:'text', text:'...'}, {type:'tool_use', ...}]
                textContent = rawContent
                    .filter((c: any) => c.type === 'text' && c.text?.trim())
                    .map((c: any) => c.text)
                    .join('\n')
                    .trim();
            }

            if (textContent) {
                if (node === 'final' || (node === 'generate' && !toolCalls.length)) {
                    result.finalContent = textContent;
                }
                await agentOpsService.recordEvent({
                    runId, eventType: mapNodeToEventType(node), node,
                    content: textContent.slice(0, 10000),
                    metadata: {
                        inputTokens: result.inputTokens,
                        outputTokens: result.outputTokens,
                        contentType: toolCalls.length > 0 ? 'thinking' : 'response',
                    },
                });
            }
            break;
        }

        // ── Tool result received ──────────────────────────────────────────────
        case 'on_tool_end': {
            const toolName = event.name || 'unknown-tool';
            const output = event.data?.output;
            let outputStr: string;
            if (typeof output === 'string') outputStr = output;
            else if (output && 'content' in output) outputStr = typeof output.content === 'string' ? output.content : JSON.stringify(output.content);
            else outputStr = JSON.stringify(output ?? '');

            await agentOpsService.recordEvent({
                runId, eventType: 'tool_result', node: node || toolName,
                toolName,
                toolOutput: outputStr.slice(0, 10000),
                content: `Tool result from ${toolName}: ${outputStr.slice(0, 500)}`,
                metadata: { step: event.metadata?.langgraph_step, outputLength: outputStr.length },
            });
            break;
        }

        // on_chain_start, on_chat_model_start, on_tool_start → intentionally skipped (noise)
        default:
            break;
    }

    // Track iterations from on_chain_start for generate node (still need this)
    if (event.event === 'on_chain_start' && (node === 'generate' || node === 'agent')) {
        result.iterationDelta = 1;
    }

    return result;
}
