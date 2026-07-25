import { AIMessage, SystemMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
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
    truncateForReview,
    contentToText,
    isToolResultError,
    sanitizeMessagesForBedrock,
    withUnresolvedToolCallsOnly,
    tagMessagePhase,
    llmAuditLog,
    getCheckpointer,
    getStore,
    REFLECTION_STALL_LIMIT,
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
import { prepareContext, buildWorkingMemorySection, estimateTokens } from "./memory/working-memory";
import { createGuardNode } from "./guard";
import { routeAfterGuard } from "./gate-routing";
import { recordNodeTiming } from "./run-timings";

const PLAN_STATUSES = new Set<PlanStep['status']>(['completed', 'in_progress', 'pending', 'failed']);

function isValidPlanStatus(value: unknown): value is PlanStep['status'] {
    return typeof value === 'string' && PLAN_STATUSES.has(value as PlanStep['status']);
}

/**
 * Maps the reflector's `updatedPlan` entries onto the existing `plan` array by
 * 1-based `index` (current format — avoids echoing full step text, which is what
 * blew the reflector's token budget). Falls back to matching by exact `step` text
 * for the old format (backward compatible with any in-flight/replayed runs).
 * Malformed entries (bad status, out-of-range index, unmatched step text) are
 * silently ignored — the corresponding step just keeps its current status.
 * Returns [] when nothing in `entries` could be applied, signalling "no change".
 */
export function mapUpdatedPlanEntries(entries: unknown[], plan: PlanStep[]): PlanStep[] {
    if (!Array.isArray(entries) || entries.length === 0 || plan.length === 0) return [];

    const statusByIndex = new Map<number, PlanStep['status']>();

    for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        if (!isValidPlanStatus(entry.status)) continue;

        if (typeof entry.index === 'number' && Number.isInteger(entry.index)) {
            const idx = entry.index - 1; // prompt uses 1-based indexing
            if (idx >= 0 && idx < plan.length) {
                statusByIndex.set(idx, entry.status);
            }
            continue;
        }

        if (typeof entry.step === 'string' && entry.step.trim().length > 0) {
            const matchIdx = plan.findIndex(p => p.step === entry.step);
            if (matchIdx !== -1) {
                statusByIndex.set(matchIdx, entry.status);
            }
        }
    }

    if (statusByIndex.size === 0) return [];

    return plan.map((s, i) => ({ ...s, status: statusByIndex.get(i) ?? s.status }));
}

export interface ParsedReflectorResult {
    analysis: string;
    issues: string;
    suggestions: string;
    isComplete: boolean;
    updatedPlan: PlanStep[];
    /** True when parsing threw outright — feeds the consecutive-failure fail-safe. */
    parseFailed?: boolean;
}

/**
 * Parses the reflector's raw model output into a structured verdict. Exported so it
 * can be unit-tested directly (truncated JSON, index vs. legacy step-text plan
 * formats, malformed entries) without spinning up the full graph.
 *
 * Truncation tolerance: the balanced-brace scan below only matches a JSON object
 * that actually closes — a maxTokens cutoff mid-object leaves it unmatched, which
 * used to silently drop a genuine `"isComplete": true` the model already wrote.
 * The raw-content fallback now re-checks for that literal before giving up.
 */
export function parseReflectorResponse(content: string, plan: PlanStep[]): ParsedReflectorResult {
    let analysis = "";
    let issues = "None";
    let suggestions = "None";
    let isComplete = false;
    let updatedPlan: PlanStep[] = [];

    try {
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
                    updatedPlan = mapUpdatedPlanEntries(parsed.updatedPlan, plan);
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
            } else if (/["']?isComplete["']?\s*:\s*true/.test(content)) {
                // Balanced-brace scan found no closing brace (maxTokens truncation) but the
                // model had already emitted isComplete:true before getting cut off.
                isComplete = true;
                analysis = "Task completed (reflector response truncated but isComplete detected)";
            }
        }
    } catch (e) {
        console.error("[Reflector] Parsing failed:", e);
        return {
            analysis: "Reflection parsing failed. Continuing with next iteration.",
            issues, suggestions, isComplete: false, updatedPlan, parseFailed: true,
        };
    }

    return { analysis, issues, suggestions, isComplete, updatedPlan };
}

