import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
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
} from "./tools";
import { getSkillContent } from "./skills/skill-loader";
import {
    GraphConfig,
    ReflectionState,
    PlanStep,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    getRecentMessages,
    sanitizeMessagesForBedrock,
    llmAuditLog,
    checkpointer,
    getActiveMCPTools,
    getMCPToolsDescription,
    getMCPManager
} from "./agent-shared";

// Factory function to create a configured reflection graph
export async function createReflectionGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds } = config;

    // Load skill content if a skill is selected. The SKILL.md file contains
    // all privilege, safety, and workflow instructions for that skill.
    let skillContent = '';
    let skillSection = '';

    if (selectedSkill) {
        const content = getSkillContent(selectedSkill);
        if (content) {
            skillContent = content;
            skillSection = `\n\n=== ACTIVE SKILL: ${selectedSkill.toUpperCase()} ===\n${skillContent}\n\nYou MUST follow the above skill-specific instructions. They define your privileges, safety guidelines, and workflow for this conversation.\n=== END SKILL ===\n`;
            console.log(`[PlanningAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[PlanningAgent] Failed to load skill content for: ${selectedSkill}`);
        }
    }

    // When no skill is selected, the agent defaults to a standard agentic assistant
    // with no artificially imposed read-only or mutation restrictions.

    // --- Model Initialization ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    // Include AWS credentials tools for account-aware operations
    const customTools = [executeCommandTool, readFileTool, writeFileTool, lsTool, editFileTool, globTool, grepTool, getAwsCredentialsTool, listAwsAccountsTool];

    // Dynamically discover and merge MCP server tools
    const mcpTools = await getActiveMCPTools(mcpServerIds);
    if (mcpTools.length > 0) {
        console.log(`[PlanningAgent] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }
    const tools = [...customTools, ...mcpTools];

    // Generate MCP tool descriptions for system prompts
    const mcpToolsDescription = mcpServerIds && mcpServerIds.length > 0
        ? getMCPToolsDescription(getMCPManager(), mcpServerIds)
        : '';

    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // Build account context string for prompts - supports multi-account
    let accountContext: string;
    if (accounts && accounts.length > 0) {
        const accountList = accounts.map(a => `  - ${a.accountName || a.accountId} (ID: ${a.accountId})`).join('\n');
        accountContext = `\n\nIMPORTANT - MULTI-ACCOUNT AWS CONTEXT:
You are operating across ${accounts.length} AWS account(s):
${accountList}

For EACH account you need to query:
1. Call get_aws_credentials with the accountId to create a session profile
2. Use the returned profile name with ALL subsequent AWS CLI commands: --profile <profileName>
3. Clearly label outputs with the account name/ID for clarity

Example workflow for multi-account:
- Call get_aws_credentials(accountId="${accounts[0].accountId}") → get profile1
- Run: aws sts get-caller-identity --profile profile1
- Call get_aws_credentials(accountId="${accounts.length > 1 ? accounts[1].accountId : accounts[0].accountId}") → get profile2
- Run: aws sts get-caller-identity --profile profile2
- Aggregate and compare results across accounts`;
    } else if (accountId) {
        // Backwards compatibility for single account
        accountContext = `\n\nIMPORTANT - AWS ACCOUNT CONTEXT:
You are operating in the context of AWS account: ${accountName || accountId} (ID: ${accountId}).
Before executing any AWS CLI commands, you MUST first call the get_aws_credentials tool with accountId="${accountId}" to create a session profile.
The tool will return a profile name. Use this profile with ALL subsequent AWS CLI commands by adding: --profile <profileName>
Example: aws sts get-caller-identity --profile <profileName>
NEVER use the host's default credentials - always use the profile returned from get_aws_credentials.`;
    } else {
        accountContext = `\n\nIMPORTANT - AUTONOMOUS AWS ACCOUNT DISCOVERY:
No explicit AWS account was provided. If the user asks to perform AWS operations:
1. First, call the list_aws_accounts tool to get a list of all available connected accounts.
2. Fuzzy-match the account name or ID from the user's prompt against the list.
3. Call the get_aws_credentials tool with the matched accountId to create a session profile.
4. Use the returned profile name with ALL subsequent AWS CLI commands by adding: --profile <profileName>`;
    }

    // Shared base identity string used across all nodes
    const baseIdentity = selectedSkill
        ? `You are an expert AI agent operating under the "${selectedSkill}" skill.`
        : `You are an expert AI agent. You are proficient with AWS CLI, Docker, Kubernetes, CI/CD pipelines, git, shell scripting, cloud infrastructure management, and general software engineering.`;

    // --- PLANNER NODE ---
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
Your role is to create a clear, step-by-step plan to accomplish the user's task.
${skillSection}
Focus on actionable steps that can be executed using available tools:
- read_file: Read content from a file (supports line ranges)
- write_file: Write content to a file
- edit_file: Replace strings in a file
- ls: List files in a directory with metadata
- glob: Find files matching a pattern
- grep: Search for patterns in files
- execute_command: Execute shell commands
- web_search: Search the web for documentation or solutions
- list_aws_accounts: List all available connected AWS accounts (use this to find the accountId if not provided)
- get_aws_credentials: Get temporary AWS credentials for a specific account (REQUIRED before any AWS CLI commands)
${accountContext}

Be specific and practical. Each step should be executable.

IMPORTANT: Return your plan as a JSON array of step descriptions.
Example: ["Step 1: List directory contents", "Step 2: Read config file", "Step 3: Execute tests"]

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

    // --- GENERATOR NODE ---
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
Your role is to execute the current plan step with precision using available tools.
${skillSection}
Based on the plan, execute the current step using available tools.

Current Step: ${currentStep}
Full Plan: ${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Available tools:
- read_file(file_path, start_line?, end_line?): Read content from a file
- write_file(file_path, content): Write content to a file (creates directories if needed)
- edit_file(file_path, edits): Replace strings in a file
- ls(path): List files in a directory with metadata
- glob(pattern, path?): Find files matching a pattern
- grep(pattern, args...): Search for patterns in files
- execute_command(command): Execute a shell command
- web_search(query): Search the web
- list_aws_accounts(): List all available connected AWS accounts
- get_aws_credentials(accountId): Get temporary AWS credentials for a specific account
${accountContext}

NOTE: AWS Cost Explorer only provides historical data for the last 14 months. Do not request data older than 14 months.

IMPORTANT: Use tools to accomplish the task if necessary. If the task is a simple question or greeting that doesn't require tools, you may answer directly.
After using tools (or if no tools are needed), provide a brief summary of what you accomplished or the answer.`);

        const recentMessages = getRecentMessages(messages, 25);
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please execute the next step of the plan based on the tools available." }));
        }
        // Sanitize to ensure every tool_use block has a matching tool_result.
        // Without this, Bedrock throws ValidationException on long multi-tool sessions.
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

        return {
            messages: [response],
            iterationCount: iterationCount + 1
        };
    }

    // Custom tool node that collects results
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [TOOLS] Executing tool calls...`);
        const result = await toolNode.invoke(state);
        console.log(`⚙️ [TOOLS] Execution complete. Result messages: ${result.messages?.length || 0}`);

        // Extract tool results for final summary
        const newToolResults: string[] = [];
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    const truncated = truncateOutput(content, 1000);
                    newToolResults.push(truncated);
                    console.log(`   ✅ [TOOL RESULT] ${msg.name || 'Unknown Tool'}:`);
                    console.log(`      ${truncateOutput(content, 200).replace(/\n/g, '\n      ')}`);
                }
            }
        }

        return {
            ...result,
            toolResults: newToolResults,
            executionOutput: newToolResults.join('\n---\n')
        };
    }

    // --- REFLECTOR NODE ---
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, taskDescription, iterationCount, plan, toolResults } = state;

        console.log(`\n================================================================================`);
        console.log(`🤔 [REFLECTOR] Analyzing execution results`);
        console.log(`   Iteration: ${iterationCount}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================`);

        // The reflector uses the skill's own instructions to judge correctness.
        const skillCritiqueContext = skillContent
            ? `The executor is operating under the "${selectedSkill}" skill. Use the following skill instructions to verify correctness and adherence:\n\n${skillContent}`
            : `The executor is operating as a general-purpose agentic assistant with no specific skill constraints. Ensure it is acting helpfully and correctly.`;

        const reflectorSystemPrompt = new SystemMessage(`You are a Senior Engineer reviewing the execution results of an AI agent for best practices, correctness, and completeness.

${skillCritiqueContext}

Original Task: ${taskDescription}

Current Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Current Iteration: ${iterationCount}/${MAX_ITERATIONS}

Review the execution results and provide your analysis in the following JSON format:
{
    "analysis": "Brief analysis of what was done and the results",
    "issues": "Any issues or errors found, or 'None' if no issues",
    "suggestions": "Suggestions for improvement, or 'None' if no suggestions",
    "isComplete": true or false (set to true ONLY if ALL plan steps are completed successfully),
    "updatedPlan": [
        { "step": "Step description as in original plan", "status": "completed" | "pending" | "failed" }
    ]
}

IMPORTANT: Set isComplete to true ONLY when the original task has been fully accomplished. You MUST return the 'updatedPlan' array updating the status of each step based on the execution results.
If there are remaining steps in the plan or the task is not fully done, set isComplete to false.

Be specific and actionable in your feedback.
Only return the JSON object, nothing else.`);

        // Construct a clean input for the reflector to avoid tool-related validation issues
        // Find the most recent AI message that has text content
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
${toolResults.slice(-5).join('\n---\n')}

Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`
        });

        // Use base model (no tools) to ensure the reflector focuses on analysis, not tool calls
        const _auditInputs_ref = [reflectorSystemPrompt, summaryInput];
        const _auditStart_ref = Date.now();
        const response = await model.invoke(_auditInputs_ref);
        llmAuditLog('REFLECTOR', _auditInputs_ref, response, _auditStart_ref);

        let analysis = "";
        let issues = "None";
        let suggestions = "None";
        let isComplete = false;
        let updatedPlan: PlanStep[] = [];

        try {
            const content = response.content as string;
            // Log raw content for debugging
            console.log(`[Reflector] Raw content: ${truncateOutput(content, 200)}`);

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                analysis = parsed.analysis || "";
                issues = parsed.issues || "None";
                suggestions = parsed.suggestions || "None";
                // Only mark complete if explicitly true in parsed JSON
                isComplete = parsed.isComplete === true;
                if (parsed.updatedPlan && Array.isArray(parsed.updatedPlan) && parsed.updatedPlan.length > 0) {
                    updatedPlan = parsed.updatedPlan;
                }
            } else {
                console.log("[Reflector] No JSON found, using raw content fallback");
                analysis = content;
                // Conservative heuristic: only mark complete if explicitly stated
                if (content.toLowerCase().includes("task complete") || content.toLowerCase().includes("successfully completed")) {
                    isComplete = true;
                }
                // If no clear completion signal, continue the loop (isComplete stays false)
            }
            // Completion should ONLY be determined by the model's explicit isComplete flag
        } catch (e) {
            console.error("[Reflector] Parsing failed:", e);
            analysis = "Reflection parsing failed. Continuing with next iteration.";
            // Parsing errors should NOT complete the task prematurely - continue the loop
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

    // --- REVISER NODE ---
    async function reviseNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, reflection, errors } = state;

        console.log(`\n================================================================================`);
        console.log(`📝 [REVISER] Applying fixes and improvements`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const reviserSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to apply fixes and improvements based on reviewer feedback.
${skillSection}
Recent Feedback: ${reflection}
Issues to Address: ${errors.join(', ') || 'None'}

Use the available tools to fix problems and improve the solution.
Focus on addressing the specific issues mentioned in the feedback.

Available tools: read_file, write_file, edit_file, ls, glob, grep, execute_command, web_search, get_aws_credentials, list_aws_accounts`);

        const recentMessages = getRecentMessages(messages, 10);
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please fix the issues mentioned in the reflection." }));
        }
        // Sanitize to ensure every tool_use block has a matching tool_result.
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

    // --- FINAL OUTPUT NODE --- (Improved to provide comprehensive summary)
    async function finalNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { taskDescription, iterationCount, reflection, toolResults, messages, plan } = state;

        console.log(`\n================================================================================`);
        console.log(`🏁 [FINAL] Generating comprehensive summary`);
        console.log(`================================================================================\n`);

        // Create a summary prompt to generate user-friendly final output
        const summarySystemPrompt = new SystemMessage(`You are a helpful assistant summarizing the results of a completed task.

Original Task: ${taskDescription}

Execution Summary:
- Total Iterations: ${iterationCount}
- Plan Steps: ${plan.map(s => `${s.step} (${s.status})`).join(', ')}

Tool Execution Results (most recent):
${toolResults.slice(-3).map(r => truncateOutput(r, 500)).join('\n\n')}

Final Reflection: ${reflection}

Based on the above, provide a clear, helpful summary for the user that:
1. States what was accomplished
2. Highlights key findings or results
3. Notes any important information from tool outputs
4. Suggests next steps if applicable

Be concise but comprehensive. Format nicely with markdown.`);

        // Use the base model (no tools) with a clean synthesized context.
        // IMPORTANT: We deliberately do NOT pass raw recentMessages here because they may
        // contain tool_use/tool_result pairs. Passing those with modelWithTools risks the
        // model emitting an accidental tool_call in the summary, which would be orphaned
        // and crash the next graph invocation with a Bedrock ValidationException.
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

    // --- CONDITIONAL EDGES ---
    function shouldContinueFromGenerate(state: ReflectionState): "tools" | "reflect" | "final" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }

        // Optimization: For simple requests (first iteration, no tools), skip reflection to speed up response
        // This helps avoid 504 Gateway Timeouts on non-streaming responses.
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

    // --- GRAPH CONSTRUCTION ---
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
            final: "final" // Added fast path
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

    // Compile with or without interrupt based on autoApprove setting
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
