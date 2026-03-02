import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatBedrockConverse } from "@langchain/aws";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
    executeCommandTool,
    readFileTool,
    writeFileTool,
    lsTool,
    editFileTool,
    globTool,
    grepTool,
    webSearchTool,
    getAwsCredentialsTool,
    listAwsAccountsTool
} from "@/lib/agent/tools";
import { getSkillContent, loadSkills } from "@/lib/agent/skills/skill-loader";
import {
    GraphConfig,
    MAX_ITERATIONS,
    truncateOutput,
    getRecentMessages,
    getCheckpointer,
    getActiveMCPTools,
    getMCPManager,
    getMCPToolsDescription
} from "@/lib/agent/agent-shared";
import { ReflectionState, graphState, PlanStep, RequestEvaluation } from "./executor-state";

// ============================================================================
// DYNAMIC EXECUTOR GRAPH
// ============================================================================

export async function createDynamicExecutorGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, mcpServerIds, tenantId } = config;
    const checkpointer = await getCheckpointer();

    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    const customTools = [executeCommandTool, readFileTool, writeFileTool, lsTool, editFileTool, globTool, grepTool, getAwsCredentialsTool, listAwsAccountsTool];

    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId);
    if (mcpTools.length > 0) {
        console.log(`[DynamicExecutorGraph] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }
    const tools = [...customTools, ...mcpTools];

    const mcpManager = getMCPManager();
    const mcpContext = mcpServerIds && mcpServerIds.length > 0 ? getMCPToolsDescription(mcpManager, mcpServerIds) : '';

    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // ========================================================================
    // EVALUATOR NODE (Entrypoint)
    // ========================================================================
    async function evaluatorNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, evaluation } = state;
        const lastMessage = messages[messages.length - 1];

        // Skip evaluation if already done (e.g. restoring from checkpoint)
        if (evaluation) return {};

        const taskDescription = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);

        console.log(`\n================================================================================`);
        console.log(`🧠 [EVALUATOR] Determining task complexity and skills...`);
        console.log(`   Task: "${truncateOutput(taskDescription, 100)}"`);
        console.log(`================================================================================\n`);

        const availableSkills = await loadSkills();
        const skillsContext = availableSkills.map(s => `- ${s.id}: ${s.name} - ${s.description}`).join('\n');

        const evaluatorSystemPrompt = new SystemMessage(`You are an intelligent request evaluator for an agentic AI system.
Your job is to analyze the user's request and determine the best approach.

Available Skills:
${skillsContext}

You must return a JSON object evaluating the request according to the following schema:
{
    "mode": "plan" | "fast" | "end", // "plan" for complex/multi-step/mutations. "fast" for simple read queries. "end" if the request is ambiguous, incomplete, or requires clarification before proceeding.
    "skillId": "string", // The ID of the best matching skill, or null if none apply directly.
    "accountId": "string", // The AWS account ID mentioned in the prompt, or null if not found.
    "requiresApproval": boolean, // true if the request involves destructive/mutative operations (create, update, delete, start, stop).
    "reasoning": "string", // A brief explanation of your decision.
    "clarificationQuestion": "string | null", // REQUIRED when mode="end": A clear, specific question to ask the user for the missing information needed to proceed. null otherwise.
    "missingInfo": "string | null" // REQUIRED when mode="end": A brief label of what is missing (e.g. "AWS account ID", "environment name"). null otherwise.
}

Determine the safest and most efficient path. Complex infrastructure deployments, security audits, and multi-step changes should use "plan" mode. Simple "how do I..." or "what is the status of..." lookups should use "fast" mode.
Use "end" only when the request is genuinely ambiguous or missing critical information — always provide a clarificationQuestion in this case.

Only return the JSON. No other text.`);

        const response = await model.invoke([evaluatorSystemPrompt, lastMessage]);

        let evalResult: RequestEvaluation = {
            mode: 'fast',
            skillId: null,
            accountId: null,
            requiresApproval: false,
            reasoning: "Fallback to fast mode due to parsing error.",
            clarificationQuestion: null,
            missingInfo: null,
        };

        try {
            const content = response.content as string;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                evalResult = {
                    mode: parsed.mode || 'fast',
                    skillId: parsed.skillId || null,
                    accountId: parsed.accountId || null,
                    requiresApproval: !!parsed.requiresApproval,
                    reasoning: parsed.reasoning || "Parsed successfully.",
                    clarificationQuestion: parsed.clarificationQuestion || null,
                    missingInfo: parsed.missingInfo || null,
                };
            }
        } catch (e) {
            console.error("[Evaluator] Parsing failed:", e);
        }

        console.log(`\n📋 [EVALUATOR] Decision:`);
        console.log(`   Mode: ${evalResult.mode}`);
        console.log(`   Skill: ${evalResult.skillId}`);
        console.log(`   Account: ${evalResult.accountId}`);
        console.log(`   Requires Approval: ${evalResult.requiresApproval}`);
        console.log(`   Reasoning: ${evalResult.reasoning}\n`);

        return {
            evaluation: evalResult
        };
    }

    // Dynamic Context Builder
    function getDynamicContext(evaluation: RequestEvaluation | null) {
        let skillContent = '';
        let readOnlyInstruction = '';

        if (evaluation?.skillId) {
            const content = getSkillContent(evaluation.skillId);
            if (content) {
                skillContent = `\n\n=== SELECTED SKILL INSTRUCTIONS ===\n${content}\n\nYou MUST follow the above skill-specific instructions for this conversation. These instructions take precedence and guide your approach to handling user requests.\n=== END SKILL INSTRUCTIONS ===\n`;
            }
        }

        const isSWESkill = evaluation?.skillId === 'swe';

        if (isSWESkill) {
            readOnlyInstruction = `IMPORTANT: You are operating with SOFTWARE ENGINEER (SWE) MUTATION PRIVILEGES.
- You ARE allowed to read, write, create, and edit files in code repositories.
- You ARE allowed to run git commands (clone, branch, commit, push) via execute_command.
- You ARE allowed to interact with BitBucket (PRs, reviews, merges) and JIRA (create, update, transition, comment) via MCP tools if connected.
- You ARE allowed to write and run tests.
- Safety guidelines: always work on a feature branch (never push to main directly), write descriptive commit messages, and include PR descriptions summarising the change.`;
        } else if (evaluation?.requiresApproval) {
            readOnlyInstruction = `IMPORTANT: This is a MUTATIVE task. You ARE allowed to create, update, delete, start, stop, and modify infrastructure resources.
- Follow safety guidelines: prefer dry-runs if unsure, output confirmation prompts for destructive actions, and verify resource IDs before applying changes.`;
        } else {
            readOnlyInstruction = `IMPORTANT: You are a READ-ONLY agent for this task. You MUST NOT create plans that modify, create, or delete resources.
- Focus ONLY on observability, diagnosis, status checks, and log analysis.
- Do NOT plan to deploy stacks, update services, or write to files unless explicitly requested.`;
        }

        let accountContext = '';
        // Prioritize dynamic account
        const targetAccountId = evaluation?.accountId || accountId;

        if (accounts && accounts.length > 0) {
            const accountList = accounts.map(a => `  - ${a.accountName || a.accountId} (ID: ${a.accountId})`).join('\n');
            accountContext = `\n\nIMPORTANT - MULTI-ACCOUNT AWS CONTEXT:
You are operating across ${accounts.length} AWS account(s):
${accountList}
For EACH account you need to query:
1. Call get_aws_credentials with the accountId to create a session profile
2. Use the returned profile name with ALL subsequent AWS CLI commands: --profile <profileName>
3. Clearly label outputs with the account name/ID for clarity`;
        } else if (targetAccountId) {
            accountContext = `\n\nIMPORTANT - AWS ACCOUNT CONTEXT:
You are operating in the context of AWS account: ${targetAccountId}.
Before executing any AWS CLI commands, you MUST first call the get_aws_credentials tool with accountId="${targetAccountId}" to create a session profile.
The tool will return a profile name. Use this profile with ALL subsequent AWS CLI commands by adding: --profile <profileName>
NEVER use the host's default credentials - always use the profile returned from get_aws_credentials.`;
        } else {
            accountContext = `\n\nIMPORTANT - AUTONOMOUS AWS ACCOUNT DISCOVERY:
No explicit AWS account was provided. If the user asks to perform AWS operations:
1. First, call the list_aws_accounts tool to get a list of all available connected accounts.
2. Fuzzy-match the account name or ID from the user's prompt against the list.
3. Call the get_aws_credentials tool with the matched accountId to create a session profile.
4. Use the returned profile name with ALL subsequent AWS CLI commands by adding: --profile <profileName>`;
        }

        let mcpInstructions = '';
        if (mcpContext) {
            mcpInstructions = `${mcpContext}\n\nYou MUST use these specialized MCP tools over generic bash commands whenever possible to interact with external APIs (Bitbucket, Jira, Confluence, etc.). When dealing with external systems, always check if an MCP tool exists for the action before attempting a curl or script.`;
        }

        return { skillContent, readOnlyInstruction, accountContext, mcpInstructions };
    }

    // ========================================================================
    // PLANNER NODE (For 'plan' mode)
    // ========================================================================
    async function planNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, evaluation } = state;
        const lastMessage = messages[messages.length - 1];
        const taskDescription = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);

        console.log(`\n================================================================================`);
        console.log(`🤖 [PLANNER] Initiating planning phase`);
        console.log(`================================================================================\n`);

        const { skillContent, readOnlyInstruction, accountContext, mcpInstructions } = getDynamicContext(evaluation);

        const plannerSystemPrompt = new SystemMessage(`You are an expert DevOps and Cloud Infrastructure planning agent.
Given a task, create a clear step-by-step plan to accomplish it.
${skillContent}
${readOnlyInstruction}
${mcpInstructions}

Focus on actionable steps that can be executed using available tools.
${accountContext}

Be specific and practical. Each step should be executable.

IMPORTANT: Return your plan as a JSON array of step descriptions.
Example: ["Step 1: List directory contents", "Step 2: Read config file", "Step 3: Execute tests"]

Only return the JSON array, nothing else.`);

        const response = await model.invoke([plannerSystemPrompt, lastMessage]);

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
            planSteps = [{ step: "Analyze and respond to user request", status: 'pending' as const }];
        }

        if (planSteps.length === 0) {
            planSteps = [{ step: "Analyze and respond to user request", status: 'pending' as const }];
        }

        const planText = planSteps.map((s, i) => `${i + 1}. ${s.step}`).join('\n');
        return {
            plan: planSteps,
            taskDescription,
            messages: [new AIMessage({ content: `📋 **Plan Created:**\n${planText}` })],
            nextAction: "generate"
        };
    }

    // ========================================================================
    // GENERATE NODE (Execution Engine)
    // ========================================================================
    async function generateNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, plan, iterationCount, evaluation } = state;

        console.log(`\n================================================================================`);
        console.log(`⚡ [EXECUTOR] Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`================================================================================\n`);

        const { skillContent, readOnlyInstruction, accountContext, mcpInstructions } = getDynamicContext(evaluation);

        let stepContext = "";
        if (evaluation?.mode === 'plan') {
            const pendingSteps = plan.filter(s => s.status === 'pending' || s.status === 'in_progress');
            const currentStep = pendingSteps[0]?.step || "Complete the task";
            stepContext = `Current Step: ${currentStep}
Full Plan: ${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`;
        }

        const executorSystemPrompt = new SystemMessage(`You are an expert DevOps executor agent.
Your goal is to execute technical tasks with precision.
${skillContent}
${readOnlyInstruction}
${mcpInstructions}

${stepContext}
${accountContext}

Available core tools:
- read_file, write_file, edit_file, ls, glob, grep, execute_command, web_search, list_aws_accounts, get_aws_credentials

IMPORTANT: You should use tools to accomplish the task if necessary. If the task is a simple question or greeting that doesn't require tools, you may answer directly. Always remember to maintain conversation continuity.`);

        const recentMessages = getRecentMessages(messages, 25);
        if (evaluation?.mode === 'plan' && recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please execute the next step of the plan based on the tools available." }));
        }

        const response = await modelWithTools.invoke([executorSystemPrompt, ...recentMessages]);

        if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
            console.log(`\n🛠️ [EXECUTOR] Tool Calls Generated`);
        }

        return {
            messages: [response],
            iterationCount: iterationCount + 1
        };
    }

    // ========================================================================
    // TOOLS NODE
    // ========================================================================
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [TOOLS] Executing tool calls...`);
        const result = await toolNode.invoke(state);

        const newToolResults: string[] = [];
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    newToolResults.push(truncateOutput(content, 1000));
                }
            }
        }

        return {
            ...result,
            toolResults: newToolResults,
            executionOutput: newToolResults.join('\n---\n')
        };
    }

    // ========================================================================
    // REFLECT NODE
    // ========================================================================
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount, plan, toolResults, evaluation } = state;

        // Fast mode skip
        const lastMessage = messages[messages.length - 1];
        if (evaluation?.mode === 'fast' && (lastMessage as AIMessage).tool_calls && ((lastMessage as AIMessage).tool_calls?.length ?? 0) > 0) {
            return {};
        }

        console.log(`\n================================================================================`);
        console.log(`🤔 [REFLECTOR] Analyzing results`);
        console.log(`================================================================================`);

        const isComplex = evaluation?.mode === 'plan';

        const reflectorSystemPrompt = new SystemMessage(isComplex ? `You are a Senior DevOps Engineer reviewing work.