/**
 * Stall breaker: when the reviser produces two consecutive no-tool-call (prose-only)
 * revisions, there is no new evidence for the reflector to evaluate — left alone, a
 * "not complete" verdict here just sends it back to revise again, ping-ponging until
 * MAX_ITERATIONS. Forces completion instead, keeping whatever was already gathered.
 * Extracted as a pure function (rather than inlined in reflectNode) so the decision
 * is unit-testable without spinning up the graph.
 */
export function applyStallBreaker(parsed: ParsedReflectorResult, stallCount: number): ParsedReflectorResult {
    if (parsed.isComplete || stallCount < 2) return parsed;
    console.log(`⚠️ [REFLECTOR] Stall detected (2 consecutive no-op revisions) — forcing completion with gathered results.`);
    return {
        ...parsed,
        isComplete: true,
        analysis: `${parsed.analysis}\n\n(Auto-completed: 2 consecutive revision cycles produced no new tool activity.)`,
    };
}

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

    // Skill catalog for progressive disclosure — gated by the console "Auto
    // skills" toggle (default on). The zero-skill sentinel string must not leak
    // into the prompt. Fetched even when a skill is pinned: the load_skill tool
    // lets the agent pull ADDITIONAL skills mid-run for phases outside the
    // active skill's scope.
    const autoLoadSkills = config.autoLoadSkills !== false;
    const skillCatalog = tenantId && autoLoadSkills
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
    const tools = await assembleTools({ includeS3Tools: true, includeMemoryTools: false, includeSkillTool: autoLoadSkills, userId: config.userId, mcpServerIds, tenantId, accounts, knowledgeBaseIds: config.knowledgeBaseIds });
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
    async function planNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
        const { messages, memoryContext } = state;
        const workingMemorySection = buildWorkingMemorySection(
            state.runningSummary || (state.scratchpad?.openGoals?.length ?? 0) > 0
                ? { runningSummary: state.runningSummary ?? '', scratchpad: state.scratchpad ?? { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }, tokenCount: 0, turnCount: 0 }
                : null,
        );
        const lastMessage = messages[messages.length - 1];
        const taskDescription = contentToText(lastMessage.content);

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

- The plan is INTERNAL COORDINATION. The user sees it in a progress rail — it is never part of the answer, so optimize it for execution, not for presentation.
- Match plan depth to the request. A simple lookup or single-command request needs only 1–2 steps (credentials + the query); a conversational or no-tool request gets exactly one step: ["Answer the user's request directly"]. Only genuinely multi-phase investigations warrant 5+ steps.
- Keep the plan SHORT: never more than 7 steps. Merge related read-only queries into a single step (e.g., one step for "inventory EC2 + RDS + EBS across regions", not one step per service per region).
- Every step except the last must be a concrete tool action. Do NOT create steps for aggregating, analyzing, summarizing, cross-referencing, or "evaluating" data — that thinking happens inside execution, not as plan line items.
- Do NOT add a knowledge-base search step unless the user asked for it or the task clearly depends on tenant-specific documented context.
- The LAST step is always: compose the final answer to the user's request from the gathered data.
- Order steps by dependency: a step that depends on the output of another must come after it.
- For any AWS operation, the first step is always credential acquisition via get_aws_credentials (or list_aws_accounts + get_aws_credentials if the account is not known).
- For multi-account tasks, add one credential acquisition step per account before any account-specific steps.
- If a step is a mutation (create, update, delete, stop, start, deploy), the step immediately after it must be a verification step (describe, list, get, check status).
- For file-system or code tasks: read before write, check before create.
- If the task is ambiguous, the first step should be a targeted discovery to resolve the ambiguity before committing to an action plan.
${reportStrategy}
${accountContext}

