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
    maskServerConfigs,
    maskMcpConfigJson,
    restoreMaskedSecrets,
} from '@/lib/agent/mcp-config';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';

// MCP config is part of the AI Ops module (agent integrations).
const CONFIG_KEY = 'mcp-servers';

export async function GET() {
    const authError = await authorize('read', 'McpServer');
    if (authError) return authError;

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

        // Never return stored secrets (bearer tokens/API keys) in plaintext.
        return NextResponse.json({
            servers: maskServerConfigs(servers),
            config: maskMcpConfigJson(editorJson),
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
    const authError = await authorize('update', 'McpServer');
    if (authError) return authError;

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
        const incoming: MCPConfigJson = body.config;

        // Restore any masked secrets from the currently-stored config, so a save
        // that left placeholders in place preserves the existing tokens/keys.
        let stored: MCPConfigJson | null = null;
        try {
            stored = await TenantConfigService.getConfig<MCPConfigJson>(CONFIG_KEY, tenantId);
        } catch (dbError) {
            console.warn('[API /mcp-servers] Stored config read failed during save:', dbError);
        }
        const config = restoreMaskedSecrets(incoming, stored);

        const validation = validateMcpConfig(config);
        if (!validation.ok) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        // Drop this tenant's cached MCP connections so the next run reconnects
        // with the new config/credentials (connections are per-tenant singletons
        // and would otherwise serve stale endpoints/tokens). Safe here because a
        // config save is a deliberate action, not a per-run event.
        try {
            const { getMCPManager } = await import('@/lib/agent/mcp-manager');
            await getMCPManager().disconnectTenantServers(tenantId);
        } catch (e) {
            console.warn('[API /mcp-servers] Failed to reset MCP connections after save:', e);
        }

        // Return the resolved server list (secrets masked)
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
            servers: maskServerConfigs(servers),
            config: maskMcpConfigJson(config),
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
    const authError = await authorize('delete', 'McpServer');
    if (authError) return authError;

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

        // Drop this tenant's cached MCP connections so custom-server sessions are
        // not reused after a reset to defaults.
        try {
            const { getMCPManager } = await import('@/lib/agent/mcp-manager');
            await getMCPManager().disconnectTenantServers(tenantId);
        } catch (e) {
            console.warn('[API /mcp-servers] Failed to reset MCP connections after delete:', e);
        }

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
