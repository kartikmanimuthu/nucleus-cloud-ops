/**
 * MCP Servers API Route
 * 
 * GET    /api/mcp-servers — Returns merged MCP server configs (defaults + DynamoDB overrides)
 * PUT    /api/mcp-servers — Save full MCP config JSON to DynamoDB
 * DELETE /api/mcp-servers — Reset to defaults by removing DynamoDB record
 */

import { NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import {
    DEFAULT_MCP_SERVERS,
    MCPConfigJson,
    mergeConfigs,
    defaultsToJson,
    jsonToServerConfigs,
    validateMcpConfig,
} from '@/lib/agent/mcp-config';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';

const CONFIG_KEY = 'mcp-servers';

export async function GET() {
    let tenantId: string;
    try {
        tenantId = await getSessionTenantId();
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // Attempt to load user config from storage
        let savedJson: MCPConfigJson | null = null;
        try {
            savedJson = await TenantConfigService.getConfig<MCPConfigJson>(CONFIG_KEY, tenantId);
        } catch (dbError) {
            console.warn('[API /mcp-servers] Config read failed, using defaults:', dbError);
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
    let tenantId: string;
    let userId: string;
    try {
        tenantId = await getSessionTenantId();
        userId = await getSessionUserId();
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await req.json();
        const config: MCPConfigJson = body.config;

        const validation = validateMcpConfig(config);
        if (!validation.ok) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        // Return the resolved server list
        const servers = jsonToServerConfigs(config);

        console.log(`[API /mcp-servers] Saved config with ${Object.keys(config.mcpServers).length} servers`);

        // Audit: log MCP config update
        AuditService.logUserAction({
            eventType: 'integration.mcp.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/mcp-servers',
            httpMethod: 'PUT',
            action: 'integration.mcp.updated',
            resourceType: 'integration',
            resourceId: 'mcp-servers',
            resourceName: 'MCP Server Configuration',
            user: userId,
            userType: 'user',
            status: 'success',
            details: `Updated MCP config with ${Object.keys(config.mcpServers).length} servers`,
            metadata: { tenantId, serverCount: Object.keys(config.mcpServers).length },
        }).catch(() => {});

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
    let tenantId: string;
    let userId: string;
    try {
        tenantId = await getSessionTenantId();
        userId = await getSessionUserId();
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        await TenantConfigService.deleteConfig(CONFIG_KEY, tenantId);

        const servers = DEFAULT_MCP_SERVERS;
        const config = defaultsToJson();

        console.log('[API /mcp-servers] Reset to defaults');

        // Audit: log MCP config reset
        AuditService.logUserAction({
            eventType: 'integration.mcp.reset',
            severity: 'medium',
            apiRoute: 'DELETE /api/mcp-servers',
            httpMethod: 'DELETE',
            action: 'integration.mcp.reset',
            resourceType: 'integration',
            resourceId: 'mcp-servers',
            resourceName: 'MCP Server Configuration',
            user: userId,
            userType: 'user',
            status: 'success',
            details: 'Reset MCP server configuration to defaults',
            metadata: { tenantId },
        }).catch(() => {});

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
