/**
 * Agent Ops — Deep Executor Graph
 *
 * The Agent Ops sibling of lib/agent/deep-agent.ts's createDeepGraph. Same
 * framework, same backend, same sub-agents; the differences are:
 *
 *   - Autonomous framing in the system prompt (no interactive user turn-taking).
 *     ask_user is still available and maps to the run's awaiting_input state.
 *   - recursionLimit comes from the caller's config.maxIterations (tenant Agent
 *     Ops budget), applied at invoke time by deep-run-executor.
 *   - onSubagentEvent / onMemoryEvent sinks are wired to the event recorder
 *     rather than to an SSE stream.
 *
 * Kept deliberately separate from createDeepGraph so Agent Ops and AI Ops can
 * evolve independently, exactly as the plan/fast graphs already are.
 */
import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware, todoListMiddleware } from "langchain";
import { isGraphInterrupt } from "@langchain/langgraph";
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
} from "@/lib/agent/tools";
import { createGetRightSizingRecommendationsTool } from "@/lib/agent/right-sizing-tool";
import { createSearchKnowledgeBaseTool } from "@/lib/agent/kb-tool";
import { createAwsReadTool } from "@/lib/agent/aws-read-tool";
import { createLoadSkillTool } from "@/lib/agent/skill-tool";
import { getSkillContent, getSkillSummaries } from "@/lib/skill-service";
import {
    type GraphConfig,
    repairEmptyAiContent,
    getCheckpointer,
    getActiveMCPTools,
    getStore,
} from "@/lib/agent/agent-shared";
import { createAgentModels, createMemoryTools } from "@/lib/agent/model-factory";
import { tenantWorkdir, ensureWorkdir, AGENTS_MD_PATH, MEMORIES_ROUTE } from "@/lib/agent/deep/workdir";
import { createDeepSubagents } from "@/lib/agent/deep/subagents";
import { PostgresFileStore } from "@/lib/agent/deep/file-store";
import { createDeepMemoryMiddleware } from "@/lib/agent/deep/memory-middleware";
import { deepContextSchema } from "@/lib/agent/deep-agent";

