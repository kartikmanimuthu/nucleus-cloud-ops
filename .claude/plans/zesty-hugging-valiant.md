# Plan: Integrate AWS MCP Servers with Dynamic Per-Account Credentials

## Context

The platform supports multi-account AWS operations where users select an AWS account in the UI. The agent obtains temporary STS credentials per-account via `get_aws_credentials`. However, MCP servers (spawned as subprocesses) receive their environment variables **at spawn time** and cannot change them afterward.

AWS Labs publishes **many** MCP servers that require AWS credentials — Cost Explorer, CloudWatch, ECS, EKS, Lambda, CloudFormation, S3, Support, Cloud Control API, and more. All follow the same auth pattern: `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars.

**Problem**: No mechanism exists to inject the selected account's credentials into MCP server subprocesses. If a user switches accounts, the MCP server still uses the old (or default) credentials.

**Solution**: Introduce **account-scoped MCP server instances** with a generic `requiresAwsCredentials` flag. Any MCP server marked with this flag will automatically get STS credentials injected for the selected AWS account. This covers all current and future AWS MCP servers.

---

## Known AWS MCP Servers That Need Credentials

All use `uvx awslabs.<name>@latest` and accept `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_SESSION_TOKEN` + `AWS_REGION`.

| Server | Package | Key Tools |
|--------|---------|-----------|
| Cost Explorer | `awslabs.cost-explorer-mcp-server` | get_cost_and_usage, get_cost_forecast, get_cost_comparison_drivers |
| CloudWatch | `awslabs.cloudwatch-mcp-server` | get_metric_data, analyze_metric, execute_log_insights_query, get_active_alarms |
| ECS | `awslabs.ecs-mcp-server` | ECS service/task management |
| EKS | `awslabs.eks-mcp-server` | Kubernetes cluster management |
| Lambda | `awslabs.lambda-tool-mcp-server` | Lambda function execution |
| CloudFormation | `awslabs.cfn-mcp-server` | Stack management |
| Cloud Control API | `awslabs.ccapi-mcp-server` | Generic AWS resource CRUD |
| AWS Support | `awslabs.aws-support-mcp-server` | Support case management |
| AWS API | `awslabs.aws-api-mcp-server` | Generic AWS CLI via MCP |

Users add any of these via the existing MCP JSON config editor. The `requiresAwsCredentials` flag tells the system to inject credentials automatically.

---

## Files to Modify

| File | Change |
|------|--------|
| `web-ui/lib/agent/mcp-config.ts` | Add `requiresAwsCredentials` to interfaces/schema; add Cost Explorer + CloudWatch to defaults |
| `web-ui/lib/agent/mcp-manager.ts` | Add `connectServerWithAwsCredentials()` for account-scoped instances |
| `web-ui/lib/agent/aws-credentials-tool.ts` | Export `getAccountFromDynamoDB` and `assumeRoleForAccount` (currently private) |
| `web-ui/lib/agent/agent-shared.ts` | Update `getActiveMCPTools()` to accept `accountId` and inject credentials |
| `web-ui/lib/agent/model-factory.ts` | Thread `accountId` through `AssembleToolsOptions` |
| `web-ui/lib/agent/fast-agent.ts` | Pass `config.accountId` to `assembleTools()` |
| `web-ui/lib/agent/planning-agent.ts` | Pass `config.accountId` to `assembleTools()` |
| `web-ui/lib/agent/deep-agent.ts` | Pass `config.accountId` to `assembleTools()` |

## Reuse Existing Code

- **`assumeRoleForAccount()`** in `aws-credentials-tool.ts:51` — STS AssumeRole, returns temp creds
- **`getAccountFromDynamoDB()`** in `aws-credentials-tool.ts:35` — fetches roleArn, externalId, regions
- **`MCPServerManager`** singleton in `mcp-manager.ts` — extend with new method, don't replace
- **`mergeConfigs()`** in `mcp-config.ts` — existing DynamoDB + defaults config resolution
- **`StdioClientTransport` env injection** in `mcp-manager.ts:236-239` — already merges `process.env` with `config.env`

---

## Implementation Steps

### Step 1: Add `requiresAwsCredentials` flag to MCP config (`mcp-config.ts`)

**1a.** Add `requiresAwsCredentials?: boolean` to `MCPServerConfig` interface.

**1b.** Add `requiresAwsCredentials?: boolean` to `MCPServerJsonEntry` interface.

**1c.** Add to `MCP_CONFIG_JSON_SCHEMA` properties:
```ts
requiresAwsCredentials: {
    type: 'boolean',
    description: 'When true, AWS credentials for the selected account are injected as env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION)',
}
```

**1d.** Add default servers (all disabled, opt-in):
```ts
{
    id: 'aws-cost-explorer',
    name: 'AWS Cost Explorer',
    command: 'uvx',
    args: ['awslabs.cost-explorer-mcp-server@latest'],
    env: { FASTMCP_LOG_LEVEL: 'ERROR' },
    enabled: false,
    description: 'Query AWS Cost Explorer for cost analysis, comparisons, and forecasts via MCP',
    requiresAwsCredentials: true,
},
{
    id: 'aws-cloudwatch',
    name: 'AWS CloudWatch',
    command: 'uvx',
    args: ['awslabs.cloudwatch-mcp-server@latest'],
    env: { FASTMCP_LOG_LEVEL: 'ERROR' },
    enabled: false,
    description: 'Query CloudWatch metrics, logs, and alarms via MCP',
    requiresAwsCredentials: true,
},
```

**1e.** Update `jsonToServerConfigs()` and `mergeConfigs()` to carry `requiresAwsCredentials` through conversions.

### Step 2: Add account-scoped connection to `MCPServerManager` (`mcp-manager.ts`)

Add a new public method:
```ts
async connectServerWithAwsCredentials(
    config: MCPServerConfig,
    accountId: string,
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; region: string }
): Promise<string>  // returns the scoped instance ID e.g. "aws-cost-explorer::123456789012"
```

Logic:
1. Build scoped key: `${config.id}::${accountId}`
2. If `this.clients.has(scopedKey)` → return early (already connected for this account)
3. Clone config with id set to `scopedKey` and merge credential env vars:
   ```ts
   AWS_ACCESS_KEY_ID: credentials.accessKeyId,
   AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
   AWS_SESSION_TOKEN: credentials.sessionToken,
   AWS_REGION: credentials.region,
   ```
4. Call existing `_doConnect()` with the cloned config
5. Return `scopedKey`

Also add: `disconnectAccountScopedServers(baseServerId: string)` — iterates `this.clients.keys()`, disconnects any key starting with `${baseServerId}::`. Useful for credential expiry cleanup.

### Step 3: Export credential helpers from `aws-credentials-tool.ts`

Add `export` keyword to:
- `getAccountFromDynamoDB()` (line 35)
- `assumeRoleForAccount()` (line 51)

No logic changes. These are currently module-private functions.

### Step 4: Update `getActiveMCPTools()` in `agent-shared.ts`

Change signature to accept account context:
```ts
export async function getActiveMCPTools(
    serverIds?: string[],
    tenantId?: string,
    accountId?: string
)
```

Updated logic:
1. Resolve all server configs from DynamoDB + defaults (existing)
2. Split requested servers into two groups:
   - **credentialServers**: configs where `requiresAwsCredentials === true` AND `accountId` is provided
   - **regularServers**: everything else
3. For **regularServers** → use existing `manager.connectServers()` path (unchanged)
4. For **credentialServers**:
   - Call `getAccountFromDynamoDB(accountId)` once to get roleArn + externalId + region
   - Call `assumeRoleForAccount(roleArn, externalId)` once to get temp credentials
   - For each credential server, call `manager.connectServerWithAwsCredentials(config, accountId, { accessKeyId, secretAccessKey, sessionToken, region })`
   - Collect the scoped instance IDs
5. Build tools from both regular server IDs + scoped instance IDs via `createTools()`

### Step 5: Thread `accountId` through `assembleTools()` (`model-factory.ts`)

Add `accountId?: string` to `AssembleToolsOptions` interface. Pass to `getActiveMCPTools`:
```ts
const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId, accountId);
```

### Step 6: Pass `accountId` in agent factories

In each agent file, add `accountId` to the `assembleTools()` call:

**fast-agent.ts** (line 57):
```ts
const tools = await assembleTools({
    includeS3Tools: false,
    includeMemoryTools: !!store,
    userId: config.userId,
    mcpServerIds,
    tenantId,
    accountId,  // NEW
});
```

**planning-agent.ts** (line 63): same pattern, `accountId` added.

**deep-agent.ts**: same pattern if it calls `assembleTools()`.

No changes to `GraphConfig` — `accountId` is already present in the interface.

### Step 7: Verify tool name sanitization (`mcp-tools.ts`)

The namespaced name `mcp_${mcpServerId}_${toolName}` with scoped IDs like `aws-cost-explorer::123456789012` becomes `mcp_aws_cost_explorer__123456789012_get_cost_and_usage` after the existing regex replace `(/[^a-zA-Z0-9_-]/g, '_')`. This is valid — no code change needed, just verify.

---

## End-to-End Flow

1. User selects AWS account `123456789012` in UI
2. User enables `aws-cost-explorer` MCP server in settings
3. User asks: "Show me my AWS costs for the last 3 months"
4. Chat API sends `{ accountId: '123456789012', mcpServerIds: ['aws-cost-explorer'] }` to agent
5. `assembleTools()` → `getActiveMCPTools()` sees `requiresAwsCredentials: true`
6. System does STS AssumeRole for account `123456789012`
7. Spawns `uvx awslabs.cost-explorer-mcp-server@latest` with credentials in env
8. Agent receives tool `mcp_aws_cost_explorer__123456789012_get_cost_and_usage`
9. Agent calls the tool → Cost Explorer API responds with **that account's** cost data
10. User switches to account `987654321098` → new MCP server instance spawned with new credentials

---

## Verification

1. **Build/lint**: `cd web-ui && npm run lint && npm run build`
2. **Manual test**:
   - Enable `aws-cost-explorer` in MCP settings JSON editor
   - Select an AWS account with `ce:GetCostAndUsage` permissions
   - Ask: "Show me my AWS costs for the last 3 months grouped by service"
   - Confirm `mcp_aws_cost_explorer_*` tool is called (check server logs)
   - Confirm response contains account-specific cost data
3. **Multi-account test**: Switch account, repeat query — verify new MCP instance spawned
4. **Non-credential MCP test**: Verify `aws-documentation` MCP server still works without credentials (no regression)
