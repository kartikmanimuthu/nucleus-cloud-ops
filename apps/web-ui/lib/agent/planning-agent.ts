import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getSkillContent, getSkillSummaries } from "@/lib/skill-service";
import {
    GraphConfig,
    ReflectionState,
    PlanStep,
    ToolResultEntry,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    sanitizeMessagesForBedrock,
    withUnresolvedToolCallsOnly,
    tagMessagePhase,
    llmAuditLog,
    getCheckpointer,
    getStore,
} from "./agent-shared";
import {
    buildBaseIdentity,
    buildEffectiveSkillSection,
    buildAccountContext,
    buildAwsCliStandards,
    buildReportStrategy,
    buildAutoApproveGuidance,
    buildOperationalWorkflows,
    CORE_PRINCIPLES,
} from "./prompt-templates";
import { createAgentModels, assembleTools, deriveInputTokenBudget } from "./model-factory";
import { createMemoryRecallNode, createMemorySaveNode } from "./memory-nodes";
import { autoSkillSelectionEnabled } from "./auto-skill-select";
import { prepareContext, buildWorkingMemorySection, estimateTokens } from "./memory/working-memory";
import { createGuardNode } from "./guard";
import { routeAfterGuard } from "./gate-routing";

// Factory function to create a configured reflection graph
export async function createReflectionGraph(config: GraphConfig) {
    const { model: modelConfig, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
    const modelId = modelConfig.modelId;
    const checkpointer = await getCheckpointer();
    const store = await getStore();

    // Pre-fetch skill content once (tenant-scoped DB lookup). No repeated queries.
    const skillContent = selectedSkill && tenantId ? (await getSkillContent(tenantId, selectedSkill)) || '' : '';
    if (selectedSkill) {
        console.log(skillContent ? `[PlanningAgent] Loaded skill: ${selectedSkill}` : `[PlanningAgent] No content for skill: ${selectedSkill}`);
    }

    // Catalog rides the auto-selection feature flag (true kill-switch) and the
    // zero-skill sentinel string must not leak into the prompt.
    const skillCatalog = !selectedSkill && tenantId && autoSkillSelectionEnabled()
        ? await getSkillSummaries(tenantId)
            .then(s => (s.startsWith('No specialized skills') ? null : s))
            .catch(() => null)
        : null;

    // --- Shared prompt fragments (built once, reused across all nodes) ---
    const baseIdentity = buildBaseIdentity(selectedSkill);
    const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill, skillContent || null, skillCatalog);
    const accountContext = buildAccountContext({ accounts, accountId, accountName });
    const awsCliStandards = buildAwsCliStandards();
    const reportStrategy = buildReportStrategy();
    const autoApproveGuidance = buildAutoApproveGuidance(autoApprove);
    const operationalWorkflows = buildOperationalWorkflows();

    // --- Model Initialization ---
    const { main: model, reflector: reflectorModel } = createAgentModels(modelConfig);

    // --- Tool Assembly ---
    // Memory tools excluded — memory_recall and memory_save graph nodes handle memory deterministically
    const tools = await assembleTools({ includeS3Tools: true, includeMemoryTools: false, userId: config.userId, mcpServerIds, tenantId, accounts, knowledgeBaseIds: config.knowledgeBaseIds });
    const modelWithTools = model.bindTools!(tools);
    const toolNode = new ToolNode(tools);

    // --- Memory Nodes ---
    const memoryDeps = { reflectorModel, tenantId, userId: config.userId, store };
    const memoryRecallNode = createMemoryRecallNode(memoryDeps);
    const memorySaveNode = createMemorySaveNode(memoryDeps);

    const guardNode = createGuardNode({ riskModel: reflectorModel });
    // approval_gate is a no-op marker node: the interrupt BEFORE it is the pause.
    async function approvalGateNode(): Promise<Partial<ReflectionState>> {
        console.log('⏸️ [APPROVAL GATE] resuming after human decision');
        return {};
    }

    // Working-memory deps — threadId is read per-node from the runtime config.
    // budgetTokens is derived from the resolved model so small/local context windows
    // trigger compaction correctly; systemPromptTokens charges the always-on prompt
    // (identity + skill + principles + workflows + account context) against that budget.
    const budgetTokens = deriveInputTokenBudget(modelConfig);
    const systemPromptTokens = estimateTokens(
        baseIdentity + effectiveSkillSection + CORE_PRINCIPLES + awsCliStandards +
        reportStrategy + autoApproveGuidance + operationalWorkflows + accountContext,
    );
    const wmDeps = { reflectorModel, tenantId, userId: config.userId, budgetTokens, systemPromptTokens };

    // ---------------------------------------------------------------------------
    // PLANNER NODE
    // ---------------------------------------------------------------------------
    async function planNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, memoryContext } = state;
        const workingMemorySection = buildWorkingMemorySection(
            state.runningSummary || (state.scratchpad?.openGoals?.length ?? 0) > 0
                ? { runningSummary: state.runningSummary ?? '', scratchpad: state.scratchpad ?? { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }, tokenCount: 0, turnCount: 0 }
                : null,
        );
        const lastMessage = messages[messages.length - 1];
        const taskDescription = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);

        console.log(`\n================================================================================`);
        console.log(`🤖 [PLANNER] Initiating planning phase`);
        console.log(`   Task: "${truncateOutput(taskDescription, 100)}"`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const plannerSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to decompose the user's task into a precise, dependency-ordered execution plan.
${effectiveSkillSection}
${CORE_PRINCIPLES}
${memoryContext ? `\n## Relevant Context from Memory\n${memoryContext}\n` : ''}
${workingMemorySection}
## Planning Methodology

Work through three phases when building the plan:

**Phase 1 — Discovery & Audit**: Identify what needs to be read, listed, or described before anything can be changed or analyzed. Discovery steps always come first.

**Phase 2 — Analysis**: Steps that process, interpret, or compare the data gathered in Phase 1.

**Phase 3 — Action & Verification**: Mutation or output steps, each followed by a verification step that confirms the expected outcome.

## Rules for Plan Steps

- Order steps by dependency: a step that depends on the output of another must come after it.
- For any AWS operation, the first step is always credential acquisition via get_aws_credentials (or list_aws_accounts + get_aws_credentials if the account is not known).
- For multi-account tasks, add one credential acquisition step per account before any account-specific steps.
- Break large tasks into the smallest independently executable unit — do not bundle unrelated actions into one step.
- If a step is a mutation (create, update, delete, stop, start, deploy), the step immediately after it must be a verification step (describe, list, get, check status).
- For file-system or code tasks: read before write, check before create.
- If the task is ambiguous, the first step should be a targeted discovery to resolve the ambiguity before committing to an action plan.
${reportStrategy}
${accountContext}

IMPORTANT: Return your plan as a JSON array of concise, action-oriented step descriptions. Each step must be independently executable by the executor agent.
Example: ["Call list_aws_accounts to identify the target account", "Call get_aws_credentials for the matched account ID", "Describe all running EC2 instances using --output json and the obtained profile", "Query CloudWatch for CPUUtilization metrics on each instance over the past 7 days", "Render the complete markdown report with all findings directly in your final response"]

Only return the JSON array, nothing else.`);

        const _auditInputs_plan = [plannerSystemPrompt, lastMessage];
        const _auditStart_plan = Date.now();
        let response: AIMessage;
        try {
            response = await model.invoke(_auditInputs_plan) as AIMessage;
            llmAuditLog('PLANNER', _auditInputs_plan, response, _auditStart_plan);
        } catch (err: any) {
            // A provider hiccup while planning must not abort the run — fall back to a
            // trivial single-step plan (the empty content flows through the parse fallback below).
            console.error(`[Planner] LLM invoke failed, falling back to single-step plan: ${err?.message ?? err}`);
            response = new AIMessage({ content: '' });
        }

        let planSteps: PlanStep[] = [];
        try {
            const content = response.content as string;
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                planSteps = parsed.map((step: string) => ({
                    step,
                    status: 'pending' as const
                }));
            }
        } catch (e) {
            console.error("[Planner] Plan parsing failed:", e);
            planSteps = [{
                step: "Analyze and respond to user request",
                status: 'pending' as const
            }];
        }

        if (planSteps.length === 0) {
            planSteps = [{
                step: "Analyze and respond to user request",
                status: 'pending' as const
            }];
        }

        const planText = planSteps.map((s, i) => `${i + 1}. ${s.step}`).join('\n');
        console.log(`\n📋 [PLANNER] Plan Generated:`);
        console.log(`--------------------------------------------------------------------------------`);
        console.log(planText);
        console.log(`--------------------------------------------------------------------------------\n`);

        return {
            plan: planSteps,
            taskDescription,
            // Keep a short text (with phase marker) for legacy rendering + history;
            // the structured plan streams as data-plan parts.
            messages: [tagMessagePhase(new AIMessage({ content: `📋 Created a ${planSteps.length}-step execution plan.` }), 'planning')],
            nextAction: "generate"
        };
    }

    // ---------------------------------------------------------------------------
    // GENERATOR (EXECUTOR) NODE
    // ---------------------------------------------------------------------------
    async function generateNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
        const { messages, plan, iterationCount, memoryContext } = state;

        console.log(`\n================================================================================`);
        console.log(`⚡ [EXECUTOR] Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Current Step: ${plan.find(s => s.status === 'pending')?.step || 'Executing...'}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const pendingSteps = plan.filter(s => s.status === 'pending' || s.status === 'in_progress');
        const currentStep = pendingSteps[0]?.step || "Complete the task";

        const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
        const { windowMessages, workingMemorySection, stateUpdate } =
            await prepareContext(state, { ...wmDeps, threadId }, 15);

        const executorSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to execute the current plan step precisely and completely using available tools.
${effectiveSkillSection}
${CORE_PRINCIPLES}
${memoryContext ? `\n## Relevant Context from Memory\n${memoryContext}\n` : ''}
${workingMemorySection}
## Current Execution Context

Current Step: ${currentStep}

Full Plan:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

${awsCliStandards}
${autoApproveGuidance}
${operationalWorkflows}
${accountContext}

## Execution Discipline

- Execute exactly the current step — do not skip ahead or bundle future steps into a single call.
- If a tool call returns an error, capture the full error message and include it in your summary; do not silently suppress it.
- If the current step is a simple question or greeting that requires no tools, answer directly and concisely.
- After completing the step (with or without tools), provide a brief, factual summary: what was done, the key output or finding, and any error or unexpected result.

⚠️ **Never use write_file or write_file_to_s3 for reports**: Render all reports and summaries directly in your response. S3 tools are only for logs, raw API outputs, or backup artifacts.

⚠️ **Tool Parameter Validation**: Always ensure tool calls include all required parameters. If a tool call fails with a parameter validation error, check that you provided all required fields.`);

        const recentMessages = windowMessages;
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please execute the next step of the plan based on the tools available." }));
        }
        const safeMessages = sanitizeMessagesForBedrock(recentMessages);
        const _auditInputs_exec = [executorSystemPrompt, ...safeMessages];
        const _auditStart_exec = Date.now();
        let response: AIMessage;
        try {
            response = await modelWithTools.invoke(_auditInputs_exec) as AIMessage;
            llmAuditLog('EXECUTOR', _auditInputs_exec, response, _auditStart_exec);
        } catch (err: any) {
            // Provider error mid-step: don't crash the run. Emit a text note (no tool calls)
            // so the graph routes on to reflection/finalization with whatever was gathered.
            console.error(`⚠️ [EXECUTOR] LLM invoke failed: ${err?.message ?? err}`);
            response = new AIMessage({ content: `⚠️ This step could not be executed due to a model/provider error (${err?.message ?? err}). Proceeding with the information gathered so far.` });
        }

        if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
            console.log(`\n🛠️ [EXECUTOR] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls) {
                console.log(`   → Tool: ${toolCall.name}`);
                console.log(`     Args: ${JSON.stringify(toolCall.args)}`);
            }
        } else {
            console.log(`\n💬 [EXECUTOR] No tools called. Generating text response.`);
        }

        const updatedPlan = plan.map((s, i) => {
            if (i === plan.findIndex(p => p.status === 'pending')) {
                return { ...s, status: 'in_progress' as const };
            }
            return s;
        });

        return {
            messages: [tagMessagePhase(response, 'execution')],
            iterationCount: iterationCount + 1,
            plan: updatedPlan,
            ...stateUpdate,
        };
    }

    // ---------------------------------------------------------------------------
    // TOOL NODE (with result collection)
    // ---------------------------------------------------------------------------
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [TOOLS] Executing tool calls...`);
        const view = withUnresolvedToolCallsOnly(state);
        if (!view) {
            console.log('⚙️ [TOOLS] All tool calls already resolved (rejected/answered) — skipping execution.');
            return {};
        }
        const result = await toolNode.invoke({ ...state, messages: view.messages });
        console.log(`⚙️ [TOOLS] Execution complete. Result messages: ${result.messages?.length || 0}`);

        const newToolResults: ToolResultEntry[] = [];
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    const isError = rawContent.toLowerCase().includes('error') || rawContent.toLowerCase().includes('exception');
                    const entry: ToolResultEntry = {
                        toolName: (msg as any).name || 'unknown_tool',
                        output: truncateOutput(rawContent, 1000),
                        isError,
                        iterationIndex: state.iterationCount,
                    };
                    newToolResults.push(entry);
                    const icon = isError ? '❌' : '✅';
                    console.log(`   ${icon} [TOOL RESULT] ${entry.toolName}:`);
                    console.log(`      ${truncateOutput(rawContent, 200).replace(/\n/g, '\n      ')}`);
                }
            }
        }

        const updatedPlan = state.plan.map(s =>
            s.status === 'in_progress' ? { ...s, status: 'completed' as const } : s
        );

        return {
            ...result,
            plan: updatedPlan,
            toolResults: newToolResults,
            executionOutput: newToolResults.map(e => `[${e.toolName}] ${e.output}`).join('\n---\n')
        };
    }

    // ---------------------------------------------------------------------------
    // REFLECTOR NODE
    // ---------------------------------------------------------------------------
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, taskDescription, iterationCount, plan, toolResults } = state;

        console.log(`\n================================================================================`);
        console.log(`🤔 [REFLECTOR] Analyzing execution results`);
        console.log(`   Iteration: ${iterationCount}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================`);

        const skillCritiqueContext = skillContent
            ? `The executor is operating under the "${selectedSkill}" skill. Use the following skill instructions to verify correctness and adherence:\n\n${skillContent}`
            : `The executor is operating as a general-purpose agentic assistant with no specific skill constraints. Ensure it is acting helpfully and correctly.`;

        const reflectorSystemPrompt = new SystemMessage(`You are a principal-level AWS and DevOps engineer performing a structured review of an AI agent's execution output.

