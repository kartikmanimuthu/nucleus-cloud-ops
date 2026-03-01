/**
 * model-factory.ts
 *
 * Single source of truth for model initialization and tool assembly.
 * Both planning-agent and fast-agent import from here — no more per-file duplication.
 */

import { ChatBedrockConverse } from "@langchain/aws";
import {
    executeCommandTool,
    readFileTool,
    writeFileTool,
    lsTool,
    editFileTool,
    globTool,
    grepTool,
    getAwsCredentialsTool,
    listAwsAccountsTool,
    writeFileToS3Tool,
    getFileFromS3Tool,
} from "./tools";
import { getActiveMCPTools } from "./agent-shared";

export interface AgentModels {
    /** Primary model: streaming, 4096 max tokens. Used for all generation nodes. */
    main: ChatBedrockConverse;
    /** Reflector model: non-streaming, 1024 max tokens. Emits small JSON critiques only. */
    reflector: ChatBedrockConverse;
}

/**
 * Creates the main and reflector model instances for a given model ID.
 * Reads region from environment — consistent across all agent types.
 */
export function createAgentModels(modelId: string): AgentModels {
    const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null';
    return {
        main: new ChatBedrockConverse({
            region,
            model: modelId,
            maxTokens: 4096,
            temperature: 0,
            streaming: true,
        }),
        reflector: new ChatBedrockConverse({
            region,
            model: modelId,
            maxTokens: 1024,
            temperature: 0,
            streaming: false, // Reflector emits small JSON only — no streaming needed
        }),
    };
}

export interface AssembleToolsOptions {
    /** Include S3 tools (write_file_to_s3, get_file_from_s3). Default: false.
     *  planning-agent uses S3 tools for report generation; fast-agent does not. */
    includeS3Tools?: boolean;
    /** MCP server IDs to dynamically load tools from. */
    mcpServerIds?: string[];
    /** Tenant ID for MCP config resolution. */
    tenantId?: string;
}

/**
 * Assembles the full tool list: built-in tools + optional S3 tools + MCP tools.
 * Logs MCP tool count when any are loaded.
 */
export async function assembleTools(options: AssembleToolsOptions = {}) {
    const { includeS3Tools = false, mcpServerIds, tenantId } = options;

    const customTools = [
        executeCommandTool,
        readFileTool,
        writeFileTool,
        lsTool,
        editFileTool,
        globTool,
        grepTool,
        getAwsCredentialsTool,
        listAwsAccountsTool,
        ...(includeS3Tools ? [writeFileToS3Tool, getFileFromS3Tool] : []),
    ];

    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId);
    if (mcpTools.length > 0) {
        console.log(`[ModelFactory] Loaded ${mcpTools.length} MCP tools from servers: ${mcpServerIds?.join(', ')}`);
    }

    return [...customTools, ...mcpTools];
}
