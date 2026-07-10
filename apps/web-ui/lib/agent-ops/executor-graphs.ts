/**
 * Agent Ops — Dynamic Executor Graph
 *
 * This is the Agent Ops-specific LangGraph workflow. It is intentionally
 * separate from the AI Ops graphs (planning-agent, fast-agent, deep-agent)
 * so each can evolve independently.
 *
 * Shared utilities reused (not copied):
 *   - prompt-templates.ts  → prompt builders
 *   - model-factory.ts     → createAgentModels, assembleTools
 *   - agent-shared.ts      → sanitizeMessagesForBedrock, getRecentMessages, truncateOutput, llmAuditLog
 *   - persistence.ts       → PostgreSQL checkpointer (short-term), PostgreSQL store (long-term memory)
 *
 * Graph flow:
 *   evaluator → clarify (end)
 *             → generate (fast mode) → tools → reflect → generate | __end__
 *             → planner (plan mode)  → generate → tools → reflect → revise → tools | reflect
 *                                                                  → final → __end__
 */

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// ── Shared utilities (reused, not copied) ────────────────────────────────────
import {
    sanitizeMessagesForBedrock,
    getRecentMessages,
    truncateOutput,
    llmAuditLog,
    getActiveMCPTools,
    getMCPToolsDescription,
    getMCPManager,
} from "@/lib/agent/agent-shared";
import {
    buildBaseIdentity,
    buildEffectiveSkillSection,
    buildAccountContext,
    buildAwsCliStandards,
    buildOperationalWorkflows,
    CORE_PRINCIPLES,
} from "@/lib/agent/prompt-templates";
import { createAgentModels, assembleTools, createMemoryTools } from "@/lib/agent/model-factory";
import { getCheckpointer, getMemoryStore } from "@/lib/agent/persistence";
import { createMemoryRecallNode, createMemorySaveNode } from "@/lib/agent/memory-nodes";
import { loadSkills, loadAllSkillContent } from "@/lib/skill-service";
import { resolveKnowledgeBaseIds } from "@/lib/agent/auto-kb-select";

// ── Agent Ops-specific imports ────────────────────────────────────────────────
import { GraphConfig } from "@/lib/agent/agent-shared";
import { ReflectionState, graphState, PlanStep, RequestEvaluation, ToolResultEntry } from "./executor-state";
import { filterMutativeToolCalls } from "./tool-classifier";
import { env } from "@/env";

// Autonomous Agent Ops runs (scheduled / channel-triggered) get their own, larger
// iteration budget — the interactive chat agents keep the shared MAX_ITERATIONS=30.
// A multi-step unattended task (AWS auth → cost query → Slack report) needs more
// headroom, especially when it must resolve the target account first.
const AGENT_OPS_MAX_ITERATIONS = Number(env.AGENT_OPS_MAX_ITERATIONS) || 150;

// ============================================================================
// AGENT OPS DYNAMIC EXECUTOR GRAPH
// ============================================================================

