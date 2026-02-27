# Plan: AI Ops Deep Agent Module

## Context

The platform currently has two agent modes — **Fast (ReAct)** and **Plan & Execute** — both built with custom LangGraph `StateGraph` implementations. The user wants a third mode using the **LangChain Deep Agents** framework (`deepagents` npm package), which provides built-in planning (`write_todos`), subagent delegation (`task` tool), file system tools, and context management. Since `createDeepAgent()` returns a standard LangGraph compiled graph, it integrates with the existing streaming, checkpointing, and HITL infrastructure with minimal changes.

**Key value-add**: Deep Agents brings autonomous task decomposition, context-aware subagent spawning, and automatic context management (summarization on long conversations) — capabilities that the current custom implementations handle manually via Planner/Reflector/Reviser nodes.

---

## Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `web-ui/package.json` | Modify | Add `deepagents` dependency |
| `web-ui/lib/agent/deep-agent.ts` | **Create** | Core deep agent factory (`createDeepGraph`) |
| `web-ui/lib/agent/graph-factory.ts` | Modify | Add re-export |
| `web-ui/app/api/chat/route.ts` | Modify | Add `'deep'` mode branch + phase mappings |
| `web-ui/components/agent/chat-interface.tsx` | Modify | Add "Deep Agent" to mode selector |

---

## Step-by-Step Implementation

### Step 1: Install dependency

```bash
cd web-ui && npm install deepagents
```

The `deepagents` package depends on `@langchain/langgraph` and `@langchain/core`, both already present in the project.

### Step 2: Create `web-ui/lib/agent/deep-agent.ts`

Factory function following the same pattern as `fast-agent.ts` and `planning-agent.ts`.

```typescript
export async function createDeepGraph(config: GraphConfig): Promise<CompiledStateGraph>
```

**Implementation details:**

#### 2a. Model — Use `ChatBedrockConverse` (same as existing agents)
```typescript
const model = new ChatBedrockConverse({
    region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
    model: modelId,
    maxTokens: 8192,
    temperature: 0,
    streaming: true,
});
```

#### 2b. Tools — Pass existing custom tools + MCP tools
Reuse from `tools.ts`: `executeCommandTool`, `readFileTool`, `writeFileTool`, `editFileTool`, `lsTool`, `globTool`, `grepTool`, `webSearchTool`, `getAwsCredentialsTool`, `listAwsAccountsTool`, `writeFileToS3Tool`, `getFileFromS3Tool`

MCP tools loaded via existing `getActiveMCPTools(mcpServerIds, tenantId)`.

Custom tools with matching names override the Deep Agent's built-in file system tools, preserving our AWS-specific enhancements (2-min timeout, 10MB buffer on `execute_command`, line numbering on `read_file`, etc.).

#### 2c. System prompt — Reuse existing building blocks
- Base DevOps identity (same as `fast-agent.ts` / `planning-agent.ts`)
- Skill section via `getSkillContent()` or fallback "Base DevOps Engineer" mode
- Account context string (multi-account, single-account, or autonomous discovery)
- AWS CLI standards
- Additional guidance about `write_todos` for planning and `task` for subagent delegation

#### 2d. Subagents — Three domain-specific subagents

| Subagent | Name | Tools | Purpose |
|----------|------|-------|---------|
| AWS Operations | `aws-ops` | `execute_command`, `get_aws_credentials`, `list_aws_accounts` | AWS CLI execution with credential management, state verification |
| Research | `research` | `web_search` + MCP tools | Documentation, error resolution, pricing lookup |
| Code/IaC | `code-iac` | `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep`, `execute_command` | Terraform, CloudFormation, Docker, Ansible, shell scripts |

Each subagent gets:
- Focused system prompt with domain-specific instructions
- Minimal tool set (reduces scope/cost)
- Same `ChatBedrockConverse` model instance
- Account context injected into `aws-ops` subagent prompt

#### 2e. Create the agent
```typescript
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
    model: model,
    tools: allTools,
    systemPrompt: systemPrompt,
    subagents: [awsOpsSubagent, researchSubagent, codeSubagent],
});
```

