# Plan: Fast Agent Multi-Account MCP + UI/UX Parity

## Task
1. Add multi-account support in fast agent execution including MCP server execution
2. Make Fast Agent UI/UX match Planning Agent UX

## Problem Analysis

### Multi-Account MCP Issue
The current pipeline only connects MCP servers for the FIRST selected account:
- `createFastGraph` → `effectiveAccountId = accountId || accounts?.[0]?.accountId` (only first)
- `assembleTools({ accountId: effectiveAccountId })` → single accountId
- `getActiveMCPTools(serverIds, tenantId, accountId)` → connects credential-sensitive MCP servers for ONE account

Evidence from logs: Account `042428207891` gets MCP tools (aws-cost-explorer, aws-billing), but account `044656767899` does NOT. The LLM falls back to raw `execute_command` with AWS CLI for the second account.

### UI/UX Issue
- Planning agent emits phases as `reasoning` parts (planning, execution, reflection, revision, final) → rendered with colored phase headers
- Fast agent emits everything as `text` parts → rendered as plain markdown with no phase indicators
- Root cause: `getPhaseFromNode('agent')` returns `'text'` instead of a phase type

## Subtasks

### Subtask 1: Multi-account MCP — `getActiveMCPTools` (agent-shared.ts)
- Accept `accounts?: AccountContext[]` array instead of single `accountId`
- Loop over all accounts, connect credential-sensitive MCP servers for each
- Collect all scoped instance IDs across accounts

### Subtask 2: Multi-account MCP — `assembleTools` (model-factory.ts)
- Replace `accountId?: string` with `accounts?: AccountContext[]` in `AssembleToolsOptions`
- Pass accounts array to `getActiveMCPTools`

### Subtask 3: Multi-account MCP — `createFastGraph` (fast-agent.ts)
- Pass all accounts to `assembleTools` instead of just `effectiveAccountId`

### Subtask 4: Multi-account MCP — `createReflectionGraph` (planning-agent.ts)
- Same fix as Subtask 3 for the planning agent

### Subtask 5: UI/UX — Phase mapping (route.ts)
- Change `getPhaseFromNode('agent')` from `'text'` to `'execution'`
- This gives fast agent the same execution/reflection phase headers as planning agent

## Files to modify
- `web-ui/lib/agent/agent-shared.ts` — `getActiveMCPTools` signature + multi-account loop
- `web-ui/lib/agent/model-factory.ts` — `AssembleToolsOptions` + `assembleTools`
- `web-ui/lib/agent/fast-agent.ts` — `createFastGraph` accounts passthrough
- `web-ui/lib/agent/planning-agent.ts` — `createReflectionGraph` accounts passthrough
- `web-ui/app/api/chat/route.ts` — `getPhaseFromNode` mapping for 'agent' node

## Files to create: none
## Files to delete: none

## Parallelizable
Yes — Subtasks 1-2 (backend MCP) and Subtask 5 (UI phase mapping) are independent.

## Approach
Modify `getActiveMCPTools` to iterate over all accounts in the array, connecting credential-sensitive MCP servers for each. Update `assembleTools` interface to accept accounts array. Both graph factories pass the full accounts array through. For UI parity, change the fast agent's `agent` node phase mapping from `'text'` to `'execution'` so it renders with the same phase headers as the planning agent.

## Key Decisions
- Using accounts array instead of single accountId throughout the pipeline (backwards-compatible: falls back to first account if legacy `accountId` is provided)
- Mapping fast agent's `agent` node to `'execution'` phase — this means the final answer also renders inside an execution phase block, matching how the planning agent's `generate` node works
- NOT adding a separate `final` node to the fast agent graph — keeps the graph simple; the execution phase block is sufficient for visual parity

## Risks / Side Effects
- MCP server connection time increases linearly with number of accounts (each credential-sensitive server spawns a subprocess per account)
- Tool name collisions: credential-sensitive MCP tools are namespaced by base server ID (not account ID) — tools from different accounts will have the same LangChain name. The LLM must use `get_aws_credentials` to switch context. This is the existing pattern (unchanged).
- The fast agent's final answer will now render inside an "EXECUTION" phase block instead of as plain text

## Assumptions
- The existing pattern of using `get_aws_credentials` tool for account switching is acceptable (MCP tools are connected for the first account; the LLM uses CLI with profiles for other accounts)
- Actually, with this change, MCP tools will be connected for ALL accounts — but since tool names are namespaced by server ID (not account ID), tools from different accounts will overwrite each other. The correct approach is to connect MCP servers for ALL accounts and ensure unique tool names per account.

## REVISED Approach for Multi-Account MCP
After deeper analysis: credential-sensitive MCP servers are already namespaced with `::accountId` suffix (e.g., `aws-cost-explorer::042428207891`). The `createMCPTools` function strips the `::accountId` from the tool name for Bedrock's 64-char limit. This means tools from different accounts get the SAME LangChain name — the LLM can't distinguish which account a tool targets.

The fix: connect MCP servers for ALL accounts, and the tool execution closure already routes to the correct account-scoped subprocess via the full `mcpTool.mcpServerId` (with `::accountId` suffix). The tool names will collide, but the LAST connected account's tools will be used. This is NOT correct.

**Better approach**: Include account ID in the tool name to disambiguate. E.g., `mcp_aws-cost-explorer_042428207891_get_cost_and_usage`. This lets the LLM explicitly choose which account to query.
