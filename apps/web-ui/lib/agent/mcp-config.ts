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
    /** Transport kind. Absent ⇒ 'stdio' for backward compatibility. */
    transport?: 'stdio' | 'sse' | 'http';
    command: string;            // stdio only ('' for remote)
    args: string[];             // stdio only ([] for remote)
    env?: Record<string, string>;
    /** Remote (sse/http) only. */
    url?: string;
    headers?: Record<string, string>;
    enabled: boolean;
    description: string;
    /** When true, AWS credentials for the selected account are injected as env vars before spawning. stdio only. */
    requiresAwsCredentials?: boolean;
}

/** stdio entry — VS Code / Cursor convention. `type` optional ⇒ defaults to stdio. */
export interface StdioJsonEntry {
    type?: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
    disabled?: boolean;
    requiresAwsCredentials?: boolean;
}

/** Remote entry — SSE or streamable HTTP. */
export interface RemoteJsonEntry {
    type: 'sse' | 'http';
    url: string;
    headers?: Record<string, string>;
    disabled?: boolean;
}

export type MCPServerJsonEntry = StdioJsonEntry | RemoteJsonEntry;

/**
 * Type guard for discriminated-union narrowing on MCPServerJsonEntry.
 * StdioJsonEntry.type is optional (absent ⇒ stdio), so a plain
 * `entry.type === 'sse' || entry.type === 'http'` check does NOT narrow
 * the else-branch to StdioJsonEntry in TypeScript — TS still sees the full
 * union there. Using this guard as the condition narrows the else-branch
 * correctly to StdioJsonEntry in all branches.
 */
export function isRemoteEntry(entry: MCPServerJsonEntry): entry is RemoteJsonEntry {
    return entry.type === 'sse' || entry.type === 'http';
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
                oneOf: [
                    {
                        type: 'object',
                        required: ['command', 'args'],
                        properties: {
                            type: { const: 'stdio' },
                            command: { type: 'string', description: 'Command to start the MCP server (e.g. "uvx", "npx", "node")' },
                            args: { type: 'array', items: { type: 'string' } },
                            env: { type: 'object', additionalProperties: { type: 'string' } },
                            disabled: { type: 'boolean' },
                            requiresAwsCredentials: { type: 'boolean' },
                        },
                        additionalProperties: false,
                    },
                    {
                        type: 'object',
                        required: ['type', 'url'],
                        properties: {
                            type: { enum: ['sse', 'http'] },
                            url: { type: 'string', description: 'Remote MCP endpoint URL' },
                            headers: { type: 'object', additionalProperties: { type: 'string' } },
                            disabled: { type: 'boolean' },
                        },
                        additionalProperties: false,
                    },
                ],
            },
        },
    },
    additionalProperties: false,
};

/**
 * Default MCP server configurations.
 * All servers start disabled (opt-in) to maintain backward compatibility.
 *
 * Servers are grouped into two categories:
 *   - Knowledge / Tools (no AWS credentials required): documentation, diagrams, IaC helpers
 *   - AWS Service Access (requiresAwsCredentials: true): any server that calls AWS APIs
 *     against the user-selected account. STS credentials are automatically injected via a
 *     named profile when these servers are spawned.
 */
