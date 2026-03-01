import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getSkillContent } from "./skills/skill-loader";
import {
    GraphConfig,
    ReflectionState,
    PlanStep,
    ToolResultEntry,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    getRecentMessages,
    sanitizeMessagesForBedrock,
    llmAuditLog,
    getCheckpointer,
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
import { createAgentModels, assembleTools } from "./model-factory";

// Factory function to create a configured reflection graph
export async function createReflectionGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
    const checkpointer = await getCheckpointer();

    // Log skill loading
    if (selectedSkill) {
        const content = getSkillContent(selectedSkill);
        if (content) {
            console.log(`[PlanningAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[PlanningAgent] Failed to load skill content for: ${selectedSkill}`);
        }
    }

    // --- Shared prompt fragments (built once, reused across all nodes) ---
    const baseIdentity = buildBaseIdentity(selectedSkill);
    const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill);
    const accountContext = buildAccountContext({ accounts, accountId, accountName });
    const awsCliStandards = buildAwsCliStandards();
    const reportStrategy = buildReportStrategy();
    const autoApproveGuidance = buildAutoApproveGuidance(autoApprove);
    const operationalWorkflows = buildOperationalWorkflows();

    // skillContent still needed for the reflector's critique context
    const skillContent = selectedSkill ? (getSkillContent(selectedSkill) || '') : '';

    // --- Model Initialization ---
    const { main: model, reflector: reflectorModel } = createAgentModels(modelId);

    // --- Tool Assembly ---
    const tools = await assembleTools({ includeS3Tools: true, mcpServerIds, tenantId });
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // ---------------------------------------------------------------------------
    // PLANNER NODE
    // ---------------------------------------------------------------------------
    async function planNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages } = state;
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
        const response = await model.invoke(_auditInputs_plan);
        llmAuditLog('PLANNER', _auditInputs_plan, response, _auditStart_plan);

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
            messages: [new AIMessage({ content: `📋 **Plan Created:**\n${planText}` })],
            nextAction: "generate"
        };
    }

    // ---------------------------------------------------------------------------
    // GENERATOR (EXECUTOR) NODE
    // ---------------------------------------------------------------------------
    async function generateNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, plan, iterationCount } = state;

        console.log(`\n================================================================================`);
        console.log(`⚡ [EXECUTOR] Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Current Step: ${plan.find(s => s.status === 'pending')?.step || 'Executing...'}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const pendingSteps = plan.filter(s => s.status === 'pending' || s.status === 'in_progress');
        const currentStep = pendingSteps[0]?.step || "Complete the task";

        const executorSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to execute the current plan step precisely and completely using available tools.
${effectiveSkillSection}
${CORE_PRINCIPLES}
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

        const recentMessages = getRecentMessages(messages, 15);
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please execute the next step of the plan based on the tools available." }));
        }
        const safeMessages = sanitizeMessagesForBedrock(recentMessages);
        const _auditInputs_exec = [executorSystemPrompt, ...safeMessages];
        const _auditStart_exec = Date.now();
        const response = await modelWithTools.invoke(_auditInputs_exec);
        llmAuditLog('EXECUTOR', _auditInputs_exec, response, _auditStart_exec);

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
            messages: [response],
            iterationCount: iterationCount + 1,
            plan: updatedPlan
        };
    }

    // ---------------------------------------------------------------------------
    // TOOL NODE (with result collection)
    // ---------------------------------------------------------------------------
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [TOOLS] Executing tool calls...`);
        const result = await toolNode.invoke(state);
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
${toolResults.slice(-3).map(e => `[${e.isError ? '❌' : '✅'} ${e.toolName}] ${e.output}`).join('\n---\n')}

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`
        });

        const _auditInputs_ref = [reflectorSystemPrompt, summaryInput];
        const _auditStart_ref = Date.now();
        const response = await reflectorModel.invoke(_auditInputs_ref);
        llmAuditLog('REFLECTOR', _auditInputs_ref, response, _auditStart_ref);

        let analysis = "";
        let issues = "None";
        let suggestions = "None";
        let isComplete = false;
        let updatedPlan: PlanStep[] = [];

        try {
            const content = response.content as string;
            console.log(`[Reflector] Raw content: ${truncateOutput(content, 200)}`);

            const jsonMatch = content.match(/\{[\s\S]*\}/);
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
            messages: [new AIMessage({ content: feedback })],
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
    async function reviseNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, reflection, errors } = state;

        console.log(`\n================================================================================`);
        console.log(`📝 [REVISER] Applying fixes and improvements`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const reviserSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to address the specific issues identified by the reviewer and advance the plan toward completion.
${effectiveSkillSection}
${CORE_PRINCIPLES}
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

        const recentMessages = getRecentMessages(messages, 10);
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please fix the issues mentioned in the reflection." }));
        }
        const safeMessages = sanitizeMessagesForBedrock(recentMessages);
        const _auditInputs_rev = [reviserSystemPrompt, ...safeMessages];
        const _auditStart_rev = Date.now();
        const response = await modelWithTools.invoke(_auditInputs_rev);
        llmAuditLog('REVISER', _auditInputs_rev, response, _auditStart_rev);

        if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
            console.log(`\n🛠️ [REVISER] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls) {
                console.log(`   → Tool: ${toolCall.name}`);
            }
        }

        return {
            messages: [response],
            nextAction: "generate"
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
        const summaryResponse = await model.invoke(_auditInputs_fin);
        llmAuditLog('FINAL', _auditInputs_fin, summaryResponse, _auditStart_fin);
        const summaryContent = typeof summaryResponse.content === 'string'
            ? summaryResponse.content
            : JSON.stringify(summaryResponse.content);

        const finalMessage = `✅ **Task Complete**

**Original Task:** ${taskDescription}

**Iterations Used:** ${iterationCount}

---

${summaryContent}`;

        console.log(`--- FINAL: Summary generated ---`);

        return {
            messages: [new AIMessage({ content: finalMessage })],
            isComplete: true
        };
    }

    // ---------------------------------------------------------------------------
    // CONDITIONAL EDGES
    // ---------------------------------------------------------------------------
    function shouldContinueFromGenerate(state: ReflectionState): "tools" | "reflect" | "final" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }

        const { iterationCount } = state;
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

    function shouldContinueFromRevise(state: ReflectionState): "tools" | "reflect" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
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
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("revise", reviseNode)
        .addNode("final", finalNode)

        .addEdge(START, "planner")
        .addEdge("planner", "generate")

        .addConditionalEdges("generate", shouldContinueFromGenerate, {
            tools: "tools",
            reflect: "reflect",
            final: "final"
        })

        .addConditionalEdges("tools", shouldContinueFromTools, {
            generate: "generate",
            reflect: "reflect"
        })

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            revise: "revise",
            final: "final"
        })

        .addConditionalEdges("revise", shouldContinueFromRevise, {
            tools: "tools",
            reflect: "reflect"
        })

        .addEdge("final", END);

    if (autoApprove) {
        console.log(`[Graph] Creating graph with autoApprove=true (no interrupts)`);
        return workflow.compile({ checkpointer });
    } else {
        console.log(`[Graph] Creating graph with autoApprove=false (interrupt before tools)`);
        return workflow.compile({
            checkpointer,
            interruptBefore: ["tools"],
        });
    }
}
