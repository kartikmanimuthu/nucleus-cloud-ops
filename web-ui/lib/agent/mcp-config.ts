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
    /** When true, AWS credentials for the selected account are injected as env vars before spawning. */
    requiresAwsCredentials?: boolean;
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
    /** When true, AWS credentials for the selected account are injected as env vars before spawning. */
    requiresAwsCredentials?: boolean;
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
                    requiresAwsCredentials: {
                        type: 'boolean',
                        description: 'When true, AWS credentials for the selected account are injected as env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION)',
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
            requiresAwsCredentials: entry.requiresAwsCredentials ?? defaultServer?.requiresAwsCredentials ?? false,
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
            requiresAwsCredentials: entry.requiresAwsCredentials ?? defaultServer?.requiresAwsCredentials ?? false,
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