${skillCritiqueContext}

Original Task: ${taskDescription}

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Iteration: ${iterationCount}/${MAX_ITERATIONS}

## Review Criteria

Evaluate the execution against these five dimensions:

1. **Correctness**: Did the tool outputs and commands produce accurate, expected results? Are the AWS CLI commands syntactically and semantically correct for the stated intent?

2. **Completeness**: Were all parts of the current step fully addressed? Are paginated results handled (i.e., did the agent collect all pages, not just the first)? Is anything clearly missing from the output?

3. **AWS Best Practices**: Did the agent use --output json? Did it use --profile correctly? Did it verify state before mutating? Did it handle pagination where required?

4. **Idempotency and Safety**: For mutation steps, was current state checked first? Was --dry-run used where appropriate? Is the action targeted at the correct resource (correct ID, correct account, correct region)?

5. **Error Handling**: If a tool returned an error or unexpected output, was it correctly identified and addressed, or silently ignored? ⚠️ CRITICAL: Flag any "content is required" or parameter validation errors from write_file as blocking issues that MUST be fixed in revision.

## Completion Criteria

Set isComplete to true ONLY when ALL of the following are true:
- Every plan step is marked completed, or an explicit decision was made to skip it with justification.
- The original task has been fully accomplished as stated by the user.
- No critical errors remain unresolved.
- Output is sufficient for the user to act on or understand the result.