IMPORTANT: Return your plan as a JSON array of concise, action-oriented step descriptions. Each step must be independently executable by the executor agent.
Example: ["Call list_aws_accounts to identify the target account", "Call get_aws_credentials for the matched account ID", "Describe all running EC2 instances using --output json and the obtained profile", "Query CloudWatch for CPUUtilization metrics on each instance over the past 7 days", "Compose the final answer to the user's request directly in the response, with all findings"]

Only return the JSON array, nothing else.`);

        const _auditInputs_plan = [plannerSystemPrompt, lastMessage];
        const _auditStart_plan = Date.now();
        let response: AIMessage;
        try {
            response = await model.invoke(_auditInputs_plan) as AIMessage;
            llmAuditLog('PLANNER', _auditInputs_plan, response, _auditStart_plan);
            recordNodeTiming(runtimeConfig?.configurable?.thread_id, 'PLANNER', Date.now() - _auditStart_plan,
                (response as any).usage_metadata?.input_tokens ?? 0, (response as any).usage_metadata?.output_tokens ?? 0);
        } catch (err: any) {
            // A provider hiccup while planning must not abort the run — fall back to a
            // trivial single-step plan (the empty content flows through the parse fallback below).
            console.error(`[Planner] LLM invoke failed, falling back to single-step plan: ${err?.message ?? err}`);
            response = new AIMessage({ content: '' });
        }

        let planSteps: PlanStep[] = [];
        try {
            const content = contentToText(response.content);
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
- If a tool call returns an error, capture the full error message and diagnose it; do not silently suppress it.
- If the current step is a simple question or greeting that requires no tools, answer directly and concisely.
- If the current step has nothing to execute (empty inventory, prerequisite returned no data), move on silently — NEVER run echo or other no-op commands just to mark a step done, and never write an explanation of why there was nothing to do.

## Narration Discipline (critical)

The user sees plan progress in a UI rail — your prose must NEVER duplicate it:
- Between tool calls, write at most ONE short sentence of context, and only when it genuinely helps the user follow the work. Silence is fine.
- NEVER write step ceremony: no "Step N complete", "Step N — COMPLETED", "Proceeding to step N", plan restatements, progress-checkpoint tables, or per-step summaries.
- Do not narrate what you are about to do or recap what you just did — the tool calls and their results are already visible.
- The final answer to the user's request is composed EXACTLY ONCE, when you reach the plan's compose step. Do not render intermediate aggregation tables, partial summaries, or draft versions of it along the way.
- If you already composed the complete final answer earlier in this conversation and this step revises or corrects it, present the corrected COMPLETE version once, beginning with the exact line "Revised report (supersedes the earlier draft):" — never leave two competing unmarked versions in the conversation.

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
            recordNodeTiming(runtimeConfig?.configurable?.thread_id, 'EXECUTOR', Date.now() - _auditStart_exec,
                (response as any).usage_metadata?.input_tokens ?? 0, (response as any).usage_metadata?.output_tokens ?? 0);
        } catch (err: any) {
            // Provider error mid-step: don't crash the run. Emit a text note (no tool calls)
            // so the graph routes on to reflection/finalization with whatever was gathered.
            console.error(`⚠️ [EXECUTOR] LLM invoke failed: ${err?.message ?? err}`);
            response = new AIMessage({ content: `⚠️ This step could not be executed due to a model/provider error (${err?.message ?? err}). Proceeding with the information gathered so far.` });
        }

        const genHasToolCalls = 'tool_calls' in response && !!response.tool_calls && response.tool_calls.length > 0;
        if (genHasToolCalls) {
            console.log(`\n🛠️ [EXECUTOR] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls!) {
                console.log(`   → Tool: ${toolCall.name}`);
                console.log(`     Args: ${JSON.stringify(toolCall.args)}`);
            }
        } else {
            console.log(`\n💬 [EXECUTOR] No tools called. Generating text response.`);
        }

        // Tool turn: current step goes in_progress (tools node completes it after
        // execution). Prose turn: the step WAS the prose (compose step, or a step
        // with nothing to run) — mark it completed directly. This monotonic
        // advancement is what makes the generate→generate continue-loop in
        // shouldContinueFromGenerate terminate: every prose pass consumes a step.
        const updatedPlan = plan.map((s, i) => {
            if (i === plan.findIndex(p => p.status === 'pending' || p.status === 'in_progress')) {
                return { ...s, status: genHasToolCalls ? 'in_progress' as const : 'completed' as const };
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

        // Map tool_call_id -> args from the AI message(s) that issued these calls, so
        // ToolResultEntry can carry a compact args hint for the reflector (which
        // otherwise sees only anonymous `[toolName]` results for a multi-region sweep).
        const argsByToolCallId = new Map<string, unknown>();
        for (const msg of view.messages) {
            if (msg._getType() === 'ai') {
                for (const tc of (msg as AIMessage).tool_calls ?? []) {
                    if (tc.id) argsByToolCallId.set(tc.id, tc.args);
                }
            }
        }

        const newToolResults: ToolResultEntry[] = [];
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const rawContent = contentToText(msg.content);
                    // Precise classifier (status flag / error-prefix / success:false JSON) —
                    // the old substring match flagged ANY output mentioning "error", e.g. a
                    // successful CloudWatch query for the "Errors" metric.
                    const isError = isToolResultError((msg as ToolMessage).status, rawContent);
                    const toolCallId = (msg as ToolMessage).tool_call_id;
                    const entry: ToolResultEntry = {
                        toolName: (msg as any).name || 'unknown_tool',
                        output: truncateOutput(rawContent, 1000),
                        isError,
                        iterationIndex: state.iterationCount,
                        args: toolCallId ? argsByToolCallId.get(toolCallId) : undefined,
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
    async function reflectNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
        const { messages, taskDescription, iterationCount, plan, toolResults, memoryContext } = state;

        console.log(`\n================================================================================`);
        console.log(`🤔 [REFLECTOR] Analyzing execution results`);
        console.log(`   Iteration: ${iterationCount}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================`);

        const skillCritiqueContext = skillContent
            ? `The executor is operating under the "${selectedSkill}" skill. Use the following skill instructions to verify correctness and adherence:\n\n${skillContent}`
            : `The executor is operating as a general-purpose agentic assistant with no specific skill constraints. Ensure it is acting helpfully and correctly.`;

        // The planner sees recalled memory (memoryContext) and may legitimately build plan
        // steps around it (baseline comparisons, prior findings). The reflector previously
        // had no visibility into memoryContext at all, so it repeatedly flagged those steps
        // as fabricated scope creep. Surface a truncated copy here so it can tell the
        // difference between scope creep and memory-grounded planning.
        const memoryContextSection = memoryContext
            ? `\n## Recalled memory available to the agent\nThe plan may legitimately reference the following recalled facts/experience — do NOT flag steps grounded in these as scope creep:\n${truncateOutput(memoryContext, 2000)}\n`
            : '';

        const reflectorSystemPrompt = new SystemMessage(`You are a principal-level AWS and DevOps engineer performing a structured review of an AI agent's execution output.

${skillCritiqueContext}
${memoryContextSection}
Original Task: ${taskDescription}

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Iteration: ${iterationCount}/${MAX_ITERATIONS}

## Input Notes

- The "Recent Assistant Output" you receive may be truncated FOR REVIEW ONLY. A "[TRUNCATED FOR REVIEW ONLY …]" marker means the real message continued past the cutoff — do NOT report it as an incomplete or truncated deliverable.
- The Plan Status block reflects YOUR OWN last updatedPlan and may lag the assistant's narrative by one cycle — such lag is expected bookkeeping, not an error to flag.

## Do NOT Flag (these are never issues)

Flag only MATERIAL defects — things that make the answer wrong, incomplete, or unsafe. Never flag:
- Plan-status bookkeeping (a step "still marked in_progress/pending" that the narrative already resolved or justifiably skipped). Fix it silently via updatedPlan; it is not an issue and never a reason to keep the run open.
- Formatting, style, verbosity, or presentation of an already-correct answer.
- Results already confirmed by tool output — do not request re-verification of data the tool log already shows.
- Apparent truncation or rendering artifacts in tool output display.
- Missing "nice-to-have" extras the user did not ask for (baselines, watch-items, cross-references, periodic re-check advice).
Every issue you raise costs a full revision cycle. An empty issues list with isComplete=true is the EXPECTED verdict for a clean execution.

## Review Criteria

Evaluate the execution against these five dimensions:

1. **Correctness**: Did the tool outputs and commands produce accurate, expected results? Are the AWS CLI commands syntactically and semantically correct for the stated intent?

2. **Completeness**: Were all parts of the current step fully addressed? Are paginated results handled (i.e., did the agent collect all pages, not just the first)? Is anything clearly missing from the output?

3. **AWS Best Practices**: Did the agent use --output json? Did it use --profile correctly? Did it verify state before mutating? Did it handle pagination where required?

4. **Idempotency and Safety**: For mutation steps, was current state checked first? Was --dry-run used where appropriate? Is the action targeted at the correct resource (correct ID, correct account, correct region)?

5. **Error Handling**: If a tool returned an error or unexpected output, was it correctly identified and addressed, or silently ignored? ⚠️ CRITICAL: Flag any "content is required" or parameter validation errors from write_file as blocking issues that MUST be fixed in revision.

## Completion Criteria

Set isComplete to true when ALL of the following are true:
- Every plan step is marked completed, or an explicit decision was made to skip it with justification.
- The original task has been fully accomplished as stated by the user.
- No critical errors remain unresolved.
- Output is sufficient for the user to act on or understand the result.

Lean toward completion: if the user's request has been answered and no unresolved errors remain, set isComplete=true NOW — do not keep the run open for polish, bookkeeping reconciliation, or optional extras.

## Output Format

Respond with exactly this JSON object — no markdown, no commentary outside the JSON. Put "isComplete" FIRST so it is not lost if your response is cut off:
{
    "isComplete": true or false,
    "analysis": "Concise assessment of what was done, quality of execution, and whether the step objective was met",
    "issues": "Specific issues found — wrong flags, missing pagination, incorrect resource targeted, error suppressed, etc. Use 'None' if no issues",
    "suggestions": "Concrete corrective actions for the reviser to take, referencing specific tool calls or flags. Use 'None' if no suggestions",
    "updatedPlan": [
        { "index": 1, "status": "completed" | "in_progress" | "pending" | "failed" }
    ]
}

"updatedPlan" MUST have exactly one entry per plan step, in order, using the 1-based "index" matching the numbered Plan Status list above. Do NOT repeat the step text — index + status only. Only return the JSON object, nothing else.`);

        const recentAiMessages = messages.filter(m => m._getType() === 'ai');
        const lastAiMessage = recentAiMessages.length > 0 ? recentAiMessages[recentAiMessages.length - 1] : null;
        // contentToText normalizes Claude Sonnet 5's block-array content (dozens of tiny
        // streamed text blocks) to plain text — JSON.stringify-ing that array instead shows
        // the reflector a JSON blob it (correctly, but unhelpfully) describes as "fragmented".
        const lastAiText = lastAiMessage && lastAiMessage.content ? contentToText(lastAiMessage.content) : "None";

        const summaryInput = new HumanMessage({
            content: `Please analyze the following execution and provide your feedback in JSON format.

Recent Assistant Output:
${truncateForReview(lastAiText, 4000)}

Tool Results (most recent):
${toolResults.slice(-8).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}(${truncateOutput(JSON.stringify(e.args ?? {}), 160)})] ${truncateOutput(e.output, 600)}`).join('\n---\n')}

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`
        });

        const _auditInputs_ref = [reflectorSystemPrompt, summaryInput];
        const _auditStart_ref = Date.now();
        let response: Awaited<ReturnType<typeof reflectorModel.invoke>>;
        try {
            response = await reflectorModel.invoke(_auditInputs_ref);
            llmAuditLog('REFLECTOR', _auditInputs_ref, response, _auditStart_ref);
            recordNodeTiming(runtimeConfig?.configurable?.thread_id, 'REFLECTOR', Date.now() - _auditStart_ref,
                (response as any).usage_metadata?.input_tokens ?? 0, (response as any).usage_metadata?.output_tokens ?? 0);
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

        const content = contentToText(response.content);
        console.log(`[Reflector] Raw content: ${truncateOutput(content, 200)}`);

        const parsedResult = applyStallBreaker(parseReflectorResponse(content, plan), state.stallCount ?? 0);
        const { issues, suggestions, updatedPlan } = parsedResult;
        let { analysis, isComplete } = parsedResult;
        // Feeds the consecutive-failure fail-safe below: empty reflector text
        // (Sonnet 5's reasoning block can consume the whole output budget,
        // stopReason max_tokens -> zero text) and unparseable output both count
        // as a failed reflection.
        const parseFailed = !content.trim() || parsedResult.parseFailed === true;

        // Fail-safe (defense in depth): a reflector we cannot parse must NEVER be
        // able to spin the reflect→revise loop. Before this guard, a parse failure
        // left isComplete=false every round, so the loop churned all the way to
        // MAX_ITERATIONS burning an LLM call per lap. After REFLECTION_STALL_LIMIT
        // consecutive unparseable reflections, finalize with what we already have.
        const priorFailures = state.reflectionStallCount ?? 0;
        const parseFailures = parseFailed ? priorFailures + 1 : 0;
        if (parseFailed && parseFailures >= REFLECTION_STALL_LIMIT) {
            isComplete = true;
            analysis = `Reflection output could not be parsed ${parseFailures} times in a row — finalizing with the results gathered so far rather than retrying further.`;
            console.warn(`⚠️ [REFLECTOR] ${parseFailures} consecutive parse failures — forcing completion.`);
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
            nextAction: isComplete ? "complete" : "revise",
            // Reset the stall counter whenever we land on completion, tidy either way.
            ...(isComplete ? { stallCount: 0 } : {}),
            reflectionStallCount: parseFailures,
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
            recordNodeTiming(runtimeConfig?.configurable?.thread_id, 'REVISER', Date.now() - _auditStart_rev,
                (response as any).usage_metadata?.input_tokens ?? 0, (response as any).usage_metadata?.output_tokens ?? 0);
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
            // Stall breaker feed: no tool calls means this revision made no new progress.
            // Two of these in a row forces completion in reflectNode (see stallCount there).
            stallCount: revHasToolCalls ? 0 : (state.stallCount ?? 0) + 1,
            ...stateUpdate,
        };
    }

    // ---------------------------------------------------------------------------
    // FINAL OUTPUT NODE
    // ---------------------------------------------------------------------------
    async function finalNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
        const { taskDescription, toolResults } = state;

        console.log(`\n================================================================================`);
        console.log(`🏁 [FINAL] Generating the user-facing answer`);
        console.log(`================================================================================\n`);

        // Did the executor (or reviser) already compose the full deliverable in-chat?
        // Any substantial execution/revision-phase text message counts. When it did,
        // PROMOTE that text verbatim as the final message — no LLM call. Rationale:
        // the UI renders only final/revision-phase messages as the Report card
        // (execution prose lands in the work rail), and an LLM "closing note" here
        // has only the last 3 truncated tool outputs as context, so it invents
        // follow-ups that contradict the real report (observed in live testing).
        // Verbatim promotion = zero drift, zero hallucination surface, zero cost.
        const deliverablePhases = new Set(['execution', 'revision']);
        let renderedDeliverable: string | null = null;
        for (const m of state.messages) {
            if (
                m._getType() === 'ai' &&
                deliverablePhases.has((m as unknown as { response_metadata?: { agentPhase?: string } }).response_metadata?.agentPhase ?? '') &&
                typeof m.content === 'string' &&
                m.content.trim().length >= 800
            ) {
                renderedDeliverable = m.content; // keep scanning — last one wins (latest revision)
            }
        }

        if (renderedDeliverable) {
            console.log(`--- FINAL: Promoting already-rendered deliverable verbatim (no LLM call) ---`);
            return {
                messages: [tagMessagePhase(new AIMessage({ content: renderedDeliverable }), 'final')],
                isComplete: true
            };
        }

        const summaryContext = `User's request: ${taskDescription}

Key Tool Outputs (most recent):
${toolResults.slice(-3).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}]\n${truncateOutput(e.output, 500)}`).join('\n\n---\n\n')}`;

        const groundingRule = `STRICT GROUNDING: state only facts that literally appear in the Key Tool Outputs above. Never introduce or extrapolate counts, region lists, resource names, or metrics that are not present there — when a detail is unavailable, refer the user to the report above instead of estimating. Write in second person ("you"), never about "the agent", plan steps, or iteration counts.`;

        const summarySystemPrompt = new SystemMessage(`You are a senior DevOps engineer answering the user's request directly. Give them the answer — not a report about how it was produced.

${summaryContext}

Write a clear, markdown-formatted answer to the user's request:
- Lead with the actual answer. Match the length and shape of the request: a direct question gets a direct answer; a broad investigation may use headings and bullets. Do not force a fixed report structure.
- Be specific — include resource IDs, account names, service names, and numeric values from the tool outputs.
- Do NOT describe the process, iterations, plan steps, or any internal review. The user does not care how the answer was produced.
- Mention a limitation ONLY if a step actually failed or returned partial data — one line, with the reason. Otherwise say nothing about limitations.
- Suggest a next step ONLY if one is genuinely warranted. Otherwise stop.

${groundingRule}`);

        const summaryInput = new HumanMessage({
            content: `Provide your answer to the user's request now.`
        });
        const _auditInputs_fin = [summarySystemPrompt, summaryInput];
        const _auditStart_fin = Date.now();
        let summaryContent: string;
        try {
            const summaryResponse = await model.invoke(_auditInputs_fin);
            llmAuditLog('FINAL', _auditInputs_fin, summaryResponse, _auditStart_fin);
            recordNodeTiming(runtimeConfig?.configurable?.thread_id, 'FINAL', Date.now() - _auditStart_fin,
                (summaryResponse as any).usage_metadata?.input_tokens ?? 0, (summaryResponse as any).usage_metadata?.output_tokens ?? 0);
            summaryContent = contentToText(summaryResponse.content);
        } catch (err: any) {
            // A finalize failure must never crash the run — assemble a best-effort answer
            // from the tool results already captured in state.
            console.error(`⚠️ [FINAL] Summary synthesis failed: ${err?.message ?? err}`);
            const toolDigest = toolResults.length > 0
                ? toolResults.slice(-3).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}]\n${truncateOutput(e.output, 500)}`).join('\n\n---\n\n')
                : '(no tool output was captured)';
            summaryContent = `⚠️ I could not generate a polished answer due to a model/provider error (${err?.message ?? err}), but here is what was gathered:

**Key tool outputs:**
${toolDigest}`;
        }

        console.log(`--- FINAL: Answer generated ---`);

        // Return the answer directly — no "Task Complete / Original Task / Iterations Used"
        // telemetry wrapper. The user asked a question; they get the answer, not a report
        // about how many loops the agent spun.
        return {
            messages: [tagMessagePhase(new AIMessage({ content: summaryContent }), 'final')],
            isComplete: true
        };
    }

    // ---------------------------------------------------------------------------
    // CONDITIONAL EDGES
    // ---------------------------------------------------------------------------
    function shouldContinueFromGenerate(state: ReflectionState): "guard" | "generate" | "reflect" | "final" {
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

        // Reflect-at-completion: a prose turn mid-plan is just a step that needed no
        // tools (generateNode already marked it completed) — keep executing the
        // remaining steps instead of spending an LLM review on every prose pass.
        // Reflection runs ONCE, when the plan is exhausted. Terminates because each
        // prose pass completes a step and iterationCount is hard-capped above.
        const hasOpenSteps = state.plan.some(s => s.status === 'pending' || s.status === 'in_progress');
        if (hasOpenSteps) {
            console.log(`▶️ [Continue] Prose turn with open plan steps — continuing execution (no mid-run reflection).`);
            return "generate";
        }

        console.log(`🔍 [Completion Check] Plan exhausted — running the single completion review.`);
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
            generate: "generate",
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
