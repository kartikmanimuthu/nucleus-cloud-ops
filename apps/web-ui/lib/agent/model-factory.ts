/**
 * model-factory.ts
 *
 * Single source of truth for model initialization and tool assembly.
 * Both planning-agent and fast-agent import from here — no more per-file duplication.
 */

import { ChatBedrockConverse } from "@langchain/aws";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
    executeCommandTool,
    readFileTool,
    writeFileTool,
    lsTool,
    editFileTool,
    globTool,
    grepTool,
    createGetAwsCredentialsTool,
    createListAwsAccountsTool,
    writeFileToS3Tool,
    getFileFromS3Tool,
    askUserTool,
} from "./tools";
import { createGetRightSizingRecommendationsTool } from "./right-sizing-tool";
import { createSearchKnowledgeBaseTool } from "./kb-tool";
import { createLoadSkillTool } from "./skill-tool";
import { getActiveMCPTools, isOpenAICompatibleProvider, type AccountContext, type ResolvedModelConfig } from "./agent-shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { saveMemory, searchMemory } from "./persistence";
import { ProviderConfigError } from "./provider-errors";
import { normalizeOpenAICompatibleBaseUrl } from "@/lib/provider-model-service";

export interface AgentModels {
    /** Primary model: streaming. Used for all generation nodes. */
    main: BaseChatModel;
    /** Reflector model: non-streaming. Emits small JSON critiques only. */
    reflector: BaseChatModel;
}

/** Conservative default output-token cap when a provider record doesn't specify one.
 *  4096 is safe across small/local models and matches the Anthropic/Bedrock defaults —
 *  the previous 40000 OpenAI-path default overflowed 8k–32k context windows. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Provider-level context-window estimates (tokens). The ProviderModel schema has no
 *  per-model context-window field, so we approximate at the provider family level — no
 *  model-ID assumptions. Self-hosted families are sized conservatively for small local
 *  models; operators can still override the derived working-memory budget via
 *  WORKING_MEMORY_TOKEN_BUDGET. */
const PROVIDER_CONTEXT_WINDOW: Record<ResolvedModelConfig["provider"], number> = {
    bedrock: 200_000,
    anthropic: 200_000,
    openai: 128_000,
    "openai-compatible": 16_000,
    ollama: 16_000,
    vllm: 16_000,
    litellm: 16_000,
    lmstudio: 16_000,
};

/**
 * Derives a safe input-token budget for working-memory compaction from the resolved
 * model config: the provider's context window minus the model's output-token
 * reservation and a safety margin, floored to a usable minimum. Fed to prepareContext
 * so small/local models aren't over-budgeted by the legacy 60k default.
 */
export function deriveInputTokenBudget(config: ResolvedModelConfig): number {
    const contextWindow = PROVIDER_CONTEXT_WINDOW[config.provider] ?? 16_000;
    const outputReserve = config.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS;
    const SAFETY_MARGIN = 2_000;
    return Math.max(8_000, contextWindow - outputReserve - SAFETY_MARGIN);
}

/**
 * Creates the main and reflector model instances for a given resolved config.
 * Routes to ChatBedrockConverse (AWS) or ChatOpenAI (self-hosted) based on provider.
 */
export function createAgentModels(config: ResolvedModelConfig): AgentModels {
    if (isOpenAICompatibleProvider(config.provider)) {
        // Ollama, LiteLLM, LM Studio, and generic OpenAI-compatible endpoints all
        // speak the same /v1 protocol, so they share this ChatOpenAI path.
        // Self-hosted providers REQUIRE an explicit base URL — without it ChatOpenAI
        // silently routes to api.openai.com, the exact implicit default this SaaS
        // model forbids. Only native "openai" may omit baseUrl (defaults correctly).
        if (config.provider !== "openai" && !config.baseUrl) {
            throw new ProviderConfigError(
                `Provider "${config.provider}" is missing a base URL. Set the endpoint on the provider in Settings → Providers.`,
            );
        }
        const openaiConfig = {
            modelName: config.modelId,
            configuration: {
                baseURL: normalizeOpenAICompatibleBaseUrl(config.provider, config.baseUrl),
                apiKey: config.apiKey || "not-needed",
            },
            // Only send temperature when the model explicitly configures one — newer
            // models reject the parameter outright (see ResolvedModelConfig.temperature).
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        };
        return {
            main: new ChatOpenAI({
                ...openaiConfig,
                maxTokens: config.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
                streaming: true,
            }),
            reflector: new ChatOpenAI({
                ...openaiConfig,
                maxTokens: 4096,
                streaming: false,
            }),
        };
    }

    if (config.provider === "anthropic") {
        // Native Anthropic API (api.anthropic.com or a compatible gateway via baseUrl).
        // ChatAnthropic supports bindTools natively, so the agent graphs work unchanged.
        const anthropicConfig = {
            model: config.modelId,
            apiKey: config.apiKey,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(config.baseUrl ? { anthropicApiUrl: config.baseUrl } : {}),
        };
        const defaultMaxTokens = config.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS;
        return {
            main: new ChatAnthropic({
                ...anthropicConfig,
                maxTokens: defaultMaxTokens,
                streaming: true,
            }),
            reflector: new ChatAnthropic({
                ...anthropicConfig,
                // Full budget, not min(…, 2048): Claude Sonnet 5 emits a reasoning
                // block before its text, and a 2048 cap let reasoning consume the
                // whole budget (stopReason max_tokens) — the reflector returned
                // ZERO text and the reflection loop spun on empty critiques.
                maxTokens: defaultMaxTokens,
                streaming: false,
            }),
        };
    }

    // Default: Bedrock. A record-backed Bedrock provider MUST supply an explicit
    // region + static credentials — there is no implicit host/task-role fallback
    // (SaaS model: only the tenant-configured provider is ever used).
    if (!config.accessKeyId || !config.secretAccessKey || !config.region) {
        throw new ProviderConfigError(
            'Bedrock provider is missing an access key, secret key, or region. Re-configure the provider in Settings → Providers.',
        );
    }
    const bedrockConfig = {
        region: config.region,
        model: config.modelId,
        // Only send temperature when explicitly configured — Bedrock Claude Sonnet 5
        // (and other newer models) reject any temperature with a ValidationException.
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    };
    const defaultMaxTokens = config.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS;
    return {
        main: new ChatBedrockConverse({
            ...bedrockConfig,
            maxTokens: defaultMaxTokens,
            streaming: true,
        }),
        reflector: new ChatBedrockConverse({
            ...bedrockConfig,
            // Full budget, not min(…, 2048) — see the ChatAnthropic reflector note.
            maxTokens: defaultMaxTokens,
            streaming: false,
        }),
    };
}

