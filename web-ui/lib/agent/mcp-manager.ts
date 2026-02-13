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
import { execFileSync } from 'child_process';
import { MCPServerConfig, DEFAULT_MCP_SERVERS } from './mcp-config';

/**
 * Check if a command binary is available on the system PATH.
 */
function isCommandAvailable(command: string): boolean {
    try {
        execFileSync('which', [command], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Known Docker image → native command mappings.
 * When a user configures an MCP server with `docker run <image>`,
 * and Docker is not available (e.g. ECS Fargate), we automatically
 * substitute the native npx/uvx equivalent.
 */
interface NativeAlternative {
    command: string;
    args: string[];
    /** Env vars to carry over from the docker -e flags */
    envKeys?: string[];
}

const DOCKER_IMAGE_ALTERNATIVES: Record<string, NativeAlternative> = {
    'grafana/mcp-grafana': {
        command: 'npx',
        args: ['-y', '@leval/mcp-grafana'],
        envKeys: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN', 'GRAFANA_TOKEN'],
    },
    'mcp/grafana': {
        command: 'npx',
        args: ['-y', '@leval/mcp-grafana'],
        envKeys: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN', 'GRAFANA_TOKEN'],
    },
};

/**
 * Adapt an MCP server config for the current runtime environment.
 *
 * If the config uses `docker` but Docker is not available, attempts to
 * find a native (npx/uvx) alternative from the known mappings table.
 * This allows user-saved DynamoDB configs with `docker run` to work
 * seamlessly in ECS Fargate where Docker-in-Docker is not available.
 *
 * Returns a new config object (never mutates the original).
 */
function adaptConfigForEnvironment(config: MCPServerConfig): MCPServerConfig {
    // If the command is available, use as-is
    if (isCommandAvailable(config.command)) {
        return config;
    }

    // --- Docker command adaptation ---
    if (config.command === 'docker') {
        // Parse docker args to find the image name
        // Typical: ["run", "--rm", "-i", "-e", "VAR1", "-e", "VAR2", "image/name", "-t", "stdio"]
        const dockerImage = extractDockerImage(config.args);

        if (dockerImage) {
            const alternative = DOCKER_IMAGE_ALTERNATIVES[dockerImage];
            if (alternative) {
                // Extract env vars from docker -e flags
                const envFromDocker = extractDockerEnvVars(config.args);
                const mergedEnv = { ...config.env };
                for (const key of (alternative.envKeys || [])) {
                    if (envFromDocker[key]) {
                        mergedEnv[key] = envFromDocker[key];
                    }
                }

                console.log(`[MCPManager] 🔄 Adapting "${config.name}": docker ${dockerImage} → ${alternative.command} ${alternative.args.join(' ')}`);

                return {
                    ...config,
                    command: alternative.command,
                    args: [...alternative.args],
                    env: mergedEnv,
                };
            }
        }

        console.warn(`[MCPManager] ⚠️ Docker not available and no native alternative found for image "${dockerImage || 'unknown'}"`);
    }

    // --- uvx → npx fallback (if uvx is missing but npx is available) ---
    if (config.command === 'uvx' && !isCommandAvailable('uvx') && isCommandAvailable('npx')) {
        console.log(`[MCPManager] 🔄 Adapting "${config.name}": uvx not found, attempting npx fallback`);
        // Some MCP servers have both pypi and npm packages
        // For known ones, we can map; for unknown, log a warning
        console.warn(`[MCPManager] ⚠️ uvx not available. "${config.name}" may not work with npx. Consider installing uv/uvx.`);
    }

    // Return original config - the pre-flight check in _doConnect will catch if the command is still unavailable
    return config;
}

/**
 * Extract the Docker image name from docker run args.
 * Handles: docker run --rm -i -e VAR1 -e VAR2 image/name [-t stdio]
 */
function extractDockerImage(args: string[]): string | null {
    let i = 0;
    // Skip "run" if present
    if (args[0] === 'run') i = 1;

    while (i < args.length) {
        const arg = args[i];
        // Skip known docker flags
        if (arg === '--rm' || arg === '-i' || arg === '-t' || arg === '--interactive' || arg === '--tty') {
            i++;
            continue;
        }
        // Skip flags that take a value: -e VAR, --env VAR, -v, --volume, --name, etc.
        if (arg === '-e' || arg === '--env' || arg === '-v' || arg === '--volume' ||
            arg === '--name' || arg === '--network' || arg === '-p' || arg === '--publish' ||
            arg === '-w' || arg === '--workdir' || arg === '--entrypoint') {
            i += 2; // skip flag + value
            continue;
        }
        // Skip flags with = (e.g. --env=VAR=VALUE)
        if (arg.startsWith('-')) {
            i++;
            continue;
        }
        // First non-flag argument is the image name
        return arg;
    }
    return null;
}

/**
 * Extract environment variable names from docker -e flags.
 * Handles both `-e VAR` (pass-through) and `-e VAR=value` forms.
 */
function extractDockerEnvVars(args: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '-e' || args[i] === '--env') && i + 1 < args.length) {
            const val = args[i + 1];
            if (val.includes('=')) {
                const [key, ...rest] = val.split('=');
                env[key] = rest.join('=');
            } else {
                // Pass-through: use value from current process.env
                env[val] = process.env[val] || '';
            }
            i++; // skip value
        }
    }
    return env;
}

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
        // Adapt config for the current environment (e.g. docker → npx in ECS)
        const adaptedConfig = adaptConfigForEnvironment(config);

        console.log(`[MCPManager] Connecting to MCP server: "${adaptedConfig.name}" (${adaptedConfig.id})`);
        console.log(`[MCPManager]   Command: ${adaptedConfig.command} ${adaptedConfig.args.join(' ')}`);
        if (adaptedConfig.command !== config.command) {
            console.log(`[MCPManager]   (adapted from: ${config.command} ${config.args.join(' ')})`);
        }

        // Pre-flight check: verify the adapted command binary exists on PATH
        if (!isCommandAvailable(adaptedConfig.command)) {
            const errMsg = `Command "${adaptedConfig.command}" not found on PATH. ` +
                `MCP server "${adaptedConfig.name}" requires "${adaptedConfig.command}" to be installed. ` +
                `Current PATH: ${process.env.PATH || '(not set)'}`;
            console.error(`[MCPManager] ❌ ${errMsg}`);
            throw new Error(errMsg);
        }
        console.log(`[MCPManager] ✓ Command "${adaptedConfig.command}" found on PATH`);

        try {
            const transport = new StdioClientTransport({
                command: adaptedConfig.command,
                args: adaptedConfig.args,
                env: {
                    ...process.env as Record<string, string>,
                    ...(adaptedConfig.env || {}),
                },
            });

            const client = new Client({
                name: 'nucleus-cloud-ops-agent',
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
