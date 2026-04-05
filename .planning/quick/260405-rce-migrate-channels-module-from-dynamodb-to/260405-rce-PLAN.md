---
phase: quick
plan: 260405-rce
type: execute
wave: 1
depends_on: []
files_modified:
  - web-ui/app/api/agent-ops/mcp-settings/route.ts
autonomous: true
requirements: [CHANNELS-PG-01]

must_haves:
  truths:
    - "MCP settings route passes tenantId to TenantConfigService on all three methods (GET, PUT, DELETE)"
    - "All three channels API routes (slack, jira, mcp-settings) consistently use getSessionTenantId() for tenant isolation"
    - "Channels module has zero direct DynamoDB imports — all storage goes through TenantConfigService"
  artifacts:
    - path: "web-ui/app/api/agent-ops/mcp-settings/route.ts"
      provides: "Tenant-scoped MCP settings API"
      contains: "getSessionTenantId"
  key_links:
    - from: "web-ui/app/api/agent-ops/mcp-settings/route.ts"
      to: "web-ui/lib/tenant-config-service.ts"
      via: "TenantConfigService with tenantId parameter"
      pattern: "TenantConfigService\\.(getConfig|saveConfig|deleteConfig).*tenantId"
---

<objective>
Fix tenant isolation gap in the channels MCP settings API route.

Purpose: The Slack and Jira settings routes already correctly pass tenantId from getSessionTenantId() to TenantConfigService. The MCP settings route (/api/agent-ops/mcp-settings) does NOT pass tenantId on any of its three methods (GET, PUT, DELETE), breaking tenant isolation. The underlying TenantConfigService already delegates to PostgreSQL when USE_PG_TENANT_CONFIG=true, so no data layer migration is needed — only the route-level tenant scoping fix.

Output: Tenant-isolated MCP settings route consistent with Slack/Jira patterns.
</objective>

<execution_context>
@.planning/STATE.md
</execution_context>

<context>
@web-ui/app/api/agent-ops/mcp-settings/route.ts
@web-ui/app/api/agent-ops/settings/slack/route.ts (reference — correct tenant isolation pattern)
@web-ui/lib/tenant-config-service.ts
@web-ui/lib/auth-session.ts
</context>

<interfaces>
<!-- Existing contracts the executor needs -->

From web-ui/lib/tenant-config-service.ts:
```typescript
export class TenantConfigService {
    static async getConfig<T = unknown>(configKey: string, tenantId: string): Promise<T | null>;
    static async saveConfig<T = unknown>(configKey: string, data: T, tenantId: string, updatedBy?: string): Promise<void>;
    static async deleteConfig(configKey: string, tenantId: string): Promise<void>;
    static async listConfigs(tenantId: string): Promise<Array<{ configKey: string; updatedAt: string }>>;
}
```

From web-ui/lib/auth-session.ts:
```typescript
export async function getSessionTenantId(): Promise<string>;
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Add tenant isolation to MCP settings route</name>
  <files>web-ui/app/api/agent-ops/mcp-settings/route.ts</files>
  <action>
    Update the MCP settings route to pass tenantId on all TenantConfigService calls, matching the pattern already used by the Slack and Jira settings routes:

    1. Add import: `import { getSessionTenantId } from '@/lib/auth-session';`

    2. In GET handler:
       - Add `const tenantId = await getSessionTenantId();` at the top of the try block
       - Change `TenantConfigService.getConfig<MCPConfigJson>(CONFIG_KEY)` to `TenantConfigService.getConfig<MCPConfigJson>(CONFIG_KEY, tenantId)`

    3. In PUT handler:
       - Add `const tenantId = await getSessionTenantId();` at the top of the try block
       - Change `TenantConfigService.saveConfig(CONFIG_KEY, config)` to `TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId)`

    4. In DELETE handler:
       - Add `const tenantId = await getSessionTenantId();` at the top of the try block
       - Change `TenantConfigService.deleteConfig(CONFIG_KEY)` to `TenantConfigService.deleteConfig(CONFIG_KEY, tenantId)`

    5. Update the file's JSDoc header comment: replace "DynamoDB" references with "tenant-scoped config store" to reflect the migration.

    Reference: web-ui/app/api/agent-ops/settings/slack/route.ts already does this correctly — follow the same pattern exactly.
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration && grep -c "getSessionTenantId" web-ui/app/api/agent-ops/mcp-settings/route.ts | grep -q "1" && grep -c "tenantId" web-ui/app/api/agent-ops/mcp-settings/route.ts | grep -qv "0" && echo "PASS" || echo "FAIL"</automated>
  </verify>
  <done>All three HTTP methods in the MCP settings route pass tenantId to TenantConfigService. The getSessionTenantId import is present. No direct DynamoDB imports exist in the file.</done>
</task>

</tasks>

<verification>
- grep for `getSessionTenantId` in all three channels-related route files confirms consistent tenant isolation
- grep for `getDynamoDBDocumentClient` or `@aws-sdk/lib-dynamodb` in channels route files returns zero matches
- `cd web-ui && npx tsc --noEmit` passes (TypeScript compilation check)
</verification>

<success_criteria>
All three channels API routes (slack, jira, mcp-settings) consistently derive tenantId from the session and pass it to TenantConfigService. No direct DynamoDB usage exists in any channels route.
</success_criteria>

<output>
After completion, create `.planning/quick/260405-rce-migrate-channels-module-from-dynamodb-to/260405-rce-SUMMARY.md`
</output>