## Output Format

Respond with exactly this JSON object — no markdown, no commentary outside the JSON:
{
    "analysis": "Concise assessment of what was done, quality of execution, and whether the step objective was met",
    "issues": "Specific issues found — wrong flags, missing pagination, incorrect resource targeted, error suppressed, etc. Use 'None' if no issues",
    "suggestions": "Concrete corrective actions for the reviser to take, referencing specific tool calls or flags. Use 'None' if no suggestions",
    "isComplete": true or false,
    "updatedPlan": [
        { "step": "Exact step description from the original plan", "status": "completed" | "pending" | "failed" }
    ]
}

You MUST return the updatedPlan array with the current status of every step. Only return the JSON object, nothing else.`);

        const recentAiMessages = messages.filter(m => m._getType() === 'ai');
        const lastAiMessage = recentAiMessages.length > 0 ? recentAiMessages[recentAiMessages.length - 1] : null;
        let lastAiText = "None";
        if (lastAiMessage && lastAiMessage.content) {
            lastAiText = typeof lastAiMessage.content === 'string'
                ? lastAiMessage.content
                : JSON.stringify(lastAiMessage.content);
        }

        const summaryInput = new HumanMessage({
            content: `Please analyze the following execution and provide your feedback in JSON format.

Recent Assistant Output:
${truncateOutput(lastAiText, 1500)}

