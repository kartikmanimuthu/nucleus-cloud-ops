/**
 * MCP Tools Bridge
 * 
 * Converts MCP server tools into LangChain StructuredTool instances
 * that can be used directly with LangGraph ToolNode.
 * 
 * Each MCP tool is namespaced as `mcp_<serverId>_<toolName>` to avoid
 * collisions with custom tools defined in tools.ts.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MCPServerManager, MCPToolInfo } from './mcp-manager';

/**
 * Convert a JSON Schema property type to a Zod schema.
 * Handles the common types exposed by MCP servers.
 */
function jsonSchemaPropertyToZod(prop: any, required: boolean): z.ZodTypeAny {
    let zodType: z.ZodTypeAny;

    switch (prop.type) {
        case 'string':
            if (prop.enum) {
                zodType = z.enum(prop.enum as [string, ...string[]]);
            } else {
                zodType = z.string();
            }
            break;
        case 'number':
        case 'integer':
            zodType = z.number();
            break;
        case 'boolean':
            zodType = z.boolean();
            break;
        case 'array':
            if (prop.items) {
                zodType = z.array(jsonSchemaPropertyToZod(prop.items, true));
            } else {
                zodType = z.array(z.any());
            }
            break;
        case 'object':
            if (prop.properties) {
                zodType = jsonSchemaToZodObject(prop);
            } else {
                zodType = z.record(z.any());
            }
            break;
        default:
            zodType = z.any();
    }

    if (prop.description) {
        zodType = zodType.describe(prop.description);
    }

    if (!required) {
        zodType = zodType.optional();
    }

    return zodType;
}

/**
 * Convert a JSON Schema object to a Zod object schema.
 */
function jsonSchemaToZodObject(schema: any): z.ZodObject<any> {
    const shape: Record<string, z.ZodTypeAny> = {};

    if (!schema.properties) {
        return z.object({});
    }

    const requiredFields: string[] = schema.required || [];

    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
        const isRequired = requiredFields.includes(key);
        shape[key] = jsonSchemaPropertyToZod(prop, isRequired);
    }

    return z.object(shape);
}

/**
 * Format MCP tool result content into a string for LangChain.
 */
function formatMCPResult(result: any): string {
    if (!result || !result.content) {
        return 'No result returned from MCP tool.';
    }

    if (Array.isArray(result.content)) {
        return result.content
            .map((item: any) => {
                if (item.type === 'text') return item.text;
                if (item.type === 'image') return `[Image: ${item.mimeType || 'unknown'}]`;
                if (item.type === 'resource') return `[Resource: ${item.uri || 'unknown'}]`;
                return JSON.stringify(item);
            })
            .join('\n\n');
    }

    if (typeof result.content === 'string') {
        return result.content;
    }

    return JSON.stringify(result.content);
}

/**
 * Create LangChain tools from MCP server tools.
 * 
 * @param mcpManager - The MCPServerManager instance with connected servers
 * @param serverIds - Optional filter to only include tools from specific servers.
 *                    If omitted, includes tools from all connected servers.
 * @returns Array of LangChain StructuredTool instances
 */
export function createMCPTools(
    mcpManager: MCPServerManager,
    serverIds?: string[]
) {
    const mcpTools: MCPToolInfo[] = serverIds
        ? mcpManager.getToolsForServers(serverIds)
        : mcpManager.getAllTools();

    if (mcpTools.length === 0) {
        console.log('[MCPTools] No MCP tools discovered');
        return [];
    }

    console.log(`[MCPTools] Converting ${mcpTools.length} MCP tools to LangChain format`);

    const langchainTools = mcpTools.map(mcpTool => {
        // Namespace the tool name to avoid collisions with custom tools
        const namespacedName = `mcp_${mcpTool.mcpServerId}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');

        // Convert MCP input schema to Zod
        let zodSchema: z.ZodObject<any>;
        try {
            zodSchema = jsonSchemaToZodObject(mcpTool.inputSchema || {});
        } catch (error: any) {
            console.warn(`[MCPTools] Failed to convert schema for ${mcpTool.name}, using permissive schema:`, error.message);
            zodSchema = z.object({}).passthrough();
        }

        // Prefix description with server name for clarity in the LLM prompt
        const description = `[MCP: ${mcpTool.mcpServerName}] ${mcpTool.description || mcpTool.name}`;

        return tool(
            async (input: any) => {
                try {
                    console.log(`[MCPTools] Executing MCP tool: ${mcpTool.name} on server: ${mcpTool.mcpServerId}`);

                    const result = await mcpManager.executeTool(
                        mcpTool.mcpServerId,
                        mcpTool.name,
                        input
                    );

                    const formatted = formatMCPResult(result);
                    console.log(`[MCPTools] MCP tool ${mcpTool.name} completed. Result length: ${formatted.length}`);

                    return formatted;
                } catch (error: any) {
                    const errorMsg = `Error executing MCP tool "${mcpTool.name}": ${error.message}`;
                    console.error(`[MCPTools] ${errorMsg}`);
                    return errorMsg;
                }
            },
            {
                name: namespacedName,
                description,
                schema: zodSchema,
            }
        );
    });

    console.log(`[MCPTools] Created ${langchainTools.length} LangChain tools from MCP servers:`);
    for (const t of langchainTools) {
        console.log(`[MCPTools]   → ${t.name}`);
    }

    return langchainTools;
}

/**
 * Generate a description string of available MCP tools for system prompts.
 */
export function getMCPToolsDescription(mcpManager: MCPServerManager, serverIds?: string[]): string {
    const tools = serverIds
        ? mcpManager.getToolsForServers(serverIds)
        : mcpManager.getAllTools();

    if (tools.length === 0) return '';

    const grouped = new Map<string, MCPToolInfo[]>();
    for (const tool of tools) {
        const existing = grouped.get(tool.mcpServerName) || [];
        existing.push(tool);
        grouped.set(tool.mcpServerName, existing);
    }

    let desc = '\n\nMCP Server Tools (external integrations):\n';
    for (const [serverName, serverTools] of grouped) {
        desc += `  [${serverName}]:\n`;
        for (const t of serverTools) {
            desc += `  - mcp_${t.mcpServerId}_${t.name}: ${(t.description || t.name).slice(0, 100)}\n`;
        }
    }

    return desc;
}
