import { SystemMessage } from "@langchain/core/messages";
import { ChatBedrockConverse } from "@langchain/aws";
import { createDeepAgent } from "deepagents";
import type { SubAgent } from "deepagents";
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
    listAwsAccountsTool,
} from "./tools";
import { getSkillContent } from "./skills/skill-loader";
import {
    GraphConfig,
    getCheckpointer,
    getActiveMCPTools,
} from "./agent-shared";

// --- DEEP GRAPH (Deep Agent Mode) ---
export async function createDeepGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds } = config;
    const checkpointer = await getCheckpointer();

    // --- Skill loading (same pattern as fast-agent.ts) ---
    let skillSection = '';
    let skillContent = '';

    if (selectedSkill) {
        const content = getSkillContent(selectedSkill);
        if (content) {
            skillContent = content;
            skillSection = `\n\n=== ACTIVE SKILL: ${selectedSkill.toUpperCase()} ===\n${skillContent}\n\nYou MUST follow the above skill-specific instructions. They define your privileges, safety guidelines, and workflow for this conversation.\n=== END SKILL ===\n`;
            console.log(`[DeepAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[DeepAgent] Failed to load skill content for: ${selectedSkill}`);
        }
    }

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
        maxTokens: 8192,
        temperature: 0,
        streaming: true,
    });

    // --- Account Context (same pattern as fast-agent.ts) ---
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

    // --- MCP Tools ---
    const mcpTools = await getActiveMCPTools(mcpServerIds);
    if (mcpTools.length > 0) {
        console.log(`[DeepAgent] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }

    // All tools available to the orchestrator agent
    const allTools = [
        executeCommandTool,
        // readFileTool,
        // writeFileTool,
        // lsTool,
        // editFileTool,
        // globTool,
        // grepTool,
        // webSearchTool,
        getAwsCredentialsTool,
        listAwsAccountsTool,
        ...mcpTools,
    ];

    // --- Subagent Definitions ---
    const awsOpsSubagent: SubAgent = {
        name: "aws-ops",
        description: "AWS Operations agent — executes AWS CLI commands, manages credentials, verifies resource state. Use for any AWS API calls, resource creation/mutation/deletion, and cross-account operations.",
        systemPrompt: `You are a senior AWS Cloud engineer specialized in executing AWS CLI operations.

${accountContext}

**Your focus:**
- Execute AWS CLI commands with proper credentials via get_aws_credentials
- Always use --output json and --profile <profileName>
- Verify resource state (describe/list) before mutations
- Handle multi-account operations by getting credentials for each account
- Return precise results with resource IDs, ARNs, and status values

**AWS CLI Standards:**
- Always use --output json
- Always use --profile obtained from get_aws_credentials
- Use --no-paginate for small result sets; use pagination loops for large ones
- Verify current resource state before any mutation command`,
        tools: [executeCommandTool, getAwsCredentialsTool, listAwsAccountsTool],
    };

    const researchSubagent: SubAgent = {
        name: "research",
        description: "Research agent — searches the web for documentation, AWS pricing, error resolution, best practices. Use when you need to look up information, check AWS docs, or resolve an error message.",
        systemPrompt: `You are a research assistant specialized in AWS and DevOps documentation.

**Your focus:**
- Search the web for accurate, up-to-date AWS documentation and best practices
- Look up error messages and their solutions
- Find AWS pricing information and service limits
- Research Terraform/CloudFormation/CDK patterns and examples
- Return concise, actionable findings with source references

Always cite the source URL when returning findings.`,
        tools: [webSearchTool, ...mcpTools],
    };

    const codeSubagent: SubAgent = {
        name: "code-iac",
        description: "Code and Infrastructure-as-Code agent — reads, writes, and edits files. Use for Terraform, CloudFormation, Docker, Ansible, shell scripts, and any file system operations.",
        systemPrompt: `You are a senior DevOps engineer specialized in Infrastructure-as-Code and automation scripts.

**Your focus:**
- Read, write, and edit Terraform configs, CloudFormation templates, Dockerfiles, Ansible playbooks
- Write precise shell scripts and CI/CD pipeline configurations
- Validate IaC syntax and suggest best practices
- Follow existing code style and conventions in the project
- Execute shell commands to validate or test IaC (terraform plan, docker build --no-cache, etc.)

Always read existing files before editing them to understand the current state.`,
        tools: [readFileTool, writeFileTool, editFileTool, lsTool, globTool, grepTool, executeCommandTool],
    };

    // --- System Prompt ---
    const baseIdentity = selectedSkill
        ? `You are a capable AI assistant operating under the "${selectedSkill}" skill.`
        : `You are a senior DevOps and AWS Cloud engineer with deep, practical knowledge of the AWS service portfolio (EC2, ECS, EKS, RDS, S3, Lambda, IAM, VPC, CloudWatch, CloudTrail, Route53, ALB/NLB, SQS, SNS, DynamoDB, SSM, Secrets Manager, Cost Explorer, and more), Terraform, Docker, Kubernetes, Ansible, CI/CD pipelines, bash scripting, and git. You write precise, production-quality AWS CLI commands and infrastructure code.`;

    const systemPrompt = `${baseIdentity}
${effectiveSkillSection}

## AWS CLI Standards

When running AWS CLI commands:
- Always use --output json.
- Always use --profile <profileName> obtained from get_aws_credentials.
- Use --no-paginate for small, bounded result sets; use --starting-token pagination loops for large ones.
- Verify current resource state before running any mutation command.
- AWS Cost Explorer data covers the last 14 months only.

## Task Decomposition

Use write_todos to plan complex multi-step tasks before executing them.
Use the task tool to delegate to specialized subagents:
- aws-ops: for AWS CLI operations, credential management, resource state verification
- research: for web searches, documentation lookups, error resolution
- code-iac: for file operations, Terraform/CloudFormation/Docker/Ansible, shell scripts

${accountContext}

## Response Discipline

- Answer the user's request directly and completely.
- If tools are needed, call them. If the question is factual or conversational, answer without tools.
- Be precise: include resource IDs, command flags, numeric values, and account names in your responses where available.
- Lead with the answer or the first action — avoid restating the question.`;

    console.log(`\n================================================================================`);
    console.log(`🧠 [DEEP AGENT] Creating deep agent`);
    console.log(`   Model: ${modelId}`);
    console.log(`   Auto-Approve: ${autoApprove}`);
    console.log(`   Subagents: aws-ops, research, code-iac`);
    console.log(`================================================================================\n`);

    // --- HITL interrupt configuration ---
    // When autoApprove=false, interrupt before mutation tools execute
    const interruptOn = autoApprove ? undefined : {
        execute_command: true,
        write_file: true,
        edit_file: true,
    };

    // Create Deep Agent
    const agent = createDeepAgent({
        model: model,
        tools: allTools,
        systemPrompt: new SystemMessage(systemPrompt),
        subagents: [awsOpsSubagent, researchSubagent, codeSubagent],
        checkpointer: checkpointer,
        interruptOn: interruptOn,
    });

    return agent;
}
