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
 *   - persistence.ts       → DynamoDB checkpointer (short-term), DynamoDB store (long-term memory)
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
    MAX_ITERATIONS,
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
import { getSkillContent, loadSkills } from "@/lib/agent/skills/skill-loader";

// ── Agent Ops-specific imports ────────────────────────────────────────────────
import { GraphConfig } from "@/lib/agent/agent-shared";
import { ReflectionState, graphState, PlanStep, RequestEvaluation, ToolResultEntry } from "./executor-state";

// ============================================================================
// AGENT OPS DYNAMIC EXECUTOR GRAPH
// ============================================================================

export async function createDynamicExecutorGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, mcpServerIds, tenantId, userId } = config as any;

    // ── Persistence (DynamoDB checkpointer + long-term memory store) ──────────
    const checkpointer = await getCheckpointer();
    const store = await getMemoryStore().catch(() => undefined);

    // ── Models (separate main + reflector to save tokens on reflection) ───────
    const { main: model, reflector: reflectorModel } = createAgentModels(modelId);

    // ── Tools (shared factory keeps tool sets in sync) ────────────────────────
    const memoryTools = (store && userId) ? createMemoryTools(userId) : [];
    const baseTools = await assembleTools({ includeS3Tools: false, mcpServerIds, tenantId });
    const tools = [...baseTools, ...memoryTools];
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // ── MCP context description for prompts ───────────────────────────────────
    const mcpContext = mcpServerIds?.length
        ? await getMCPToolsDescription(mcpServerIds, tenantId).catch(() => '')
        : '';

    // ── Shared prompt fragments (built once, reused across nodes) ─────────────
    const awsCliStandards = buildAwsCliStandards();
    const operationalWorkflows = buildOperationalWorkflows();

    // ============================================================================
    // CONTEXT BUILDER — derives per-evaluation prompt fragments
    // ============================================================================
    function getDynamicContext(evaluation: RequestEvaluation | null) {
        const skillId = evaluation?.skillId ?? null;
        const targetAccountId = evaluation?.accountId || accountId;

        const skillSection = buildEffectiveSkillSection(skillId);
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

        return { skillSection, accountContext, mutationInstruction, mcpInstructions };
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

        const availableSkills = await loadSkills();
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

        console.log(`[EVALUATOR] Mode: ${evalResult.mode} | Skill: ${evalResult.skillId} | Approval: ${evalResult.requiresApproval}`);
        return { evaluation: evalResult };
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

        const { skillSection, accountContext, mutationInstruction } = getDynamicContext(state.evaluation);
        const baseIdentity = buildBaseIdentity(state.evaluation?.skillId);

        const systemPrompt = new SystemMessage(`${baseIdentity}
${skillSection}
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
        console.log(`\n[EXECUTOR] Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);

        const { skillSection, accountContext, mutationInstruction, mcpInstructions } = getDynamicContext(evaluation);
        const baseIdentity = buildBaseIdentity(evaluation?.skillId);

        let stepContext = '';
        if (evaluation?.mode === 'plan') {
            const pending = plan.filter(s => s.status === 'pending' || s.status === 'in_progress');
            const currentStep = pending[0]?.step || 'Complete the task';
            stepContext = `\nCurrent Step: ${currentStep}\nFull Plan:\n${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`;
        }

        const systemPrompt = new SystemMessage(`${baseIdentity}
${skillSection}
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
    // NODE: TOOLS — executes tool calls and collects structured results
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

        return { ...result, toolResults: newToolResults };
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
        const skillContent = skillId ? (getSkillContent(skillId) || '') : '';

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
                isComplete: isComplete || iterationCount >= MAX_ITERATIONS,
                plan: updatedPlan.length > 0 ? updatedPlan : plan,
            };
        } else {
            if (content.includes('COMPLETE') || iterationCount >= MAX_ITERATIONS) {
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

        const { skillSection, accountContext, mutationInstruction } = getDynamicContext(evaluation);
        const baseIdentity = buildBaseIdentity(evaluation?.skillId);

        const systemPrompt = new SystemMessage(`${baseIdentity}
${skillSection}
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
        return 'generate';
    }

    function routeFromGenerate(state: ReflectionState): 'tools' | 'reflect' | 'final' | '__end__' {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        if (lastMessage.tool_calls?.length) return 'tools';
        if (state.evaluation?.mode === 'plan') {
            return state.iterationCount <= 1 ? 'final' : 'reflect';
        }
        if (state.iterationCount >= MAX_ITERATIONS) return '__end__';
        return 'reflect';
    }

    function routeFromTools(state: ReflectionState): 'generate' | 'reflect' {
        return state.iterationCount >= MAX_ITERATIONS ? 'reflect' : 'generate';
    }

    function routeFromReflect(state: ReflectionState): 'revise' | 'generate' | 'final' | '__end__' {
        if (state.evaluation?.mode === 'plan') {
            if (state.isComplete || state.iterationCount >= MAX_ITERATIONS) return 'final';
            return 'revise';
        }
        if (state.isComplete) return '__end__';
        return 'generate';
    }

    function routeFromRevise(state: ReflectionState): 'tools' | 'reflect' {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        return lastMessage.tool_calls?.length ? 'tools' : 'reflect';
    }

    // ============================================================================
    // GRAPH CONSTRUCTION
    // ============================================================================
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("evaluator", evaluatorNode)
        .addNode("clarify", clarifyNode)
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("revise", reviseNode)
        .addNode("final", finalNode)

        .addEdge(START, "evaluator")

        .addConditionalEdges("evaluator", routeFromEvaluator, {
            planner: "planner",
            generate: "generate",
            clarify: "clarify",
        })

        .addEdge("clarify", END)
        .addEdge("planner", "generate")

        .addConditionalEdges("generate", routeFromGenerate, {
            tools: "tools",
            reflect: "reflect",
            final: "final",
            __end__: END,
        })

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
            reflect: "reflect",
        })

        .addEdge("final", END);

    const compileOptions = autoApprove
        ? { checkpointer, ...(store && { store }) }
        : { checkpointer, ...(store && { store }), interruptBefore: ["tools" as const] };

    return workflow.compile(compileOptions);
}