export async function createDynamicExecutorGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, mcpServerIds, tenantId, userId, knowledgeBaseIds } = config as any;

    // ── Persistence (PostgreSQL checkpointer + long-term memory store) ────────
    const checkpointer = await getCheckpointer();
    const store = await getMemoryStore().catch(() => undefined);

    // ── Models (separate main + reflector to save tokens on reflection) ───────
    const { main: model, reflector: reflectorModel } = createAgentModels(modelId);

    // ── Shared long-term memory nodes (recall before evaluation, save after final) ──
    const memoryDeps = { reflectorModel, tenantId, userId, store: store ?? null };
    const memoryRecallNode = createMemoryRecallNode(memoryDeps);
    const memorySaveNode = createMemorySaveNode(memoryDeps);

    // ── Tools (shared factory keeps tool sets in sync) ────────────────────────
    const memoryTools = (store && tenantId && userId) ? createMemoryTools(tenantId, userId) : [];
    const baseTools = await assembleTools({ includeS3Tools: false, mcpServerIds, tenantId, knowledgeBaseIds });
    const tools = [...baseTools, ...memoryTools];
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // ── MCP context description for prompts ───────────────────────────────────
    // assembleTools() above already connected the requested servers via the global
    // MCPManager, so pull the description from that same instance (getMCPToolsDescription
    // is synchronous and expects an MCPServerManager, not the id array).
    let mcpContext = '';
    if (mcpServerIds?.length) {
        try {
            mcpContext = getMCPToolsDescription(getMCPManager(), mcpServerIds);
        } catch {
            mcpContext = '';
        }
    }

    // ── Shared prompt fragments (built once, reused across nodes) ─────────────
    const awsCliStandards = buildAwsCliStandards();
    const operationalWorkflows = buildOperationalWorkflows();

    // Pre-load all enabled tenant skills' content once. The evaluator picks a skill
    // at runtime, so node closures read content synchronously from this Map.
    const skillContentMap: Map<string, string> = tenantId ? await loadAllSkillContent(tenantId) : new Map();

    // ============================================================================
    // CONTEXT BUILDER — derives per-evaluation prompt fragments
    // ============================================================================
    function getDynamicContext(evaluation: RequestEvaluation | null, memoryContext = '') {
        const skillId = evaluation?.skillId ?? null;
        const targetAccountId = evaluation?.accountId || accountId;

        const skillSection = buildEffectiveSkillSection(skillId, skillId ? (skillContentMap.get(skillId) ?? null) : null);
        const accountContext = buildAccountContext({ accounts, accountId: targetAccountId });

        let mutationInstruction: string;
        if (evaluation?.skillId === 'swe') {
            mutationInstruction = `IMPORTANT: SWE mode — file read/write, git, Bitbucket PRs, and Jira MCP tools are all permitted. Always work on a feature branch.`;
        } else if (evaluation?.requiresApproval) {
            mutationInstruction = `IMPORTANT: MUTATIVE task — create, update, delete, start, stop operations are permitted. Verify resource state before mutating.`;
        } else {
            mutationInstruction = `IMPORTANT: READ-ONLY task — do NOT create, modify, or delete resources. Focus on observability and diagnosis only.`;
        }

        const mcpInstructions = mcpContext
            ? `${mcpContext}\n\nPrefer MCP tools over raw bash/curl for external APIs (Bitbucket, Jira, Confluence, etc.).`
            : '';

        const memorySection = memoryContext ? `\n## Relevant Context from Memory\n${memoryContext}\n` : '';

        const kbIds = evaluation?.knowledgeBaseIds ?? [];
        const kbSection = kbIds.length > 0
            ? `\n## Knowledge Base Context\nRelevant knowledge base(s) for this task: ${kbIds.join(', ')}. When calling search_knowledge_base, pass these ids as the knowledgeBaseIds argument to scope your search; omit it to search all knowledge bases.\n`
            : '';

        return { skillSection, accountContext, mutationInstruction, mcpInstructions, memorySection, kbSection };
    }

    // ============================================================================
    // NODE: EVALUATOR — determines mode, skill, account, and whether clarification needed
    // ============================================================================
    async function evaluatorNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        if (state.evaluation) return {}; // Already evaluated (e.g. resumed from checkpoint)

        const lastMessage = state.messages[state.messages.length - 1];
        const taskDescription = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);

        console.log(`\n[EVALUATOR] Analyzing task: "${truncateOutput(taskDescription, 100)}"`);

        const availableSkills = tenantId ? await loadSkills(tenantId) : [];
        const skillsContext = availableSkills.map(s => `- ${s.id}: ${s.name} - ${s.description}`).join('\n');

        const systemPrompt = new SystemMessage(`You are an intelligent request evaluator for an agentic AI system.
Your job is to analyze the user's request and determine the best execution approach.

Available Skills:
${skillsContext}

Return a JSON object with this exact schema:
{
    "mode": "plan" | "fast" | "end",
    "skillId": string | null,
    "accountId": string | null,
    "requiresApproval": boolean,
    "reasoning": string,
    "clarificationQuestion": string | null,
    "missingInfo": string | null
}

Rules:
- "plan" for complex multi-step tasks, infrastructure mutations, security audits
- "fast" for simple read queries, status checks, how-to questions
- "end" ONLY when genuinely ambiguous — always set clarificationQuestion in this case
- requiresApproval=true for any create/update/delete/start/stop operations

Return only the JSON object.`);

        const inputs = [systemPrompt, lastMessage];
        const start = Date.now();
        const response = await model.invoke(inputs);
        llmAuditLog('EVALUATOR', inputs, response, start);

        let evalResult: RequestEvaluation = {
            mode: 'fast', skillId: null, accountId: null,
            requiresApproval: false, reasoning: 'Fallback to fast mode.',
            clarificationQuestion: null, missingInfo: null,
        };

        try {
            const content = response.content as string;
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                evalResult = {
                    mode: parsed.mode || 'fast',
                    skillId: parsed.skillId || null,
                    accountId: parsed.accountId || null,
                    requiresApproval: !!parsed.requiresApproval,
                    reasoning: parsed.reasoning || '',
                    clarificationQuestion: parsed.clarificationQuestion || null,
                    missingInfo: parsed.missingInfo || null,
                };
            }
        } catch (e) {
            console.error('[EVALUATOR] Parse failed:', e);
        }

        // KB autonomy: manual run-level selection (config.knowledgeBaseIds) always wins;
        // otherwise a cheap reflector call (resolveKnowledgeBaseIds → autoSelectKb) matches
        // the task against the tenant's KB catalog (vectorCount > 0). Never throws.
        evalResult.knowledgeBaseIds = tenantId
            ? await resolveKnowledgeBaseIds({ tenantId, selectedIds: knowledgeBaseIds, message: taskDescription, model: modelId }).catch(() => [])
            : [];

        console.log(`[EVALUATOR] Mode: ${evalResult.mode} | Skill: ${evalResult.skillId} | Approval: ${evalResult.requiresApproval} | KBs: ${evalResult.knowledgeBaseIds.join(', ') || 'none'}`);
        return { evaluation: evalResult };
    }

    // ============================================================================
    // NODE: APPROVAL GATE — interrupts after planner when requiresApproval=true
    // The graph pauses here; on resume (after Slack approval), routes to generate.
    // ============================================================================
    async function approvalGateNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`[APPROVAL_GATE] Plan requires approval — pausing for human review`);
        // Signal the executor that we're waiting for approval
        return { nextAction: 'awaiting_approval', approvalStatus: 'pending' };
    }

    // ============================================================================
    // NODE: CLARIFY — posts clarification question back to user
    // ============================================================================
    async function clarifyNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const question = state.evaluation?.clarificationQuestion
            || "I need more information to proceed. Could you please clarify your request?";
        console.log(`[CLARIFY] Question: "${question}"`);
        return { clarificationQuestion: question, nextAction: 'awaiting_input' };
    }

    // ============================================================================
    // NODE: PLANNER — creates a dependency-ordered execution plan
    // ============================================================================
    async function planNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const lastMessage = state.messages[state.messages.length - 1];
        const taskDescription = typeof lastMessage.content === 'string'
            ? lastMessage.content : JSON.stringify(lastMessage.content);

        console.log(`\n[PLANNER] Creating plan for: "${truncateOutput(taskDescription, 100)}"`);

        const { skillSection, accountContext, mutationInstruction, memorySection, kbSection } = getDynamicContext(state.evaluation, state.memoryContext);
        const baseIdentity = buildBaseIdentity(state.evaluation?.skillId);

        const systemPrompt = new SystemMessage(`${baseIdentity}
${skillSection}
${memorySection}
${kbSection}
${CORE_PRINCIPLES}
${mutationInstruction}

## Planning Methodology
Phase 1 — Discovery: list/describe before any mutation.
Phase 2 — Analysis: process gathered data.
Phase 3 — Action & Verification: mutate then verify.

Rules:
- First step for any AWS task: get_aws_credentials (or list_aws_accounts first if account unknown)
- Every mutation step must be followed by a verification step
- Break tasks into smallest independently executable units
${awsCliStandards}
${accountContext}

Return ONLY a JSON array of step strings. Example:
["Call list_aws_accounts to identify target account", "Call get_aws_credentials for matched accountId", "Describe running EC2 instances with --output json"]`);

        const inputs = [systemPrompt, lastMessage];
        const start = Date.now();
        const response = await model.invoke(inputs);
        llmAuditLog('PLANNER', inputs, response, start);

        let planSteps: PlanStep[] = [];
        try {
            const match = (response.content as string).match(/\[[\s\S]*\]/);
            if (match) {
                planSteps = JSON.parse(match[0]).map((step: string) => ({ step, status: 'pending' as const }));
            }
        } catch (e) {
            console.error('[PLANNER] Parse failed:', e);
        }

        if (planSteps.length === 0) {
            planSteps = [{ step: "Analyze and respond to user request", status: 'pending' }];
        }

        const planText = planSteps.map((s, i) => `${i + 1}. ${s.step}`).join('\n');
        console.log(`[PLANNER] Plan (${planSteps.length} steps):\n${planText}`);

        return {
            plan: planSteps,
            taskDescription,
            messages: [new AIMessage({ content: `📋 **Plan Created:**\n${planText}` })],
            nextAction: "generate",
        };
    }

    // ============================================================================
    // NODE: GENERATE — executes the current plan step or answers directly (fast mode)
    // ============================================================================
    async function generateNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, plan, iterationCount, evaluation } = state;
        console.log(`\n[EXECUTOR] Iteration ${iterationCount + 1}/${AGENT_OPS_MAX_ITERATIONS}`);

        const { skillSection, accountContext, mutationInstruction, mcpInstructions, memorySection, kbSection } = getDynamicContext(evaluation, state.memoryContext);
        const baseIdentity = buildBaseIdentity(evaluation?.skillId);

        let stepContext = '';
        if (evaluation?.mode === 'plan') {
            const pending = plan.filter(s => s.status === 'pending' || s.status === 'in_progress');
            const currentStep = pending[0]?.step || 'Complete the task';
            stepContext = `\nCurrent Step: ${currentStep}\nFull Plan:\n${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`;
        }

        const systemPrompt = new SystemMessage(`${baseIdentity}
${skillSection}
${memorySection}
${kbSection}
${CORE_PRINCIPLES}
${mutationInstruction}
${mcpInstructions}
${awsCliStandards}
${operationalWorkflows}
${accountContext}
${stepContext}

Execute the task using available tools. For simple questions that need no tools, answer directly.
After completing a step, provide a brief factual summary of what was done and the key output.`);

        const recentMessages = sanitizeMessagesForBedrock(getRecentMessages(messages, 25));
        if (evaluation?.mode === 'plan' && recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please execute the next step of the plan." }));
        }

        const inputs = [systemPrompt, ...recentMessages];
        const start = Date.now();
        const response = await modelWithTools.invoke(inputs);
        llmAuditLog('EXECUTOR', inputs, response, start);

        const updatedPlan = evaluation?.mode === 'plan'
            ? plan.map((s, i) => i === plan.findIndex(p => p.status === 'pending') ? { ...s, status: 'in_progress' as const } : s)
            : plan;

        return { messages: [response], iterationCount: iterationCount + 1, plan: updatedPlan };
    }

    // ============================================================================
    // NODE: TOOLS — executes tool calls and collects structured results.
    // Read-only tools run immediately (yolo mode).
    // Mutative tools are gated: if any are present and autoApprove=false,
    // the graph was interrupted before this node via interruptBefore.
    // On resume (after Slack approval), all pending tool calls execute normally.
    // ============================================================================
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const result = await toolNode.invoke(state);
        const newToolResults: ToolResultEntry[] = [];

        for (const msg of (result.messages || [])) {
            if (msg._getType() === 'tool') {
                const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                const isError = rawContent.toLowerCase().includes('error') || rawContent.toLowerCase().includes('exception');
                newToolResults.push({
                    toolName: (msg as any).name || 'unknown_tool',
                    output: truncateOutput(rawContent, 1000),
                    isError,
                    iterationIndex: state.iterationCount,
                });
            }
        }

        // Reset approvalStatus after execution so the next mutative tool batch is gated again
        return { ...result, toolResults: newToolResults, approvalStatus: null, pendingToolApprovals: [] };
    }

    // ============================================================================
    // ROUTING: GENERATE → TOOLS — check if pending tool calls are mutative.
    // If autoApprove=false and any tool is mutative AND not yet approved, gate them.
    // Read-only tool calls always go straight to tools node (yolo mode).
    // ============================================================================
    function routeFromGenerateToTools(state: ReflectionState): 'tools' | 'mutative_approval_gate' {
        if (autoApprove) return 'tools';
        // If user already approved this batch (resume path), skip the gate
        if (state.approvalStatus === 'approved') return 'tools';

        const lastMessage = state.messages[state.messages.length - 1] as any;
        const toolCalls = lastMessage?.tool_calls ?? [];
        const mutative = filterMutativeToolCalls(toolCalls);

        if (mutative.length > 0) {
            console.log(`[TOOL_GATE] Mutative tools detected: ${mutative.map(t => t.name).join(', ')} — requesting approval`);
            return 'mutative_approval_gate';
        }
        return 'tools';
    }

    // ============================================================================
    // NODE: MUTATIVE_APPROVAL_GATE — pauses before executing mutative tools.
    // Stores the pending tool names in state for the executor to pick up.
    // ============================================================================
    async function mutativeApprovalGateNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const lastMessage = state.messages[state.messages.length - 1] as any;
        const toolCalls = lastMessage?.tool_calls ?? [];
        const mutative = filterMutativeToolCalls(toolCalls);
        const toolNames = mutative.map(t => t.name);

        console.log(`[MUTATIVE_APPROVAL_GATE] Pausing for approval of: ${toolNames.join(', ')}`);
        return {
            nextAction: 'awaiting_tool_approval',
            approvalStatus: 'pending',
            pendingToolApprovals: toolNames,
        };
    }

    // ============================================================================
    // NODE: REFLECT — critiques execution output and updates plan status
    // ============================================================================
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount, plan, toolResults, evaluation } = state;
        const lastMessage = messages[messages.length - 1];

        // Skip reflection if last message has pending tool calls
        if ((lastMessage as AIMessage).tool_calls?.length) return {};

        console.log(`\n[REFLECTOR] Analyzing results (iteration ${iterationCount})`);

        const isComplex = evaluation?.mode === 'plan';
        const skillId = evaluation?.skillId;
        const skillContent = skillId ? (skillContentMap.get(skillId) ?? '') : '';

        const systemPrompt = new SystemMessage(isComplex
            ? `You are a principal-level AWS/DevOps engineer reviewing agent execution output.
${skillContent ? `Skill context: ${skillContent}` : ''}

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Evaluate on: Correctness, Completeness, AWS best practices (--output json, --profile, pagination), Safety (verify before mutate), Error handling.

Set isComplete=true ONLY when ALL plan steps are completed and the original task is fully accomplished.

Return ONLY this JSON:
{
    "analysis": "concise assessment",
    "issues": "specific issues or 'None'",
    "suggestions": "corrective actions or 'None'",
    "isComplete": true | false,
    "updatedPlan": [{ "step": "...", "status": "completed" | "pending" | "failed" }]
}`
            : `You are a strict critic reviewing an AI assistant's response.
${skillContent ? `Skill context: ${skillContent}` : ''}
Evaluate for Correctness, Completeness, AWS CLI quality, and Specificity.
If the response is correct and complete, respond with exactly: COMPLETE
Otherwise list specific issues to fix. Do not generate the fixed answer.`);

        const lastAiText = messages.filter(m => m._getType() === 'ai').slice(-1)[0]?.content;
        const lastAiStr = typeof lastAiText === 'string' ? lastAiText : JSON.stringify(lastAiText || '');

        const summaryInput = new HumanMessage({
            content: isComplex
                ? `Recent Output:\n${truncateOutput(lastAiStr, 1500)}\n\nTool Results:\n${toolResults.slice(-5).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}] ${e.output}`).join('\n---\n')}\n\nPlan:\n${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`
                : `Evaluate this response:\n${lastAiStr}`,
        });

        const inputs = [systemPrompt, summaryInput];
        const start = Date.now();
        const response = await reflectorModel.invoke(inputs);
        llmAuditLog('REFLECTOR', inputs, response, start);

        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

        if (isComplex) {
            let analysis = '', issues = 'None', isComplete = false, updatedPlan: PlanStep[] = [];
            try {
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    const parsed = JSON.parse(match[0]);
                    analysis = parsed.analysis || '';
                    issues = parsed.issues || 'None';
                    isComplete = parsed.isComplete === true;
                    if (parsed.updatedPlan?.length) updatedPlan = parsed.updatedPlan;
                }
            } catch { isComplete = false; }

            console.log(`[REFLECTOR] Complete: ${isComplete} | Issues: ${issues !== 'None' ? issues : 'None'}`);

            return {
                messages: [new AIMessage({ content: `🔍 **Reflection:**\n${analysis}${issues !== 'None' ? `\n⚠️ Issues: ${issues}` : ''}` })],
                reflection: analysis,
                errors: issues !== 'None' ? [issues] : [],
                isComplete: isComplete || iterationCount >= AGENT_OPS_MAX_ITERATIONS,
                plan: updatedPlan.length > 0 ? updatedPlan : plan,
            };
        } else {
            if (content.includes('COMPLETE') || iterationCount >= AGENT_OPS_MAX_ITERATIONS) {
                return { messages: [response], isComplete: true };
            }
            return {
                messages: [new HumanMessage({ content: `Critique: ${content}\nPlease update your answer.` })],
                isComplete: false,
            };
        }
    }

    // ============================================================================
    // NODE: REVISE — targeted fix node for plan mode (separate from generate)
    // ============================================================================
    async function reviseNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, reflection, errors, plan, evaluation } = state;
        console.log(`\n[REVISER] Applying targeted fixes`);

        const { skillSection, accountContext, mutationInstruction, memorySection, kbSection } = getDynamicContext(evaluation, state.memoryContext);
        const baseIdentity = buildBaseIdentity(evaluation?.skillId);

        const systemPrompt = new SystemMessage(`${baseIdentity}
${skillSection}
${memorySection}
${kbSection}
${CORE_PRINCIPLES}
${mutationInstruction}

## Reviewer Feedback
Analysis: ${reflection}
Issues to fix: ${errors.join(', ') || 'None'}

## Revision Rules
1. Fix ONLY the identified issues — do not redo completed steps.
2. For AWS CLI issues (wrong flags, missing --output json, missing pagination): re-run the corrected command.
3. For write_file errors: always include BOTH file_path AND content parameters.
4. For tool errors: diagnose root cause (permissions, wrong region, wrong account) before retrying.
5. After fixing, provide a brief summary of what was corrected.

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}
${awsCliStandards}
${accountContext}`);

        const recentMessages = sanitizeMessagesForBedrock(getRecentMessages(messages, 10));
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please fix the issues identified in the reflection." }));
        }

        const inputs = [systemPrompt, ...recentMessages];
        const start = Date.now();
        const response = await modelWithTools.invoke(inputs);
        llmAuditLog('REVISER', inputs, response, start);

        return { messages: [response], nextAction: 'generate' };
    }

    // ============================================================================
    // NODE: FINAL — generates a structured delivery note for the completed task
    // ============================================================================
    async function finalNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { taskDescription, iterationCount, reflection, toolResults, plan } = state;
        console.log(`\n[FINAL] Generating delivery summary`);

        const systemPrompt = new SystemMessage(`You are a senior DevOps engineer writing the final delivery note for a completed automated task.

