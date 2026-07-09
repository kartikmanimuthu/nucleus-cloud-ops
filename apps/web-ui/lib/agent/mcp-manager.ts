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
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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

/**
 * Build the stdio subprocess environment.
 *
 * A tenant-authored MCP server command runs as a child process. Spreading the
 * full parent `process.env` would hand it every application secret (DATABASE_URL,
 * NEXTAUTH_SECRET, COGNITO_*, provider API keys, LANGFUSE_*, …). We instead pass
 * an explicit allowlist plus the server-specific `config.env` (which is where the
 * server's own credentials, e.g. GRAFANA_TOKEN, are intentionally provided).
 */
function buildStdioEnv(configEnv?: Record<string, string>): Record<string, string> {
    const ALLOWED_KEYS = [
        'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR',
        'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_STS_REGIONAL_ENDPOINTS', 'AWS_CA_BUNDLE',
        // uv/uvx + node runtime knobs the MCP server processes rely on.
        'NODE_EXTRA_CA_CERTS', 'UV_CACHE_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'NPM_CONFIG_CACHE',
    ];
    const env: Record<string, string> = {};
    for (const key of ALLOWED_KEYS) {
        const val = process.env[key];
        if (val !== undefined) env[key] = val;
    }
    // Server-specific env wins (credentials, log level, and any AWS_PROFILE /
    // AWS_SHARED_CREDENTIALS_FILE injected for credential-scoped servers).
    return { ...env, ...(configEnv || {}) };
}

/**
 * Build the MCP client transport for a server config.
 * Pure + side-effect free (constructs the transport object) — unit tested.
 */
export function buildTransport(config: MCPServerConfig): Transport {
    const transport = config.transport ?? 'stdio';

    if (transport === 'sse' || transport === 'http') {
        if (!config.url) {
            throw new Error(`MCP server "${config.name}" (${config.id}) uses ${transport} transport but has no "url"`);
        }
        const url = new URL(config.url);
        const headers = config.headers || {};
        const opts = Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined;
        return transport === 'sse'
            ? new SSEClientTransport(url, opts)
            : new StreamableHTTPClientTransport(url, opts);
    }

    return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildStdioEnv(config.env),
    });
}

export interface MCPToolInfo {
    mcpServerId: string;
    mcpServerName: string;
    name: string;
    description?: string;
    inputSchema: any;
}

/**
 * Separator between the tenant prefix and the logical server id in a connection
 * cache key. Distinct from the account separator ('::') so tool-name derivation
 * in mcp-tools.ts can strip the tenant prefix without disturbing account scoping.
 *
 * Key shapes:
 *   regular         → `<tenantId>##<serverId>`
 *   account-scoped  → `<tenantId>##<serverId>::<accountId>`
 */
export const TENANT_SEP = '##';

/** Build the tenant-scoped connection cache key for a (regular) server. */
export function tenantScopedKey(tenantId: string, serverId: string): string {
    return `${tenantId || 'default'}${TENANT_SEP}${serverId}`;
}

export class MCPServerManager {
    private clients: Map<string, Client> = new Map();
    private transports: Map<string, Transport> = new Map();
    private toolCache: Map<string, MCPToolInfo[]> = new Map();
    private connecting: Map<string, Promise<void>> = new Map();
    private probeCounter = 0;

    /**
     * Connect to a specific MCP server by config, isolated per tenant.
     * Returns immediately if this tenant already has the server connected.
     * Uses a connecting lock to prevent duplicate connections.
     *
     * The connection is cached under a tenant-scoped key so one tenant can never
     * reuse another tenant's live subprocess/session (e.g. two tenants both
     * defining a server id "grafana" get separate connections + tokens).
     */
    async connectServer(config: MCPServerConfig, tenantId: string = 'default'): Promise<void> {
        const key = tenantScopedKey(tenantId, config.id);

        if (this.clients.has(key)) {
            console.log(`[MCPManager] Server "${config.name}" (${key}) already connected`);
            return;
        }

        // Prevent duplicate concurrent connections
        if (this.connecting.has(key)) {
            console.log(`[MCPManager] Server "${config.name}" (${key}) connection in progress, waiting...`);
            await this.connecting.get(key);
            return;
        }

        // _doConnect stores under the config's `id`; give it the tenant-scoped key.
        const connectPromise = this._doConnect({ ...config, id: key });
        this.connecting.set(key, connectPromise);

        try {
            await connectPromise;
        } finally {
            this.connecting.delete(key);
        }
    }

