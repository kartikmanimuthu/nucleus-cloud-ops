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
    getAwsCredentialsTool
} from "./tools";
import {
    GraphConfig,
    ReflectionState,
    PlanStep,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    getRecentMessages,
    checkpointer
} from "./agent-shared";

// Factory function to create a configured reflection graph
export function createReflectionGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accountId, accountName } = config;

    // --- Model Initialization ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    // Include AWS credentials tool for account-aware operations
    // Include AWS credentials tool for account-aware operations
    const tools = [executeCommandTool, readFileTool, writeFileTool, lsTool, editFileTool, globTool, grepTool, webSearchTool, getAwsCredentialsTool];
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // Build account context string for prompts
    const accountContext = accountId
        ? `\n\nIMPORTANT - AWS ACCOUNT CONTEXT:\nYou are operating in the context of AWS account: ${accountName || accountId} (ID: ${accountId}).\nBefore executing any AWS CLI commands, you MUST first call the get_aws_credentials tool with accountId="${accountId}" to create a session profile.\nThe tool will return a profile name. Use this profile with ALL subsequent AWS CLI commands by adding: --profile <profileName>\nExample: aws sts get-caller-identity --profile <profileName>\nNEVER use the host's default credentials - always use the profile returned from get_aws_credentials.`
        : `\n\nNOTE: No AWS account is selected. If the user asks to perform AWS operations, inform them that they need to select an AWS account first.`;

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

IMPORTANT: You are a READ-ONLY agent. You MUST NOT create plans that modify, create, or delete resources.
- Focus ONLY on observability, diagnosis, status checks, and log analysis.
- Do NOT plan to deploy stacks, update services, or write to files unless explicitly for logging/reporting (and even then, prefer stdout).

Focus on actionable steps that can be executed using available tools:
- read_file: Read content from a file (supports line ranges)
- write_file: Write content to a file
- edit_file: Replace strings in a file
- ls: List files in a directory with metadata
- glob: Find files matching a pattern
- grep: Search for patterns in files
- execute_command: Execute shell commands
- web_search: Search the web for information
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

IMPORTANT: You are a READ-ONLY agent.
- You MUST NOT execute commands that modify, create, or delete infrastructure or files (unless strictly necessary for reporting).
- If the plan asks you to perform a mutation, REFUSE and explain that you are in read-only mode.
- Your AWS IAM role is read-only.

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
- web_search(query): Search the web for information
- get_aws_credentials(accountId): Get temporary AWS credentials for a specific account
${accountContext}

NOTE: AWS Cost Explorer only provides historical data for the last 14 months. Do not request data older than 14 months.

IMPORTANT: You should use tools to accomplish the task if necessary. If the task is a simple question or greeting that doesn't require tools, you may answer directly.
After using tools (or if no tools are needed), provide a brief summary of what you accomplished or the answer.`);

        const response = await modelWithTools.invoke([executorSystemPrompt, ...getRecentMessages(messages, 10)]);

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

IMPORTANT: Ensure the agent is adhering to READ-ONLY protocols.
- Flag any attempt to modify, create, or delete resources as a CRITICAL ISSUE.
- Verify that only diagnosis, observation, and status checks were performed.

Original Task: ${taskDescription}

Current Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Current Iteration: ${iterationCount}/${MAX_ITERATIONS}

Review the execution results and provide your analysis in the following JSON format:
{
    "analysis": "Brief analysis of what was done and the results",
    "issues": "Any issues or errors found, or 'None' if no issues",
    "suggestions": "Suggestions for improvement, or 'None' if no suggestions",
    "isComplete": true or false (set to true ONLY if ALL plan steps are completed successfully)
}

IMPORTANT: Set isComplete to true ONLY when the original task has been fully accomplished.
If there are remaining steps in the plan or the task is not fully done, set isComplete to false.

Be specific and actionable in your feedback.
Only return the JSON object, nothing else.`);

        // Construct a clean input for the reflector to avoid tool-related validation issues
        // This approach mirrors fast-agent.ts and prevents the reflector from trying to call tools
        const summaryInput = new HumanMessage({
            content: `Please analyze the following execution and provide your feedback in JSON format.

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

        return {
            messages: [new AIMessage({ content: feedback })],
            reflection: analysis,
            errors: issues !== "None" ? [issues] : [],
            isComplete,
            nextAction: isComplete ? "complete" : "revise"
        };
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

        const response = await modelWithTools.invoke([reviserSystemPrompt, ...getRecentMessages(messages, 10)]);

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
        const summaryResponse = await modelWithTools.invoke([summarySystemPrompt, ...getRecentMessages(messages, 5)]);
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
