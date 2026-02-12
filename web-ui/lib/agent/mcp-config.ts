/**
 * MCP Server Configuration
 * 
 * Defines the structure, defaults, and DynamoDB-backed resolution for MCP server configs.
 * JSON format follows VS Code / Cursor MCP convention:
 * 
 * {
 *   "mcpServers": {
 *     "<server-id>": {
 *       "command": "uvx",
 *       "args": ["..."],
 *       "env": {},
 *       "disabled": false
 *     }
 *   }
 * }
 */

export interface MCPServerConfig {
    id: string;
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    enabled: boolean;
    description: string;
}

/**
 * JSON format for the MCP config stored in DynamoDB / shown in the editor.
 * Mirrors VS Code / Cursor convention.
 */
export interface MCPServerJsonEntry {
    command: string;
    args: string[];
    env?: Record<string, string>;
    disabled?: boolean;
}

export interface MCPConfigJson {
    mcpServers: Record<string, MCPServerJsonEntry>;
}

/**
 * JSON Schema for Monaco editor validation.
 */
export const MCP_CONFIG_JSON_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['mcpServers'],
    properties: {
        mcpServers: {
            type: 'object',
            description: 'Map of MCP server configurations keyed by server ID',
            additionalProperties: {
                type: 'object',
                required: ['command', 'args'],
                properties: {
                    command: {
                        type: 'string',
                        description: 'Command to start the MCP server (e.g., "uvx", "npx", "node")',
                    },
                    args: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Arguments to pass to the command',
                    },
                    env: {
                        type: 'object',
                        additionalProperties: { type: 'string' },
                        description: 'Environment variables for the server process',
                    },
                    disabled: {
                        type: 'boolean',
                        description: 'Set to true to disable this server (default: false)',
                    },
                },
                additionalProperties: false,
            },
        },
    },
    additionalProperties: false,
};

/**
 * Default MCP server configurations.
 * All servers start disabled (opt-in) to maintain backward compatibility.
 */
export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [
    {
        id: 'aws-documentation',
        name: 'AWS Documentation & Tools',
        command: 'uvx',
        args: ['awslabs.aws-documentation-mcp-server@latest'],
        env: {},
        enabled: false,
        description: 'Search and access AWS documentation, best practices, and service guides via MCP',
    },
    {
        id: 'aws-cdk',
        name: 'AWS CDK MCP',
        command: 'uvx',
        args: ['awslabs.cdk-mcp-server@latest'],
        env: {},
        enabled: false,
        description: 'AWS CDK infrastructure-as-code assistance and guidance via MCP',
    },
];

/**
 * Convert default MCPServerConfig[] to the JSON editor format.
 */
export function defaultsToJson(): MCPConfigJson {
    const mcpServers: Record<string, MCPServerJsonEntry> = {};
    for (const server of DEFAULT_MCP_SERVERS) {
        mcpServers[server.id] = {
            command: server.command,
            args: [...server.args],
            env: server.env ? { ...server.env } : {},
            disabled: !server.enabled,
        };
    }
    return { mcpServers };
}

/**
 * Convert JSON editor format back to MCPServerConfig[].
 */
export function jsonToServerConfigs(json: MCPConfigJson): MCPServerConfig[] {
    return Object.entries(json.mcpServers).map(([id, entry]) => {
        // Find matching default for display name/description, or generate from ID
        const defaultServer = DEFAULT_MCP_SERVERS.find(s => s.id === id);
        return {
            id,
            name: defaultServer?.name || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            command: entry.command,
            args: entry.args,
            env: entry.env || {},
            enabled: entry.disabled !== true,
            description: defaultServer?.description || `MCP server: ${id}`,
        };
    });
}

/**
 * Merge user-saved config (from DynamoDB) with defaults.
 * User config wins — any server in user config overrides the default.
 * Servers in defaults but not in user config are included as-is.
 */
export function mergeConfigs(
    savedJson: MCPConfigJson | null
): MCPServerConfig[] {
    if (!savedJson) {
        return DEFAULT_MCP_SERVERS;
    }

    const merged: Record<string, MCPServerConfig> = {};

    // Start with defaults
    for (const server of DEFAULT_MCP_SERVERS) {
        merged[server.id] = { ...server };
    }

    // Overlay user config
    for (const [id, entry] of Object.entries(savedJson.mcpServers)) {
        const defaultServer = DEFAULT_MCP_SERVERS.find(s => s.id === id);
        merged[id] = {
            id,
            name: defaultServer?.name || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            command: entry.command,
            args: entry.args,
            env: entry.env || {},
            enabled: entry.disabled !== true,
            description: defaultServer?.description || `MCP server: ${id}`,
        };
    }

    return Object.values(merged);
}

/**
 * Get a specific MCP server config by ID from defaults.
 */
export function getMCPServerConfigById(id: string): MCPServerConfig | undefined {
    return DEFAULT_MCP_SERVERS.find(s => s.id === id);
}

/**
 * Get all enabled MCP server configs from defaults.
 */
export function getEnabledMCPServers(): MCPServerConfig[] {
    return DEFAULT_MCP_SERVERS.filter(s => s.enabled);
}
