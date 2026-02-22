import { BaseMessage, AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
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
    checkpointer,
    getActiveMCPTools,
    getMCPToolsDescription,
    getMCPManager
} from "./agent-shared";

// Factory function to create a configured reflection graph
export async function createReflectionGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds } = config;

    // Load skill content if a skill is selected
    let skillContent = '';
    const isDevOpsSkill = selectedSkill === 'devops';

    if (selectedSkill) {
        const content = getSkillContent(selectedSkill);
        if (content) {
            skillContent = `\n\n=== SELECTED SKILL INSTRUCTIONS ===\n${content}\n\nYou MUST follow the above skill-specific instructions for this conversation. These instructions take precedence and guide your approach to handling user requests.\n=== END SKILL INSTRUCTIONS ===\n`;
            console.log(`[PlanningAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[PlanningAgent] Failed to load skill content for: ${selectedSkill}`);
        }
    }

    const readOnlyInstruction = isDevOpsSkill
        ? `IMPORTANT: You are operating with DEVOPS MUTATION PRIVILEGES. 
- You ARE allowed to create, update, delete, start, stop, and modify AWS infrastructure resources as requested by the user.
- Follow safety guidelines: prefer dry-runs if unsure, output confirmation prompts for destructive actions, and verify resource IDs before applying changes.`
        : `IMPORTANT: You are a READ-ONLY agent. You MUST NOT create plans that modify, create, or delete resources.
- Focus ONLY on observability, diagnosis, status checks, and log analysis.
- Do NOT plan to deploy stacks, update services, or write to files unless explicitly for logging/reporting (and even then, prefer stdout).`;

    // --- Model Initialization ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    // Include AWS credentials tools for account-aware operations
    const customTools = [executeCommandTool, readFileTool, writeFileTool, lsTool, editFileTool, globTool, grepTool, webSearchTool, getAwsCredentialsTool, listAwsAccountsTool];

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

        const plannerSystemPrompt = new SystemMessage(`You are an expert DevOps and Cloud Infrastructure planning agent.
Given a task, create a clear step-by-step plan to accomplish it, utilizing your expertise in AWS, Docker, Kubernetes, and CI/CD.
${skillContent}
${readOnlyInstruction}

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

        const executorSystemPrompt = new SystemMessage(`You are an expert DevOps and Cloud Infrastructure executor agent.
Your goal is to execute technical tasks with precision, utilizing tools like AWS CLI, git, bash, and more.
${skillContent}
${isDevOpsSkill ? `IMPORTANT: You have DEVOPS MUTATION ACCESS. You are authorized to execute commands that modify, create, or delete infrastructure if the plan requires it.` : `IMPORTANT: You are a READ-ONLY agent.
- You MUST NOT execute commands that modify, create, or delete infrastructure or files (unless strictly necessary for reporting).
- If the plan asks you to perform a mutation, REFUSE and explain that you are in read-only mode.
- Your AWS IAM role is read-only.`}

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

IMPORTANT: You should use tools to accomplish the task if necessary. If the task is a simple question or greeting that doesn't require tools, you may answer directly.
After using tools (or if no tools are needed), provide a brief summary of what you accomplished or the answer.`);

        const recentMessages = getRecentMessages(messages, 25);
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please execute the next step of the plan based on the tools available." }));
        }
        const response = await modelWithTools.invoke([executorSystemPrompt, ...recentMessages]);

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

        const reflectorSystemPrompt = new SystemMessage(`You are a Senior DevOps Engineer reviewing work for best practices, security, and correctness.

${isDevOpsSkill ? `IMPORTANT: The agent has DEVOPS MUTATION ACCESS.
- Ensure the agent is performing mutations safely and verifying outcomes.
- Flag risky destructive commands if they lack appropriate checks, but mutations themselves are ALLOWED.` : `IMPORTANT: Ensure the agent is adhering to READ-ONLY protocols.
- Flag any attempt to modify, create, or delete resources as a CRITICAL ISSUE.
- Verify that only diagnosis, observation, and status checks were performed.`}

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
        // This approach mirrors fast-agent.ts and prevents the reflector from trying to call tools

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
        const response = await model.invoke([reflectorSystemPrompt, summaryInput]);

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
            // REMOVED: The overly aggressive "if (issues === 'None' && !isComplete)" fallback
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

        const reviserSystemPrompt = new SystemMessage(`You are a code revision agent.
Based on the feedback provided, make improvements to address the issues.

Recent Feedback: ${reflection}
Issues to Address: ${errors.join(', ') || 'None'}

Use the available tools to fix problems and improve the solution.
Focus on addressing the specific issues mentioned in the feedback.

Available tools:
- read_file, write_file, list_directory, execute_command, web_search`);

        const recentMessages = getRecentMessages(messages, 10);
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please fix the issues mentioned in the reflection." }));
        }
        const response = await modelWithTools.invoke([reviserSystemPrompt, ...recentMessages]);

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

        // Use modelWithTools since messages contain tool content
        const recentMessages = getRecentMessages(messages, 5);
        if (recentMessages.length > 0 && recentMessages[recentMessages.length - 1]._getType() === 'ai') {
            recentMessages.push(new HumanMessage({ content: "Please provide the final summary." }));
        }
        const summaryResponse = await modelWithTools.invoke([summarySystemPrompt, ...recentMessages]);
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
