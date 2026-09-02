# Agent Ops Deep Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **COMMIT GATE:** The user has explicitly instructed that **nothing may be committed without their approval**. Every task below ends with a commit step. Write the changes, run the tests, then **STOP** and report. Do not run the `git commit` command until the user says so. The commit commands are recorded so they can be run in order later.

**Goal:** Add the `deepagents` framework to Agent Ops as an opt-in third execution mode (`deep`), alongside the existing plan graph.

**Architecture:** A new `createDeepExecutorGraph` wraps `createDeepAgent` for Agent Ops, driven by a new `executeDeepRun` that consumes the v3 projections and translates them into `agent_ops_events` rows through a pure recorder module. Per-action HITL reuses `lib/agent/deep/hitl.ts` verbatim; channel adapters keep their binary approve/reject via a fan-out in the existing approve route. The plan graph is untouched.

**Tech Stack:** TypeScript 5, Next.js 15 App Router, `deepagents`, `@langchain/langgraph`, Prisma, Vitest, TanStack Query, Radix/shadcn, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-ops-deep-agent-design.md`

## Global Constraints

- Branch is `feature/AgentOps-DeepAgent`, based on `origin/uat` @ `589d13e7`. Do not rebase.
- **No Prisma migration.** `AgentOpsRun.mode` and `AgentOpsEvent.eventType` are free-form `String` columns.
- Tests run with `cd apps/web-ui && bun run test` (Vitest, `vitest run`, not watch).
- `virtualMode: true` on `FilesystemBackend` is **mandatory** — without it the agent can read other tenants' credential directories.
- `save_memory` must stay **excluded** from the deep toolset; only `search_memory` is included. `createDeepMemoryMiddleware` already saves from the full transcript, and the tool caused a second blind write racing the reconcile judge.
- Middleware order must be `[todoListMiddleware(), memoryMiddleware, handleToolErrors, repairMessages]`.
- `todoListMiddleware()` must be passed explicitly — deepagents v0.7 made todos opt-in; without it the `todos` state channel does not exist.
- Recursion limit comes from `resolveMaxIterations(tenantId)` (tenant budget, 150 fallback) — **not** AI Ops' hardcoded 100.
- Tool output truncates at **8000** characters.
- Web-ui code uses 4-space indent in `lib/`, 2-space in `components/`. Follow the file you are editing.
- All new API routes must `export const authz: RouteAuthz`.

---

### Task 1: Extract the shared sub-agent factory

Pure extraction from `deep-agent.ts` so Agent Ops and AI Ops share one definition. No behaviour change.

**Files:**
- Create: `apps/web-ui/lib/agent/deep/subagents.ts`
- Create: `apps/web-ui/lib/agent/deep/__tests__/subagents.test.ts`
- Modify: `apps/web-ui/lib/agent/deep-agent.ts` (replace the three inline `SubAgent` literals with a call to the factory)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createDeepSubagents(opts: DeepSubagentOptions): SubAgent[]` and `interface DeepSubagentOptions`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/deep/__tests__/subagents.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createDeepSubagents } from '../subagents';

const fakeTool = (name: string) => ({ name, description: name, invoke: vi.fn() }) as never;

const baseOpts = {
    accountContext: '\n\nACCOUNT CONTEXT MARKER',
    executeCommand: fakeTool('execute_command'),
    getAwsCredentials: fakeTool('get_aws_credentials'),
    listAwsAccounts: fakeTool('list_aws_accounts'),
    researchTools: [fakeTool('web_search'), fakeTool('search_knowledge_base')],
    interruptOn: { execute_command: true } as Record<string, boolean> | undefined,
};

