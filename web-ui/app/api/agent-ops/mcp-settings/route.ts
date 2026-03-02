/**
 * AgentOps MCP Settings API Route
 *
 * GET    /api/agent-ops/mcp-settings — Returns AgentOps-specific MCP config
 * PUT    /api/agent-ops/mcp-settings — Save AgentOps MCP config to DynamoDB
 * DELETE /api/agent-ops/mcp-settings — Reset to defaults
 *
 * Uses a separate config key ('agent-ops-mcp-servers') so AgentOps MCP servers
 * are independent from the main AI Ops MCP config ('mcp-servers').
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

const CONFIG_KEY = 'agent-ops-mcp-servers';

export async function GET() {
    try {
        let savedJson: MCPConfigJson | null = null;
        try {
            savedJson = await TenantConfigService.getConfig<MCPConfigJson>(CONFIG_KEY);
        } catch (dbError) {
            console.warn('[API /agent-ops/mcp-settings] DynamoDB read failed, using defaults:', dbError);
        }

        const servers = mergeConfigs(savedJson);
        const editorJson = savedJson || defaultsToJson();

        return NextResponse.json({
            servers,
            config: editorJson,
            isCustom: savedJson !== null,
        });
    } catch (error: any) {
        console.error('[API /agent-ops/mcp-settings] Error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch AgentOps MCP servers' },
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

        for (const [id, entry] of Object.entries(config.mcpServers)) {
            if (!entry.command || !Array.isArray(entry.args)) {
                return NextResponse.json(
                    { error: `Invalid server "${id}": must have "command" (string) and "args" (array)` },
                    { status: 400 }
                );
            }
        }

        await TenantConfigService.saveConfig(CONFIG_KEY, config);
        const servers = jsonToServerConfigs(config);

        console.log(`[API /agent-ops/mcp-settings] Saved config with ${Object.keys(config.mcpServers).length} servers`);

        return NextResponse.json({
            success: true,
            servers,
            config,
            isCustom: true,
        });
    } catch (error: any) {
        console.error('[API /agent-ops/mcp-settings] Error saving:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save AgentOps MCP config' },
            { status: 500 }
        );
    }
}

export async function DELETE() {
    try {
        await TenantConfigService.deleteConfig(CONFIG_KEY);

        const servers = DEFAULT_MCP_SERVERS;
        const config = defaultsToJson();

        console.log('[API /agent-ops/mcp-settings] Reset to defaults');

        return NextResponse.json({
            success: true,
            servers,
            config,
            isCustom: false,
        });
    } catch (error: any) {
        console.error('[API /agent-ops/mcp-settings] Error resetting:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to reset AgentOps MCP config' },
            { status: 500 }
        );
    }
}
