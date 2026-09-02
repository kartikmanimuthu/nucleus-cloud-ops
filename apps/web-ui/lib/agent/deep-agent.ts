import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware, todoListMiddleware } from "langchain";
import { isGraphInterrupt } from "@langchain/langgraph";
import { z } from "zod";
import { createDeepAgent, FilesystemBackend, CompositeBackend, StoreBackend } from "deepagents";
import {
    webSearchTool,
    webSearchAvailable,
    askUserTool,
    writeFileToS3Tool,
    getFileFromS3Tool,
    createExecuteCommandTool,
    createGetAwsCredentialsTool,
    createListAwsAccountsTool,
} from "./tools";
import { createGetRightSizingRecommendationsTool } from "./right-sizing-tool";
import { createGetResourceNeighborsTool, createGetBlastRadiusTool } from "./resource-graph-tool";
import {
    createFindPathTool,
    createQueryGraphTool,
    createDescribeEnvironmentTool,
} from "./resource-graph-query-tool";
import { createSearchKnowledgeBaseTool } from "./kb-tool";
import { createAwsReadTool } from "./aws-read-tool";
import { createLoadSkillTool } from "./skill-tool";
import { getSkillContent, getSkillSummaries } from "@/lib/skill-service";
import {
    GraphConfig,
    repairEmptyAiContent,
    stripReasoningFromMessages,
    getCheckpointer,
    getActiveMCPTools,
    getStore,
} from "./agent-shared";
import { createAgentModels, createMemoryTools } from "./model-factory";
import { tenantWorkdir, ensureWorkdir, AGENTS_MD_PATH, MEMORIES_ROUTE } from "./deep/workdir";
import { createDeepSubagents } from "./deep/subagents";
import { PostgresFileStore } from "./deep/file-store";
import { createDeepMemoryMiddleware } from "./deep/memory-middleware";

export const DEEP_INTERRUPT_TOOLS = ['execute_command', 'write_file', 'edit_file', 'ask_user'];

// Per-run data, passed as `context` at invoke and readable by middleware and subagents via
// runtime.context. The framework propagates it to every subagent automatically.
export const deepContextSchema = z.object({
    tenantId: z.string().optional(),
    userId: z.string().optional(),
    threadId: z.string().optional(),
});