#### 2f. Compile with checkpointer + HITL
The compiled graph needs the existing `checkpointer` from `agent-shared.ts`. Since `createDeepAgent()` returns a LangGraph graph, we either:
- Pass `checkpointer` as a config option if supported, OR
- Recompile the graph with `{ checkpointer, interruptBefore: [...] }` if needed

If `autoApprove` is false, configure tool interrupts for mutation tools (`execute_command`, `write_file`, `edit_file`).

### Step 3: Update `graph-factory.ts`

Add one line:
```typescript
export * from "./deep-agent";
```

### Step 4: Update API route (`web-ui/app/api/chat/route.ts`)

#### 4a. Import
```typescript
import { createReflectionGraph, createFastGraph, createDeepGraph } from '@/lib/agent/graph-factory';
```

#### 4b. Graph selection (line 78-80)
```typescript
let graph;
if (mode === 'deep') {
    graph = await createDeepGraph(graphConfig);
} else if (mode === 'fast') {
    graph = await createFastGraph(graphConfig);
} else {
    graph = await createReflectionGraph(graphConfig);
}
```

#### 4c. Phase mapping (line 221-237)
Add Deep Agent node names to `getPhaseFromNode()`:
```typescript
case 'call_model':    return 'execution';   // Deep Agent main model node
case 'tools':         return 'execution';   // Deep Agent tool execution
```

### Step 5: Update UI (`web-ui/components/agent/chat-interface.tsx`)

Add to `AGENT_MODES` array:
```typescript
{ id: "deep", label: "Deep Agent" }
```

No other UI changes needed — the mode flows through `agentMode` state → `body.mode` in `useChat` → API route.

---

## Reusable Existing Code

| What | Where | How Used |
|------|-------|----------|
| All custom tools | `web-ui/lib/agent/tools.ts` | Passed as `tools` array to `createDeepAgent()` |
| AWS credentials tools | `web-ui/lib/agent/aws-credentials-tool.ts` | Included in tools + aws-ops subagent |
| MCP tool loading | `agent-shared.ts:getActiveMCPTools()` | Loaded and passed as additional tools |
| Skill loading | `skills/skill-loader.ts:getSkillContent()` | Injected into system prompt |
| Checkpointer | `agent-shared.ts:checkpointer` | DynamoDB/S3 persistence for deep agent graph |
| Account context builder | Pattern from `fast-agent.ts` lines 104-128 | Extracted/reused for system prompt construction |
| Skill section builder | Pattern from `fast-agent.ts` lines 39-68 | Extracted/reused for system prompt construction |

---

## Known Considerations

1. **Tool name overlap**: Deep Agents has built-in `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep`. Our custom tools should override them by name. If not, we may need to omit our duplicates or rename them. Will verify during implementation.

2. **Bedrock message formatting**: The existing agents use `sanitizeMessagesForBedrock()` for strict message ordering. The `deepagents` package may not handle this. If Bedrock validation errors occur, we may need a middleware or callback wrapper. Will test and fix if needed.

3. **Checkpointer integration**: Need to verify whether `createDeepAgent()` accepts a `checkpointer` parameter directly or if we need to recompile the returned graph. The JS package documentation indicates it returns a compiled LangGraph graph.

4. **Streaming node names**: The exact internal node names used by `deepagents` (e.g., `call_model`, `tools`) need verification. Unknown nodes will fall through to `'text'` phase, which is functional but won't show reasoning panels. Refinable after initial testing.

---

## Verification

1. **Build check**: `cd web-ui && npm run build` — ensure TypeScript compiles with no errors
2. **Dev server**: `cd web-ui && npm run dev` — verify server starts
3. **Mode selection**: Open browser → Agent chat → verify "Deep Agent" appears in mode dropdown
4. **Basic invocation**: Select "Deep Agent" mode → send a simple message (e.g., "Hello") → verify streaming response appears
5. **Tool execution**: Send an AWS-related task (e.g., "List my AWS accounts") → verify tools execute and results stream
6. **Subagent delegation**: Send a complex task requiring research + AWS ops → verify subagent delegation occurs (visible in server logs)
7. **HITL**: Disable auto-approve → send a task requiring tool execution → verify interrupt/approval flow works
8. **Skills**: Select a skill → send a task → verify skill instructions are followed
9. **Lint**: `cd web-ui && npm run lint` — ensure no lint errors
