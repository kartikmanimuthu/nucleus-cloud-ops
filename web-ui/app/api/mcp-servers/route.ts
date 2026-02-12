/**
 * MCP Servers API Route
 * 
 * GET    /api/mcp-servers — Returns merged MCP server configs (defaults + DynamoDB overrides)
 * PUT    /api/mcp-servers — Save full MCP config JSON to DynamoDB
 * DELETE /api/mcp-servers — Reset to defaults by removing DynamoDB record
 */

import { NextResponse } from 'next/server';
import {
    DEFAULT_MCP_SERVERS,
    MCPConfigJson,
    mergeConfigs,
    defaultsToJson,
    jsonToServerConfigs,
} from '@/lib/agent/mcp-config';
import { TenantConfigService } from '@/lib/tenant-config-service';

const CONFIG_KEY = 'mcp-servers';

export async function GET() {
    try {
        // Attempt to load user config from DynamoDB
        let savedJson: MCPConfigJson | null = null;
        try {
            savedJson = await TenantConfigService.getConfig<MCPConfigJson>(CONFIG_KEY);
        } catch (dbError) {
            console.warn('[API /mcp-servers] DynamoDB read failed, using defaults:', dbError);
        }

        // Merge saved config with defaults
        const servers = mergeConfigs(savedJson);

        // Return both the server list and the raw JSON for the editor
        const editorJson = savedJson || defaultsToJson();

        return NextResponse.json({
            servers,
            config: editorJson,
            isCustom: savedJson !== null,
        });
    } catch (error: any) {
        console.error('[API /mcp-servers] Error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch MCP servers' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        const body = await req.json();
        const config: MCPConfigJson = body.config;

        if (!config || !config.mcpServers || typeof config.mcpServers !== 'object') {
            return NextResponse.json(
                { error: 'Invalid config: must contain "mcpServers" object' },
                { status: 400 }
            );
        }

        // Validate each server entry
        for (const [id, entry] of Object.entries(config.mcpServers)) {
            if (!entry.command || !Array.isArray(entry.args)) {
                return NextResponse.json(
                    { error: `Invalid server "${id}": must have "command" (string) and "args" (array)` },
                    { status: 400 }
                );
            }
        }

        // Save to DynamoDB
        await TenantConfigService.saveConfig(CONFIG_KEY, config);

        // Return the resolved server list
        const servers = jsonToServerConfigs(config);

        console.log(`[API /mcp-servers] Saved config with ${Object.keys(config.mcpServers).length} servers`);

        return NextResponse.json({
            success: true,
            servers,
            config,
            isCustom: true,
        });
    } catch (error: any) {
        console.error('[API /mcp-servers] Error saving:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save MCP config' },
            { status: 500 }
        );
    }
}

export async function DELETE() {
    try {
        // Delete custom config, reverting to defaults
        await TenantConfigService.deleteConfig(CONFIG_KEY);

        const servers = DEFAULT_MCP_SERVERS;
        const config = defaultsToJson();

        console.log('[API /mcp-servers] Reset to defaults');

        return NextResponse.json({
            success: true,
            servers,
            config,
            isCustom: false,
        });
    } catch (error: any) {
        console.error('[API /mcp-servers] Error resetting:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to reset MCP config' },
            { status: 500 }
        );
    }
}