Review the execution results and provide your analysis in JSON format:
{
    "analysis": "Brief analysis",
    "issues": "Any issues or 'None'",
    "suggestions": "Suggestions or 'None'",
    "isComplete": true/false (true ONLY if ALL plan steps are completed successfully),
    "updatedPlan": [{ "step": "step description", "status": "completed" | "pending" | "failed" }]
}
Only return the JSON object.` : `You are a strict critic reviewing an AI assistant's response.
Analyze the response for Correctness and Completeness.
If the response is good and complete, respond with "COMPLETE".
If there are issues, list them clearly as feedback. Do not generate the fixed answer yourself.`);

        const recentAiMessages = messages.filter(m => m._getType() === 'ai');
        const lastAiText = recentAiMessages.length > 0 ? (typeof recentAiMessages[recentAiMessages.length - 1].content === 'string' ? recentAiMessages[recentAiMessages.length - 1].content : JSON.stringify(recentAiMessages[recentAiMessages.length - 1].content)) : "None";

        const summaryInput = new HumanMessage({
            content: isComplex ? `Recent Output:\n${truncateOutput(lastAiText as string, 1500)}\n\nTool Results:\n${toolResults.slice(-5).join('\n---\n')}\n\nPlan:\n${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}` : `Evaluate the response:\n${lastAiText}`
        });

        const response = await model.invoke([reflectorSystemPrompt, summaryInput]);
        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

        if (isComplex) {
            let analysis = "", issues = "None", isComplete = false, updatedPlan: PlanStep[] = [];
            try {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    analysis = parsed.analysis || "";
                    issues = parsed.issues || "None";
                    isComplete = parsed.isComplete === true;
                    if (parsed.updatedPlan) updatedPlan = parsed.updatedPlan;
                }
            } catch {
                isComplete = false;
            }

            const feedback = `🔍 **Reflection Analysis:**\n${analysis}\n${issues !== "None" ? `⚠️ **Issues:** ${issues}` : ""}`;
            return {
                messages: [new AIMessage({ content: feedback })],
                reflection: analysis,
                errors: issues !== "None" ? [issues] : [],
                isComplete: isComplete || iterationCount >= MAX_ITERATIONS,
                plan: updatedPlan.length > 0 ? updatedPlan : plan
            };
        } else {
            if (content.includes("COMPLETE") || iterationCount >= MAX_ITERATIONS) {
                return { messages: [response], isComplete: true };
            }
            return { messages: [new HumanMessage({ content: `Critique: ${content}\nPlease update your answer.` })], isComplete: false };
        }
    }

    // ========================================================================
    // CONDITIONAL EDGE ROUTING
    // ========================================================================

    // ========================================================================
    // CLARIFY NODE (Human-in-Loop: request missing information)
    // ========================================================================
    async function clarifyNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { evaluation } = state;

        const question = evaluation?.clarificationQuestion
            || "I need more information to proceed. Could you please clarify your request?";

        console.log(`\n================================================================================`);
        console.log(`❓ [CLARIFY] Requesting clarification from user`);
        console.log(`   Question: "${question}"`);
        console.log(`================================================================================\n`);

        return {
            clarificationQuestion: question,
            nextAction: 'awaiting_input',
        };
    }

    function routeFromEvaluator(state: ReflectionState): "planner" | "generate" | "clarify" | "__end__" {
        if (!state.evaluation) return "generate"; // Fallback to fast mode

        if (state.evaluation.mode === 'plan') return "planner";
        if (state.evaluation.mode === 'fast') return "generate";
        return "clarify"; // End mode → clarification
    }

    function routeFromGenerate(state: ReflectionState): "tools" | "reflect" | "final" | "__end__" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) return "tools";

        // If in plan mode, we might want to fast-path
        if (state.evaluation?.mode === 'plan') {
            if (state.iterationCount <= 1) return "final";
            return "reflect";
        }

        // Fast mode logic
        if (state.iterationCount >= MAX_ITERATIONS) return "__end__";
        return "reflect";
    }

    function routeFromTools(state: ReflectionState): "generate" | "reflect" {
        if (state.iterationCount >= MAX_ITERATIONS) return "reflect";
        return "generate";
    }

    function routeFromReflect(state: ReflectionState): "generate" | "final" | "__end__" {
        if (state.evaluation?.mode === 'plan') {
            if (state.isComplete || state.iterationCount >= MAX_ITERATIONS) return "final";
            return "generate"; // Loop back to execute next step based on critique
        } else {
            if (state.isComplete) return "__end__";
            return "generate";
        }
    }

    // ========================================================================
    // GRAPH CONSTRUCTION
    // ========================================================================
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("evaluator", evaluatorNode)
        .addNode("clarify", clarifyNode)
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)

        // Single final node just for complex plan summaries, fast mode handles its own output
        .addNode("final", async (state) => {
            const { iterationCount, plan } = state;
            const finalMessage = `✅ **Plan Execution Complete**
**Iterations:** ${iterationCount}
**Status:** ${plan.find(s => s.status !== 'completed') ? 'Partial/Failed' : 'All steps completed'}`;
            return { messages: [new AIMessage({ content: finalMessage })], isComplete: true };
        })

        .addEdge(START, "evaluator")

        .addConditionalEdges("evaluator", routeFromEvaluator, {
            planner: "planner",
            generate: "generate",
            clarify: "clarify",
            __end__: END
        })

        .addEdge("clarify", END)

        .addEdge("planner", "generate")

        .addConditionalEdges("generate", routeFromGenerate, {
            tools: "tools",
            reflect: "reflect",
            final: "final",
            __end__: END
        })

        .addConditionalEdges("tools", routeFromTools, {
            generate: "generate",
            reflect: "reflect"
        })

        .addConditionalEdges("reflect", routeFromReflect, {
            generate: "generate",
            final: "final",
            __end__: END
        })

        .addEdge("final", END);

    const compiledGraph = autoApprove
        ? workflow.compile({ checkpointer })
        : workflow.compile({ checkpointer, interruptBefore: ["tools"] });
    return compiledGraph;
}