Tool Results (most recent):
${toolResults.slice(-3).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}] ${truncateOutput(e.output, 500)}`).join('\n---\n')}

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`
        });

        const _auditInputs_ref = [reflectorSystemPrompt, summaryInput];
        const _auditStart_ref = Date.now();
        let response: Awaited<ReturnType<typeof reflectorModel.invoke>>;
        try {
            response = await reflectorModel.invoke(_auditInputs_ref);
            llmAuditLog('REFLECTOR', _auditInputs_ref, response, _auditStart_ref);
        } catch (err: any) {
            // If the reflector fails (throttle, context overflow, parse-impossible), treat the
            // work as complete and force finalization rather than aborting the whole run.
            console.warn(`⚠️ [REFLECTOR] invoke failed, forcing finalization: ${err?.message ?? err}`);
            return {
                messages: [tagMessagePhase(new AIMessage({ content: "🔍 Reflection skipped due to a model/provider error — finalizing with the results gathered so far." }), 'reflection')],
                reflection: state.reflection || "Reflection unavailable (provider error).",
                isComplete: true,
                nextAction: "complete",
            };
        }

        let analysis = "";
        let issues = "None";
        let suggestions = "None";
        let isComplete = false;
        let updatedPlan: PlanStep[] = [];

        try {
            const content = response.content as string;
            console.log(`[Reflector] Raw content: ${truncateOutput(content, 200)}`);

            // Extract outermost JSON object using balanced-brace scan to avoid
            // greedy regex capturing embedded JSON strings in large tool outputs.
            let jsonStr: string | null = null;
            const start = content.indexOf('{');
            if (start !== -1) {
                let depth = 0;
                for (let i = start; i < content.length; i++) {
                    if (content[i] === '{') depth++;
                    else if (content[i] === '}') { depth--; if (depth === 0) { jsonStr = content.slice(start, i + 1); break; } }
                }
            }
            const jsonMatch = jsonStr ? [jsonStr] : null;
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    analysis = parsed.analysis || "";
                    issues = parsed.issues || "None";
                    suggestions = parsed.suggestions || "None";
                    isComplete = parsed.isComplete === true;
                    if (parsed.updatedPlan && Array.isArray(parsed.updatedPlan) && parsed.updatedPlan.length > 0) {
                        updatedPlan = parsed.updatedPlan;
                    }
                } catch (parseErr) {
                    console.warn("[Reflector] JSON.parse failed, using isComplete regex fallback:", parseErr);
                    if (/["']?isComplete["']?\s*:\s*true/.test(jsonMatch[0])) {
                        isComplete = true;
                        analysis = "Task completed (reflector JSON parse failed but isComplete detected)";
                    } else {
                        analysis = "Reflection JSON parse failed. Continuing.";
                        isComplete = false;
                    }
                }
            } else {
                console.log("[Reflector] No JSON found, using raw content fallback");
                analysis = content;
                if (content.toLowerCase().includes("task complete") || content.toLowerCase().includes("successfully completed")) {
                    isComplete = true;
                }
            }
        } catch (e) {
            console.error("[Reflector] Parsing failed:", e);
            analysis = "Reflection parsing failed. Continuing with next iteration.";
            isComplete = false;
        }

        console.log(`\n🧐 [REFLECTOR] Analysis Complete:`);
        console.log(`   Analysis:    ${truncateOutput(analysis, 300)}`);
        console.log(`   Issues:      ${issues !== "None" ? '❌ ' + issues : '✅ None'}`);
        console.log(`   Suggestions: ${suggestions !== "None" ? '💡 ' + suggestions : 'None'}`);
        console.log(`   Status:      ${isComplete ? '✅ COMPLETE' : '🔄 CONTINUING'}`);
        console.log(`--------------------------------------------------------------------------------\n`);

        const feedback = `🔍 **Reflection Analysis:**
${analysis}

${issues !== "None" ? `⚠️ **Issues Found:** ${issues}` : ""}
${suggestions !== "None" ? `💡 **Suggestions:** ${suggestions}` : ""}

**Task Complete:** ${isComplete ? "✅ Yes" : "❌ No, continuing..."}`;

        if (iterationCount >= MAX_ITERATIONS && !isComplete) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached. Forcing completion.`);
            isComplete = true;
        }

        const resultState: Partial<ReflectionState> = {
            messages: [tagMessagePhase(new AIMessage({ content: feedback }), 'reflection')],
            reflection: analysis,
            errors: issues !== "None" ? [issues] : [],
            isComplete,
            nextAction: isComplete ? "complete" : "revise"
        };

        if (updatedPlan.length > 0) {
            resultState.plan = updatedPlan;
        }

        return resultState;
    }

    // ---------------------------------------------------------------------------
    // REVISER NODE
    // ---------------------------------------------------------------------------
    async function reviseNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
        const { messages, reflection, errors, iterationCount } = state;

        const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
        const { windowMessages, workingMemorySection, stateUpdate } =
            await prepareContext(state, { ...wmDeps, threadId }, 10);

        console.log(`\n================================================================================`);
        console.log(`📝 [REVISER] Applying fixes and improvements`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const reviserSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to address the specific issues identified by the reviewer and advance the plan toward completion.
${effectiveSkillSection}
${CORE_PRINCIPLES}
${workingMemorySection}
## Reviewer Feedback

Analysis: ${reflection}

Issues to Address: ${errors.join(', ') || 'None'}

## Revision Approach

1. Read the reviewer's issues carefully — each issue points to a specific gap, error, or missing action.
2. For AWS CLI issues (wrong flags, missing --output json, missing pagination, wrong profile): re-run the corrected command immediately.
3. For missing data (incomplete pagination, only first page retrieved): fetch the remaining pages using --starting-token or --no-paginate.
4. For resource state issues (mutation attempted on resource in wrong state): run the corresponding describe command first, then re-attempt the mutation with the correct preconditions.
5. For write_file parameter errors (missing "content" or "file_path"): CRITICAL — Always include BOTH file_path AND content parameters together. Re-call write_file with both required parameters populated. Never skip this step.
6. For errors returned by tools: diagnose the root cause (permissions, resource not found, wrong region, wrong account) and fix the underlying issue rather than retrying the same command unchanged.
7. Do not repeat actions that the reviewer marked as correctly completed — focus only on the open issues.
8. After fixing all issues, provide a brief summary of what was corrected and what the result now shows.
${accountContext}`);

        const recentMessages = windowMessages;
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please fix the issues mentioned in the reflection." }));
        }
        const safeMessages = sanitizeMessagesForBedrock(recentMessages);
        const _auditInputs_rev = [reviserSystemPrompt, ...safeMessages];
        const _auditStart_rev = Date.now();
        let response: AIMessage;
        try {
            response = await modelWithTools.invoke(_auditInputs_rev) as AIMessage;
            llmAuditLog('REVISER', _auditInputs_rev, response, _auditStart_rev);
        } catch (err: any) {
            // Provider error while revising: emit a text note (no tool calls) so the graph
            // routes back to reflection and can finalize instead of aborting.
            console.error(`⚠️ [REVISER] LLM invoke failed: ${err?.message ?? err}`);
            response = new AIMessage({ content: `⚠️ Revision could not be completed due to a model/provider error (${err?.message ?? err}).` });
        }

        const revHasToolCalls = 'tool_calls' in response && !!response.tool_calls && response.tool_calls.length > 0;
        if (revHasToolCalls) {
            console.log(`\n🛠️ [REVISER] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls!) {
                console.log(`   → Tool: ${toolCall.name}`);
            }
        }

        return {
            messages: [tagMessagePhase(response, 'revision')],
            nextAction: "generate",
            // Advance the iteration counter on the prose reflect→revise→reflect cycle. The
            // executor only increments when it runs, so a reviser returning prose (no tool
            // calls) would otherwise ping-pong reflect↔revise until GraphRecursionError. When
            // the reviser emits tool_calls the tools→generate path increments as before, so
            // we leave the counter untouched there to avoid double-counting.
            ...(revHasToolCalls ? {} : { iterationCount: iterationCount + 1 }),
            ...stateUpdate,
        };
    }

    // ---------------------------------------------------------------------------
    // FINAL OUTPUT NODE
    // ---------------------------------------------------------------------------
    async function finalNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { taskDescription, iterationCount, reflection, toolResults, plan } = state;

        console.log(`\n================================================================================`);
        console.log(`🏁 [FINAL] Generating comprehensive summary`);
        console.log(`================================================================================\n`);

        const summarySystemPrompt = new SystemMessage(`You are a senior DevOps engineer writing the final delivery note for a completed automated task.

Original Task: ${taskDescription}

Execution Summary:
- Iterations used: ${iterationCount}
- Plan steps: ${plan.map(s => `${s.step} (${s.status})`).join(' | ')}

Key Tool Outputs (most recent):
${toolResults.slice(-3).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}]\n${truncateOutput(e.output, 500)}`).join('\n\n---\n\n')}

Final Review Notes: ${reflection}

Write a clear, markdown-formatted summary for the user that includes:

1. **What Was Accomplished** — state the outcome directly, not the process
2. **Key Findings or Results** — bullet the most important data points, IDs, metrics, or decisions from the tool outputs
3. **Errors or Limitations** — if any step failed or returned partial data, state it explicitly with the reason
4. **Recommended Next Steps** — concrete actions the user should consider based on the findings

Write for an engineer audience. Be specific — include resource IDs, account names, service names, and numeric values where the data is available.`);

        const summaryInput = new HumanMessage({
            content: `Please provide the final summary for the completed task.`
        });
        const _auditInputs_fin = [summarySystemPrompt, summaryInput];
        const _auditStart_fin = Date.now();
        let summaryContent: string;
        try {
            const summaryResponse = await model.invoke(_auditInputs_fin);
            llmAuditLog('FINAL', _auditInputs_fin, summaryResponse, _auditStart_fin);
            summaryContent = typeof summaryResponse.content === 'string'
                ? summaryResponse.content
                : JSON.stringify(summaryResponse.content);
        } catch (err: any) {
            // A finalize failure must never crash the run — assemble a best-effort summary
            // from the tool results and review notes already captured in state.
            console.error(`⚠️ [FINAL] Summary synthesis failed: ${err?.message ?? err}`);
            const toolDigest = toolResults.length > 0
                ? toolResults.slice(-3).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}]\n${truncateOutput(e.output, 500)}`).join('\n\n---\n\n')
                : '(no tool output was captured)';
            summaryContent = `⚠️ I could not generate a polished summary due to a model/provider error (${err?.message ?? err}), but here is what was gathered:

