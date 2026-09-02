import type { SubAgent } from 'deepagents';

/** A LangChain tool, structurally. Avoids importing the heavy tool types here. */
type AnyTool = SubAgent['tools'] extends (infer T)[] | undefined ? T : never;

export interface DeepSubagentOptions {
    /** Prompt fragment describing the AWS account(s) in scope. */
    accountContext: string;
    executeCommand: AnyTool;
    getAwsCredentials: AnyTool;
    listAwsAccounts: AnyTool;
    /** Read-only research toolset — web search, KB, aws-read, MCP. Caller assembles it. */
    researchTools: AnyTool[];
    /** HITL gate config, or undefined when autoApprove is on. */
    interruptOn?: Record<string, boolean>;
}

/**
 * The three deep sub-agents, shared by the AI Ops chat graph (createDeepGraph)
 * and the Agent Ops executor graph (createDeepExecutorGraph).
 *
 * Order is stable and asserted by tests: aws-ops, research, code-iac.
 * `research` is deliberately un-gated — it holds only read-only tools.
 */
export function createDeepSubagents(opts: DeepSubagentOptions): SubAgent[] {
    const { accountContext, executeCommand, getAwsCredentials, listAwsAccounts, researchTools, interruptOn } = opts;

    const awsOps: SubAgent = {
        name: 'aws-ops',
        description: 'AWS Operations agent — executes AWS CLI commands, manages credentials, verifies resource state. Use for any AWS API calls, resource creation/mutation/deletion, and cross-account operations.',
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
        tools: [executeCommand, getAwsCredentials, listAwsAccounts],
        ...(interruptOn ? { interruptOn } : {}),
    };

    const research: SubAgent = {
        name: 'research',
        description: 'Research agent — searches the web for documentation, AWS pricing, error resolution, best practices. Use when you need to look up information, check AWS docs, or resolve an error message.',
        systemPrompt: `You are a research assistant specialized in AWS and DevOps documentation.

**Your focus:**
- Search the web for accurate, up-to-date AWS documentation and best practices
- Look up error messages and their solutions
- Find AWS pricing information and service limits
- Research Terraform/CloudFormation/CDK patterns and examples
- Return concise, actionable findings with source references

Always cite the source URL when returning findings.`,
        tools: researchTools,
    };

    const codeIac: SubAgent = {
        name: 'code-iac',
        description: 'Code and Infrastructure-as-Code agent — reads, writes, and edits files. Use for Terraform, CloudFormation, Docker, Ansible, shell scripts, and any file system operations.',
        systemPrompt: `You are a senior DevOps engineer specialized in Infrastructure-as-Code and automation scripts.

**Your focus:**
- Read, write, and edit Terraform configs, CloudFormation templates, Dockerfiles, Ansible playbooks
- Write precise shell scripts and CI/CD pipeline configurations
- Validate IaC syntax and suggest best practices
- Follow existing code style and conventions in the project
- Execute shell commands to validate or test IaC (terraform plan, docker build --no-cache, etc.)

Always read existing files before editing them to understand the current state.`,
        tools: [executeCommand],
        ...(interruptOn ? { interruptOn } : {}),
    };

    return [awsOps, research, codeIac];
}
