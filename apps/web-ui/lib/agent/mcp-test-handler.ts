import { NextResponse } from 'next/server';
import {
    validateMcpConfig,
    jsonToServerConfigs,
    type MCPConfigJson,
    type MCPServerJsonEntry,
} from '@/lib/agent/mcp-config';
import { getMCPManager } from '@/lib/agent/mcp-manager';
import { getSessionTenantId } from '@/lib/auth-session';

/**
 * Shared "Test connection" handler for both MCP settings surfaces.
 * Probes a single server entry (connect → listTools → disconnect). No persistence.
 */
export async function handleMcpTest(req: Request): Promise<NextResponse> {
    try {
        await getSessionTenantId();
    } catch {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await req.json();
        const id: string | undefined = body?.id;
        const entry: MCPServerJsonEntry | undefined = body?.entry;
        if (!id || !entry) {
            return NextResponse.json({ success: false, error: 'Request must include "id" and "entry"' }, { status: 400 });
        }

        const single: MCPConfigJson = { mcpServers: { [id]: entry } };
        const validation = validateMcpConfig(single);
        if (!validation.ok) {
            return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
        }

        const config = jsonToServerConfigs(single)[0];

        if ((config.transport ?? 'stdio') === 'stdio' && config.requiresAwsCredentials) {
            return NextResponse.json({
                success: false,
                error: 'This server injects AWS credentials and can only be verified at run time with an account selected.',
            });
        }

        const manager = getMCPManager();
        const result = await manager.probeConnection(config);
        return NextResponse.json({ success: true, toolCount: result.toolCount, tools: result.tools });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error?.message || 'Connection test failed' });
    }
}
