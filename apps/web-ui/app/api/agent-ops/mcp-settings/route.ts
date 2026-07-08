/**
 * AgentOps MCP Settings API Route
 *
 * GET    /api/agent-ops/mcp-settings — Returns AgentOps-specific MCP config
 * PUT    /api/agent-ops/mcp-settings — Save AgentOps MCP config to tenant-scoped config store
 * DELETE /api/agent-ops/mcp-settings — Reset to defaults
 *
 * Shares the SAME tenant-config key ('mcp-servers') as the main AI Ops MCP
 * config, so AI Ops and Agent Ops manage one unified server set. The Agent Ops
 * executor already reads 'mcp-servers' at run time (see agent-executor.ts), so
 * a separate 'agent-ops-mcp-servers' store was never consumed by runs — anything
 * saved there had no effect. This route is kept as a thin alias for the existing
 * Agent Ops / Channels settings pages that call it.
 */

import { NextResponse } from 'next/server';
import {
    DEFAULT_MCP_SERVERS,
    MCPConfigJson,
    mergeConfigs,
    defaultsToJson,
    jsonToServerConfigs,
    validateMcpConfig,
} from '@/lib/agent/mcp-config';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';

// Unified with the main AI Ops MCP config store. This is the key the Agent Ops
// executor reads at run time, so both settings surfaces now edit the same servers.
const CONFIG_KEY = 'mcp-servers';

export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        let savedJson: MCPConfigJson | null = null;
        try {
            savedJson = await TenantConfigService.getConfig<MCPConfigJson>(CONFIG_KEY, tenantId);
        } catch (dbError) {
            console.warn('[API /agent-ops/mcp-settings] Config read failed, using defaults:', dbError);
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
        const tenantId = await getSessionTenantId();
        const body = await req.json();
        const config: MCPConfigJson = body.config;

        const validation = validateMcpConfig(config);
        if (!validation.ok) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);
        const servers = jsonToServerConfigs(config);

        console.log(`[API /agent-ops/mcp-settings] Saved config with ${Object.keys(config.mcpServers).length} servers`);

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.mcp_updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/mcp-settings',
            httpMethod: 'PUT',
            action: 'Updated MCP Settings',
            resourceType: 'agent',
            resourceId: 'mcp-settings',
            resourceName: 'MCP Settings',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Updated MCP settings with ${Object.keys(config.mcpServers).length} servers`,
            metadata: { tenantId },
        }).catch(() => {});

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
        const tenantId = await getSessionTenantId();
        await TenantConfigService.deleteConfig(CONFIG_KEY, tenantId);

        const servers = DEFAULT_MCP_SERVERS;
        const config = defaultsToJson();

        console.log('[API /agent-ops/mcp-settings] Reset to defaults');

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.mcp_reset',
            severity: 'medium',
            apiRoute: 'DELETE /api/agent-ops/mcp-settings',
            httpMethod: 'DELETE',
            action: 'Reset MCP Settings',
            resourceType: 'agent',
            resourceId: 'mcp-settings',
            resourceName: 'MCP Settings',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Reset MCP settings to defaults',
            metadata: { tenantId },
        }).catch(() => {});

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