describe('createDeepSubagents', () => {
    it('returns the three sub-agents in a stable order', () => {
        const subs = createDeepSubagents(baseOpts);
        expect(subs.map(s => s.name)).toEqual(['aws-ops', 'research', 'code-iac']);
    });

    it('gives aws-ops the three AWS tools and the interrupt config', () => {
        const [awsOps] = createDeepSubagents(baseOpts);
        expect(awsOps.tools?.map((t: { name: string }) => t.name)).toEqual([
            'execute_command', 'get_aws_credentials', 'list_aws_accounts',
        ]);
        expect(awsOps.interruptOn).toEqual({ execute_command: true });
    });

    it('injects the account context into the aws-ops prompt', () => {
        const [awsOps] = createDeepSubagents(baseOpts);
        expect(awsOps.systemPrompt).toContain('ACCOUNT CONTEXT MARKER');
    });

    it('leaves research un-gated — it is read-only', () => {
        const research = createDeepSubagents(baseOpts)[1];
        expect(research.interruptOn).toBeUndefined();
        expect(research.tools?.map((t: { name: string }) => t.name)).toEqual([
            'web_search', 'search_knowledge_base',
        ]);
    });

    it('gates code-iac, which can execute and write', () => {
        const code = createDeepSubagents(baseOpts)[2];
        expect(code.interruptOn).toEqual({ execute_command: true });
        expect(code.tools?.map((t: { name: string }) => t.name)).toEqual(['execute_command']);
    });

    it('omits interruptOn entirely when autoApprove left it undefined', () => {
        const subs = createDeepSubagents({ ...baseOpts, interruptOn: undefined });
        expect(subs[0].interruptOn).toBeUndefined();
        expect(subs[2].interruptOn).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/subagents.test.ts`
Expected: FAIL — `Failed to resolve import "../subagents"`.

- [ ] **Step 3: Create the factory**

Create `apps/web-ui/lib/agent/deep/subagents.ts`. Copy the three `systemPrompt` strings **verbatim** from `apps/web-ui/lib/agent/deep-agent.ts` (the `awsOpsSubagent`, `researchSubagent`, `codeSubagent` literals) so no prompt text changes:

```typescript
import type { SubAgent } from 'deepagents';

/** A LangChain tool, structurally. Avoids importing the heavy tool types here. */
type AnyTool = SubAgent['tools'] extends (infer T)[] | undefined ? T : never;

export interface DeepSubagentOptions {
    /** Prompt fragment describing the AWS account(s) in scope. */
    accountContext: string;
    executeCommand: AnyTool;
    getAwsCredentials: AnyTool;
    listAwsAccounts: AnyTool;
    /** Read-only research toolset — web search, KB, aws-read, MCP. Caller assembles it. */
    researchTools: AnyTool[];
    /** HITL gate config, or undefined when autoApprove is on. */
    interruptOn?: Record<string, boolean>;
}

/**
 * The three deep sub-agents, shared by the AI Ops chat graph (createDeepGraph)
 * and the Agent Ops executor graph (createDeepExecutorGraph).
 *
 * Order is stable and asserted by tests: aws-ops, research, code-iac.
 * `research` is deliberately un-gated — it holds only read-only tools.
 */
export function createDeepSubagents(opts: DeepSubagentOptions): SubAgent[] {
    const { accountContext, executeCommand, getAwsCredentials, listAwsAccounts, researchTools, interruptOn } = opts;

    const awsOps: SubAgent = {
        name: 'aws-ops',
        description: 'AWS Operations agent — executes AWS CLI commands, manages credentials, verifies resource state. Use for any AWS API calls, resource creation/mutation/deletion, and cross-account operations.',
        systemPrompt: `You are a senior AWS Cloud engineer specialized in executing AWS CLI operations.

${accountContext}

**Your focus:**
- Execute AWS CLI commands with proper credentials via get_aws_credentials
- Always use --output json and --profile <profileName>
- Verify resource state (describe/list) before mutations
- Handle multi-account operations by getting credentials for each account
- Return precise results with resource IDs, ARNs, and status values

**AWS CLI Standards:**
- Always use --output json
- Always use --profile obtained from get_aws_credentials
- Use --no-paginate for small result sets; use pagination loops for large ones
- Verify current resource state before any mutation command`,
        tools: [executeCommand, getAwsCredentials, listAwsAccounts],
        ...(interruptOn ? { interruptOn } : {}),
    };

    const research: SubAgent = {
        name: 'research',
        description: 'Research agent — searches the web for documentation, AWS pricing, error resolution, best practices. Use when you need to look up information, check AWS docs, or resolve an error message.',
        systemPrompt: `You are a research assistant specialized in AWS and DevOps documentation.

**Your focus:**
- Search the web for accurate, up-to-date AWS documentation and best practices
- Look up error messages and their solutions
- Find AWS pricing information and service limits
- Research Terraform/CloudFormation/CDK patterns and examples
- Return concise, actionable findings with source references

Always cite the source URL when returning findings.`,
        tools: researchTools,
    };

    const codeIac: SubAgent = {
        name: 'code-iac',
        description: 'Code and Infrastructure-as-Code agent — reads, writes, and edits files. Use for Terraform, CloudFormation, Docker, Ansible, shell scripts, and any file system operations.',
        systemPrompt: `You are a senior DevOps engineer specialized in Infrastructure-as-Code and automation scripts.

**Your focus:**
- Read, write, and edit Terraform configs, CloudFormation templates, Dockerfiles, Ansible playbooks
- Write precise shell scripts and CI/CD pipeline configurations
- Validate IaC syntax and suggest best practices
- Follow existing code style and conventions in the project
- Execute shell commands to validate or test IaC (terraform plan, docker build --no-cache, etc.)

Always read existing files before editing them to understand the current state.`,
        tools: [executeCommand],
        ...(interruptOn ? { interruptOn } : {}),
    };

    return [awsOps, research, codeIac];
}
```

> Before writing, open `apps/web-ui/lib/agent/deep-agent.ts` and copy the three `systemPrompt` template literals exactly. If they differ from the text above, **the file wins** — this plan was written from a snapshot.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/subagents.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Rewire `deep-agent.ts` to use the factory**

In `apps/web-ui/lib/agent/deep-agent.ts`, add the import:

```typescript
import { createDeepSubagents } from "./deep/subagents";
```

Delete the three `const awsOpsSubagent: SubAgent = {...}`, `const researchSubagent: SubAgent = {...}`, `const codeSubagent: SubAgent = {...}` blocks and replace with:

```typescript
    const subagents = createDeepSubagents({
        accountContext,
        executeCommand,
        getAwsCredentials,
        listAwsAccounts,
        researchTools: [
            ...(webSearchAvailable() ? [webSearchTool] : []),
            ...(tenantId ? [createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined)] : []),
            ...(tenantId ? [createAwsReadTool(tenantId, userId)] : []),
            ...mcpTools,
        ] as never,
        interruptOn,
    });
```

Then change the `createDeepAgent({...})` call's `subagents:` line from
`subagents: [awsOpsSubagent, researchSubagent, codeSubagent],` to `subagents,`.

If `SubAgent` is now unused as a type import, remove it from the `deepagents` import.

- [ ] **Step 6: Verify no AI Ops regression**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Expected: no new errors mentioning `deep-agent.ts` or `subagents.ts`.

Run: `cd apps/web-ui && bun run test`
Expected: the full suite passes as before — in particular `lib/agent/deep/__tests__/*`.

- [ ] **Step 7: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/lib/agent/deep/subagents.ts apps/web-ui/lib/agent/deep/__tests__/subagents.test.ts apps/web-ui/lib/agent/deep-agent.ts
git commit -m "refactor(deep): extract shared sub-agent factory"
```

---

### Task 2: Extend Agent Ops types and tenant defaults

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/types.ts`
- Modify: `apps/web-ui/lib/agent-ops/agent-ops-defaults.ts`
- Create: `apps/web-ui/lib/agent-ops/agent-ops-defaults.test.ts`
- Modify: `apps/web-ui/lib/gateway/types.ts:20`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentMode` including `'deep'`; `AgentEventType` including `'todo' | 'subagent'`; `AgentOpsApprovalRequest.pendingActions`; `AgentOpsDefaultsConfig.defaultMode`; `resolveDefaultMode(tenantId): Promise<AgentMode>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent-ops/agent-ops-defaults.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfig = vi.fn();
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: (...a: unknown[]) => getConfig(...a) },
}));
vi.mock('@/env', () => ({ env: { AGENT_OPS_MAX_ITERATIONS: undefined } }));

import { resolveDefaultMode, validateAgentOpsDefaults, FALLBACK_DEFAULT_MODE } from './agent-ops-defaults';

describe('resolveDefaultMode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the configured mode', async () => {
        getConfig.mockResolvedValue({ defaultModel: 'm', maxIterations: 50, defaultMode: 'deep' });
        await expect(resolveDefaultMode('t1')).resolves.toBe('deep');
    });

    it('falls back to plan when nothing is configured', async () => {
        getConfig.mockResolvedValue(null);
        await expect(resolveDefaultMode('t1')).resolves.toBe(FALLBACK_DEFAULT_MODE);
        expect(FALLBACK_DEFAULT_MODE).toBe('plan');
    });

    it('falls back to plan on an unrecognised stored value', async () => {
        getConfig.mockResolvedValue({ defaultModel: 'm', maxIterations: 50, defaultMode: 'wat' });
        await expect(resolveDefaultMode('t1')).resolves.toBe('plan');
    });

    it('never throws when the config read fails', async () => {
        getConfig.mockRejectedValue(new Error('db down'));
        await expect(resolveDefaultMode('t1')).resolves.toBe('plan');
    });
});

describe('validateAgentOpsDefaults', () => {
    it('accepts a valid deep default', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'bedrock:x:1', maxIterations: 50, defaultMode: 'deep' })).toBeNull();
    });

    it('rejects an unknown mode', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'bedrock:x:1', maxIterations: 50, defaultMode: 'turbo' }))
            .toMatch(/defaultMode/);
    });

    it('still accepts a payload with no mode — the field is optional', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'bedrock:x:1', maxIterations: 50 })).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/agent-ops-defaults.test.ts`
Expected: FAIL — `resolveDefaultMode` / `FALLBACK_DEFAULT_MODE` are not exported.

- [ ] **Step 3: Edit `types.ts`**

In `apps/web-ui/lib/agent-ops/types.ts`:

Replace the `AgentMode` declaration and its comment with:

```typescript
// Agent Ops supports two live execution graphs:
//   'plan' — the dynamic executor graph (evaluator → planner → reflect → final)
//   'deep' — the deepagents framework graph (sub-agents, virtual FS, write_todos)
// 'fast' remains in the union solely so legacy rows/checkpoints still type-check;
// nothing produces it anymore and the executor coerces it to 'plan'.
export type AgentMode = 'plan' | 'fast' | 'deep';
```

Add `'todo'` and `'subagent'` to `AgentEventType`:

```typescript
export type AgentEventType =
    | 'planning'
    | 'execution'
    | 'tool_call'
    | 'tool_result'
    | 'reflection'
    | 'revision'
    | 'final'
    | 'error'
    | 'memory_recall'
    | 'memory_save'
    | 'evaluation'
    | 'notification'
    // Deep-mode only: the write_todos checklist and sub-agent lifecycle.
    | 'todo'
    | 'subagent';
```

Extend `AgentOpsApprovalRequest`:

```typescript
export interface AgentOpsApprovalRequest {
    planSteps: string[];        // Human-readable plan steps to show in Slack
    pendingTools?: string[];    // Tool names that will be called (if interrupt-before-tools)
    approvalType: 'plan' | 'tool_execution' | 'deep_actions';
    slackMessageTs?: string;    // ts of the Block Kit approval message (for updating it)
    /**
     * Deep mode only. Every action awaiting a decision, flattened across all
     * pending interrupts. Shape matches PendingAction in lib/agent/deep/hitl.ts;
     * duplicated structurally here so this types file stays free of agent imports.
     */
    pendingActions?: Array<{
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        interruptId: string;
        index: number;
    }>;
}
```

Extend `AgentOpsDefaultsConfig`:

```typescript
export interface AgentOpsDefaultsConfig {
    // Composite model id ({provider}:{modelId}:{recordId}) from the provider
    // model picker; resolved via resolveModelConfig at run time.
    defaultModel: string;
    // Graph iteration budget — caps the executor loop AND LangGraph's recursionLimit.
    maxIterations: number;
    /**
     * Execution graph for runs that carry no explicit mode — channel triggers
     * (Slack/Jira/Discord/Telegram/webhook) have no UI to pick one. Optional:
     * rows written before deep mode existed simply resolve to 'plan'.
     */
    defaultMode?: AgentMode;
}
```

- [ ] **Step 4: Edit `agent-ops-defaults.ts`**

Add after `FALLBACK_MAX_ITERATIONS`:

```typescript
/** Mode used when a tenant has not chosen one. Preserves pre-deep behaviour. */
export const FALLBACK_DEFAULT_MODE: AgentMode = 'plan';

/** Modes a tenant may actually select. 'fast' is legacy-only and not offered. */
export const SELECTABLE_MODES: AgentMode[] = ['plan', 'deep'];
```

Change the type import to `import type { AgentOpsDefaultsConfig, AgentMode } from './types';`.

Extend `validateAgentOpsDefaults` — insert before `return null;`:

```typescript
    if (input.defaultMode !== undefined) {
        if (typeof input.defaultMode !== 'string' || !SELECTABLE_MODES.includes(input.defaultMode as AgentMode)) {
            return `defaultMode must be one of: ${SELECTABLE_MODES.join(', ')}`;
        }
    }
```

Widen the parameter type to include `defaultMode?: unknown;`.

Append:

```typescript
/**
 * Resolve the execution graph for a run that carries no explicit mode.
 * Never throws: an unreadable or unrecognised value resolves to 'plan'.
 */
export async function resolveDefaultMode(tenantId: string): Promise<AgentMode> {
    const config = await getAgentOpsDefaults(tenantId);
    const mode = config?.defaultMode;
    return mode && SELECTABLE_MODES.includes(mode) ? mode : FALLBACK_DEFAULT_MODE;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/agent-ops-defaults.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Widen the gateway mode union**

`apps/web-ui/lib/gateway/types.ts:20` currently reads `mode?: 'fast' | 'plan';`. Change to:

```typescript
    mode?: 'fast' | 'plan' | 'deep';
```

In `apps/web-ui/lib/gateway/gateway-service.ts:84`, the default is `message.mode ?? 'fast'` — which is stale, since Agent Ops retired fast. Change it to resolve the tenant default:

```typescript
            mode: message.mode ?? await resolveDefaultMode(message.tenantId),
```

Add the import `import { resolveDefaultMode } from '@/lib/agent-ops/agent-ops-defaults';`. If the enclosing function is not `async`, make it `async` and await at its call site.

- [ ] **Step 7: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | head -40`
Expected: no errors. If `build-steps.ts` errors on a non-exhaustive switch, that is expected and fixed in Task 9 — note it and continue.

- [ ] **Step 8: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/lib/agent-ops/types.ts apps/web-ui/lib/agent-ops/agent-ops-defaults.ts apps/web-ui/lib/agent-ops/agent-ops-defaults.test.ts apps/web-ui/lib/gateway/types.ts apps/web-ui/lib/gateway/gateway-service.ts
git commit -m "feat(agent-ops): add deep mode to types and tenant defaults"
```

---

### Task 3: Deep event recorder

The heart of the port: turns deep's runtime signals into `agent_ops_events` rows. Pure and fully unit-testable — it takes a sink function, never touches the DB itself.

**Files:**
- Create: `apps/web-ui/lib/agent-ops/deep-event-recorder.ts`
- Create: `apps/web-ui/lib/agent-ops/deep-event-recorder.test.ts`

**Interfaces:**
- Consumes: `AgentEventType` (Task 2), `RecordEventParams` from `./record-and-emit`.
- Produces: `createDeepEventRecorder(opts): DeepEventRecorder` with methods `text`, `reasoning`, `toolCall`, `toolResult`, `todos`, `subagent`, `memory`, `approvalGate`, `final`, and the constant `MAX_TOOL_OUTPUT`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent-ops/deep-event-recorder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDeepEventRecorder, MAX_TOOL_OUTPUT } from './deep-event-recorder';
import type { RecordEventParams } from './record-and-emit';

function harness() {
    const sink = vi.fn<[RecordEventParams], Promise<void>>().mockResolvedValue(undefined);
    const rec = createDeepEventRecorder({ runId: 'run-1', tenantId: 'tenant-1', sink });
    return { sink, rec, rows: () => sink.mock.calls.map(c => c[0]) };
}

describe('createDeepEventRecorder', () => {
    beforeEach(() => vi.clearAllMocks());

    it('stamps runId and tenantId on every row', async () => {
        const { rec, rows } = harness();
        await rec.text('hello');
        expect(rows()[0].runId).toBe('run-1');
        expect(rows()[0].tenantId).toBe('tenant-1');
    });

    it('assigns a strictly increasing seq across all event kinds', async () => {
        const { rec, rows } = harness();
        await rec.text('a');
        await rec.toolCall({ toolCallId: 'c1', toolName: 'execute_command', args: { command: 'ls' } });
        await rec.todos([{ content: 'step one', status: 'pending' }]);
        await rec.memory('recall', 'found 2 memories');
        const seqs = rows().map(r => r.metadata?.seq as number);
        expect(seqs).toEqual([0, 1, 2, 3]);
    });

    it('maps text to an execution event on call_model', async () => {
        const { rec, rows } = harness();
        await rec.text('thinking out loud');
        expect(rows()[0]).toMatchObject({
            eventType: 'execution', node: 'call_model', content: 'thinking out loud',
        });
    });

    it('flags reasoning separately from plain text', async () => {
        const { rec, rows } = harness();
        await rec.reasoning('internal deliberation');
        expect(rows()[0].eventType).toBe('execution');
        expect(rows()[0].metadata?.reasoning).toBe(true);
    });

    it('skips empty text without calling the sink', async () => {
        const { rec, sink } = harness();
        await rec.text('');
        await rec.text('   ');
        await rec.reasoning('');
        expect(sink).not.toHaveBeenCalled();
    });

    it('records a tool call with its args and id', async () => {
        const { rec, rows } = harness();
        await rec.toolCall({ toolCallId: 'c1', toolName: 'execute_command', args: { command: 'aws s3 ls' } });
        expect(rows()[0]).toMatchObject({
            eventType: 'tool_call', node: 'tools', toolName: 'execute_command',
            toolArgs: { command: 'aws s3 ls' },
        });
        expect(rows()[0].metadata?.toolCallId).toBe('c1');
    });

    it('truncates tool output at MAX_TOOL_OUTPUT and says so', async () => {
        const { rec, rows } = harness();
        const huge = 'x'.repeat(MAX_TOOL_OUTPUT + 500);
        await rec.toolResult({ toolCallId: 'c1', toolName: 'execute_command', output: huge, status: 'finished' });
        const out = rows()[0].toolOutput as string;
        expect(out.length).toBeLessThan(huge.length);
        expect(out).toContain('truncated');
        expect(rows()[0].metadata?.truncated).toBe(true);
    });

    it('leaves short tool output untouched', async () => {
        const { rec, rows } = harness();
        await rec.toolResult({ toolCallId: 'c1', toolName: 'ls', output: 'a\nb', status: 'finished' });
        expect(rows()[0].toolOutput).toBe('a\nb');
        expect(rows()[0].metadata?.truncated).toBeUndefined();
    });

    it('marks an errored tool result', async () => {
        const { rec, rows } = harness();
        await rec.toolResult({ toolCallId: 'c1', toolName: 'ls', output: 'boom', status: 'error' });
        expect(rows()[0].metadata?.status).toBe('error');
    });

    it('tags sub-agent work with subagentId so the timeline can group it', async () => {
        const { rec, rows } = harness();
        await rec.toolCall({ toolCallId: 'c1', toolName: 'execute_command', args: {}, subagentId: 'sub-7' });
        expect(rows()[0].metadata?.subagentId).toBe('sub-7');
    });

    it('records todos as a single todo event carrying the whole list', async () => {
        const { rec, rows } = harness();
        await rec.todos([
            { content: 'one', status: 'completed' },
            { content: 'two', status: 'in_progress' },
        ]);
        expect(rows()[0]).toMatchObject({ eventType: 'todo', node: 'write_todos' });
        expect(rows()[0].metadata?.todos).toHaveLength(2);
    });

    it('skips a todo write that is identical to the previous one', async () => {
        const { rec, sink } = harness();
        const todos = [{ content: 'one', status: 'pending' as const }];
        await rec.todos(todos);
        await rec.todos([{ content: 'one', status: 'pending' }]);
        expect(sink).toHaveBeenCalledTimes(1);
    });

    it('records a sub-agent lifecycle event', async () => {
        const { rec, rows } = harness();
        await rec.subagent({
            id: 'sub-1', role: 'aws-ops', task: 'list buckets', status: 'done',
            toolCount: 3, tokensIn: 100, tokensOut: 50, summary: 'found 4 buckets',
        });
        expect(rows()[0]).toMatchObject({ eventType: 'subagent', node: 'task' });
        expect(rows()[0].metadata).toMatchObject({
            subagentId: 'sub-1', name: 'aws-ops', status: 'done', toolCount: 3,
        });
    });

    it('maps memory ops onto the plan graph event types', async () => {
        const { rec, rows } = harness();
        await rec.memory('recall', 'two prior findings');
        await rec.memory('save', '{"saved":1}');
        expect(rows()[0]).toMatchObject({ eventType: 'memory_recall', node: 'deep_memory' });
        expect(rows()[1]).toMatchObject({ eventType: 'memory_save', node: 'deep_memory' });
    });

    it('records the approval gate with its pending actions', async () => {
        const { rec, rows } = harness();
        await rec.approvalGate([
            { toolCallId: 'ck:i1#0', toolName: 'execute_command', args: { command: 'rm -rf /' }, interruptId: 'i1', index: 0 },
        ]);
        expect(rows()[0]).toMatchObject({ eventType: 'planning', node: 'deep_approval_gate' });
        expect(rows()[0].content).toContain('execute_command');
        expect(rows()[0].metadata?.pendingActions).toHaveLength(1);
    });

    it('records the final summary', async () => {
        const { rec, rows } = harness();
        await rec.final('all done');
        expect(rows()[0]).toMatchObject({ eventType: 'final', node: '__end__', content: 'all done' });
    });

    it('never lets a sink failure escape', async () => {
        const sink = vi.fn().mockRejectedValue(new Error('db down'));
        const rec = createDeepEventRecorder({ runId: 'r', tenantId: 't', sink });
        await expect(rec.text('hi')).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-event-recorder.test.ts`
Expected: FAIL — cannot resolve `./deep-event-recorder`.

- [ ] **Step 3: Implement the recorder**

Create `apps/web-ui/lib/agent-ops/deep-event-recorder.ts`:

```typescript
/**
 * Deep Event Recorder — translates deepagents runtime signals into
 * agent_ops_events rows.
 *
 * This is the DB-row analogue of app/api/chat/deep-stream.ts: that module turns
 * the same signals into AI SDK UIMessageChunks for a browser, this one turns
 * them into persisted rows the Agent Ops timeline polls.
 *
 * Deliberately pure: it takes a `sink` rather than importing the service, so the
 * whole translation layer is unit-testable with no DB. Every method swallows
 * sink failures — event recording must never abort a run.
 *
 * ORDERING: the v3 projections are consumed in parallel, so several writers can
 * land inside the same millisecond and `getRunEvents` orders by createdAt only.
 * Every row therefore carries `metadata.seq` from a per-run counter, and the
 * timeline sorts on that.
 */
import type { RecordEventParams } from './record-and-emit';

/** Tool output longer than this is truncated before persisting. */
export const MAX_TOOL_OUTPUT = 8000;

export type DeepEventSink = (params: RecordEventParams) => Promise<void>;

export interface DeepTodo {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}

export interface DeepSubagentSnapshot {
    id: string;
    role: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string;
}

export interface DeepPendingAction {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    interruptId: string;
    index: number;
}

export interface DeepEventRecorder {
    text(content: string, subagentId?: string): Promise<void>;
    reasoning(content: string, subagentId?: string): Promise<void>;
    toolCall(args: { toolCallId: string; toolName: string; args: Record<string, unknown>; subagentId?: string }): Promise<void>;
    toolResult(args: { toolCallId: string; toolName: string; output: string; status: 'finished' | 'error'; subagentId?: string }): Promise<void>;
    todos(todos: DeepTodo[]): Promise<void>;
    subagent(snapshot: DeepSubagentSnapshot): Promise<void>;
    memory(op: 'recall' | 'save', summary: string): Promise<void>;
    approvalGate(actions: DeepPendingAction[]): Promise<void>;
    final(content: string): Promise<void>;
}

function truncate(text: string): { output: string; truncated: boolean } {
    if (text.length <= MAX_TOOL_OUTPUT) return { output: text, truncated: false };
    return {
        output: `${text.slice(0, MAX_TOOL_OUTPUT)}\n...[truncated — ${text.length} total chars]`,
        truncated: true,
    };
}

export function createDeepEventRecorder(opts: {
    runId: string;
    tenantId: string;
    sink: DeepEventSink;
}): DeepEventRecorder {
    const { runId, tenantId, sink } = opts;
    let seq = 0;
    // Todos are re-emitted on every state write; only a real change is worth a row.
    let lastTodosJson = '';

    async function emit(
        params: Omit<RecordEventParams, 'runId' | 'tenantId'> & { metadata?: Record<string, unknown> },
    ): Promise<void> {
        const row: RecordEventParams = {
            runId,
            tenantId,
            ...params,
            metadata: { ...(params.metadata ?? {}), seq: seq++ },
        };
        try {
            await sink(row);
        } catch (err) {
            console.error(`[DeepEventRecorder] sink failed (${params.eventType}/${params.node}):`, err);
        }
    }

    function withSub(subagentId?: string): Record<string, unknown> {
        return subagentId ? { subagentId } : {};
    }

    return {
        async text(content, subagentId) {
            if (!content?.trim()) return;
            await emit({ eventType: 'execution', node: 'call_model', content, metadata: withSub(subagentId) });
        },

        async reasoning(content, subagentId) {
            if (!content?.trim()) return;
            await emit({
                eventType: 'execution', node: 'call_model', content,
                metadata: { ...withSub(subagentId), reasoning: true },
            });
        },

        async toolCall({ toolCallId, toolName, args, subagentId }) {
            await emit({
                eventType: 'tool_call', node: 'tools', toolName, toolArgs: args,
                metadata: { ...withSub(subagentId), toolCallId },
            });
        },

        async toolResult({ toolCallId, toolName, output, status, subagentId }) {
            const { output: text, truncated } = truncate(output ?? '');
            await emit({
                eventType: 'tool_result', node: 'tools', toolName, toolOutput: text,
                metadata: {
                    ...withSub(subagentId), toolCallId, status,
                    ...(truncated ? { truncated: true } : {}),
                },
            });
        },

        async todos(todos) {
            const json = JSON.stringify(todos);
            if (json === lastTodosJson) return;
            lastTodosJson = json;
            const done = todos.filter(t => t.status === 'completed').length;
            await emit({
                eventType: 'todo', node: 'write_todos',
                content: `${done}/${todos.length} complete`,
                metadata: { todos },
            });
        },

        async subagent(snapshot) {
            await emit({
                eventType: 'subagent', node: 'task',
                content: snapshot.summary ?? snapshot.task,
                metadata: {
                    subagentId: snapshot.id,
                    name: snapshot.role,
                    task: snapshot.task,
                    status: snapshot.status,
                    toolCount: snapshot.toolCount,
                    tokensIn: snapshot.tokensIn,
                    tokensOut: snapshot.tokensOut,
                    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
                },
            });
        },

        async memory(op, summary) {
            await emit({
                eventType: op === 'recall' ? 'memory_recall' : 'memory_save',
                node: 'deep_memory',
                content: summary,
            });
        },

        async approvalGate(actions) {
            const names = actions.map(a => a.toolName).join(', ');
            await emit({
                eventType: 'planning', node: 'deep_approval_gate',
                content: `Awaiting approval for: ${names}`,
                metadata: { pendingActions: actions },
            });
        },

        async final(content) {
            await emit({ eventType: 'final', node: '__end__', content: content.slice(0, 5000) });
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-event-recorder.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/lib/agent-ops/deep-event-recorder.ts apps/web-ui/lib/agent-ops/deep-event-recorder.test.ts
git commit -m "feat(agent-ops): add deep event recorder"
```

---

### Task 4: Deep executor graph

**Files:**
- Create: `apps/web-ui/lib/agent-ops/deep-executor-graph.ts`
- Create: `apps/web-ui/lib/agent-ops/deep-executor-graph.test.ts`

**Interfaces:**
- Consumes: `createDeepSubagents` (Task 1).
- Produces: `createDeepExecutorGraph(config: GraphConfig)` returning the compiled deep agent.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent-ops/deep-executor-graph.test.ts`. It asserts the wiring contract by capturing the `createDeepAgent` argument:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createDeepAgent = vi.fn().mockReturnValue({ compiled: true });
const todoListMiddleware = vi.fn().mockReturnValue({ name: 'TodoList' });

vi.mock('deepagents', () => ({
    createDeepAgent: (...a: unknown[]) => createDeepAgent(...a),
    FilesystemBackend: class { constructor(public opts: unknown) {} },
    CompositeBackend: class { constructor(...a: unknown[]) { this.args = a; } args: unknown[]; },
    StoreBackend: class { constructor(public opts: unknown) {} },
}));
vi.mock('langchain', () => ({
    todoListMiddleware: () => todoListMiddleware(),
    createMiddleware: (c: unknown) => c,
}));
vi.mock('@langchain/langgraph', () => ({ isGraphInterrupt: () => false }));
vi.mock('@/lib/agent/model-factory', () => ({
    createAgentModels: () => ({ main: { bindTools: vi.fn() }, reflector: {} }),
    createMemoryTools: () => [{ name: 'search_memory' }, { name: 'save_memory' }],
}));
vi.mock('@/lib/agent/agent-shared', () => ({
    getCheckpointer: async () => ({ ck: true }),
    getStore: async () => ({ st: true }),
    getActiveMCPTools: async () => [],
    repairEmptyAiContent: (m: unknown) => m,
}));
vi.mock('@/lib/agent/deep/memory-middleware', () => ({
    createDeepMemoryMiddleware: () => ({ name: 'DeepMemory' }),
}));
vi.mock('@/lib/agent/deep/workdir', () => ({
    tenantWorkdir: (t: string) => `/tmp/wd/${t}`,
    ensureWorkdir: async () => undefined,
    AGENTS_MD_PATH: '/memories/AGENTS.md',
    MEMORIES_ROUTE: '/memories/',
}));
vi.mock('@/lib/agent/deep/file-store', () => ({ PostgresFileStore: class {} }));
vi.mock('@/lib/agent/tools', () => ({
    createExecuteCommandTool: () => ({ name: 'execute_command' }),
    createGetAwsCredentialsTool: () => ({ name: 'get_aws_credentials' }),
    createListAwsAccountsTool: () => ({ name: 'list_aws_accounts' }),
    askUserTool: { name: 'ask_user' },
    webSearchTool: { name: 'web_search' },
    webSearchAvailable: () => true,
    writeFileToS3Tool: { name: 'write_file_to_s3' },
    getFileFromS3Tool: { name: 'get_file_from_s3' },
}));
vi.mock('@/lib/agent/right-sizing-tool', () => ({ createGetRightSizingRecommendationsTool: () => ({ name: 'rs' }) }));
vi.mock('@/lib/agent/kb-tool', () => ({ createSearchKnowledgeBaseTool: () => ({ name: 'search_knowledge_base' }) }));
vi.mock('@/lib/agent/aws-read-tool', () => ({ createAwsReadTool: () => ({ name: 'aws_read' }) }));
vi.mock('@/lib/agent/skill-tool', () => ({ createLoadSkillTool: () => ({ name: 'load_skill' }) }));
vi.mock('@/lib/skill-service', () => ({
    getSkillContent: async () => null,
    getSkillSummaries: async () => 'Available skills: none',
}));

import { createDeepExecutorGraph } from './deep-executor-graph';

const baseConfig = {
    model: { modelId: 'anthropic.claude', provider: 'bedrock' },
    autoApprove: false,
    tenantId: 't1',
    userId: 'u1',
    accountId: '111122223333',
    accountName: 'prod',
} as never;

const callArg = () => createDeepAgent.mock.calls[0][0] as Record<string, never>;

describe('createDeepExecutorGraph', () => {
    beforeEach(() => vi.clearAllMocks());

    it('passes todoListMiddleware first — todos are opt-in since deepagents v0.7', async () => {
        await createDeepExecutorGraph(baseConfig);
        const names = (callArg().middleware as Array<{ name: string }>).map(m => m.name);
        expect(names[0]).toBe('TodoList');
        expect(names).toContain('DeepMemory');
    });

    it('wires the three shared sub-agents', async () => {
        await createDeepExecutorGraph(baseConfig);
        expect((callArg().subagents as Array<{ name: string }>).map(s => s.name))
            .toEqual(['aws-ops', 'research', 'code-iac']);
    });

    it('excludes save_memory — the memory middleware already saves', async () => {
        await createDeepExecutorGraph(baseConfig);
        const names = (callArg().tools as Array<{ name: string }>).map(t => t.name);
        expect(names).toContain('search_memory');
        expect(names).not.toContain('save_memory');
    });

    it('gates the four mutating tools when autoApprove is false', async () => {
        await createDeepExecutorGraph(baseConfig);
        expect(callArg().interruptOn).toEqual({
            execute_command: true, write_file: true, edit_file: true, ask_user: true,
        });
    });

    it('omits interruptOn entirely when autoApprove is true', async () => {
        await createDeepExecutorGraph({ ...baseConfig, autoApprove: true } as never);
        expect(callArg().interruptOn).toBeUndefined();
    });

    it('registers AGENTS.md as durable memory', async () => {
        await createDeepExecutorGraph(baseConfig);
        expect(callArg().memory).toEqual(['/memories/AGENTS.md']);
    });

    it('drops load_skill when autoLoadSkills is false', async () => {
        await createDeepExecutorGraph({ ...baseConfig, autoLoadSkills: false } as never);
        const names = (callArg().tools as Array<{ name: string }>).map(t => t.name);
        expect(names).not.toContain('load_skill');
    });

    it('throws when no tenant is supplied — every tool is tenant-scoped', async () => {
        await expect(createDeepExecutorGraph({ ...baseConfig, tenantId: undefined } as never))
            .rejects.toThrow(/tenant/i);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-executor-graph.test.ts`
Expected: FAIL — cannot resolve `./deep-executor-graph`.

- [ ] **Step 3: Implement the graph**

Create `apps/web-ui/lib/agent-ops/deep-executor-graph.ts`. Model it on `apps/web-ui/lib/agent/deep-agent.ts` — **open that file and mirror its structure**, changing only what this comment block describes:

```typescript
/**
 * Agent Ops — Deep Executor Graph
 *
 * The Agent Ops sibling of lib/agent/deep-agent.ts's createDeepGraph. Same
 * framework, same backend, same sub-agents; the differences are:
 *
 *   - Autonomous framing in the system prompt (no interactive user turn-taking).
 *     ask_user is still available and maps to the run's awaiting_input state.
 *   - recursionLimit comes from the caller's config.maxIterations (tenant Agent
 *     Ops budget), applied at invoke time by deep-run-executor.
 *   - onSubagentEvent / onMemoryEvent sinks are wired to the event recorder
 *     rather than to an SSE stream.
 *
 * Kept deliberately separate from createDeepGraph so Agent Ops and AI Ops can
 * evolve independently, exactly as the plan/fast graphs already are.
 */
import { SystemMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware, todoListMiddleware } from 'langchain';
import { isGraphInterrupt } from '@langchain/langgraph';
import { createDeepAgent, FilesystemBackend, CompositeBackend, StoreBackend } from 'deepagents';
import {
    askUserTool, webSearchTool, webSearchAvailable, writeFileToS3Tool, getFileFromS3Tool,
    createExecuteCommandTool, createGetAwsCredentialsTool, createListAwsAccountsTool,
} from '@/lib/agent/tools';
import { createGetRightSizingRecommendationsTool } from '@/lib/agent/right-sizing-tool';
import { createSearchKnowledgeBaseTool } from '@/lib/agent/kb-tool';
import { createAwsReadTool } from '@/lib/agent/aws-read-tool';
import { createLoadSkillTool } from '@/lib/agent/skill-tool';
import { getSkillContent, getSkillSummaries } from '@/lib/skill-service';
import {
    type GraphConfig, getCheckpointer, getStore, getActiveMCPTools, repairEmptyAiContent,
} from '@/lib/agent/agent-shared';
import { createAgentModels, createMemoryTools } from '@/lib/agent/model-factory';
import { createDeepMemoryMiddleware } from '@/lib/agent/deep/memory-middleware';
import { createDeepSubagents } from '@/lib/agent/deep/subagents';
import { tenantWorkdir, ensureWorkdir, AGENTS_MD_PATH, MEMORIES_ROUTE } from '@/lib/agent/deep/workdir';
import { PostgresFileStore } from '@/lib/agent/deep/file-store';

export async function createDeepExecutorGraph(config: GraphConfig) {
    const {
        model: modelConfig, autoApprove, accounts, accountId, accountName,
        selectedSkill, autoLoadSkills, mcpServerIds, knowledgeBaseIds, tenantId, userId,
    } = config as never as Record<string, never>;

    if (!tenantId) {
        throw new Error('A tenant context is required to build the Agent Ops deep graph.');
    }

    const checkpointer = await getCheckpointer();
    const store = await getStore();
    const { main: model, reflector: reflectorModel } = createAgentModels(modelConfig);

    // --- Skills: pinned skill (if any) + progressive-disclosure catalog ---
    let skillSection = '';
    if (selectedSkill) {
        const content = await getSkillContent(tenantId, selectedSkill);
        if (content) {
            skillSection = `\n\n=== ACTIVE SKILL: ${String(selectedSkill).toUpperCase()} ===\n${content}\n\nYou MUST follow the above skill-specific instructions.\n=== END SKILL ===\n`;
        }
    }
    const skillCatalog = autoLoadSkills !== false
        ? await getSkillSummaries(tenantId)
            .then(c => (c.startsWith('No specialized skills') ? null : c))
            .catch(() => null)
        : null;
    const skillCatalogSection = skillCatalog
        ? `\n${skillCatalog}\nIf one of these skills covers the task (or a phase of it), call the load_skill tool with its id to load the full instructions BEFORE doing that work, then follow them. Do not reload a skill already loaded in this run.\n`
        : '';

    // --- Account context ---
    const accountList = Array.isArray(accounts) ? accounts : [];
    let accountContext: string;
    if (accountList.length > 0) {
        const list = accountList
            .map((a: { accountName?: string; accountId: string }) => `  - ${a.accountName || a.accountId} (ID: ${a.accountId})`)
            .join('\n');
        accountContext = `\n\nIMPORTANT - MULTI-ACCOUNT AWS CONTEXT:\nYou are operating across ${accountList.length} AWS account(s):\n${list}\n\nFor EACH account: call get_aws_credentials with the accountId, then use --profile <profileName> with ALL subsequent AWS CLI commands, and label outputs by account.`;
    } else if (accountId) {
        accountContext = `\n\nIMPORTANT - AWS ACCOUNT CONTEXT:\nYou are operating in AWS account: ${accountName || accountId} (ID: ${accountId}).\nBefore any AWS CLI command you MUST call get_aws_credentials with accountId="${accountId}" and use the returned --profile with every command. NEVER use the host's default credentials.`;
    } else {
        accountContext = `\n\nIMPORTANT - AUTONOMOUS AWS ACCOUNT DISCOVERY:\nNo explicit account was provided. If AWS operations are needed:\n1. Call list_aws_accounts.\n2. Fuzzy-match the account named in the task.\n3. Call get_aws_credentials with the matched accountId.\n4. Use the returned --profile with every AWS CLI command.`;
    }

    // --- Workdir + backend. virtualMode is MANDATORY: without it FilesystemBackend
    // treats absolute paths as real host paths and the agent could read another
    // tenant's credentials directory, .env, or app source. ---
    const root = tenantWorkdir(tenantId);
    await ensureWorkdir(root);
    const fileStore = new PostgresFileStore(tenantId);
    const backend = new CompositeBackend(
        new FilesystemBackend({ rootDir: root, virtualMode: true }),
        { [MEMORIES_ROUTE]: new StoreBackend({ namespace: () => ['deep-agent'] }) },
    );

    // --- Tools ---
    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId, accountList);
    const executeCommand = createExecuteCommandTool({ cwd: root });
    const getAwsCredentials = createGetAwsCredentialsTool(tenantId);
    const listAwsAccounts = createListAwsAccountsTool(tenantId);
    const researchTools = [
        ...(webSearchAvailable() ? [webSearchTool] : []),
        createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined),
        createAwsReadTool(tenantId, userId),
        ...mcpTools,
    ];

    const allTools = [
        executeCommand,
        getAwsCredentials,
        listAwsAccounts,
        askUserTool,
        ...(webSearchAvailable() ? [webSearchTool] : []),
        writeFileToS3Tool,
        getFileFromS3Tool,
        createGetRightSizingRecommendationsTool(tenantId),
        createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined),
        createAwsReadTool(tenantId, userId),
        // search_memory ONLY. DeepMemoryMiddleware already saves from the whole
        // transcript (extract → reconcile judge → episode); a save_memory tool call
        // is a second blind write of the same finding that races the reconcile UPDATE.
        ...(userId ? createMemoryTools(tenantId, userId).filter(t => t.name === 'search_memory') : []),
        ...(autoLoadSkills !== false ? [createLoadSkillTool(tenantId)] : []),
        ...mcpTools,
    ];

    // --- HITL ---
    const interruptOn = autoApprove ? undefined : {
        execute_command: true,
        write_file: true,
        edit_file: true,
        ask_user: true,
    };

    const memoryMiddleware = createDeepMemoryMiddleware({
        reflectorModel,
        tenantId,
        userId,
        store,
        onMemoryEvent: (config as never as { onMemoryEvent?: (op: 'recall' | 'save', s: string) => void }).onMemoryEvent,
    });

    const subagents = createDeepSubagents({
        accountContext,
        executeCommand: executeCommand as never,
        getAwsCredentials: getAwsCredentials as never,
        listAwsAccounts: listAwsAccounts as never,
        researchTools: researchTools as never,
        interruptOn,
    });

    const systemPrompt = `You are an elite autonomous AI DevOps and Cloud Operations engineer executing an unattended operations task.
${skillSection}${skillCatalogSection}

## Core Identity
You plan comprehensively before acting, use your tools directly, and maintain a to-do list with write_todos so progress is visible to the humans reviewing this run.

## Autonomous Operating Rules
- Nobody is watching this run in real time. Do not ask for confirmation you could establish yourself with a describe/list call.
- Use ask_user ONLY when the task is genuinely ambiguous and no tool can resolve it. It pauses the entire run pending a human reply.
- Finish with a self-contained report: what you checked, what you changed, and the resource IDs involved. It may be read hours later with no other context.

## AWS CLI Standards
- Always use --output json and --profile <profileName> from get_aws_credentials.
- Run describe/list before any mutation; use --dry-run or terraform plan where supported.
- AWS Cost Explorer data covers the last 14 months only.
${accountContext}

## Durable Memory
\`${AGENTS_MD_PATH}\` is your notebook. It is loaded every run and persists across runs. When you learn a durable operating rule — a rejected flag, an environment convention, a correction — append it with edit_file. Record rules, not one-off facts.

Call \`search_memory\` when prior findings would save work. Live data always wins over a stored fact: re-verify before relying on anything recalled.`;

    // A tool error must reach the MODEL, not kill the run. deepagents wraps every
    // tool call, so ToolNode sees failures as middleware errors and re-raises them.
    const handleToolErrors = createMiddleware({
        name: 'HandleToolErrors',
        wrapToolCall: async (request: never, handler: never) => {
            try {
                return await (handler as (r: unknown) => Promise<unknown>)(request);
            } catch (error) {
                if (isGraphInterrupt(error)) throw error;
                const message = error instanceof Error ? error.message : String(error);
                if ((error as { name?: string })?.name === 'AbortError' || /abort/i.test(message)) throw error;
                const req = request as never as { toolCall: { id?: string; name: string } };
                return new ToolMessage({
                    content: `Tool error: ${message}\nCheck your arguments against the tool's schema and try again.`,
                    tool_call_id: req.toolCall.id!,
                    name: req.toolCall.name,
                });
            }
        },
    });

    const repairMessages = createMiddleware({
        name: 'RepairMessages',
        wrapModelCall: async (request: never, handler: never) =>
            (handler as (r: unknown) => Promise<unknown>)({
                ...(request as object),
                messages: repairEmptyAiContent((request as never as { messages: never }).messages),
            }),
    });

    console.log(`[AgentOpsDeep] Graph ready — workdir ${root}, autoApprove=${autoApprove}, tools=${allTools.length}`);

    return createDeepAgent({
        model,
        tools: allTools as never,
        systemPrompt: new SystemMessage(systemPrompt),
        subagents,
        backend,
        memory: [AGENTS_MD_PATH],
        checkpointer,
        store: fileStore as never,
        ...(interruptOn ? { interruptOn } : {}),
        middleware: [todoListMiddleware(), memoryMiddleware, handleToolErrors, repairMessages] as never,
    });
}
```

> If `deep-agent.ts` also passes `contextSchema: deepContextSchema`, add the same here by importing `deepContextSchema` from `@/lib/agent/deep-agent` — the per-run context is what propagates tenantId to sub-agents.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-executor-graph.test.ts`
Expected: PASS, 8 tests. If a mock is missing a symbol the real module imports, add it to the `vi.mock` factory — do not change the implementation to suit the test.

- [ ] **Step 5: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/lib/agent-ops/deep-executor-graph.ts apps/web-ui/lib/agent-ops/deep-executor-graph.test.ts
git commit -m "feat(agent-ops): add deep executor graph"
```

---

### Task 5: Deep run executor

Drives the graph, consumes the v3 projections in parallel, detects interrupts, and moves the run through its statuses.

**Files:**
- Create: `apps/web-ui/lib/agent/deep/projections.ts` (extract the projection interfaces so there is one definition)
- Modify: `apps/web-ui/app/api/chat/deep-stream.ts` (import those types instead of re-declaring)
- Create: `apps/web-ui/lib/agent-ops/deep-run-executor.ts`
- Create: `apps/web-ui/lib/agent-ops/deep-run-executor.test.ts`

**Interfaces:**
- Consumes: `createDeepExecutorGraph` (Task 4), `createDeepEventRecorder` (Task 3), `pendingActions`/`hasPendingInterrupt` from `lib/agent/deep/hitl.ts`, `resolveMaxIterations`/`resolveDefaultMode` (Task 2).
- Produces: `executeDeepRun(run: AgentOpsRun, eventBus?: GatewayEventBus): Promise<void>` and `resumeDeepRun(run: AgentOpsRun, resumeMap: ResumeMap, eventBus?: GatewayEventBus): Promise<void>`, plus `consumeDeepRun(run, recorder, signal)` exported for testing.

- [ ] **Step 1: Extract the projection types**

Create `apps/web-ui/lib/agent/deep/projections.ts` by moving the interface block from `apps/web-ui/app/api/chat/deep-stream.ts` (`ToolCallStatus`, `ToolCallHandle`, `TextStream`, `UsageLike`, `MessageHandle`, `SubagentHandle`, `DeepRun`) verbatim, adding `export` to each:

```typescript
/**
 * Structural types for the deepagents v3 stream projections.
 *
 * Extracted from app/api/chat/deep-stream.ts so the Agent Ops executor and the
 * AI Ops SSE translator describe the same handles instead of keeping two copies
 * that can drift. These are duck-typed against what streamEvents({version:'v3'})
 * yields — there is no runtime import from deepagents here.
 */
export type ToolCallStatus = 'running' | 'finished' | 'error';

export interface ToolCallHandle {
    readonly name: string;
    readonly callId: string;
    readonly input: unknown;
    readonly output: Promise<unknown>;
    readonly status: Promise<ToolCallStatus>;
    readonly error: Promise<string | undefined>;
}

export interface TextStream extends AsyncIterable<string> {}

export interface UsageLike { input_tokens?: number; output_tokens?: number }

export interface MessageHandle {
    readonly node?: string;
    readonly text: TextStream;
    readonly reasoning: TextStream;
    readonly usage: PromiseLike<UsageLike | undefined>;
}

export interface SubagentHandle {
    readonly name: string;
    readonly taskInput: PromiseLike<unknown>;
    readonly output: PromiseLike<unknown>;
    readonly toolCalls: AsyncIterable<ToolCallHandle>;
    readonly messages: AsyncIterable<MessageHandle>;
}

export interface DeepRun extends AsyncIterable<unknown> {
    readonly messages: AsyncIterable<MessageHandle>;
    readonly toolCalls: AsyncIterable<ToolCallHandle>;
    readonly subagents: AsyncIterable<SubagentHandle>;
    readonly values: AsyncIterable<Record<string, unknown>>;
    readonly interrupted: boolean;
}
```

In `deep-stream.ts`, delete those local interfaces and add:

```typescript
import type { ToolCallHandle, MessageHandle, SubagentHandle, DeepRun } from '@/lib/agent/deep/projections';
```

Keep `DeepStreamOptions` where it is — only the projection handles move.

- [ ] **Step 2: Write the failing test**

Create `apps/web-ui/lib/agent-ops/deep-run-executor.test.ts`. It tests `consumeDeepRun` against a hand-built fake `DeepRun`, which is where the parallelism and ordering rules live:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { consumeDeepRun } from './deep-run-executor';
import { createDeepEventRecorder } from './deep-event-recorder';
import type { RecordEventParams } from './record-and-emit';

/** Async iterable from a fixed list. */
async function* iter<T>(items: T[]): AsyncIterable<T> {
    for (const i of items) yield i;
}

function textStream(chunks: string[]) {
    return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}

function message(text: string[], reasoning: string[] = []) {
    return {
        node: 'call_model',
        text: textStream(text),
        reasoning: textStream(reasoning),
        usage: Promise.resolve({ input_tokens: 10, output_tokens: 5 }),
    };
}

function toolCall(name: string, callId: string, output: unknown, status = 'finished') {
    return {
        name, callId, input: { a: 1 },
        output: Promise.resolve(output),
        status: Promise.resolve(status),
        error: Promise.resolve(undefined),
    };
}

function harness() {
    const sink = vi.fn<[RecordEventParams], Promise<void>>().mockResolvedValue(undefined);
    const recorder = createDeepEventRecorder({ runId: 'r1', tenantId: 't1', sink });
    return { sink, recorder, rows: () => sink.mock.calls.map(c => c[0]) };
}

describe('consumeDeepRun', () => {
    beforeEach(() => vi.clearAllMocks());

    it('records accumulated assistant text', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([message(['Hello ', 'world'])]),
            toolCalls: iter([]),
            subagents: iter([]),
            values: iter([]),
        };
        const result = await consumeDeepRun(run as never, recorder, undefined);
        const texts = rows().filter(r => r.eventType === 'execution').map(r => r.content);
        expect(texts.join('')).toContain('Hello world');
        expect(result.finalText).toContain('Hello world');
    });

    it('records reasoning separately', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([message([], ['pondering'])]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };
        await consumeDeepRun(run as never, recorder, undefined);
        expect(rows().some(r => r.metadata?.reasoning === true)).toBe(true);
    });

    it('records a tool call and its result, and collects the tool name', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([]),
            toolCalls: iter([toolCall('execute_command', 'c1', 'ok')]),
            subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run as never, recorder, undefined);
        expect(rows().some(r => r.eventType === 'tool_call' && r.toolName === 'execute_command')).toBe(true);
        expect(rows().some(r => r.eventType === 'tool_result' && r.toolOutput === 'ok')).toBe(true);
        expect(result.toolsUsed).toContain('execute_command');
    });

    it('marks an errored tool result', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([]),
            toolCalls: iter([toolCall('execute_command', 'c1', 'boom', 'error')]),
            subagents: iter([]), values: iter([]),
        };
        await consumeDeepRun(run as never, recorder, undefined);
        const res = rows().find(r => r.eventType === 'tool_result');
        expect(res?.metadata?.status).toBe('error');
    });

    it('records todos from the values projection', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([]), toolCalls: iter([]), subagents: iter([]),
            values: iter([{ todos: [{ content: 'one', status: 'pending' }] }]),
        };
        await consumeDeepRun(run as never, recorder, undefined);
        expect(rows().some(r => r.eventType === 'todo')).toBe(true);
    });

    it('tags sub-agent tool calls with the sub-agent id', async () => {
        const { recorder, rows } = harness();
        const sub = {
            name: 'aws-ops',
            taskInput: Promise.resolve('list buckets'),
            output: Promise.resolve('done'),
            toolCalls: iter([toolCall('execute_command', 'sc1', 'bucket-a')]),
            messages: iter([message(['sub thinking'])]),
        };
        const run = { messages: iter([]), toolCalls: iter([]), subagents: iter([sub]), values: iter([]) };
        await consumeDeepRun(run as never, recorder, undefined);
        const tagged = rows().filter(r => typeof r.metadata?.subagentId === 'string');
        expect(tagged.length).toBeGreaterThan(0);
        expect(rows().some(r => r.eventType === 'subagent')).toBe(true);
    });

    it('gives every row a unique increasing seq even with concurrent producers', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([message(['a']), message(['b'])]),
            toolCalls: iter([toolCall('t1', 'c1', 'x'), toolCall('t2', 'c2', 'y')]),
            subagents: iter([]),
            values: iter([{ todos: [{ content: 'z', status: 'pending' }] }]),
        };
        await consumeDeepRun(run as never, recorder, undefined);
        const seqs = rows().map(r => r.metadata?.seq as number);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    });

    it('stops early when the signal is already aborted', async () => {
        const { recorder, sink } = harness();
        const ac = new AbortController();
        ac.abort();
        const run = {
            messages: iter([message(['should not appear'])]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run as never, recorder, ac.signal);
        expect(result.aborted).toBe(true);
        expect(sink).not.toHaveBeenCalled();
    });

    it('survives a projection that throws without losing the others', async () => {
        const { recorder, rows } = harness();
        const exploding = { async *[Symbol.asyncIterator]() { throw new Error('projection died'); } };
        const run = {
            messages: iter([message(['still recorded'])]),
            toolCalls: exploding,
            subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run as never, recorder, undefined);
        expect(rows().some(r => r.content?.includes('still recorded'))).toBe(true);
        expect(result.errors.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-run-executor.test.ts`
Expected: FAIL — `consumeDeepRun` is not exported.

- [ ] **Step 4: Implement the executor**

Create `apps/web-ui/lib/agent-ops/deep-run-executor.ts`:

```typescript
/**
 * Agent Ops — Deep Run Executor
 *
 * Headless driver for a deep-mode run. The plan-mode sibling is agent-executor.ts's
 * executeAgentRun; this one differs in three ways:
 *
 *   1. It consumes the deepagents v3 PROJECTIONS (messages / toolCalls / subagents /
 *      values) rather than v2 streamEvents, because that is where sub-agents and
 *      real tool callIds are exposed.
 *   2. Every projection is consumed in its OWN task inside Promise.all. Awaiting a
 *      projection inline would serialise parallel sub-agent work — deep-stream.ts
 *      documents this: awaiting `message.text` resolves the whole message.
 *   3. Interrupts are per-action, so the pending set is read from the checkpoint via
 *      hitl.ts's pendingActions() and stored on the run's approvalRequest.
 */
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createDeepExecutorGraph } from './deep-executor-graph';
import { createDeepEventRecorder, type DeepEventRecorder, type DeepTodo } from './deep-event-recorder';
import { recordAndEmit } from './record-and-emit';
import { agentOpsService } from './agent-ops-service';
import { registerRun, cleanupRun, isAborted } from './run-manager';
import { resolveMaxIterations } from './agent-ops-defaults';
import { resolveModelConfig, resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { hasPendingInterrupt, pendingActions, type ResumeMap } from '@/lib/agent/deep/hitl';
import type { DeepRun, MessageHandle, SubagentHandle, ToolCallHandle } from '@/lib/agent/deep/projections';
import type { AgentOpsRun } from './types';
import type { GatewayEventBus } from '@/lib/gateway/event-bus';

const CANCEL_POLL_INTERVAL_MS = 5_000;

export interface DeepConsumeResult {
    finalText: string;
    toolsUsed: string[];
    inputTokens: number;
    outputTokens: number;
    aborted: boolean;
    errors: string[];
}

/** Drain one text projection into the recorder, returning what it produced. */
async function drainText(
    stream: AsyncIterable<string>,
    write: (chunk: string) => Promise<void>,
): Promise<string> {
    let acc = '';
    for await (const chunk of stream) {
        if (!chunk) continue;
        acc += chunk;
        await write(chunk);
    }
    return acc;
}

async function consumeToolCall(
    call: ToolCallHandle,
    recorder: DeepEventRecorder,
    result: DeepConsumeResult,
    subagentId?: string,
): Promise<void> {
    const args = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
    result.toolsUsed.push(call.name);
    await recorder.toolCall({ toolCallId: call.callId, toolName: call.name, args, subagentId });

    const [output, status] = await Promise.all([call.output, call.status]);
    const text = typeof output === 'string'
        ? output
        : output && typeof output === 'object' && 'content' in output
            ? String((output as { content: unknown }).content)
            : JSON.stringify(output ?? '');

    await recorder.toolResult({
        toolCallId: call.callId,
        toolName: call.name,
        output: text,
        status: status === 'error' ? 'error' : 'finished',
        subagentId,
    });
}

async function consumeMessages(
    messages: AsyncIterable<MessageHandle>,
    recorder: DeepEventRecorder,
    result: DeepConsumeResult,
    subagentId?: string,
): Promise<void> {
    for await (const msg of messages) {
        // text and reasoning are independent streams on the same message; both must be
        // iterated concurrently, and neither may be awaited as a whole.
        const [text] = await Promise.all([
            drainText(msg.text, c => recorder.text(c, subagentId)),
            drainText(msg.reasoning, c => recorder.reasoning(c, subagentId)),
        ]);
        if (text.trim()) result.finalText = text;
        const usage = await msg.usage;
        result.inputTokens += usage?.input_tokens ?? 0;
        result.outputTokens += usage?.output_tokens ?? 0;
    }
}

/**
 * Consume every projection of a deep run into the recorder.
 * Exported for tests — production callers use executeDeepRun / resumeDeepRun.
 */
export async function consumeDeepRun(
    run: DeepRun,
    recorder: DeepEventRecorder,
    signal: AbortSignal | undefined,
): Promise<DeepConsumeResult> {
    const result: DeepConsumeResult = {
        finalText: '', toolsUsed: [], inputTokens: 0, outputTokens: 0, aborted: false, errors: [],
    };

    if (signal?.aborted) {
        result.aborted = true;
        return result;
    }

    // Each projection gets its own task. A failure in one must not lose the others,
    // so every task carries its own catch that records the error and returns.
    const guard = (label: string, task: () => Promise<void>) =>
        task().catch((err: unknown) => {
            result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        });

    await Promise.all([
        guard('messages', () => consumeMessages(run.messages, recorder, result)),

        guard('toolCalls', async () => {
            const watchers: Promise<void>[] = [];
            for await (const call of run.toolCalls) {
                // Collected, never awaited in the loop — parallel calls must not serialise.
                watchers.push(consumeToolCall(call, recorder, result));
            }
            await Promise.all(watchers);
        }),

        guard('subagents', async () => {
            const watchers: Promise<void>[] = [];
            for await (const sub of run.subagents) {
                watchers.push((async () => {
                    const id = `${sub.name}-${watchers.length}`;
                    const task = await sub.taskInput.then(t => (typeof t === 'string' ? t : JSON.stringify(t ?? '')));
                    await recorder.subagent({
                        id, role: sub.name, task, status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0,
                    });

                    const inner: DeepConsumeResult = {
                        finalText: '', toolsUsed: [], inputTokens: 0, outputTokens: 0, aborted: false, errors: [],
                    };
                    const subWatchers: Promise<void>[] = [];
                    for await (const call of sub.toolCalls) {
                        subWatchers.push(consumeToolCall(call, recorder, inner, id));
                    }
                    await Promise.all([
                        Promise.all(subWatchers),
                        consumeMessages(sub.messages, recorder, inner, id),
                    ]);

                    const output = await sub.output;
                    await recorder.subagent({
                        id, role: sub.name, task, status: 'done',
                        toolCount: inner.toolsUsed.length,
                        tokensIn: inner.inputTokens, tokensOut: inner.outputTokens,
                        summary: typeof output === 'string' ? output : inner.finalText,
                    });
                    result.toolsUsed.push(...inner.toolsUsed);
                })());
            }
            await Promise.all(watchers);
        }),

        guard('values', async () => {
            for await (const values of run.values) {
                const todos = values?.todos;
                if (Array.isArray(todos)) await recorder.todos(todos as DeepTodo[]);
            }
        }),
    ]);

    return result;
}

async function resolveRunModel(runModel: string | undefined, tenantId: string) {
    if (runModel) return resolveModelConfig(runModel, tenantId);
    return resolveDefaultModelConfig(tenantId);
}

/** Build the graph and the invoke config shared by execute and resume. */
async function prepare(run: AgentOpsRun, recorder: DeepEventRecorder) {
    const tenantId = run.tenantId;
    const maxIterations = await resolveMaxIterations(tenantId);
    const resolvedModel = await resolveRunModel(run.model, tenantId);
    const userId = `agent-ops-${run.runId}`;

    const graph = await createDeepExecutorGraph({
        model: resolvedModel,
        autoApprove: run.autoApprove ?? false,
        accounts: run.accountId ? [{ accountId: run.accountId, accountName: run.accountName || run.accountId }] : [],
        accountId: run.accountId,
        accountName: run.accountName,
        selectedSkill: run.selectedSkill ?? null,
        mcpServerIds: run.mcpServerIds,
        knowledgeBaseIds: run.knowledgeBaseIds,
        tenantId,
        userId,
        maxIterations,
        onMemoryEvent: (op, summary) => { void recorder.memory(op, summary); },
    } as never);

    const invokeConfig = {
        version: 'v3' as const,
        recursionLimit: maxIterations,
        configurable: { thread_id: run.threadId, tenant_id: tenantId, user_id: userId },
        context: { tenantId, userId, threadId: run.threadId },
    };

    return { graph, invokeConfig, tenantId, userId };
}

/**
 * After the projections drain, decide the run's terminal state: cancelled,
 * awaiting_approval (per-action interrupt), awaiting_input (ask_user), or completed.
 */
async function settle(
    run: AgentOpsRun,
    graph: { getState: (c: unknown) => Promise<unknown> },
    threadConfig: unknown,
    recorder: DeepEventRecorder,
    result: DeepConsumeResult,
    startedAt: number,
    eventBus?: GatewayEventBus,
): Promise<void> {
    const { runId, tenantId } = run;

    if (isAborted(runId) || result.aborted) {
        await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
        await recordAndEmit(eventBus, {
            runId, tenantId, eventType: 'final', node: '__cancelled__',
            content: 'Run was cancelled by user.',
            metadata: { durationMs: Date.now() - startedAt },
        });
        eventBus?.emit({ type: 'run:cancelled', runId, tenantId, timestamp: new Date(), data: {} });
        return;
    }

    const state = await graph.getState(threadConfig).catch(() => null) as never;

    if (state && hasPendingInterrupt(state)) {
        const actions = pendingActions(state);
        await recorder.approvalGate(actions);
        await agentOpsService.updateRunStatus(tenantId, runId, 'awaiting_approval', {
            approvalRequest: {
                planSteps: actions.map(a => `${a.toolName}(${JSON.stringify(a.args).slice(0, 200)})`),
                pendingTools: [...new Set(actions.map(a => a.toolName))],
                approvalType: 'deep_actions' as const,
                pendingActions: actions,
            },
        });
        eventBus?.emit({
            type: 'hil:tool_approval', runId, tenantId, timestamp: new Date(),
            data: { pendingTools: [...new Set(actions.map(a => a.toolName))] },
        });
        return;
    }

    const durationMs = Date.now() - startedAt;
    const summary = result.finalText || 'Deep agent run completed.';
    await agentOpsService.updateRunStatus(tenantId, runId, 'completed', {
        result: { summary, toolsUsed: [...new Set(result.toolsUsed)], iterations: 0 },
    });
    await recorder.final(summary);
    await recordAndEmit(eventBus, {
        runId, tenantId, eventType: 'final', node: '__end__',
        content: summary.slice(0, 5000),
        metadata: {
            durationMs, toolsUsed: [...new Set(result.toolsUsed)],
            totalInputTokens: result.inputTokens, totalOutputTokens: result.outputTokens,
            projectionErrors: result.errors.length ? result.errors : undefined,
        },
    });

    const fresh = await agentOpsService.getRun(tenantId, runId);
    eventBus?.emit({ type: 'run:completed', runId, tenantId, timestamp: new Date(), data: { run: fresh ?? run } });
}

/** Poll the run's DB status so a cancel issued on another replica still aborts here. */
function startCancelWatchdog(run: AgentOpsRun, abort: AbortController): () => void {
    let stopped = false;
    (async () => {
        while (!stopped && !abort.signal.aborted) {
            await new Promise(r => setTimeout(r, CANCEL_POLL_INTERVAL_MS));
            if (stopped) return;
            try {
                const fresh = await agentOpsService.getRun(run.tenantId, run.runId);
                if (fresh?.status === 'cancelled') abort.abort();
            } catch { /* never let a status poll kill a healthy run */ }
        }
    })();
    return () => { stopped = true; };
}

export async function executeDeepRun(run: AgentOpsRun, eventBus?: GatewayEventBus): Promise<void> {
    const { runId, tenantId, taskDescription } = run;
    const startedAt = Date.now();
    const abortController = registerRun(runId);
    const recorder = createDeepEventRecorder({
        runId, tenantId, sink: params => recordAndEmit(eventBus, params),
    });
    const stopWatchdog = startCancelWatchdog(run, abortController);

    console.log(`[DeepRunExecutor] ▶ Run ${runId} starting (deep)`);

    try {
        await agentOpsService.updateRunStatus(tenantId, runId, 'in_progress');
        await recordAndEmit(eventBus, {
            runId, tenantId, eventType: 'planning', node: '__start__',
            content: `Deep agent run started. Task: ${taskDescription}`,
            metadata: { mode: 'deep', accountId: run.accountId, accountName: run.accountName },
        });

        const { graph, invokeConfig } = await prepare(run, recorder);
        const deepRun = await (graph as never as {
            streamEvents: (i: unknown, c: unknown) => Promise<DeepRun>;
        }).streamEvents(
            { messages: [new HumanMessage(taskDescription)] },
            { ...invokeConfig, signal: abortController.signal },
        );

        const result = await consumeDeepRun(deepRun, recorder, abortController.signal);
        await settle(run, graph as never, { configurable: { thread_id: run.threadId } }, recorder, result, startedAt, eventBus);
    } catch (error) {
        await handleFailure(run, error, startedAt, eventBus);
    } finally {
        stopWatchdog();
        cleanupRun(runId);
    }
}

export async function resumeDeepRun(
    run: AgentOpsRun,
    resumeMap: ResumeMap,
    eventBus?: GatewayEventBus,
): Promise<void> {
    const { runId, tenantId } = run;
    const startedAt = Date.now();
    const abortController = registerRun(runId);
    const recorder = createDeepEventRecorder({
        runId, tenantId, sink: params => recordAndEmit(eventBus, params),
    });
    const stopWatchdog = startCancelWatchdog(run, abortController);

    console.log(`[DeepRunExecutor] ⏵ Run ${runId} resuming with ${Object.keys(resumeMap).length} interrupt(s)`);

    try {
        await agentOpsService.updateRunStatus(tenantId, runId, 'in_progress');
        const { graph, invokeConfig } = await prepare(run, recorder);
        const deepRun = await (graph as never as {
            streamEvents: (i: unknown, c: unknown) => Promise<DeepRun>;
        }).streamEvents(
            new Command({ resume: resumeMap }),
            { ...invokeConfig, signal: abortController.signal },
        );

        const result = await consumeDeepRun(deepRun, recorder, abortController.signal);
        await settle(run, graph as never, { configurable: { thread_id: run.threadId } }, recorder, result, startedAt, eventBus);
    } catch (error) {
        await handleFailure(run, error, startedAt, eventBus);
    } finally {
        stopWatchdog();
        cleanupRun(runId);
    }
}

async function handleFailure(
    run: AgentOpsRun, error: unknown, startedAt: number, eventBus?: GatewayEventBus,
): Promise<void> {
    const { runId, tenantId } = run;
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = message === 'This operation was aborted'
        || (error instanceof Error && error.name === 'AbortError')
        || isAborted(runId);

    if (isAbort) {
        console.log(`[DeepRunExecutor] 🛑 Run ${runId} cancelled`);
        await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
        await recordAndEmit(eventBus, {
            runId, tenantId, eventType: 'final', node: '__cancelled__',
            content: 'Run was cancelled by user.',
            metadata: { durationMs: Date.now() - startedAt },
        });
        eventBus?.emit({ type: 'run:cancelled', runId, tenantId, timestamp: new Date(), data: {} });
        return;
    }

    console.error(`[DeepRunExecutor] ❌ Run ${runId} failed:`, message);
    await agentOpsService.updateRunStatus(tenantId, runId, 'failed', { error: message });
    await recordAndEmit(eventBus, {
        runId, tenantId, eventType: 'error', node: 'deep_executor',
        content: message,
        metadata: { stack: (error instanceof Error ? error.stack : '')?.slice(0, 2000) },
    });
    eventBus?.emit({ type: 'run:failed', runId, tenantId, timestamp: new Date(), data: { error: message } });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-run-executor.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify the AI Ops stream still typechecks after the projection move**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "deep-stream|projections" | head -20`
Expected: no output.

- [ ] **Step 7: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/lib/agent/deep/projections.ts apps/web-ui/app/api/chat/deep-stream.ts apps/web-ui/lib/agent-ops/deep-run-executor.ts apps/web-ui/lib/agent-ops/deep-run-executor.test.ts
git commit -m "feat(agent-ops): add deep run executor over v3 projections"
```

---

### Task 6: Dispatch on mode and delete the dead sandbox

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/agent-executor.ts`
- Create: `apps/web-ui/lib/agent-ops/agent-executor-dispatch.test.ts`

**Interfaces:**
- Consumes: `executeDeepRun` / `resumeDeepRun` (Task 5).
- Produces: `executeAgentRun` and `resumeApprovedRun` routing deep runs to the deep executor.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent-ops/agent-executor-dispatch.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeDeepRun = vi.fn().mockResolvedValue(undefined);
const resumeDeepRun = vi.fn().mockResolvedValue(undefined);
const createDynamicExecutorGraph = vi.fn();

vi.mock('./deep-run-executor', () => ({
    executeDeepRun: (...a: unknown[]) => executeDeepRun(...a),
    resumeDeepRun: (...a: unknown[]) => resumeDeepRun(...a),
}));
vi.mock('./executor-graphs', () => ({
    createDynamicExecutorGraph: (...a: unknown[]) => { createDynamicExecutorGraph(...a); throw new Error('plan graph reached'); },
}));
vi.mock('./agent-ops-service', () => ({
    agentOpsService: {
        updateRunStatus: vi.fn().mockResolvedValue(undefined),
        recordEvent: vi.fn().mockResolvedValue(undefined),
        getRun: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('./run-manager', () => ({
    registerRun: () => new AbortController(),
    cleanupRun: vi.fn(),
    isAborted: () => false,
}));
vi.mock('../agent/mcp-manager', () => ({ getMCPManager: () => ({ connectServers: vi.fn() }) }));

import { executeAgentRun } from './agent-executor';

const run = (mode: string) => ({
    runId: 'r1', tenantId: 't1', taskDescription: 'do a thing', threadId: 'th1',
    mode, source: 'api', status: 'queued', autoApprove: false,
} as never);

describe('executeAgentRun mode dispatch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('routes a deep run to the deep executor', async () => {
        await executeAgentRun(run('deep'));
        expect(executeDeepRun).toHaveBeenCalledTimes(1);
        expect(createDynamicExecutorGraph).not.toHaveBeenCalled();
    });

    it('leaves a plan run on the plan graph', async () => {
        await executeAgentRun(run('plan'));
        expect(executeDeepRun).not.toHaveBeenCalled();
    });

    it('treats legacy fast rows as plan, not deep', async () => {
        await executeAgentRun(run('fast'));
        expect(executeDeepRun).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/agent-executor-dispatch.test.ts`
Expected: FAIL — `executeDeepRun` not called; the plan graph is reached for a deep run.

- [ ] **Step 3: Add the dispatch**

In `apps/web-ui/lib/agent-ops/agent-executor.ts`, add near the imports:

```typescript
import { executeDeepRun, resumeDeepRun } from './deep-run-executor';
```

As the **first statement** inside `executeAgentRun`, before `registerRun`:

```typescript
    // Deep mode has its own executor: it consumes the v3 projections and has
    // per-action HITL, neither of which the v2 loop below can express.
    if ((run as { mode?: string }).mode === 'deep') {
        return executeDeepRun(run, eventBus);
    }
```

Add the same guard as the first statement of `resumeApprovedRun`. A deep run reaching the *plan* resume path means the caller did not build a resume map, so fail loudly rather than silently re-running:

```typescript
    if ((run as { mode?: string }).mode === 'deep') {
        throw new Error(
            `Run ${run.runId} is deep mode — resume it via POST /api/agent-ops/${run.runId}/decisions, which builds the per-action resume map. resumeApprovedRun cannot resume a deep interrupt.`,
        );
    }
```

- [ ] **Step 4: Delete the dead sandbox**

`sandboxDir` is created at `agent-executor.ts:92` and `:583`, removed at `:392` and `:810`, and **never passed to any tool** — the plan graph uses the module-level `executeCommandTool`, not a cwd-bound one. Remove all six references plus the `SANDBOX_BASE` constant (`:47`) and the now-unused `fs`/`path` imports if nothing else uses them.

Verify nothing else referenced it:

```bash
cd apps/web-ui && grep -n "sandboxDir\|SANDBOX_BASE" lib/agent-ops/agent-executor.ts
```
Expected: no output.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/`
Expected: PASS, including the pre-existing `record-and-emit.test.ts` and `executor-kb.test.ts`.

- [ ] **Step 6: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/lib/agent-ops/agent-executor.ts apps/web-ui/lib/agent-ops/agent-executor-dispatch.test.ts
git commit -m "feat(agent-ops): dispatch deep runs and drop dead sandbox"
```

---

### Task 7: Per-action decisions route

**Files:**
- Create: `apps/web-ui/app/api/agent-ops/[runId]/decisions/route.ts`
- Create: `apps/web-ui/app/api/agent-ops/[runId]/decisions/route.test.ts`

**Interfaces:**
- Consumes: `resumeDeepRun` (Task 5), `toResumeMap` / `pendingActions` from `lib/agent/deep/hitl.ts`, `approvalRequest.pendingActions` (Task 2).
- Produces: `POST /api/agent-ops/[runId]/decisions` accepting `{ decisions: ToolDecision[] }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/app/api/agent-ops/[runId]/decisions/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getRun = vi.fn();
const resumeDeepRun = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: (...a: unknown[]) => getRun(...a), recordEvent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/agent-ops/deep-run-executor', () => ({ resumeDeepRun: (...a: unknown[]) => resumeDeepRun(...a) }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: async () => 't1',
    getAuthSession: async () => ({ user: { email: 'a@b.c' } }),
}));
vi.mock('@/lib/gateway/event-bus', () => ({ getGatewayEventBus: () => ({ emit: vi.fn() }) }));
vi.mock('@/lib/gateway', () => ({ getGatewayService: () => ({}) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { POST } from './route';

const pendingActions = [
    { toolCallId: 'ck:i1#0', toolName: 'execute_command', args: { command: 'ls' }, interruptId: 'i1', index: 0 },
    { toolCallId: 'ck:i1#1', toolName: 'write_file', args: { path: '/a' }, interruptId: 'i1', index: 1 },
];

const awaitingRun = {
    runId: 'r1', tenantId: 't1', mode: 'deep', status: 'awaiting_approval', threadId: 'th1',
    approvalRequest: { planSteps: [], approvalType: 'deep_actions', pendingActions },
};

const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const params = Promise.resolve({ runId: 'r1' });

describe('POST /api/agent-ops/[runId]/decisions', () => {
    beforeEach(() => { vi.clearAllMocks(); getRun.mockResolvedValue(awaitingRun); });

    it('declares the approve permission', async () => {
        const mod = await import('./route');
        expect(mod.authz.POST).toEqual({ action: 'approve', subject: 'Agent' });
    });

    it('resumes when every pending action has a decision', async () => {
        const res = await POST(req({ decisions: [
            { toolCallId: 'ck:i1#0', approved: true },
            { toolCallId: 'ck:i1#1', approved: true },
        ] }), { params });
        expect(res.status).toBe(200);
        expect(resumeDeepRun).toHaveBeenCalledTimes(1);
        const map = resumeDeepRun.mock.calls[0][1];
        expect(map.i1.decisions).toEqual([{ type: 'approve' }, { type: 'approve' }]);
    });

    it('rejects a partial decision set', async () => {
        const res = await POST(req({ decisions: [{ toolCallId: 'ck:i1#0', approved: true }] }), { params });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/Undecided/) });
        expect(resumeDeepRun).not.toHaveBeenCalled();
    });

    it('rejects an unknown toolCallId', async () => {
        const res = await POST(req({ decisions: [
            { toolCallId: 'ck:i1#0', approved: true },
            { toolCallId: 'ck:i1#1', approved: true },
            { toolCallId: 'bogus', approved: true },
        ] }), { params });
        expect(res.status).toBe(400);
        expect(resumeDeepRun).not.toHaveBeenCalled();
    });

    it('turns a rejection into a reject decision carrying the reason', async () => {
        const res = await POST(req({ decisions: [
            { toolCallId: 'ck:i1#0', approved: false, reason: 'too risky' },
            { toolCallId: 'ck:i1#1', approved: true },
        ] }), { params });
        expect(res.status).toBe(200);
        const map = resumeDeepRun.mock.calls[0][1];
        expect(map.i1.decisions[0].type).toBe('reject');
        expect(map.i1.decisions[0].message).toContain('too risky');
    });

    it('409s when the run is not awaiting approval', async () => {
        getRun.mockResolvedValue({ ...awaitingRun, status: 'in_progress' });
        const res = await POST(req({ decisions: [] }), { params });
        expect(res.status).toBe(409);
    });

    it('409s for a non-deep run', async () => {
        getRun.mockResolvedValue({ ...awaitingRun, mode: 'plan' });
        const res = await POST(req({ decisions: [] }), { params });
        expect(res.status).toBe(409);
    });

    it('403s when the run does not belong to the session tenant', async () => {
        getRun.mockResolvedValue(null);
        const res = await POST(req({ decisions: [] }), { params });
        expect(res.status).toBe(403);
    });

    it('400s when decisions is not an array', async () => {
        const res = await POST(req({ decisions: 'nope' }), { params });
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run "app/api/agent-ops/[runId]/decisions/route.test.ts"`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the route**

Create `apps/web-ui/app/api/agent-ops/[runId]/decisions/route.ts`:

```typescript
/**
 * Agent Ops — Deep Per-Action Decisions
 *
 * POST /api/agent-ops/[runId]/decisions
 * Body: { decisions: Array<{ toolCallId, approved, reason?, answer? }> }
 *
 * Deep interrupts are per-action and several can be pending at once (one per
 * parallel sub-agent), so a binary approve/reject on the run cannot express them.
 * This route maps the client's decisions onto the interrupt ids recorded on the
 * run's approvalRequest and resumes with a two-level ResumeMap.
 *
 * The batch path for channel adapters (Slack et al.) lives in ../approve/route.ts,
 * which fans one action out across every pending action.
 */
import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { resumeDeepRun } from '@/lib/agent-ops/deep-run-executor';
import { toResumeMap, syntheticOutput, type PendingAction } from '@/lib/agent/deep/hitl';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';
import { getGatewayService } from '@/lib/gateway';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'approve', subject: 'Agent' },
};

interface ToolDecisionInput {
    toolCallId: string;
    approved: boolean;
    reason?: string;
    answer?: string;
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ runId: string }> },
) {
    try {
        const { runId } = await params;
        const tenantId = await getSessionTenantId();
        const body = await req.json().catch(() => null) as { decisions?: unknown } | null;

        if (!body || !Array.isArray(body.decisions)) {
            return NextResponse.json({ success: false, error: 'decisions must be an array' }, { status: 400 });
        }
        const decisions = body.decisions as ToolDecisionInput[];

        // Ownership: getRun is tenant-scoped, so a miss is a cross-tenant probe.
        const run = await agentOpsService.getRun(tenantId, runId);
        if (!run) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }
        if (run.mode !== 'deep') {
            return NextResponse.json({
                success: false,
                error: `Run is ${run.mode} mode — use POST /api/agent-ops/${runId}/approve instead.`,
            }, { status: 409 });
        }
        if (run.status !== 'awaiting_approval') {
            return NextResponse.json({
                success: false,
                error: `Run is not awaiting approval (current status: ${run.status})`,
            }, { status: 409 });
        }

        const pending = (run.approvalRequest?.pendingActions ?? []) as PendingAction[];
        if (pending.length === 0) {
            return NextResponse.json({
                success: false, error: 'Run has no pending actions recorded.',
            }, { status: 409 });
        }

        const mapped = toResumeMap(pending, decisions as never);
        if (!mapped.ok) {
            return NextResponse.json({ success: false, error: mapped.error }, { status: 400 });
        }

        // Rejected and answered actions never execute, so mirror their outcome into
        // the event log — otherwise the timeline shows a tool card that never settles.
        const byId = new Map(decisions.map(d => [d.toolCallId, d]));
        for (const action of pending) {
            const decision = byId.get(action.toolCallId);
            if (!decision || (decision.approved && action.toolName !== 'ask_user')) continue;
            await agentOpsService.recordEvent({
                runId, tenantId, eventType: 'tool_result', node: 'tools',
                toolName: action.toolName,
                toolOutput: syntheticOutput(action, decision as never),
                metadata: { toolCallId: action.toolCallId, synthetic: true, status: 'finished' },
            });
        }

        const eventBus = getGatewayEventBus();
        getGatewayService();

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.run.decisions',
            severity: 'high',
            apiRoute: 'POST /api/agent-ops/[runId]/decisions',
            httpMethod: 'POST',
            action: 'Submitted Deep Agent Action Decisions',
            resourceType: 'agent',
            resourceId: runId,
            resourceName: runId,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Decided ${decisions.length} action(s) on deep run ${runId}`,
            metadata: {
                tenantId,
                approved: decisions.filter(d => d.approved).map(d => d.toolCallId),
                rejected: decisions.filter(d => !d.approved).map(d => d.toolCallId),
            },
        }).catch(() => {});

        // Fire-and-forget: the executor emits run:completed / run:failed to the bus.
        resumeDeepRun(run, mapped.resume, eventBus).catch(err => {
            console.error(`[Agent Ops API] Deep resume failed for run ${runId}:`, err);
        });

        return NextResponse.json({
            success: true,
            data: { runId, status: 'in_progress', message: 'Decisions accepted — resuming execution.' },
        });
    } catch (error) {
        console.error('[Agent Ops API] Decisions error:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}
```

> `toResumeMap` expects `ToolDecision` from `@/app/api/chat/decisions`. Open that file and confirm the field names (`toolCallId`, `approved`, `reason`, `answer`). If they differ, use the real shape and update `ToolDecisionInput` and the test to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run "app/api/agent-ops/[runId]/decisions/route.test.ts"`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit — GATED, do not run without user approval**

```bash
git add "apps/web-ui/app/api/agent-ops/[runId]/decisions"
git commit -m "feat(agent-ops): add per-action deep decisions route"
```

---

### Task 8: Batch fan-out in the approve route

Keeps every channel adapter working unchanged.

**Files:**
- Modify: `apps/web-ui/app/api/agent-ops/[runId]/approve/route.ts`
- Create: `apps/web-ui/lib/agent-ops/deep-batch-decision.ts`
- Create: `apps/web-ui/lib/agent-ops/deep-batch-decision.test.ts`

**Interfaces:**
- Consumes: `PendingAction` from `lib/agent/deep/hitl.ts`.
- Produces: `fanOutDecision(actions: PendingAction[], action: 'approve' | 'reject'): ResumeMap`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent-ops/deep-batch-decision.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fanOutDecision } from './deep-batch-decision';

const actions = [
    { toolCallId: 'a', toolName: 'execute_command', args: {}, interruptId: 'i1', index: 0 },
    { toolCallId: 'b', toolName: 'write_file', args: {}, interruptId: 'i1', index: 1 },
    { toolCallId: 'c', toolName: 'execute_command', args: {}, interruptId: 'i2', index: 0 },
];

describe('fanOutDecision', () => {
    it('approves every action, grouped by interrupt id', () => {
        const map = fanOutDecision(actions, 'approve');
        expect(map.i1.decisions).toEqual([{ type: 'approve' }, { type: 'approve' }]);
        expect(map.i2.decisions).toEqual([{ type: 'approve' }]);
    });

    it('rejects every action with an explanatory message', () => {
        const map = fanOutDecision(actions, 'reject');
        expect(map.i1.decisions[0].type).toBe('reject');
        expect((map.i1.decisions[0] as { message: string }).message).toMatch(/rejected/i);
    });

    it('answers ask_user with respond, never approve — approve would hang the tool', () => {
        const map = fanOutDecision(
            [{ toolCallId: 'q', toolName: 'ask_user', args: {}, interruptId: 'i9', index: 0 }],
            'approve',
        );
        expect(map.i9.decisions[0].type).toBe('respond');
    });

    it('places decisions at their positional index, not append order', () => {
        const map = fanOutDecision(
            [{ toolCallId: 'z', toolName: 'execute_command', args: {}, interruptId: 'i1', index: 2 }],
            'approve',
        );
        expect(map.i1.decisions[2]).toEqual({ type: 'approve' });
    });

    it('returns an empty map for no actions', () => {
        expect(fanOutDecision([], 'approve')).toEqual({});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-batch-decision.test.ts`
Expected: FAIL — cannot resolve `./deep-batch-decision`.

- [ ] **Step 3: Implement the fan-out**

Create `apps/web-ui/lib/agent-ops/deep-batch-decision.ts`:

```typescript
/**
 * Batch → per-action decision fan-out for deep runs.
 *
 * Channel adapters (Slack, Jira, Discord, Telegram, webhook) offer one
 * approve/reject button for the whole run. Deep interrupts are per-action, so a
 * batch verdict is applied uniformly to every pending action. This keeps every
 * adapter working with zero changes; the web UI uses the per-action route instead.
 *
 * ask_user is special: 'approve' is not a valid outcome for it (the tool's real
 * implementation IS the human's reply), so a batch approve becomes a 'respond'
 * that tells the agent nobody answered.
 */
import type { DeepDecision, PendingAction, ResumeMap } from '@/lib/agent/deep/hitl';

const NO_ANSWER = 'No answer was provided (bulk approval from a channel). Proceed with your best judgment or finish and state the open question.';

export function fanOutDecision(actions: PendingAction[], action: 'approve' | 'reject'): ResumeMap {
    const resume: ResumeMap = {};

    for (const item of actions) {
        let decision: DeepDecision;
        if (item.toolName === 'ask_user') {
            decision = {
                type: 'respond',
                message: action === 'approve' ? NO_ANSWER : 'The user declined to answer.',
            };
        } else if (action === 'approve') {
            decision = { type: 'approve' };
        } else {
            decision = {
                type: 'reject',
                message: 'Rejected by user from the originating channel. Do not retry this exact action; adapt or ask.',
            };
        }
        (resume[item.interruptId] ??= { decisions: [] }).decisions[item.index] = decision;
    }

    return resume;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/deep-batch-decision.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the approve route**

In `apps/web-ui/app/api/agent-ops/[runId]/approve/route.ts` add the imports:

```typescript
import { fanOutDecision } from '@/lib/agent-ops/deep-batch-decision';
import { resumeDeepRun } from '@/lib/agent-ops/deep-run-executor';
import type { PendingAction } from '@/lib/agent/deep/hitl';
```

Immediately **after** the existing `run.status !== 'awaiting_approval'` 409 check, insert the deep branch:

```typescript
        // ── DEEP: fan the batch verdict out across every pending action ───────
        if (run.mode === 'deep') {
            const pending = (run.approvalRequest?.pendingActions ?? []) as PendingAction[];
            if (pending.length === 0) {
                return NextResponse.json({
                    error: 'Deep run has no pending actions recorded.',
                }, { status: 409 });
            }

            const eventBus = getGatewayEventBus();
            getGatewayService();

            await agentOpsService.recordEvent({
                runId, tenantId,
                eventType: action === 'approve' ? 'planning' : 'final',
                node: 'deep_approval_gate',
                content: `All ${pending.length} pending action(s) ${action === 'approve' ? 'approved' : 'rejected'} via channel.`,
                metadata: { batch: true, tools: [...new Set(pending.map(p => p.toolName))] },
            });

            const session = await getAuthSession();
            AuditService.logUserAction({
                eventType: action === 'approve' ? 'agent.run.approved' : 'agent.run.rejected',
                severity: action === 'approve' ? 'high' : 'medium',
                apiRoute: 'POST /api/agent-ops/[runId]/approve',
                httpMethod: 'POST',
                action: action === 'approve' ? 'Approved Deep Agent Run' : 'Rejected Deep Agent Run',
                resourceType: 'agent',
                resourceId: runId,
                resourceName: runId,
                user: session?.user?.email || 'unknown',
                userType: 'user',
                status: 'success',
                details: `${action} ${pending.length} deep action(s) on run ${runId}`,
                metadata: { tenantId, batch: true },
            }).catch(() => {});

            // Both verdicts resume the graph. A rejection is NOT a cancellation:
            // the agent receives the rejection messages and decides how to adapt.
            resumeDeepRun(run, fanOutDecision(pending, action as 'approve' | 'reject'), eventBus)
                .then(async () => {
                    const fresh = await agentOpsService.getRun(tenantId, runId);
                    if (fresh) await finalizeScheduledRun(fresh, { countRun: false });
                })
                .catch(err => console.error(`[Agent Ops API] Deep resume failed for run ${runId}:`, err));

            return NextResponse.json({
                runId,
                status: 'in_progress',
                message: `All pending actions ${action === 'approve' ? 'approved' : 'rejected'} — resuming execution.`,
            });
        }
```

- [ ] **Step 6: Verify nothing regressed**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: tests pass; no new type errors.

- [ ] **Step 7: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/lib/agent-ops/deep-batch-decision.ts apps/web-ui/lib/agent-ops/deep-batch-decision.test.ts "apps/web-ui/app/api/agent-ops/[runId]/approve/route.ts"
git commit -m "feat(agent-ops): fan channel approvals out across deep actions"
```

---

### Task 9: Timeline — todo and sub-agent steps

**Files:**
- Modify: `apps/web-ui/components/agent-ops/run-timeline/build-steps.ts`
- Modify: `apps/web-ui/components/agent-ops/run-timeline/build-steps.test.ts`
- Create: `apps/web-ui/components/agent-ops/run-timeline/todo-step.tsx`
- Create: `apps/web-ui/components/agent-ops/run-timeline/subagent-step.tsx`
- Modify: `apps/web-ui/components/agent-ops/run-timeline/timeline.tsx`

**Interfaces:**
- Consumes: `AgentEventType` with `'todo' | 'subagent'` (Task 2), `metadata.seq` / `metadata.subagentId` / `metadata.todos` (Task 3).
- Produces: `TimelineStep` variants `{kind:'todo'}` and `{kind:'subagent'}`; components `TodoStep`, `SubagentStep`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web-ui/components/agent-ops/run-timeline/build-steps.test.ts`:

```typescript
describe("buildSteps — deep mode", () => {
  const ev = (over: Partial<AgentOpsEvent> & { eventType: string }): AgentOpsEvent => ({
    PK: "RUN#r1", SK: "", runId: "r1", node: "n", createdAt: "2026-08-24T10:00:00.000Z", ttl: 0,
    ...over,
  } as AgentOpsEvent);

  it("sorts by metadata.seq, not insertion order", () => {
    const steps = buildSteps([
      ev({ eventType: "execution", content: "second", createdAt: "2026-08-24T10:00:00.000Z", metadata: { seq: 1 } }),
      ev({ eventType: "execution", content: "first", createdAt: "2026-08-24T10:00:00.000Z", metadata: { seq: 0 } }),
    ], "completed");
    const contents = steps.flatMap(s => (s.kind === "group" ? s.steps : [s]))
      .map(s => (s.kind === "thinking" ? s.event.content : undefined))
      .filter(Boolean);
    expect(contents).toEqual(["first", "second"]);
  });

  it("keeps only the latest todo state", () => {
    const steps = buildSteps([
      ev({ eventType: "todo", metadata: { seq: 0, todos: [{ content: "a", status: "pending" }] } }),
      ev({ eventType: "todo", metadata: { seq: 1, todos: [{ content: "a", status: "completed" }] } }),
    ], "completed");
    const todos = steps.filter(s => s.kind === "todo");
    expect(todos).toHaveLength(1);
    expect((todos[0] as { todos: Array<{ status: string }> }).todos[0].status).toBe("completed");
  });

  it("groups events tagged with the same subagentId", () => {
    const steps = buildSteps([
      ev({ eventType: "subagent", metadata: { seq: 0, subagentId: "s1", name: "aws-ops", status: "running", task: "list" } }),
      ev({ eventType: "tool_call", toolName: "execute_command", metadata: { seq: 1, subagentId: "s1" } }),
      ev({ eventType: "tool_result", toolName: "execute_command", toolOutput: "ok", metadata: { seq: 2, subagentId: "s1" } }),
      ev({ eventType: "subagent", metadata: { seq: 3, subagentId: "s1", name: "aws-ops", status: "done", task: "list", summary: "4 buckets" } }),
    ], "completed");
    const subs = steps.filter(s => s.kind === "subagent");
    expect(subs).toHaveLength(1);
    const sub = subs[0] as { name: string; status: string; steps: unknown[] };
    expect(sub.name).toBe("aws-ops");
    expect(sub.status).toBe("done");
    expect(sub.steps.length).toBeGreaterThan(0);
  });

  it("keeps parent-level tool calls out of sub-agent groups", () => {
    const steps = buildSteps([
      ev({ eventType: "tool_call", toolName: "list_aws_accounts", metadata: { seq: 0 } }),
      ev({ eventType: "tool_result", toolName: "list_aws_accounts", toolOutput: "ok", metadata: { seq: 1 } }),
      ev({ eventType: "subagent", metadata: { seq: 2, subagentId: "s1", name: "research", status: "done", task: "look up" } }),
    ], "completed");
    expect(steps.some(s => s.kind === "subagent")).toBe(true);
    const flat = steps.flatMap(s => (s.kind === "group" ? s.steps : [s]));
    expect(flat.some(s => s.kind === "tool" && s.toolName === "list_aws_accounts")).toBe(true);
  });

  it("still handles a plan-mode run with no seq metadata", () => {
    const steps = buildSteps([
      ev({ eventType: "planning", content: "p", createdAt: "2026-08-24T10:00:00.000Z" }),
      ev({ eventType: "final", content: "f", createdAt: "2026-08-24T10:00:01.000Z" }),
    ], "completed");
    expect(steps.map(s => s.kind)).toEqual(["planning", "final"]);
  });
});
```

Add `import type { AgentOpsEvent } from "@/lib/agent-ops/types";` at the top if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/agent-ops/run-timeline/build-steps.test.ts`
Expected: FAIL — no `todo` or `subagent` step kinds.

- [ ] **Step 3: Extend `build-steps.ts`**

Add the two variants to the `TimelineStep` union:

```typescript
  | { kind: "todo"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; event: AgentOpsEvent }
  | { kind: "subagent"; subagentId: string; name: string; task: string; status: "running" | "done" | "failed"; summary?: string; steps: TimelineStep[] }
```

At the top of `buildSteps`, sort by `seq` when present, and split off sub-agent events:

```typescript
export function buildSteps(events: AgentOpsEvent[], runStatus: AgentOpsStatus): TimelineStep[] {
  const runActive = ACTIVE_STATUSES.includes(runStatus);

  // Deep runs write rows from several concurrent producers, so createdAt ties are
  // common and the DB can only order by it. metadata.seq is the authoritative
  // order when present; plan-mode rows have none and keep their arrival order.
  const seqOf = (e: AgentOpsEvent): number | undefined => {
    const s = (e.metadata as { seq?: unknown } | undefined)?.seq;
    return typeof s === "number" ? s : undefined;
  };
  const ordered = [...events].sort((a, b) => {
    const sa = seqOf(a), sb = seqOf(b);
    if (sa !== undefined && sb !== undefined) return sa - sb;
    return ts(a) - ts(b);
  });

  const subIdOf = (e: AgentOpsEvent): string | undefined => {
    const id = (e.metadata as { subagentId?: unknown } | undefined)?.subagentId;
    return typeof id === "string" ? id : undefined;
  };

  // Partition: sub-agent-tagged rows are folded into their own groups so the
  // parent timeline stays readable when several sub-agents run in parallel.
  const parentEvents: AgentOpsEvent[] = [];
  const bySubagent = new Map<string, AgentOpsEvent[]>();
  for (const e of ordered) {
    const id = subIdOf(e);
    if (id) {
      const list = bySubagent.get(id) ?? [];
      list.push(e);
      bySubagent.set(id, list);
    } else {
      parentEvents.push(e);
    }
  }
  ...
```

Replace the `for (const e of events)` loop header with `for (const e of parentEvents)`, and add two cases to the switch:

```typescript
      case "todo": {
        const todos = (e.metadata as { todos?: unknown } | undefined)?.todos;
        if (Array.isArray(todos)) flat.push({ kind: "todo", todos: todos as never, event: e });
        break;
      }
      case "subagent":
        // Handled in the sub-agent fold below — a lifecycle row carries subagentId,
        // so it never reaches here unless it was written without one.
        break;
```

After the existing `for (const open of openTools) ...` line, build the sub-agent steps and splice them in. Insert before pass 2:

```typescript
  // Fold each sub-agent's rows into one collapsible step, placed at the position of
  // its FIRST row so the parent narrative order is preserved.
  const subSteps: Array<{ seq: number; step: TimelineStep }> = [];
  for (const [subagentId, rows] of bySubagent) {
    const lifecycle = rows.filter(r => r.eventType === "subagent");
    const last = lifecycle[lifecycle.length - 1];
    const meta = (last?.metadata ?? {}) as { name?: string; task?: string; status?: string; summary?: string };
    const inner = buildSteps(
      rows.filter(r => r.eventType !== "subagent").map(r => ({ ...r, metadata: { ...(r.metadata as object), subagentId: undefined } })),
      runStatus,
    );
    subSteps.push({
      seq: seqOf(rows[0]) ?? ts(rows[0]),
      step: {
        kind: "subagent",
        subagentId,
        name: meta.name ?? subagentId,
        task: meta.task ?? "",
        status: (meta.status as "running" | "done" | "failed") ?? (runActive ? "running" : "done"),
        summary: meta.summary,
        steps: inner,
      },
    });
  }
  // Latest-wins for todos: a run rewrites the list on every write_todos call.
  const todoSteps = flat.filter(s => s.kind === "todo");
  const keptTodo = todoSteps[todoSteps.length - 1];
  let flatNoTodos = flat.filter(s => s.kind !== "todo");
  if (keptTodo) flatNoTodos = [keptTodo, ...flatNoTodos];
  const withSubs = [...flatNoTodos, ...subSteps.map(s => s.step)];
```

Then change pass 2 to iterate `withSubs` instead of `flat`, and add `"todo"` and `"subagent"` to the list of kinds that **flush** the current group (they are not "work" steps):

```typescript
  for (const step of withSubs) {
    if (step.kind === "tool" || step.kind === "thinking") segment.push(step);
    else { flush(); out.push(step); }
  }
```

> The recursive `buildSteps` call strips `subagentId` before recursing so the inner rows are treated as parent-level. If a sub-agent ever nests another sub-agent, this recursion handles it naturally.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run components/agent-ops/run-timeline/build-steps.test.ts`
Expected: PASS — the existing cases plus the 5 new ones.

- [ ] **Step 5: Create `todo-step.tsx`**

```tsx
"use client";

import { CheckCircle2, Circle, Loader2, ListChecks } from "lucide-react";
import { StepShell } from "./step-shell";
import { cn } from "@/lib/utils";

type Todo = { content: string; status: "pending" | "in_progress" | "completed" };

const ICON = {
  completed: <CheckCircle2 className="size-3.5 text-green-600" />,
  in_progress: <Loader2 className="size-3.5 animate-spin text-primary" />,
  pending: <Circle className="size-3.5 text-muted-foreground" />,
} as const;

export function TodoStep({ todos }: { todos: Todo[] }) {
  const done = todos.filter(t => t.status === "completed").length;

  return (
    <StepShell
      icon={<ListChecks className="size-3.5" />}
      iconClass="bg-primary/10 text-primary"
      title="Plan"
      meta={<span className="shrink-0 text-xs text-muted-foreground">{done}/{todos.length}</span>}
      defaultOpen
    >
      <ul className="space-y-1.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">{ICON[t.status] ?? ICON.pending}</span>
            <span className={cn("min-w-0", t.status === "completed" && "text-muted-foreground line-through")}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </StepShell>
  );
}
```

- [ ] **Step 6: Create `subagent-step.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";
import { Bot, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { StepShell } from "./step-shell";
import type { TimelineStep } from "./build-steps";

const STATUS = {
  running: { icon: <Loader2 className="size-3.5 animate-spin" />, cls: "bg-primary/10 text-primary" },
  done: { icon: <CheckCircle2 className="size-3.5" />, cls: "bg-green-500/10 text-green-600" },
  failed: { icon: <XCircle className="size-3.5" />, cls: "bg-red-500/10 text-red-600" },
} as const;

export function SubagentStep({
  step,
  renderStep,
}: {
  step: Extract<TimelineStep, { kind: "subagent" }>;
  renderStep: (s: TimelineStep, i: number) => ReactNode;
}) {
  const status = STATUS[step.status] ?? STATUS.running;

  return (
    <StepShell
      icon={status.icon ?? <Bot className="size-3.5" />}
      iconClass={status.cls}
      title={<span className="font-mono text-xs">{step.name}</span>}
      meta={
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
          {step.summary || step.task}
        </span>
      }
      running={step.status === "running"}
      defaultOpen={step.status === "running"}
    >
      <div className="space-y-2">
        {step.task && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Task:</span> {step.task}
          </p>
        )}
        {step.steps.length > 0
          ? <div className="space-y-2">{step.steps.map((s, i) => renderStep(s, i))}</div>
          : <p className="text-xs text-muted-foreground">No recorded activity.</p>}
      </div>
    </StepShell>
  );
}
```

- [ ] **Step 7: Wire both into `timeline.tsx`**

Add the imports:

```typescript
import { TodoStep } from "./todo-step";
import { SubagentStep } from "./subagent-step";
```

Add two cases to `StepRenderer`'s switch, before `case "group"`:

```typescript
    case "todo": return <TodoStep todos={step.todos} />;
    case "subagent":
      return (
        <SubagentStep
          step={step}
          renderStep={(s, i) => <StepRenderer key={i} step={s} timezone={timezone} />}
        />
      );
```

- [ ] **Step 8: Verify**

Run: `cd apps/web-ui && bunx vitest run components/agent-ops/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: tests pass; no type errors (the switch is now exhaustive).

- [ ] **Step 9: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/components/agent-ops/run-timeline/
git commit -m "feat(agent-ops): render deep todos and sub-agent groups in the timeline"
```

---

### Task 10: Deep approval card

**Files:**
- Create: `apps/web-ui/components/agent-ops/deep-approval-card.tsx`
- Modify: `apps/web-ui/app/app/agent-ops/[runId]/page.tsx`
- Modify: `apps/web-ui/lib/queries/agent-ops.ts`
- Modify: `apps/web-ui/lib/queries/query-keys.ts` (only if a new key is needed)

**Interfaces:**
- Consumes: `POST /[runId]/decisions` (Task 7), `approvalRequest.pendingActions` (Task 2).
- Produces: `useSubmitDecisions()` mutation hook; `DeepApprovalCard` component.

- [ ] **Step 1: Add the mutation hook**

In `apps/web-ui/lib/queries/agent-ops.ts`, follow the shape of the existing `useApproveRun` (read it first) and add:

```typescript
export function useSubmitDecisions() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ runId, decisions }: {
            runId: string;
            decisions: Array<{ toolCallId: string; approved: boolean; reason?: string; answer?: string }>;
        }) => {
            const res = await fetch(`/api/agent-ops/${runId}/decisions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decisions }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to submit decisions');
            return data;
        },
        onSuccess: (_d, { runId }) => {
            queryClient.invalidateQueries({ queryKey: queryKeys.agentOps.detail(runId) });
        },
    });
}
```

> Match the existing file's import style and the exact `queryKeys.agentOps.*` accessor it already uses. If `useApproveRun` invalidates a different key, use that one.

- [ ] **Step 2: Create the card**

Create `apps/web-ui/components/agent-ops/deep-approval-card.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, ShieldX, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useSubmitDecisions } from "@/lib/queries/agent-ops";

export interface PendingActionView {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

type Verdict = { approved: boolean; reason?: string; answer?: string };

/**
 * Per-action approval for a deep run. Every pending action needs a decision
 * before the run can resume — the API rejects a partial set — so the submit
 * button stays disabled until all of them are decided.
 */
export function DeepApprovalCard({
  runId,
  actions,
}: {
  runId: string;
  actions: PendingActionView[];
}) {
  const submit = useSubmitDecisions();
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});

  const set = (id: string, v: Verdict) => setVerdicts(prev => ({ ...prev, [id]: v }));
  const undecided = actions.filter(a => !verdicts[a.toolCallId]);

  const decideAll = (approved: boolean) =>
    setVerdicts(Object.fromEntries(actions.map(a => [a.toolCallId, { approved }])));

  const onSubmit = () => {
    submit.mutate(
      { runId, decisions: actions.map(a => ({ toolCallId: a.toolCallId, ...verdicts[a.toolCallId] })) },
      {
        onSuccess: () => toast.success("Decisions submitted — run resuming"),
        onError: (err: Error) => toast.error(err.message),
      },
    );
  };

  return (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-700 dark:bg-amber-950/20">
      <p className="mb-3 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <ShieldCheck className="h-4 w-4" /> Approval required
        <Badge variant="outline" className="ml-auto border-amber-400 text-xs text-amber-600">
          {actions.length} action{actions.length === 1 ? "" : "s"}
        </Badge>
      </p>

      <div className="mb-3 space-y-2">
        {actions.map(action => {
          const verdict = verdicts[action.toolCallId];
          const isQuestion = action.toolName === "ask_user";
          return (
            <div key={action.toolCallId} className="rounded-md border bg-background p-3">
              <div className="mb-2 flex items-center gap-2">
                {isQuestion && <MessageCircleQuestion className="size-4 shrink-0 text-primary" />}
                <code className="text-xs font-semibold">{action.toolName}</code>
                {verdict && (
                  <Badge variant="outline" className={verdict.approved ? "border-green-400 text-xs text-green-600" : "border-red-400 text-xs text-red-600"}>
                    {verdict.approved ? (isQuestion ? "answered" : "approved") : "rejected"}
                  </Badge>
                )}
              </div>

              <pre className="mb-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(action.args, null, 2)}
              </pre>

              {isQuestion ? (
                <div className="space-y-2">
                  <Textarea
                    placeholder="Your answer…"
                    className="text-sm"
                    value={verdict?.answer ?? ""}
                    onChange={e => set(action.toolCallId, { approved: true, answer: e.target.value })}
                  />
                  <Button size="sm" variant="outline" onClick={() => set(action.toolCallId, { approved: false })}>
                    Decline to answer
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="bg-green-600 text-white hover:bg-green-700"
                    onClick={() => set(action.toolCallId, { approved: true })}
                  >
                    <ShieldCheck className="mr-1.5 size-3.5" /> Approve
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => set(action.toolCallId, { approved: false })}>
                    <ShieldX className="mr-1.5 size-3.5" /> Reject
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => decideAll(true)}>Approve all</Button>
        <Button size="sm" variant="outline" onClick={() => decideAll(false)}>Reject all</Button>
        <Button
          className="ml-auto"
          disabled={undecided.length > 0 || submit.isPending}
          onClick={onSubmit}
        >
          {submit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {undecided.length > 0 ? `${undecided.length} left to decide` : "Submit & resume"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Branch the run detail page**

In `apps/web-ui/app/app/agent-ops/[runId]/page.tsx`, add the import:

```typescript
import { DeepApprovalCard } from "@/components/agent-ops/deep-approval-card"
```

Change the existing approval block's condition so the deep card takes precedence. Replace the opening line of that block:

```tsx
          {run.status === "awaiting_approval" && run.approvalRequest?.approvalType === "deep_actions" && (
            <DeepApprovalCard
              runId={runId}
              actions={(run.approvalRequest.pendingActions ?? []).map(a => ({
                toolCallId: a.toolCallId,
                toolName: a.toolName,
                args: a.args,
              }))}
            />
          )}

          {run.status === "awaiting_approval" && run.approvalRequest && run.approvalRequest.approvalType !== "deep_actions" && (
```

…leaving the rest of the existing plan/tool_execution block unchanged.

Also update the badge label in that block so the third type reads correctly:

```tsx
                  {run.approvalRequest.approvalType === "plan" ? "Plan" : "Tool execution"}
```
stays as-is, since the deep case now returns earlier.

- [ ] **Step 4: Verify**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors.

Run: `cd apps/web-ui && bun run lint`
Expected: no new warnings in the touched files.

- [ ] **Step 5: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/components/agent-ops/deep-approval-card.tsx "apps/web-ui/app/app/agent-ops/[runId]/page.tsx" apps/web-ui/lib/queries/agent-ops.ts
git commit -m "feat(agent-ops): add per-action deep approval card"
```

---

### Task 11: Mode selectors

**Files:**
- Modify: `apps/web-ui/components/agent-ops/new-run-dialog.tsx`
- Modify: `apps/web-ui/components/agent-ops/scheduled-task-dialog.tsx`
- Modify: `apps/web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts`
- Modify: `apps/web-ui/components/agent-ops/agent-ops-settings-form.tsx`

**Interfaces:**
- Consumes: `SELECTABLE_MODES` / `resolveDefaultMode` (Task 2).
- Produces: `mode` sent on run creation and stored on scheduled tasks.

- [ ] **Step 1: Add the selector to the New Run dialog**

In `apps/web-ui/components/agent-ops/new-run-dialog.tsx`, add state:

```typescript
    const [mode, setMode] = useState<"plan" | "deep">("plan")
```

Include it in the POST body:

```typescript
                body: JSON.stringify({
                    taskDescription: taskDescription.trim(),
                    mode,
                }),
```

Add the control above the dialog footer, importing `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` from `@/components/ui/select` and `Label` (already imported):

```tsx
                    <div className="space-y-2">
                        <Label htmlFor="run-mode">Execution mode</Label>
                        <Select value={mode} onValueChange={v => setMode(v as "plan" | "deep")}>
                            <SelectTrigger id="run-mode">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="plan">Plan &amp; execute — evaluator picks a skill, then plans and reflects</SelectItem>
                                <SelectItem value="deep">Deep — sub-agents, to-do list, and a virtual filesystem</SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            Deep suits long multi-step investigations. Plan suits focused, single-goal tasks.
                        </p>
                    </div>
```

- [ ] **Step 2: Add the selector to the scheduled task dialog**

`scheduled-task-dialog.tsx:113` currently carries the comment "Mode is not sent: Agent Ops runs are always plan-mode." That is no longer true.

Add `mode` to the form state initialiser:

```typescript
        mode: task?.mode === "deep" ? "deep" : "plan",
```

Delete the "Mode is not sent" comment and include the field in the payload built at that spot:

```typescript
            mode: form.mode,
```

Add the control next to the existing `scheduleType` select (`:204`), using this file's plain `Select value=… onValueChange=…` house style:

```tsx
                    <div className="space-y-2">
                        <Label htmlFor="task-mode">Execution mode</Label>
                        <Select value={form.mode} onValueChange={v => set("mode", v)}>
                            <SelectTrigger id="task-mode">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="plan">Plan &amp; execute</SelectItem>
                                <SelectItem value="deep">Deep (sub-agents)</SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            Deep runs use sub-agents and a to-do list. Existing tasks keep Plan unless changed.
                        </p>
                    </div>
```

- [ ] **Step 3: Honour the stored mode when a scheduled task fires**

`trigger/route.ts:112` already passes `mode: task.mode`, so a task saved as deep will dispatch to the deep executor via Task 6. Verify with:

```bash
cd apps/web-ui && grep -n "mode: task.mode" "app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts"
```
Expected: one match. If the field is absent, add it to the `createRun` call.

- [ ] **Step 4: Add the tenant default to the settings form**

In `agent-ops-settings-form.tsx`, add a `defaultMode` select alongside the existing `defaultModel` and `maxIterations` fields, posting to the existing `PUT /api/agent-ops/settings/defaults`. Then confirm that route calls `validateAgentOpsDefaults` (Task 2 already accepts and validates `defaultMode`):

```bash
cd apps/web-ui && grep -n "validateAgentOpsDefaults" app/api/agent-ops/settings/defaults/route.ts
```
Expected: one match. If the route builds its payload field-by-field, add `defaultMode` there too.

- [ ] **Step 5: Verify**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | head -20 && bun run lint`
Expected: clean.

Run: `cd apps/web-ui && bun run test`
Expected: the **whole** suite passes.

- [ ] **Step 6: Commit — GATED, do not run without user approval**

```bash
git add apps/web-ui/components/agent-ops/ "apps/web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts" apps/web-ui/app/api/agent-ops/settings/defaults/route.ts
git commit -m "feat(agent-ops): let runs and scheduled tasks choose deep mode"
```

---

## Manual verification

Automated tests cannot cover a real deep run — it needs live Bedrock. After Task 11:

- [ ] `docker compose up -d postgres && bun run dev`
- [ ] Start a **plan** run from the New Run dialog. Confirm the timeline looks exactly as before — this is the no-regression check.
- [ ] Start a **deep** run with a multi-step task (e.g. "audit S3 buckets in prod for public access and summarise"). Confirm: a Plan checklist appears and updates; sub-agent groups appear and expand; tool cards settle.
- [ ] With `autoApprove: false`, confirm the run parks in `awaiting_approval` and the per-action card lists each gated call. Approve one and reject another; confirm the rejected tool shows a synthetic result and the agent adapts.
- [ ] Trigger a deep run from Slack. Confirm the existing approve/reject buttons still resume it (batch fan-out).
- [ ] Save a scheduled task as deep, fire it with "Run now", and confirm it dispatches to the deep executor.
- [ ] Cancel a running deep run; confirm status flips to `cancelled` within ~5s.
- [ ] Confirm `/memories/AGENTS.md` written by an AI Ops deep chat is visible to an Agent Ops deep run in the same tenant (the shared-workdir consequence the spec calls out).