export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [

    // ─── Knowledge & Tools (no AWS credentials required) ─────────────────────

    {
        id: 'aws-documentation',
        name: 'AWS Documentation',
        command: 'uvx',
        args: ['awslabs.aws-documentation-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Search and read AWS documentation pages, best practices, and service guides',
    },
    {
        id: 'aws-knowledge',
        name: 'AWS Knowledge',
        command: 'uvx',
        args: ['awslabs.aws-knowledge-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Access curated AWS knowledge, architectural patterns, and Well-Architected guidance',
    },
    {
        id: 'aws-cdk',
        name: 'AWS CDK',
        command: 'uvx',
        args: ['awslabs.cdk-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'AWS CDK infrastructure-as-code assistance: constructs, patterns, CDK Nag rules',
    },
    {
        id: 'terraform',
        name: 'Terraform (AWS)',
        command: 'uvx',
        args: ['awslabs.terraform-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Terraform module guidance, AWS provider patterns, and IaC best practices',
    },
    {
        id: 'aws-diagram',
        name: 'AWS Architecture Diagrams',
        command: 'uvx',
        args: ['awslabs.aws-diagram-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Generate AWS architecture diagrams from natural language descriptions',
    },
    {
        id: 'aws-pricing',
        name: 'AWS Pricing',
        command: 'uvx',
        args: ['awslabs.aws-pricing-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Query AWS public pricing data for any service, region, and instance type',
    },

    // ─── AWS Service Access (STS credentials injected per selected account) ──

    {
        id: 'aws-cost-explorer',
        name: 'AWS Cost Explorer',
        command: 'uvx',
        args: ['awslabs.cost-explorer-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Query Cost Explorer: usage, forecasts, comparisons, and cost drivers by account',
        requiresAwsCredentials: true,
    },
    {
        id: 'aws-billing',
        name: 'AWS Billing & Cost Management',
        command: 'uvx',
        args: ['awslabs.billing-cost-management-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Access AWS billing statements, invoices, credits, and cost allocation tags',
        requiresAwsCredentials: true,
    },
    {
        id: 'aws-cloudwatch',
        name: 'AWS CloudWatch',
        command: 'uvx',
        args: ['awslabs.cloudwatch-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Query CloudWatch metrics, logs insights, alarms, and anomaly detection',
        requiresAwsCredentials: true,
    },
    {
        id: 'aws-ecs',
        name: 'AWS ECS',
        command: 'uvx',
        args: ['awslabs.ecs-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Manage ECS clusters, services, tasks, and container deployments',
        requiresAwsCredentials: true,
    },
    {
        id: 'aws-dynamodb',
        name: 'AWS DynamoDB',
        command: 'uvx',
        args: ['awslabs.dynamodb-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Query and manage DynamoDB tables: scans, queries, schema analysis, and capacity',
        requiresAwsCredentials: true,
    },
    {
        id: 'aws-cloudformation',
        name: 'AWS CloudFormation',
        command: 'uvx',
        args: ['awslabs.cfn-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Manage CloudFormation stacks: deploy, update, describe, and detect drift',
        requiresAwsCredentials: true,
    },
    {
        id: 'aws-eks',
        name: 'AWS EKS',
        command: 'uvx',
        args: ['awslabs.eks-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Manage EKS clusters, node groups, and Kubernetes workloads',
        requiresAwsCredentials: true,
    },
    {
        id: 'aws-lambda',
        name: 'AWS Lambda',
        command: 'uvx',
        args: ['awslabs.lambda-tool-mcp-server@latest'],
        env: { FASTMCP_LOG_LEVEL: 'ERROR' },
        enabled: false,
        description: 'Invoke Lambda functions and retrieve logs and execution results',
        requiresAwsCredentials: true,
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

function toServerConfig(id: string, entry: MCPServerJsonEntry): MCPServerConfig {
    const defaultServer = DEFAULT_MCP_SERVERS.find(s => s.id === id);
    const name = defaultServer?.name || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const description = defaultServer?.description || `MCP server: ${id}`;
    const enabled = entry.disabled !== true;

    if (isRemoteEntry(entry)) {
        return {
            id, name, description, enabled,
            transport: entry.type,
            command: '',
            args: [],
            url: entry.url,
            headers: entry.headers || {},
        };
    }

    return {
        id, name, description, enabled,
        transport: 'stdio',
        command: entry.command,
        args: entry.args,
        env: entry.env || {},
        requiresAwsCredentials: entry.requiresAwsCredentials ?? defaultServer?.requiresAwsCredentials ?? false,
    };
}

/**
 * Convert JSON editor format back to MCPServerConfig[].
 */
export function jsonToServerConfigs(json: MCPConfigJson): MCPServerConfig[] {
    return Object.entries(json.mcpServers).map(([id, entry]) => toServerConfig(id, entry));
}

/**
 * Merge user-saved config (from DynamoDB) with defaults.
 * User config wins — any server in user config overrides the default.
 * Servers in defaults but not in user config are included as-is.
 */
export function mergeConfigs(savedJson: MCPConfigJson | null): MCPServerConfig[] {
    if (!savedJson) {
        return DEFAULT_MCP_SERVERS;
    }
    const merged: Record<string, MCPServerConfig> = {};
    for (const server of DEFAULT_MCP_SERVERS) {
        merged[server.id] = { ...server };
    }
    for (const [id, entry] of Object.entries(savedJson.mcpServers)) {
        merged[id] = toServerConfig(id, entry);
    }
    return Object.values(merged);
}

/**
 * SECURITY NOTE — SSRF surface (accepted risk):
 *
 * Only the URL protocol (http: / https:) is validated here. Remote MCP URLs
 * are NOT restricted from loopback (127.0.0.1), link-local (169.254.0.0/16,
 * includes AWS IMDS at 169.254.169.254), or RFC-1918 private ranges.
 *
 * This means an authenticated tenant user can make the server open a
 * connection to internal services via the Test-connection action or at
 * runtime when the MCP manager connects.
 *
 * Accepted risk rationale: the stdio transport already grants the same user
 * arbitrary local command execution (same trust boundary). Remote MCP widens
 * the surface to outbound HTTP rather than local exec, but both operate on the
 * same tenant-scoped, authenticated surface. The risk profile is comparable.
 *
 * Follow-up (not in scope for this change): deny-list link-local
 * (169.254.0.0/16), loopback (127.0.0.0/8), and private CIDR ranges
 * (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) before exposing this to
 * untrusted or lower-trust user tiers.
 */
function isValidHttpUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Single source of truth for MCP config validation (used by both API routes).
 * stdio entries require command + args; remote (sse/http) require a valid url.
 */
export function validateMcpConfig(config: unknown): { ok: true } | { ok: false; error: string } {
    const cfg = config as { mcpServers?: unknown };
    if (!cfg || typeof cfg !== 'object' || typeof cfg.mcpServers !== 'object' || cfg.mcpServers === null) {
        return { ok: false, error: 'Invalid config: must contain "mcpServers" object' };
    }
    for (const [id, raw] of Object.entries(cfg.mcpServers as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') {
            return { ok: false, error: `Invalid server "${id}": entry must be an object` };
        }
        const entry = raw as Record<string, unknown>;
        const type = (entry.type as string) ?? 'stdio';
        if (type === 'stdio') {
            if (typeof entry.command !== 'string' || !entry.command.trim()) {
                return { ok: false, error: `Invalid server "${id}": stdio servers require a non-empty "command"` };
            }
            if (!Array.isArray(entry.args)) {
                return { ok: false, error: `Invalid server "${id}": stdio servers require an "args" array` };
            }
        } else if (type === 'sse' || type === 'http') {
            if (!isValidHttpUrl(entry.url)) {
                return { ok: false, error: `Invalid server "${id}": ${type} servers require a valid http(s) "url"` };
            }
        } else {
            return { ok: false, error: `Invalid server "${id}": unknown transport type "${type}"` };
        }
    }
    return { ok: true };
}

// ─── Secret masking ──────────────────────────────────────────────────────────
//
// GET /api/mcp-servers must never return stored secrets (bearer tokens in
// headers, API keys in env) in plaintext. We replace secret-looking values with
// a sentinel placeholder in responses, keeping the stored copy intact. On save,
// any field still equal to the placeholder is restored from the stored config,
// so editing a server without re-typing its secret preserves it.

/** Sentinel returned in place of a secret value. The UI shows it read-only. */
export const MCP_SECRET_MASK = '__NUCLEUS_SECRET_UNCHANGED__';

/** True for map keys that name a secret (API key, token, password, Authorization…). */
function isSecretKey(key: string): boolean {
    return /(secret|token|password|passwd|credential|authorization|auth\b|api[_-]?key|access[_-]?key|_key$|^key$)/i.test(key);
}

function maskValueMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!map) return map;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
        out[k] = v && isSecretKey(k) ? MCP_SECRET_MASK : v;
    }
    return out;
}

function restoreValueMap(
    incoming: Record<string, string> | undefined,
    stored: Record<string, string> | undefined,
): Record<string, string> | undefined {
    if (!incoming) return incoming;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
        if (v === MCP_SECRET_MASK) {
            // Unchanged secret: restore the stored value; drop the field entirely
            // if there is nothing to restore (never persist the placeholder literal).
            if (stored && stored[k] !== undefined) out[k] = stored[k];
        } else {
            out[k] = v;
        }
    }
    return out;
}

/** Mask secret values in the resolved server list (GET response). */
export function maskServerConfigs(servers: MCPServerConfig[]): MCPServerConfig[] {
    return servers.map(s => ({
        ...s,
        env: maskValueMap(s.env),
        headers: maskValueMap(s.headers),
    }));
}

/** Mask secret values in the editor JSON (GET response). */
export function maskMcpConfigJson(json: MCPConfigJson): MCPConfigJson {
    const masked: MCPConfigJson = { mcpServers: {} };
    for (const [id, entry] of Object.entries(json.mcpServers)) {
        if (isRemoteEntry(entry)) {
            masked.mcpServers[id] = { ...entry, headers: maskValueMap(entry.headers) };
        } else {
            masked.mcpServers[id] = { ...entry, env: maskValueMap(entry.env) };
        }
    }
    return masked;
}

/**
 * Restore masked secrets in an incoming config against what is currently stored,
 * so a save that left placeholders in place keeps the existing secrets.
 */
export function restoreMaskedSecrets(incoming: MCPConfigJson, stored: MCPConfigJson | null): MCPConfigJson {
    const result: MCPConfigJson = { mcpServers: {} };
    for (const [id, entry] of Object.entries(incoming.mcpServers)) {
        const prev = stored?.mcpServers?.[id];
        if (isRemoteEntry(entry)) {
            const prevHeaders = prev && isRemoteEntry(prev) ? prev.headers : undefined;
            result.mcpServers[id] = { ...entry, headers: restoreValueMap(entry.headers, prevHeaders) };
        } else {
            const prevEnv = prev && !isRemoteEntry(prev) ? prev.env : undefined;
            result.mcpServers[id] = { ...entry, env: restoreValueMap(entry.env, prevEnv) };
        }
    }
    return result;
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
