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
import { MCPServerManager, MCPToolInfo, TENANT_SEP } from './mcp-manager';
import { AuditService } from '@/lib/audit-service';

/**
 * Strip the tenant prefix (`<tenantId>##`) from a connection key, leaving the
 * logical server id — either `<serverId>` or `<serverId>::<accountId>`.
 * Tool names/descriptions are derived from the logical id so they stay stable
 * and human-readable regardless of the tenant the run belongs to.
 */
function logicalServerId(mcpServerId: string): string {
    const idx = mcpServerId.indexOf(TENANT_SEP);
    return idx >= 0 ? mcpServerId.slice(idx + TENANT_SEP.length) : mcpServerId;
}

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
                zodType = z.record(z.string(), z.any());
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
 * Coerce tool input values to match the expected MCP schema types.
 *
 * LLMs frequently send arrays where the MCP server expects a plain string
 * (e.g. `metrics: ["UnblendedCost"]` instead of `metrics: "UnblendedCost"`,
 * or `group_by: [{"Type":"DIMENSION","Key":"SERVICE"}]` instead of a JSON string).
 * This burns iteration cycles as the agent retries with the same wrong types.
 *
 * We walk the schema and coerce mismatched values at the boundary so the MCP
 * server receives valid input on the first call.
 */
function coerceInputToSchema(input: Record<string, any>, schema: any): Record<string, any> {
    if (!schema?.properties) return input;

    const coerced: Record<string, any> = { ...input };

    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
        if (!(key in coerced)) continue;
        const value = coerced[key];

        if (prop.type === 'string' && typeof value !== 'string') {
            if (Array.isArray(value)) {
                if (value.length === 1 && typeof value[0] === 'string') {
                    coerced[key] = value[0];
                } else {
                    coerced[key] = JSON.stringify(value);
                }
                console.warn(`[MCPTools] Coerced "${key}" from array to string: ${coerced[key]}`);
            } else if (typeof value === 'object' && value !== null) {
                coerced[key] = JSON.stringify(value);
                console.warn(`[MCPTools] Coerced "${key}" from object to string: ${coerced[key]}`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                coerced[key] = String(value);
            }
        } else if ((prop.type === 'number' || prop.type === 'integer') && typeof value === 'string') {
            const parsed = Number(value);
            if (!isNaN(parsed)) {
                coerced[key] = parsed;
            }
        } else if (prop.type === 'boolean' && typeof value === 'string') {
            coerced[key] = value === 'true';
        } else if (prop.type === 'array' && typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) coerced[key] = parsed;
            } catch { /* leave as-is */ }
        } else if (prop.type === 'object' && typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (typeof parsed === 'object' && parsed !== null) coerced[key] = parsed;
            } catch { /* leave as-is */ }
        }
    }

    return coerced;
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
        // Derive the tool name from the tenant-stripped logical id.
        // For account-scoped servers (logicalId contains ::accountId), include last 4
        // digits of the account ID in the tool name so the LLM can target specific
        // accounts. Bedrock enforces a 64-char tool name limit — truncate if needed.
        const logicalId = logicalServerId(mcpTool.mcpServerId);
        let namespacedName: string;
        if (logicalId.includes('::')) {
            const [baseServerId, accountId] = logicalId.split('::');
            const accountSuffix = accountId.slice(-4);
            const raw = `mcp_${baseServerId}_${accountSuffix}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
            namespacedName = raw.slice(0, 64);
        } else {
            namespacedName = `mcp_${logicalId}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        }

        // Convert MCP input schema to Zod
        let zodSchema: z.ZodObject<any>;
        try {
            zodSchema = jsonSchemaToZodObject(mcpTool.inputSchema || {});
        } catch (error: any) {
            console.warn(`[MCPTools] Failed to convert schema for ${mcpTool.name}, using permissive schema:`, error.message);
            zodSchema = z.object({}).passthrough();
        }

        // Prefix description with server name + account context for clarity in the LLM prompt
        const accountId = logicalId.includes('::') ? logicalId.split('::')[1] : undefined;
        const description = accountId
            ? `[MCP: ${mcpTool.mcpServerName} | Account: ${accountId}] ${mcpTool.description || mcpTool.name}`
            : `[MCP: ${mcpTool.mcpServerName}] ${mcpTool.description || mcpTool.name}`;

        return tool(
            async (input: any, config?: any) => {
                // Tenant/user context arrives via the LangGraph RunnableConfig
                // ({ configurable: { tenant_id, user_id } }) set by the chat/agent-ops routes.
                const configurable = config?.configurable ?? {};
                const auditTenantId = (configurable.tenant_id as string | undefined) ?? undefined;
                const auditUserId = (configurable.user_id as string | undefined) ?? undefined;

                const audit = (status: 'success' | 'error') => {
                    // MCP tools call out to customer AWS/integrations — audit every invocation.
                    // Fire-and-forget: never block or fail tool execution on audit write.
                    AuditService.logResourceAction({
                        eventType: 'agent.tool.mcp',
                        action: 'mcp_tool_call',
                        resourceType: 'mcp_tool',
                        resourceId: namespacedName,
                        resourceName: `${mcpTool.mcpServerName} / ${mcpTool.name}`,
                        status,
                        details: `Agent invoked MCP tool "${mcpTool.name}" on server "${mcpTool.mcpServerName}"${accountId ? ` (account ${accountId})` : ''}`,
                        user: auditUserId || 'agent',
                        userType: auditUserId ? 'user' : 'system',
                        source: 'agent',
                        severity: 'medium',
                        ...(auditTenantId ? { tenantId: auditTenantId } : {}),
                        ...(accountId ? { accountId } : {}),
                        metadata: { tenantId: auditTenantId, mcpServer: mcpTool.mcpServerName, tool: mcpTool.name, accountId },
                    }).catch(() => {});
                };

                try {
                    const coercedInput = coerceInputToSchema(input, mcpTool.inputSchema);
                    console.log(`[MCPTools] Executing MCP tool: ${mcpTool.name} on server: ${mcpTool.mcpServerId}`);

                    const result = await mcpManager.executeTool(
                        mcpTool.mcpServerId,
                        mcpTool.name,
                        coercedInput
                    );

                    const formatted = formatMCPResult(result);
                    console.log(`[MCPTools] MCP tool ${mcpTool.name} completed. Result length: ${formatted.length}`);

                    audit('success');
                    return formatted;
                } catch (error: any) {
                    const errorMsg = `Error executing MCP tool "${mcpTool.name}": ${error.message}`;
                    console.error(`[MCPTools] ${errorMsg}`);
                    audit('error');
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
            desc += `  - mcp_${logicalServerId(t.mcpServerId)}_${t.name}: ${(t.description || t.name).slice(0, 100)}\n`;
        }
    }

    return desc;
}
