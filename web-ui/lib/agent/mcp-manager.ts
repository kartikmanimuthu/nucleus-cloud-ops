/**
 * MCP Server Manager
 * 
 * Central lifecycle manager for MCP (Model Context Protocol) server processes.
 * Handles spawning server subprocesses, connecting via StdioClientTransport,
 * discovering tools, and proxying tool execution calls.
 * 
 * Uses globalThis singleton pattern to survive Next.js hot reloads (same as the checkpointer).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCPServerConfig, DEFAULT_MCP_SERVERS } from './mcp-config';

export interface MCPToolInfo {
    mcpServerId: string;
    mcpServerName: string;
    name: string;
    description?: string;
    inputSchema: any;
}

export class MCPServerManager {
    private clients: Map<string, Client> = new Map();
    private transports: Map<string, StdioClientTransport> = new Map();
    private toolCache: Map<string, MCPToolInfo[]> = new Map();
    private connecting: Map<string, Promise<void>> = new Map();

    /**
     * Connect to a specific MCP server by config.
     * Returns immediately if already connected.
     * Uses a connecting lock to prevent duplicate connections.
     */
    async connectServer(config: MCPServerConfig): Promise<void> {
        if (this.clients.has(config.id)) {
            console.log(`[MCPManager] Server "${config.name}" (${config.id}) already connected`);
            return;
        }

        // Prevent duplicate concurrent connections
        if (this.connecting.has(config.id)) {
            console.log(`[MCPManager] Server "${config.name}" (${config.id}) connection in progress, waiting...`);
            await this.connecting.get(config.id);
            return;
        }

        const connectPromise = this._doConnect(config);
        this.connecting.set(config.id, connectPromise);

        try {
            await connectPromise;
        } finally {
            this.connecting.delete(config.id);
        }
    }

    private async _doConnect(config: MCPServerConfig): Promise<void> {
        console.log(`[MCPManager] Connecting to MCP server: "${config.name}" (${config.id})`);
        console.log(`[MCPManager]   Command: ${config.command} ${config.args.join(' ')}`);

        try {
            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: {
                    ...process.env as Record<string, string>,
                    ...(config.env || {}),
                },
            });

            const client = new Client({
                name: 'nucleus-platform-agent',
                version: '1.0.0',
            });

            await client.connect(transport);

            this.clients.set(config.id, client);
            this.transports.set(config.id, transport);

            // Pre-cache tools on connection
            await this._cacheTools(config.id, config.name);

            console.log(`[MCPManager] ✅ Connected to "${config.name}" (${config.id})`);
        } catch (error: any) {
            console.error(`[MCPManager] ❌ Failed to connect to "${config.name}" (${config.id}):`, error.message);
            // Clean up partial state
            this.clients.delete(config.id);
            this.transports.delete(config.id);
            this.toolCache.delete(config.id);
            throw error;
        }
    }

    /**
     * Cache tool schemas from a connected server
     */
    private async _cacheTools(serverId: string, serverName: string): Promise<void> {
        const client = this.clients.get(serverId);
        if (!client) return;

        try {
            const result = await client.listTools();
            const tools: MCPToolInfo[] = result.tools.map(tool => ({
                mcpServerId: serverId,
                mcpServerName: serverName,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            }));

            this.toolCache.set(serverId, tools);
            console.log(`[MCPManager] Cached ${tools.length} tools from "${serverName}" (${serverId}):`);
            for (const t of tools) {
                console.log(`[MCPManager]   → ${t.name}: ${(t.description || '').slice(0, 80)}`);
            }
        } catch (error: any) {
            console.error(`[MCPManager] Error caching tools from ${serverId}:`, error.message);
            this.toolCache.set(serverId, []);
        }
    }

    /**
     * Connect to multiple MCP servers by their IDs.
     * If allConfigs is provided (from DynamoDB), uses those; otherwise falls back to DEFAULT_MCP_SERVERS.
     */
    async connectServers(serverIds: string[], allConfigs?: MCPServerConfig[]): Promise<void> {
        const source = allConfigs || DEFAULT_MCP_SERVERS;
        const configs = source.filter(s => serverIds.includes(s.id));

        const results = await Promise.allSettled(
            configs.map(config => this.connectServer(config))
        );

        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'rejected') {
                console.error(`[MCPManager] Failed to connect "${configs[i].name}":`, (results[i] as PromiseRejectedResult).reason);
            }
        }
    }

    /**
     * Get all tools from all connected servers (uses cache)
     */
    getAllTools(): MCPToolInfo[] {
        const allTools: MCPToolInfo[] = [];
        for (const tools of this.toolCache.values()) {
            allTools.push(...tools);
        }
        return allTools;
    }

    /**
     * Get tools from specific connected servers
     */
    getToolsForServers(serverIds: string[]): MCPToolInfo[] {
        const tools: MCPToolInfo[] = [];
        for (const id of serverIds) {
            const serverTools = this.toolCache.get(id);
            if (serverTools) {
                tools.push(...serverTools);
            }
        }
        return tools;
    }

    /**
     * Execute a tool on a specific MCP server
     */
    async executeTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<any> {
        const client = this.clients.get(serverId);
        if (!client) {
            throw new Error(`MCP server "${serverId}" is not connected. Cannot execute tool "${toolName}".`);
        }

        console.log(`[MCPManager] Executing tool: ${toolName} on server: ${serverId}`);

        try {
            const result = await client.callTool({
                name: toolName,
                arguments: args,
            });
            return result;
        } catch (error: any) {
            console.error(`[MCPManager] Tool execution error (${serverId}/${toolName}):`, error.message);
            throw error;
        }
    }

    /**
     * Check if a specific server is connected
     */
    isConnected(serverId: string): boolean {
        return this.clients.has(serverId);
    }

    /**
     * Get list of connected server IDs
     */
    getConnectedServerIds(): string[] {
        return Array.from(this.clients.keys());
    }

    /**
     * Disconnect a specific server
     */
    async disconnectServer(serverId: string): Promise<void> {
        const client = this.clients.get(serverId);
        const transport = this.transports.get(serverId);

        if (client) {
            try {
                await client.close();
            } catch (error: any) {
                console.warn(`[MCPManager] Error closing client for ${serverId}:`, error.message);
            }
            this.clients.delete(serverId);
        }

        if (transport) {
            try {
                await transport.close();
            } catch (error: any) {
                console.warn(`[MCPManager] Error closing transport for ${serverId}:`, error.message);
            }
            this.transports.delete(serverId);
        }

        this.toolCache.delete(serverId);
        console.log(`[MCPManager] Disconnected server: ${serverId}`);
    }

    /**
     * Disconnect all servers (cleanup)
     */
    async disconnectAll(): Promise<void> {
        console.log(`[MCPManager] Disconnecting all servers...`);
        const serverIds = Array.from(this.clients.keys());

        await Promise.allSettled(
            serverIds.map(id => this.disconnectServer(id))
        );

        console.log(`[MCPManager] All servers disconnected`);
    }
}

// --- Global Singleton ---
// Survives Next.js hot reloads in dev mode (same pattern as checkpointer in agent-shared.ts)
const globalForMCP = globalThis as unknown as { mcpManager: MCPServerManager };

export function getMCPManager(): MCPServerManager {
    if (!globalForMCP.mcpManager) {
        globalForMCP.mcpManager = new MCPServerManager();
        console.log('[MCPManager] Created new global MCPServerManager instance');
    }
    return globalForMCP.mcpManager;
}