    private async _doConnect(config: MCPServerConfig): Promise<void> {
        const transportType = config.transport ?? 'stdio';
        let effectiveConfig = config;

        if (transportType === 'stdio') {
            // Adapt config for the current environment (e.g. docker → npx in ECS)
            effectiveConfig = adaptConfigForEnvironment(config);
            console.log(`[MCPManager] Connecting to stdio MCP server: "${effectiveConfig.name}" (${effectiveConfig.id})`);
            console.log(`[MCPManager]   Command: ${effectiveConfig.command} ${effectiveConfig.args.join(' ')}`);
            if (effectiveConfig.command !== config.command) {
                console.log(`[MCPManager]   (adapted from: ${config.command} ${config.args.join(' ')})`);
            }
            if (!isCommandAvailable(effectiveConfig.command)) {
                const errMsg = `Command "${effectiveConfig.command}" not found on PATH. ` +
                    `MCP server "${effectiveConfig.name}" requires "${effectiveConfig.command}" to be installed. ` +
                    `Current PATH: ${process.env.PATH || '(not set)'}`;
                console.error(`[MCPManager] ❌ ${errMsg}`);
                throw new Error(errMsg);
            }
            console.log(`[MCPManager] ✓ Command "${effectiveConfig.command}" found on PATH`);
        } else {
            console.log(`[MCPManager] Connecting to ${transportType} MCP server: "${config.name}" (${config.id}) at ${config.url}`);
        }

        try {
            const transport = buildTransport(effectiveConfig);

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
     * Connect to an MCP server with AWS credentials injected as environment variables.
     * Uses an account-scoped instance key (`${serverId}::${accountId}`) so each account
     * gets its own subprocess with its own credentials.
     *
     * Returns the scoped instance ID that can be used to retrieve tools.
     */
    async connectServerWithAwsCredentials(
        config: MCPServerConfig,
        accountId: string,
        credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; region: string },
        tenantId: string = 'default'
    ): Promise<string> {
        // Remote transports never use AWS credential injection — connect normally.
        if ((config.transport ?? 'stdio') !== 'stdio') {
            await this.connectServer(config, tenantId);
            return tenantScopedKey(tenantId, config.id);
        }

        // Tenant-scoped + account-scoped key: `<tenantId>##<serverId>::<accountId>`.
        const scopedId = `${tenantScopedKey(tenantId, config.id)}::${accountId}`;

        if (this.clients.has(scopedId)) {
            console.log(`[MCPManager] Account-scoped server "${config.name}" for account ${accountId} already connected`);
            return scopedId;
        }

        // Write STS credentials to a named profile in this tenant's ISOLATED
        // credentials file so boto3 uses the correct account credentials regardless
        // of the parent process's AWS_PROFILE. The file lives outside the agent
        // file-tool jail and is per-tenant, so no cross-tenant credential leak.
        const { createSessionProfile } = await import('./session-manager');
        const sessionProfile = await createSessionProfile(accountId, credentials, tenantId);
        console.log(`[MCPManager] Created session profile "${sessionProfile.profileName}" for account-scoped MCP server`);

        // Build subprocess env: server-specific vars, then force AWS_PROFILE to our
        // named profile and point AWS_SHARED_CREDENTIALS_FILE at the tenant file so
        // the subprocess resolves the profile from there (not the shared ~/.aws file).
        const scopedConfig: MCPServerConfig = {
            ...config,
            id: scopedId,
            env: {
                ...(config.env || {}),
                AWS_PROFILE: sessionProfile.profileName,
                AWS_DEFAULT_PROFILE: sessionProfile.profileName,
                AWS_SHARED_CREDENTIALS_FILE: sessionProfile.credentialsFile,
                AWS_DEFAULT_REGION: credentials.region,
            },
        };

        console.log(`[MCPManager] Connecting account-scoped server "${config.name}" for account ${accountId} (id: ${scopedId}) using profile ${sessionProfile.profileName}`);
        await this._doConnect(scopedConfig);
        return scopedId;
    }

    /**
     * Connect a throwaway instance, list its tools, then disconnect.
     * Used by the "Test connection" endpoint — never persists state.
     */
    async probeConnection(config: MCPServerConfig): Promise<{ toolCount: number; tools: string[] }> {
        const ephemeralId = `__probe__:${config.id}:${Date.now()}:${++this.probeCounter}`;
        try {
            await this._doConnect({ ...config, id: ephemeralId });

            const client = this.clients.get(ephemeralId);
            if (!client) {
                throw new Error('Connection could not be established.');
            }

            // Strict tool discovery for the health probe. We deliberately do NOT
            // read from the tool cache populated by _doConnect → _cacheTools,
            // because _cacheTools swallows listTools() errors (it stores an empty
            // list on failure). That leniency is correct for a live run — one
            // flaky listTools shouldn't tear down an enabled server — but it makes
            // a "Test connection" probe report success for a broken server.
            // Here we call listTools() directly so its error propagates.
            const result = await client.listTools();
            const tools = (result.tools ?? []).map((t: any) => t.name);

            // A healthy MCP server advertises at least one tool. Zero tools means
            // the command/URL/args/credentials are almost certainly wrong — treat
            // it as a failed test rather than a misleading "Connected — 0 tools".
            if (tools.length === 0) {
                throw new Error(
                    'Connected, but the server exposed no tools. This usually means the command, URL, arguments, or credentials are incorrect — a working MCP server advertises at least one tool.',
                );
            }

            return { toolCount: tools.length, tools };
        } finally {
            await this.disconnectServer(ephemeralId);
        }
    }

    /**
     * Disconnect all account-scoped instances of a server (all accounts).
     * Useful for credential rotation or cleanup.
     */
    async disconnectAccountScopedServers(baseServerId: string): Promise<void> {
        // Matches `<tenantId>##<baseServerId>::<accountId>` across all tenants.
        const marker = `${TENANT_SEP}${baseServerId}::`;
        const scopedIds = Array.from(this.clients.keys()).filter(id => id.includes(marker) || id.startsWith(`${baseServerId}::`));
        console.log(`[MCPManager] Disconnecting ${scopedIds.length} account-scoped instances of "${baseServerId}"`);
        await Promise.allSettled(scopedIds.map(id => this.disconnectServer(id)));
    }

    /**
     * Disconnect every server instance opened for a tenant (regular + account-scoped).
     * Call this on run end / abort so a run's MCP subprocesses and their live tokens
     * do not outlive the run. Safe to call when nothing is connected.
     */
    async disconnectTenantServers(tenantId: string): Promise<void> {
        const prefix = `${tenantId || 'default'}${TENANT_SEP}`;
        const ids = Array.from(this.clients.keys()).filter(id => id.startsWith(prefix));
        if (ids.length === 0) return;
        console.log(`[MCPManager] Disconnecting ${ids.length} server instance(s) for tenant "${tenantId}"`);
        await Promise.allSettled(ids.map(id => this.disconnectServer(id)));
    }

    /**
     * Connect to multiple MCP servers by their IDs.
     * If allConfigs is provided (from DynamoDB), uses those; otherwise falls back to DEFAULT_MCP_SERVERS.
     */
    async connectServers(serverIds: string[], allConfigs?: MCPServerConfig[], tenantId: string = 'default'): Promise<void> {
        const source = allConfigs || DEFAULT_MCP_SERVERS;
        const configs = source.filter(s => serverIds.includes(s.id));

        const results = await Promise.allSettled(
            configs.map(config => this.connectServer(config, tenantId))
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