export async function createDeepGraph(config: GraphConfig) {
    const { model: modelConfig, autoApprove, accounts, accountId, accountName, selectedSkill, autoLoadSkills, mcpServerIds, knowledgeBaseIds, tenantId, userId } = config as any;
    const modelId = modelConfig.modelId;
    const checkpointer = await getCheckpointer();
    const store = await getStore();

    // --- Skill loading (async DB lookup, tenant-scoped) ---
    let skillSection = '';
    let skillContent = '';
    if (selectedSkill && tenantId) {
        const content = await getSkillContent(tenantId, selectedSkill);
        if (content) {
            skillContent = content;
            skillSection = `\n\n=== ACTIVE SKILL: ${selectedSkill.toUpperCase()} ===\n${skillContent}\n\nYou MUST follow the above skill-specific instructions. They define your privileges, safety guidelines, and workflow for this conversation.\n=== END SKILL ===\n`;
            console.log(`[DeepAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[DeepAgent] No content for skill: ${selectedSkill}`);
        }
    }

    // Skill catalog for progressive disclosure, gated by the console "Auto skills" toggle.
    // Deep loads skills through load_skill (like fast/planning) rather than deepagents'
    // SkillsMiddleware: the load becomes a named, persisted tool card instead of an
    // anonymous read_file on a SKILL.md path.
    const skillCatalog = tenantId && autoLoadSkills !== false
        ? await getSkillSummaries(tenantId)
            .then(c => (c.startsWith('No specialized skills') ? null : c))
            .catch(() => null)
        : null;
    const skillCatalogSection = skillCatalog
        ? `\n${skillCatalog}\nIf one of these skills covers the task (or a phase of it), call the load_skill tool with its id to load the full instructions BEFORE doing that work, then follow them. Load additional skills later in the run if a different phase needs them. Do not reload a skill already loaded in this conversation.\n`
        : '';

    const baseSkillSection = skillSection || `

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
    const effectiveSkillSection = baseSkillSection + skillCatalogSection;

    // --- Model Initialization ---
    const { main: model, reflector: reflectorModel } = createAgentModels(modelConfig);

    // --- Account Context (same pattern as fast-agent.ts) ---
    let accountContext: string;
    if (accounts && accounts.length > 0) {
        const accountList = accounts.map((a: { accountName?: string; accountId: string }) => `  - ${a.accountName || a.accountId} (ID: ${a.accountId})`).join('\n');
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

    // --- Per-tenant workdir + AGENTS.md ---
    const root = tenantWorkdir(tenantId ?? 'default');
    await ensureWorkdir(root);

    // Working files on disk; /memories/ routed to Postgres so AGENTS.md survives
    // deploys. fileStore is a real BaseStore over agent_files — getStore()'s
    // PostgresMemoryStore is NOT one (batch() only, and it embeds into agent_memories).
    const fileStore = new PostgresFileStore(tenantId ?? 'default');
    // virtualMode is MANDATORY. With the default (false), FilesystemBackend treats absolute
    // paths as real host paths — the agent could read /tmp/nucleus-aws-creds/<otherTenant>/
    // credentials, .env, or app source. virtualMode jails every path under rootDir and
    // rejects .. and ~, which is what tools.ts's resolveInJail did for the old file tools.
    const backend = new CompositeBackend(
        new FilesystemBackend({ rootDir: root, virtualMode: true }),
        { [MEMORIES_ROUTE]: new StoreBackend({ namespace: () => ['deep-agent'] }) },
    );
    console.log(`[DeepAgent] Workdir: ${root}; /memories/ → agent_files`);

    // --- MCP Tools ---
    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId, accounts);
    if (mcpTools.length > 0) {
        console.log(`[DeepAgent] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }

    // --- Custom tools (non-builtins) ---
    const executeCommand = createExecuteCommandTool({ cwd: root });
    const getAwsCredentials = createGetAwsCredentialsTool(tenantId);
    const listAwsAccounts = createListAwsAccountsTool(tenantId);

    const allTools = [
        executeCommand,
        getAwsCredentials,
        listAwsAccounts,
        askUserTool,
        ...(webSearchAvailable() ? [webSearchTool] : []),
        writeFileToS3Tool,
        getFileFromS3Tool,
        ...(tenantId ? [createGetRightSizingRecommendationsTool(tenantId)] : []),
        // The deep agent builds its own tool list rather than going through assembleTools, so
        // anything added there does not reach it. Without these it falls back to aws_read and
        // execute_command and re-derives relationships AWS call by AWS call, when the graph
        // already holds them.
        ...(tenantId
            ? [
                createGetResourceNeighborsTool(tenantId),
                createGetBlastRadiusTool(tenantId),
                createFindPathTool(tenantId),
                createQueryGraphTool(tenantId),
                createDescribeEnvironmentTool(tenantId),
            ]
            : []),
        ...(tenantId ? [createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined)] : []),
        ...(tenantId ? [createAwsReadTool(tenantId, userId)] : []),
        // search_memory only. DeepMemoryMiddleware already saves after every run —
        // it extracts from the whole transcript, runs the reconcile judge and captures
        // an episode — so a save_memory tool call is a second, blind write of the same
        // finding. Observed: the tool wrote a complete row, then the middleware's
        // reconcile UPDATE landed on it moments later. Recall keeps both paths, because
        // the automatic one searches on the user's raw message and a terse follow-up
        // ("and do it for ec2 as well") gives it nothing to match on.
        ...(tenantId && userId
            ? createMemoryTools(tenantId, userId).filter(t => t.name === 'search_memory')
            : []),
        ...(tenantId && autoLoadSkills !== false ? [createLoadSkillTool(tenantId)] : []),
        ...mcpTools,
    ];

    // --- HITL interrupt configuration ---
    const interruptOn = autoApprove ? undefined : {
        execute_command: true,
        write_file: true,
        edit_file: true,
        ask_user: true,
    };

    // --- Memory middleware ---
    const memoryMiddleware = createDeepMemoryMiddleware({
        reflectorModel,
        tenantId,
        userId,
        store,
        onMemoryEvent: config.onMemoryEvent,
    });

    // --- Subagent Definitions ---
    const subagents = createDeepSubagents({
        accountContext,
        executeCommand,
        getAwsCredentials,
        listAwsAccounts,
        researchTools: [
            ...(webSearchAvailable() ? [webSearchTool] : []),
            ...(tenantId ? [createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined)] : []),
            ...(tenantId ? [createAwsReadTool(tenantId, userId)] : []),
            ...mcpTools,
        ] as never,
        interruptOn,
    });

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

${accountContext}

## Durable Memory