**Key tool outputs:**
${toolDigest}

**Review notes:** ${reflection || 'None'}`;
        }

        const finalMessage = `✅ **Task Complete**

**Original Task:** ${taskDescription}

**Iterations Used:** ${iterationCount}

---

${summaryContent}`;

        console.log(`--- FINAL: Summary generated ---`);

        return {
            messages: [tagMessagePhase(new AIMessage({ content: finalMessage }), 'final')],
            isComplete: true
        };
    }

    // ---------------------------------------------------------------------------
    // CONDITIONAL EDGES
    // ---------------------------------------------------------------------------
    function shouldContinueFromGenerate(state: ReflectionState): "guard" | "reflect" | "final" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        const { iterationCount } = state;

        // Hard cap FIRST — prevents unbounded loops when model keeps generating tool_calls
        if (iterationCount >= MAX_ITERATIONS) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached in generate. Forcing reflection.`);
            return "reflect";
        }

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "guard";
        }

        if (iterationCount <= 1) {
            console.log("⚡ [Fast Path] First iteration with no tools. Skipping reflection.");
            return "final";
        }

        return "reflect";
    }

    function shouldContinueFromTools(state: ReflectionState): "generate" | "reflect" {
        const { iterationCount } = state;
        if (iterationCount >= MAX_ITERATIONS) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached after tools. Forcing reflection.`);
            return "reflect";
        }
        return "generate";
    }

    function shouldContinueFromRevise(state: ReflectionState): "guard" | "reflect" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        const { iterationCount } = state;

        // Hard cap — prevent unbounded tool loops from reviser
        if (iterationCount >= MAX_ITERATIONS) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached in revise. Forcing reflection.`);
            return "reflect";
        }

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "guard";
        }
        return "reflect";
    }

    function shouldContinueFromReflect(state: ReflectionState): "revise" | "final" {
        const { isComplete, iterationCount } = state;
        if (isComplete || iterationCount >= MAX_ITERATIONS) {
            return "final";
        }
        return "revise";
    }

    // ---------------------------------------------------------------------------
    // GRAPH CONSTRUCTION
    // ---------------------------------------------------------------------------
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("memory_recall", memoryRecallNode)
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("guard", guardNode)
        .addNode("approval_gate", approvalGateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("revise", reviseNode)
        .addNode("final", finalNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "planner")
        .addEdge("planner", "generate")

        .addConditionalEdges("generate", shouldContinueFromGenerate, {
            guard: "guard",
            reflect: "reflect",
            final: "final"
        })

        .addConditionalEdges("guard", (state: ReflectionState) => routeAfterGuard(state, autoApprove), {
            approval_gate: "approval_gate",
            tools: "tools"
        })
        .addEdge("approval_gate", "tools")

        .addConditionalEdges("tools", shouldContinueFromTools, {
            generate: "generate",
            reflect: "reflect"
        })

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            revise: "revise",
            final: "final"
        })

        .addConditionalEdges("revise", shouldContinueFromRevise, {
            guard: "guard",
            reflect: "reflect"
        })

        .addEdge("final", "memory_save")
        .addEdge("memory_save", END);

    // The gate is ALWAYS compiled in; routeAfterGuard decides whether flow enters it.
    console.log(`[Graph] Compiling with approval_gate interrupt (autoApprove=${autoApprove} affects routing only)`);
    return workflow.compile({
        checkpointer,
        ...(store && { store }),
        interruptBefore: ["approval_gate"],
    });
}
