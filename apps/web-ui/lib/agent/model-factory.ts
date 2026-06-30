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
} from "./tools";
import { createGetRightSizingRecommendationsTool } from "./right-sizing-tool";
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
            temperature: 0,
        };
        return {
            main: new ChatOpenAI({
                ...openaiConfig,
                maxTokens: config.maxTokens || 40000,
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
            temperature: 0,
            ...(config.baseUrl ? { anthropicApiUrl: config.baseUrl } : {}),
        };
        const defaultMaxTokens = config.maxTokens || 4096;
        return {
            main: new ChatAnthropic({
                ...anthropicConfig,
                maxTokens: defaultMaxTokens,
                streaming: true,
            }),
            reflector: new ChatAnthropic({
                ...anthropicConfig,
                maxTokens: Math.min(defaultMaxTokens, 2048),
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
        temperature: 0,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    };
    const defaultMaxTokens = config.maxTokens || 4096;
    return {
        main: new ChatBedrockConverse({
            ...bedrockConfig,
            maxTokens: defaultMaxTokens,
            streaming: true,
        }),
        reflector: new ChatBedrockConverse({
            ...bedrockConfig,
            maxTokens: Math.min(defaultMaxTokens, 2048),
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
    /** User ID for scoping memory operations. Required when includeMemoryTools is true. */
    userId?: string;
    /** MCP server IDs to dynamically load tools from. */
    mcpServerIds?: string[];
    /** Tenant ID for MCP config resolution. */
    tenantId?: string;
    /** AWS accounts for injecting STS credentials into credential-sensitive MCP servers. */
    accounts?: AccountContext[];
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
    const { includeS3Tools = false, includeMemoryTools = false, userId, mcpServerIds, tenantId, accounts } = options;

    const effectiveTenantId = tenantId || 'default';
    if (!tenantId) {
        console.warn('[ModelFactory] assembleTools called without tenantId — falling back to "default". This may return cross-tenant data.');
    }

    const memoryTools = (includeMemoryTools && tenantId && userId) ? createMemoryTools(tenantId, userId) : [];

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
        ...(includeS3Tools ? [writeFileToS3Tool, getFileFromS3Tool] : []),
        ...memoryTools,
    ];

    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId, accounts);
    if (mcpTools.length > 0) {
        console.log(`[ModelFactory] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }

    return [...customTools, ...mcpTools];
}
