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
    getAwsCredentialsTool,
    listAwsAccountsTool
} from "./tools";
import { getSkillContent } from "./skills/skill-loader";
import {
    GraphConfig,
    ReflectionState,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    getRecentMessages,
    checkpointer,
    getActiveMCPTools,
    getMCPManager,
    getMCPToolsDescription
} from "./agent-shared";

// --- FAST GRAPH (Reflection Agent Mode) ---
export async function createFastGraph(config: GraphConfig) {
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
            console.log(`[FastAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[FastAgent] Failed to load skill content for: ${selectedSkill}`);
        }
    }

    // When no skill is selected, inject explicit base DevOps operating mode guidance
    // so the agent knows its full capabilities without relying on implicit assumptions.
    const effectiveSkillSection = skillSection || `

## Operating Mode: Base DevOps Engineer
You are operating as a general-purpose DevOps engineer with full read and write access. No skill-specific restrictions apply.

**Capabilities (all permitted):**
- AWS resource management: describe, list, create, update, delete, start, stop, reboot, terminate across all AWS services (EC2, ECS, EKS, RDS, Lambda, S3, IAM, VPC, CloudWatch, SSM, and more)
- Infrastructure mutations: update ECS desired counts, force new deployments, modify Auto Scaling groups, run SSM Run Commands on EC2, manage RDS instances
- File and IaC operations: read, write, and edit any local files, Terraform configs, Ansible playbooks, Dockerfiles, CI/CD pipeline configs
- Shell execution: AWS CLI, kubectl, terraform, ansible-playbook, git, bash scripts — no restrictions

**Safety practices (always apply):**
- Run a describe/list command to verify current state before any mutation
- Clearly identify the target resource (ID, account, region) before executing destructive actions
- Use --dry-run or terraform plan where supported to validate impact before committing
- For irreversible actions (terminate, delete, drop), confirm the intent is unambiguous from the user's request before proceeding
`;

    // --- Model Initialization ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    // Reflector only needs to emit a short critique (~200 tokens max).
    // Using a capped model avoids burning TTFT budget on 4096-token allocations.
    const reflectorModel = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 1024,
        temperature: 0,
        streaming: false, // reflector is non-streaming; no UI delta needed
    });

    // Include AWS credentials tools for account-aware operations
    const customTools = [executeCommandTool, readFileTool, writeFileTool, lsTool, editFileTool, globTool, grepTool, getAwsCredentialsTool, listAwsAccountsTool];

    // Dynamically discover and merge MCP server tools
    const mcpTools = await getActiveMCPTools(mcpServerIds);
    if (mcpTools.length > 0) {
        console.log(`[FastAgent] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }
    const tools = [...customTools, ...mcpTools];

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
3. Clearly label outputs with the account name/ID for clarity`;
    } else if (accountId) {
        // Backwards compatibility for single account
        accountContext = `\n\nIMPORTANT - AWS ACCOUNT CONTEXT:
You are operating in the context of AWS account: ${accountName || accountId} (ID: ${accountId}).
Before executing any AWS CLI commands, you MUST first call the get_aws_credentials tool with accountId="${accountId}" to create a session profile.
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

    // --- GENERATOR NODE (Agent) ---
    async function agentNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount } = state;

        console.log(`\n================================================================================`);
        console.log(`🚀 [FAST AGENT] Generator Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const baseIdentity = selectedSkill
            ? `You are a capable AI assistant operating under the "${selectedSkill}" skill.`
            : `You are a senior DevOps and AWS Cloud engineer with deep, practical knowledge of the AWS service portfolio (EC2, ECS, EKS, RDS, S3, Lambda, IAM, VPC, CloudWatch, CloudTrail, Route53, ALB/NLB, SQS, SNS, DynamoDB, SSM, Secrets Manager, Cost Explorer, and more), Terraform, Docker, Kubernetes, Ansible, CI/CD pipelines, bash scripting, and git. You write precise, production-quality AWS CLI commands and infrastructure code.`;

        const systemPrompt = new SystemMessage(`${baseIdentity}
You have access to tools: execute_command, read_file, write_file, edit_file, ls, glob, grep, web_search, get_aws_credentials, list_aws_accounts.
${effectiveSkillSection}

## AWS CLI Standards

When running AWS CLI commands:
- Always use --output json.
- Always use --profile <profileName> obtained from get_aws_credentials.
- Use --no-paginate for small, bounded result sets; use --starting-token pagination loops for large ones.
- Verify current resource state before running any mutation command.
- AWS Cost Explorer data covers the last 14 months only.

## Conversation Continuity

Review the full conversation history before responding:
- For follow-up questions, reference findings, resource IDs, and outputs from previous turns directly — do not re-discover what is already known.
- If a previous tool result is relevant to the current question, cite it rather than re-running the same command.
- If the user's intent is ambiguous given prior context, state your interpretation before proceeding.

${accountContext}

## Response Discipline

- Answer the user's request directly and completely.
- If tools are needed, call them. If the question is factual or conversational, answer without tools.
- If you receive a critique from the Reflector, address each identified issue specifically — do not restate the original answer unchanged.
- Be precise: include resource IDs, command flags, numeric values, and account names in your responses where available.
- Lead with the answer or the first action — avoid restating the question.`);

        // Reduced from 30 to 20 to cut input token cost per call
        const response = await modelWithTools.invoke([systemPrompt, ...getRecentMessages(messages, 20)]);

        if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
            console.log(`\n🛠️ [FAST AGENT] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls) {
                console.log(`   → Tool: ${toolCall.name}`);
                console.log(`     Args: ${JSON.stringify(toolCall.args)}`);
            }
        } else {
            console.log(`\n💬 [FAST AGENT] No tools called. Generating text response.`);
        }

        return {
            messages: [response],
            iterationCount: iterationCount + 1
        };
    }

    // Custom tool node that collects results (Added for logging parity)
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [FAST TOOLS] Executing tool calls...`);
        const result = await toolNode.invoke(state);
        console.log(`⚙️ [FAST TOOLS] Execution complete. Result messages: ${result.messages?.length || 0}`);

        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    console.log(`   ✅ [TOOL RESULT] ${msg.name || 'Unknown Tool'}:`);
                    console.log(`      ${truncateOutput(content, 200).replace(/\n/g, '\n      ')}`);
                }
            }
        }
        return result;
    }

    // --- REFLECTOR NODE ---
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages } = state;
        const lastMessage = messages[messages.length - 1];

        // If only tool calls, skip reflection (we need an answer to reflect on)
        if ((lastMessage as AIMessage).tool_calls && ((lastMessage as AIMessage).tool_calls?.length ?? 0) > 0) {
            return {};
        }

        console.log(`\n================================================================================`);
        console.log(`🤔 [FAST REFLECTOR] Critiquing response`);
        console.log(`================================================================================\n`);

        // The reflector critique is informed by the skill's own instructions.
        // If a skill is active, its privilege/safety context is used to evaluate correctness.
        const skillCritiqueContext = skillContent
            ? `The assistant is operating under the "${selectedSkill}" skill. Use the following skill instructions to verify correctness and adherence:\n\n${skillContent}`
            : `The assistant is operating as a general-purpose agentic assistant with no specific skill constraints.`;

        const reflectorPrompt = new SystemMessage(`You are a senior AWS and DevOps engineer performing a strict quality review of an AI assistant's response.

${skillCritiqueContext}

Evaluate the assistant's response on these five dimensions:

1. **Correctness**: Is the answer factually accurate? Are AWS CLI commands syntactically valid and semantically correct for the stated intent? Are resource IDs, service names, and flags correct?

2. **Completeness**: Does the response fully address what the user asked? Are there unstated assumptions, missing steps, or gaps that would leave the user unable to act on the answer?

3. **AWS CLI Quality** (if commands were used or suggested): Does the output use --output json? Is --profile used correctly? Is pagination handled for list/describe operations? Was state verified before any mutation was suggested or executed?

4. **Skill Adherence** (if a skill is active): Does the response comply with the privilege rules, safety constraints, and workflow defined in the skill instructions?

5. **Specificity**: Are findings specific (resource IDs, metric values, account names) or vague and generic? Vague responses are considered incomplete.

If the response is correct, complete, and specific — respond with exactly: COMPLETE

If there are issues — list them as concise, actionable critique points for the assistant to fix. Be specific about what is wrong and what the correct approach is. Do not generate the fixed answer yourself — only provide the critique.`);

        // Construct a clean context for the Reflector to avoid Bedrock tool validation issues
        // and to prevent the Reflector from trying to use tools itself.
        const userMessage = messages.slice().reverse().find(m => m._getType() === 'human');
        const originalQuery = userMessage ? getStringContent(userMessage.content) : "Unknown query";
        const agentResponse = getStringContent(lastMessage.content);

        const critiqueInput = new HumanMessage({
            content: `Here is the interaction to review:
                
<USER_QUERY>
${originalQuery}
</USER_QUERY>

<ASSISTANT_RESPONSE>
${agentResponse}
</ASSISTANT_RESPONSE>

Please provide your critique.`
        });

        // Use reflectorModel (maxTokens:1024, non-streaming) — critique is short, no need for 4096 budget
        const response = await reflectorModel.invoke([reflectorPrompt, critiqueInput]);
        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

        if (!content) {
            console.log(`⚠️ [FAST REFLECTOR] Empty content received!`);
            console.log(`   Input Query Length: ${originalQuery.length}`);
            console.log(`   Agent Response Length: ${agentResponse.length}`);
            console.log(`   Raw Response:`, JSON.stringify(response));
        }

        console.log(`   Critique: ${truncateOutput(content, 200)}`);

        if (content.includes("COMPLETE")) {
            // We're done. Return the critique message so it's visible, and mark complete.
            return {
                messages: [response],
                isComplete: true
            };
        }

        return {
            messages: [new HumanMessage({ content: `Critique: ${content}\nPlease update your answer.` })],
            isComplete: false
        };
    }

    // Helper to safely extract string content
    function getStringContent(content: string | any[]): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map(c => c.text || JSON.stringify(c)).join('');
        }
        return JSON.stringify(content);
    }

    // --- CONDITIONAL EDGES ---
    function shouldContinue(state: ReflectionState): "tools" | "reflect" | "__end__" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        const { iterationCount } = state;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }

        // If we have text, we reflect
        if (iterationCount >= MAX_ITERATIONS) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached. Stopping.`);
            return END;
        }

        return "reflect";
    }

    function shouldContinueFromReflect(state: ReflectionState): "agent" | "__end__" {
        if (state.isComplete) {
            return END;
        }
        return "agent";
    }

    // --- GRAPH CONSTRUCTION ---
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("agent", agentNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)

        .addEdge(START, "agent")

        .addConditionalEdges("agent", shouldContinue, {
            tools: "tools",
            reflect: "reflect",
            __end__: END
        })

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            agent: "agent",
            __end__: END
        })

        .addEdge("tools", "agent");

    if (autoApprove) {
        return workflow.compile({ checkpointer });
    } else {
        return workflow.compile({
            checkpointer,
            interruptBefore: ["tools"],
        });
    }
}