Original Task: ${taskDescription}
Iterations used: ${iterationCount}
Plan steps: ${plan.map(s => `${s.step} (${s.status})`).join(' | ')}

Key Tool Outputs (most recent):
${toolResults.slice(-3).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}]\n${truncateOutput(e.output, 500)}`).join('\n\n---\n\n')}

Final Review Notes: ${reflection}

Write a clear markdown summary including:
1. **What Was Accomplished** — state the outcome directly
2. **Key Findings or Results** — bullet the most important data points, IDs, metrics
3. **Errors or Limitations** — if any step failed, state it explicitly with the reason
4. **Recommended Next Steps** — concrete actions based on findings

Be specific — include resource IDs, account names, and numeric values where available.`);

        const inputs = [systemPrompt, new HumanMessage({ content: "Provide the final summary." })];
        const start = Date.now();
        const response = await model.invoke(inputs);
        llmAuditLog('FINAL', inputs, response, start);

        const summaryContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
        const finalMessage = `✅ **Task Complete**\n\n**Original Task:** ${taskDescription}\n**Iterations:** ${iterationCount}\n\n---\n\n${summaryContent}`;

        return { messages: [new AIMessage({ content: finalMessage })], isComplete: true };
    }

    // ============================================================================
    // ROUTING FUNCTIONS
    // ============================================================================

    function routeFromEvaluator(state: ReflectionState): 'planner' | 'generate' | 'clarify' {
        if (!state.evaluation) return 'generate';
        if (state.evaluation.mode === 'plan') return 'planner';
        if (state.evaluation.mode === 'end') return 'clarify';
        // Fast mode mutative tasks still need plan-level approval gate when autoApprove=false.
        // Without this, "start EC2" (fast mode, requiresApproval=true) skips approval_gate entirely.
        if (!autoApprove && state.evaluation.requiresApproval && state.approvalStatus !== 'approved') {
            return 'planner';
        }
        return 'generate';
    }

    // After planner: if approval required and not yet approved, go to approval_gate; else generate
    function routeFromPlanner(state: ReflectionState): 'approval_gate' | 'generate' {
        if (!autoApprove && state.evaluation?.requiresApproval && state.approvalStatus !== 'approved') {
            return 'approval_gate';
        }
        return 'generate';
    }

    function routeFromGenerate(state: ReflectionState): 'tools' | 'mutative_approval_gate' | 'reflect' | 'final' | '__end__' {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        if (lastMessage.tool_calls?.length) {
            // Delegate to the selective gate router
            return routeFromGenerateToTools(state);
        }
        if (state.evaluation?.mode === 'plan') {
            return state.iterationCount <= 1 ? 'final' : 'reflect';
        }
        if (state.iterationCount >= AGENT_OPS_MAX_ITERATIONS) return '__end__';
        return 'reflect';
    }

    function routeFromTools(state: ReflectionState): 'generate' | 'reflect' {
        return state.iterationCount >= AGENT_OPS_MAX_ITERATIONS ? 'reflect' : 'generate';
    }

    function routeFromReflect(state: ReflectionState): 'revise' | 'generate' | 'final' | '__end__' {
        if (state.evaluation?.mode === 'plan') {
            if (state.isComplete || state.iterationCount >= AGENT_OPS_MAX_ITERATIONS) return 'final';
            return 'revise';
        }
        if (state.isComplete) return '__end__';
        return 'generate';
    }

    function routeFromRevise(state: ReflectionState): 'tools' | 'mutative_approval_gate' | 'reflect' {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        if (lastMessage.tool_calls?.length) {
            return routeFromGenerateToTools(state) === 'mutative_approval_gate' ? 'mutative_approval_gate' : 'tools';
        }
        return 'reflect';
    }

    // ============================================================================
    // GRAPH CONSTRUCTION
    // ============================================================================
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("evaluator", evaluatorNode)
        .addNode("clarify", clarifyNode)
        .addNode("approval_gate", approvalGateNode)
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("tools", collectingToolNode)
        .addNode("mutative_approval_gate", mutativeApprovalGateNode)
        .addNode("reflect", reflectNode)
        .addNode("revise", reviseNode)
        .addNode("final", finalNode)
        .addNode("memory_recall", memoryRecallNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "evaluator")

        .addConditionalEdges("evaluator", routeFromEvaluator, {
            planner: "planner",
            generate: "generate",
            clarify: "clarify",
        })

        .addEdge("clarify", END)

        .addConditionalEdges("planner", routeFromPlanner, {
            approval_gate: "approval_gate",
            generate: "generate",
        })

        .addEdge("approval_gate", END)

        .addConditionalEdges("generate", routeFromGenerate, {
            tools: "tools",
            mutative_approval_gate: "mutative_approval_gate",
            reflect: "reflect",
            final: "final",
            __end__: END,
        })

        .addEdge("mutative_approval_gate", END)

        .addConditionalEdges("tools", routeFromTools, {
            generate: "generate",
            reflect: "reflect",
        })

        .addConditionalEdges("reflect", routeFromReflect, {
            revise: "revise",
            generate: "generate",
            final: "final",
            __end__: END,
        })

        .addConditionalEdges("revise", routeFromRevise, {
            tools: "tools",
            mutative_approval_gate: "mutative_approval_gate",
            reflect: "reflect",
        })

        .addEdge("final", "memory_save")
        .addEdge("memory_save", END);

    // autoApprove=false: interrupt before plan-level approval_gate and mutative_approval_gate.
    // Read-only tools always run without interruption (yolo mode).
    const compileOptions = autoApprove
        ? { checkpointer, ...(store && { store }) }
        : { checkpointer, ...(store && { store }), interruptBefore: ["approval_gate" as const, "mutative_approval_gate" as const] };

    return workflow.compile(compileOptions);
}