\`${AGENTS_MD_PATH}\` is your own notebook. It is loaded into your prompt on every run and it
persists across conversations.

When you learn a durable operating rule — a command flag that is rejected, a convention of this
environment, or a correction the user gives you — append it there with \`edit_file\` (use
\`write_file\` if the file does not exist yet). Record rules, not one-off facts, and keep it short.

## Resource Relationships

Relationships between AWS resources come from the dependency graph, not from guesswork and not
from repeated describe calls. The graph is built from the discovery scan and already knows what
is connected to what.

- Use get_resource_neighbors to learn what one resource is attached to — its VPC, subnets,
  security groups, volumes, load balancers, IAM role, KMS key.
- Use find_path to establish whether and how two resources are connected. One call returns the
  whole chain; do not walk it hop by hop with get_resource_neighbors.
- Use query_graph for "everything that matches X" — by type, by VPC, internet-facing,
  unmonitored, or isolated.
- Use describe_environment before reasoning about an account you have not examined yet, rather
  than inferring its size or composition.
- Before recommending or performing any stop, delete or resize, call get_blast_radius first and
  state what depends on the resource.

If the graph returns nothing, say so plainly. It distinguishes "this resource is not in
inventory" from "it is in inventory but has no recorded relationships", and those mean different
things — never collapse them into "nothing found". When a result reports itself truncated, say
so rather than presenting a capped list as complete.

## Planning Discipline

Use the write_todos tool to plan. Do not reserve it for work you judge "complex":
- Write the todo list BEFORE the first tool call whenever the request needs more than two steps, touches more than one account or region, or spans more than one AWS service.
- Keep exactly one item in_progress. Mark it completed the moment it is done — never batch completions at the end of the run.
- When new work appears mid-run (a failed call to retry, an extra region, a follow-up check the data suggests), add it to the list instead of doing it silently.
- Rewrite the list when the scope changes. A stale list is worse than no list.
- Skip it only for a single-step lookup or a purely conversational answer.

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

    // A tool error must reach the MODEL, not kill the run. deepagents wraps every tool
    // call (for LangSmith), so ToolNode sees tool failures as MIDDLEWARE errors and
    // re-raises them: one malformed argument aborted a 7-step audit mid-flight, taking
    // 12 in-flight sibling calls with it, and the model never got to correct itself.
    // This is the documented wrapToolCall pattern from the tools docs.
    const handleToolErrors = createMiddleware({
        name: "HandleToolErrors",
        wrapToolCall: async (request, handler) => {
            try {
                return await handler(request);
            } catch (error) {
                // Interrupts are the HITL pause, and aborts are the client hanging up.
                // Neither is the model's to recover from — ToolNode re-raises both, and
                // swallowing an interrupt here would silently break every approval.
                if (isGraphInterrupt(error)) throw error;
                const message = error instanceof Error ? error.message : String(error);
                if ((error as { name?: string })?.name === 'AbortError' || /abort/i.test(message)) throw error;
                return new ToolMessage({
                    content: `Tool error: ${message}\nCheck your arguments against the tool's schema and try again.`,
                    tool_call_id: request.toolCall.id!,
                    name: request.toolCall.name,
                });
            }
        },
    });

    // Bedrock rejects a message with no content, and a reasoning-only turn comes
    // back from the checkpoint with nothing left in it — so reopening an old thread
    // died with "The content field in the Message object at messages.N is empty".
    // Fast and planning avoid this by running sanitizeMessagesForBedrock before
    // every call; deep never could, because deepagents owns the model call. This is
    // that guard, narrowed to the crash: rewrite empty AI content, touch nothing else.
    const repairMessages = createMiddleware({
        name: "RepairEmptyAiContent",
        // Strip before repair: a thinking block replayed from a checkpoint has lost the
        // signature Bedrock requires ("messages.N.content.0.thinking.signature: Field
        // required"), and stripping one can leave the turn empty, which Bedrock also
        // rejects. Fast and planning get both from sanitizeMessagesForBedrock; deep cannot
        // call it because deepagents owns the model call, so it gets the same two guards here.
        wrapModelCall: async (request, handler) =>
            handler({
                ...request,
                messages: repairEmptyAiContent(stripReasoningFromMessages(request.messages)),
            }),
    });

    return createDeepAgent({
        model,
        tools: allTools,
        systemPrompt: new SystemMessage(systemPrompt),
        subagents,
        contextSchema: deepContextSchema,
        backend,
        memory: [AGENTS_MD_PATH],
        checkpointer,
        store: fileStore,
        interruptOn,
        // deepagents v0.7 made planning todos opt-in: createDeepAgent no longer bundles
        // TodoListMiddleware, so write_todos and the `todos` state channel are absent unless
        // passed explicitly (only the OpenAI Codex harness profile still opts in). The plan
        // rail reads run.values.todos, so without this it renders nothing.
        middleware: [todoListMiddleware(), memoryMiddleware, handleToolErrors, repairMessages],
    });
}