export async function createDeepExecutorGraph(config: GraphConfig) {
    const {
        model: modelConfig, autoApprove, accounts, accountId, accountName,
        selectedSkill, autoLoadSkills, mcpServerIds, knowledgeBaseIds, tenantId, userId,
    } = config as never as Record<string, never>;

    if (!tenantId) {
        throw new Error('A tenant context is required to build the Agent Ops deep graph.');
    }

    const checkpointer = await getCheckpointer();
    const store = await getStore();
    const { main: model, reflector: reflectorModel } = createAgentModels(modelConfig);

    // --- Skills: pinned skill (if any) + progressive-disclosure catalog ---
    let skillSection = '';
    if (selectedSkill) {
        const content = await getSkillContent(tenantId, selectedSkill);
        if (content) {
            skillSection = `\n\n=== ACTIVE SKILL: ${String(selectedSkill).toUpperCase()} ===\n${content}\n\nYou MUST follow the above skill-specific instructions.\n=== END SKILL ===\n`;
        }
    }
    const skillCatalog = autoLoadSkills !== false
        ? await getSkillSummaries(tenantId)
            .then(c => (c.startsWith('No specialized skills') ? null : c))
            .catch(() => null)
        : null;
    const skillCatalogSection = skillCatalog
        ? `\n${skillCatalog}\nIf one of these skills covers the task (or a phase of it), call the load_skill tool with its id to load the full instructions BEFORE doing that work, then follow them. Do not reload a skill already loaded in this run.\n`
        : '';

    // --- Account context ---
    const accountList = Array.isArray(accounts) ? accounts : [];
    let accountContext: string;
    if (accountList.length > 0) {
        const list = accountList
            .map((a: { accountName?: string; accountId: string }) => `  - ${a.accountName || a.accountId} (ID: ${a.accountId})`)
            .join('\n');
        accountContext = `\n\nIMPORTANT - MULTI-ACCOUNT AWS CONTEXT:\nYou are operating across ${accountList.length} AWS account(s):\n${list}\n\nFor EACH account: call get_aws_credentials with the accountId, then use --profile <profileName> with ALL subsequent AWS CLI commands, and label outputs by account.`;
    } else if (accountId) {
        accountContext = `\n\nIMPORTANT - AWS ACCOUNT CONTEXT:\nYou are operating in AWS account: ${accountName || accountId} (ID: ${accountId}).\nBefore any AWS CLI command you MUST call get_aws_credentials with accountId="${accountId}" and use the returned --profile with every command. NEVER use the host's default credentials.`;
    } else {
        accountContext = `\n\nIMPORTANT - AUTONOMOUS AWS ACCOUNT DISCOVERY:\nNo explicit account was provided. If AWS operations are needed:\n1. Call list_aws_accounts.\n2. Fuzzy-match the account named in the task.\n3. Call get_aws_credentials with the matched accountId.\n4. Use the returned --profile with every AWS CLI command.`;
    }

    // --- Workdir + backend. virtualMode is MANDATORY: without it FilesystemBackend
    // treats absolute paths as real host paths and the agent could read another
    // tenant's credentials directory, .env, or app source. ---
    const root = tenantWorkdir(tenantId);
    await ensureWorkdir(root);
    const fileStore = new PostgresFileStore(tenantId);
    const backend = new CompositeBackend(
        new FilesystemBackend({ rootDir: root, virtualMode: true }),
        { [MEMORIES_ROUTE]: new StoreBackend({ namespace: () => ['deep-agent'] }) },
    );

    // --- Tools ---
    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId, accountList);
    const executeCommand = createExecuteCommandTool({ cwd: root });
    const getAwsCredentials = createGetAwsCredentialsTool(tenantId);
    const listAwsAccounts = createListAwsAccountsTool(tenantId);
    const researchTools = [
        ...(webSearchAvailable() ? [webSearchTool] : []),
        createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined),
        createAwsReadTool(tenantId, userId),
        ...mcpTools,
    ];

    const allTools = [
        executeCommand,
        getAwsCredentials,
        listAwsAccounts,
        askUserTool,
        ...(webSearchAvailable() ? [webSearchTool] : []),
        writeFileToS3Tool,
        getFileFromS3Tool,
        createGetRightSizingRecommendationsTool(tenantId),
        createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined),
        createAwsReadTool(tenantId, userId),
        // search_memory ONLY. DeepMemoryMiddleware already saves from the whole
        // transcript (extract → reconcile judge → episode); a save_memory tool call
        // is a second blind write of the same finding that races the reconcile UPDATE.
        ...(userId ? createMemoryTools(tenantId, userId).filter(t => t.name === 'search_memory') : []),
        ...(autoLoadSkills !== false ? [createLoadSkillTool(tenantId)] : []),
        ...mcpTools,
    ];

    // --- HITL ---
    const interruptOn = autoApprove ? undefined : {
        execute_command: true,
        write_file: true,
        edit_file: true,
        ask_user: true,
    };

    const memoryMiddleware = createDeepMemoryMiddleware({
        reflectorModel,
        tenantId,
        userId,
        store,
        onMemoryEvent: (config as never as { onMemoryEvent?: (op: 'recall' | 'save', s: string) => void }).onMemoryEvent,
    });

    const subagents = createDeepSubagents({
        accountContext,
        executeCommand: executeCommand as never,
        getAwsCredentials: getAwsCredentials as never,
        listAwsAccounts: listAwsAccounts as never,
        researchTools: researchTools as never,
        interruptOn,
    });

    const systemPrompt = `You are an elite autonomous AI DevOps and Cloud Operations engineer executing an unattended operations task.
${skillSection}${skillCatalogSection}

## Core Identity
You plan comprehensively before acting, use your tools directly, and maintain a to-do list with write_todos so progress is visible to the humans reviewing this run.

## Autonomous Operating Rules
- Nobody is watching this run in real time. Do not ask for confirmation you could establish yourself with a describe/list call.
- Use ask_user ONLY when the task is genuinely ambiguous and no tool can resolve it. It pauses the entire run pending a human reply.
- Finish with a self-contained report: what you checked, what you changed, and the resource IDs involved. It may be read hours later with no other context.

## AWS CLI Standards
- Always use --output json and --profile <profileName> from get_aws_credentials.
- Run describe/list before any mutation; use --dry-run or terraform plan where supported.
- Use --no-paginate for small, bounded result sets; use --starting-token pagination loops for large ones.
- AWS Cost Explorer data covers the last 14 months only.
${accountContext}

## Durable Memory
\`${AGENTS_MD_PATH}\` is your notebook. It is loaded every run and persists across runs. When you learn a durable operating rule — a rejected flag, an environment convention, a correction — append it with edit_file. Record rules, not one-off facts.

Call \`search_memory\` when prior findings would save work. Live data always wins over a stored fact: re-verify before relying on anything recalled.`;

    // A tool error must reach the MODEL, not kill the run. deepagents wraps every
    // tool call, so ToolNode sees failures as middleware errors and re-raises them.
    const handleToolErrors = createMiddleware({
        name: "HandleToolErrors",
        wrapToolCall: async (request, handler) => {
            try {
                return await handler(request);
            } catch (error) {
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

    const repairMessages = createMiddleware({
        name: "RepairMessages",
        wrapModelCall: async (request, handler) =>
            handler({ ...request, messages: repairEmptyAiContent(request.messages) }),
    });

    console.log(`[AgentOpsDeep] Graph ready — workdir ${root}, autoApprove=${autoApprove}, tools=${allTools.length}`);

    return createDeepAgent({
        model,
        tools: allTools as never,
        systemPrompt: new SystemMessage(systemPrompt),
        subagents,
        contextSchema: deepContextSchema,
        backend,
        memory: [AGENTS_MD_PATH],
        checkpointer,
        store: fileStore as never,
        ...(interruptOn ? { interruptOn } : {}),
        // deepagents v0.7 made planning todos opt-in: createDeepAgent no longer bundles
        // TodoListMiddleware, so write_todos and the `todos` state channel are absent unless
        // passed explicitly. The Agent Ops timeline reads run.values.todos, so without this
        // it renders nothing.
        middleware: [todoListMiddleware(), memoryMiddleware, handleToolErrors, repairMessages] as never,
    });
}