export interface AssembleToolsOptions {
    /** Include S3 tools (write_file_to_s3, get_file_from_s3). Default: false.
     *  planning-agent uses S3 tools for artifacts/logs/backups, NOT for reports (reports render in-memory). */
    includeS3Tools?: boolean;
    /** Include long-term memory tools (save_memory, search_memory). Enable when DynamoDBStore is active. */
    includeMemoryTools?: boolean;
    /** Include the load_skill progressive-disclosure tool. Default: true. The
     *  console "Auto skills" toggle sets this false to disable dynamic skill loading. */
    includeSkillTool?: boolean;
    /** User ID for scoping memory operations. Required when includeMemoryTools is true. */
    userId?: string;
    /** MCP server IDs to dynamically load tools from. */
    mcpServerIds?: string[];
    /** Tenant ID for MCP config resolution. */
    tenantId?: string;
    /** AWS accounts for injecting STS credentials into credential-sensitive MCP servers. */
    accounts?: AccountContext[];
    /** Knowledge base ids to default-scope the search_knowledge_base tool to. Omit/null to search tenant-wide. */
    knowledgeBaseIds?: string[] | null;
}

/**
 * Creates save_memory and search_memory tools bound to a specific tenantId + userId.
 * Exported for agents that manually assemble their tool lists (e.g. deep-agent).
 */
export function createMemoryTools(tenantId: string, userId: string) {
    return [
        tool(
            async (input: { namespace: string[]; key: string; value: Record<string, unknown> }) => {
                await saveMemory(tenantId, userId, input.namespace, input.key, input.value);
                return `Memory saved: ${input.namespace.join('/')}/${input.key}`;
            },
            {
                name: 'save_memory',
                description: 'Save a fact, preference, or finding to long-term memory for the current user. Use for user preferences, infrastructure facts, and recurring task patterns.',
                schema: z.object({
                    namespace: z.array(z.string()).describe('Namespace path e.g. ["user","preferences"] or ["infra","<account-id>"]'),
                    key: z.string().describe('Unique key within the namespace'),
                    value: z.record(z.string(), z.unknown()).describe('Structured data to store'),
                }),
            }
        ),
        tool(
            async (input: { namespacePrefix: string[]; query: string; limit?: number }) => {
                const results = await searchMemory(tenantId, userId, input.namespacePrefix, input.query, input.limit ?? 5);
                if (!results || (results as unknown[]).length === 0) return 'No memories found.';
                return JSON.stringify(results, null, 2);
            },
            {
                name: 'search_memory',
                description: 'Search long-term memory for the current user using semantic search. Call at the start of a new task to retrieve relevant context from previous sessions.',
                schema: z.object({
                    namespacePrefix: z.array(z.string()).describe('Namespace prefix to search within e.g. ["user"] or ["infra"]'),
                    query: z.string().describe('Natural language query describing what to look for'),
                    limit: z.number().optional().describe('Max results to return (default 5)'),
                }),
            }
        ),
    ];
}

/**
 * Assembles the full tool list: built-in tools + optional S3 tools + MCP tools.
 * Logs MCP tool count when any are loaded.
 */
export async function assembleTools(options: AssembleToolsOptions = {}) {
    const { includeS3Tools = false, includeMemoryTools = false, includeSkillTool = true, userId, mcpServerIds, tenantId, accounts, knowledgeBaseIds } = options;

    const effectiveTenantId = tenantId || 'default';
    if (!tenantId) {
        console.warn('[ModelFactory] assembleTools called without tenantId — falling back to "default". This may return cross-tenant data.');
    }

    const memoryTools = (includeMemoryTools && tenantId && userId) ? createMemoryTools(tenantId, userId) : [];
    const kbTools = tenantId ? [createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined)] : [];
    // Progressive skill disclosure: catalog lives in the system prompt, full
    // content loads on demand via this tool (tenant-scoped, enabled-only).
    const skillTools = includeSkillTool && tenantId ? [createLoadSkillTool(tenantId)] : [];

    const customTools = [
        executeCommandTool,
        readFileTool,
        writeFileTool,
        lsTool,
        editFileTool,
        globTool,
        grepTool,
        createGetAwsCredentialsTool(effectiveTenantId),
        createListAwsAccountsTool(effectiveTenantId),
        createGetRightSizingRecommendationsTool(effectiveTenantId),
        askUserTool,
        ...(includeS3Tools ? [writeFileToS3Tool, getFileFromS3Tool] : []),
        ...memoryTools,
        ...kbTools,
        ...skillTools,
    ];

    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId, accounts);
    if (mcpTools.length > 0) {
        console.log(`[ModelFactory] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }

    return [...customTools, ...mcpTools];
}
