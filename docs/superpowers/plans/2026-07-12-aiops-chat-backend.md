# AIOps Chat Backend Overhaul Implementation Plan (Phases 0–1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four chat correctness gaps — batch approval running unapproved tools, no destructive-action guard, no clarification mechanism, plan state never reaching the UI — behind the existing UI, after upgrading to AI SDK 7.

**Architecture:** Insert `guard` → `approval_gate` nodes between the model node and `tools` in both chat graphs (fast + planning); always compile with `interruptBefore: ["approval_gate"]` and route into the gate only when needed (mutative call, ask_user, or auto-approve off). Extend `/api/chat` with a per-tool `decisions` resume contract and typed data parts (`data-plan`, `data-phase`, `data-guard`, `data-approval`, `data-clarification`) on the UI Message Stream. `collectingToolNode` skips tool calls that already have results — the graph-level fix for "approve one, run all".

**Tech Stack:** LangGraph (`@langchain/langgraph` ^1.2), AI SDK 7 (`ai`, `@ai-sdk/react`), Next.js 15 App Router, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-aiops-chat-overhaul-design.md`

## Global Constraints

- Server-side agent execution stays LangGraph — do NOT adopt AI SDK `ToolLoopAgent`/`WorkflowAgent`.
- Guard is fail-closed: classifier error, unknown tool, or risk-LLM failure ⇒ treated as mutative / severity `HIGH` ⇒ approval required.
- Mutative tool calls ALWAYS route to `approval_gate`, even when `autoApprove` is true.
- The legacy resume contract (`role:'tool'` message, content `'Approved'` or rejection text) must keep working until Plan B ships the new UI.
- Existing wire behavior (phase markers in reasoning text, tool-input/output chunks) must keep working — Phase 1 ADDS data parts alongside, never removes.
- Multi-tenant scoping rules apply (thread IDs are `tenantId:userId:ts`; audit via `AuditService`).
- Tests: Vitest, run with `cd apps/web-ui && bun run test`. Some pre-existing failures exist in the suite (mock-harness related, ~41); the gate is "no NEW failures" — record the baseline count in Task 1 and compare.
- Commit style: conventional commits (`feat(ai-ops): …`, `chore(deps): …`).
- Work on branch `ai-ops`.

---

### Task 1: Upgrade AI SDK to v7 (Phase 0)

The web-ui is on `ai` ^5.0.115 / `@ai-sdk/react` ^2.0.116. Upgrade to v7 with the official codemod. Consumers of the SDK in this repo: `app/api/chat/route.ts` (`createUIMessageStreamResponse`, `UIMessageChunk`), `components/agent/chat-interface.tsx` (`useChat`, `addToolResult`, `sendMessage`), `app/api/ask-ai/route.ts`, and any `@ai-sdk/langchain` usage.

**Files:**
- Modify: `apps/web-ui/package.json` (deps: `ai`, `@ai-sdk/react`, `@ai-sdk/langchain`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/anthropic`)
- Modify: whatever the codemod touches (expect `app/api/chat/route.ts`, `app/api/ask-ai/route.ts`, `components/agent/chat-interface.tsx`)

**Interfaces:**
- Produces: a working v7 install. Later tasks rely on: `createUIMessageStreamResponse` (same name in v7), `UIMessageChunk` union including `data-*` chunks of shape `{ type: \`data-${string}\`, id?: string, data: unknown }`, and `useChat` from `@ai-sdk/react`.

- [ ] **Step 1: Record the test baseline**

Run: `cd apps/web-ui && bun run test 2>&1 | tail -5`
Record the pass/fail counts in the task notes — this is the no-new-failures baseline.

- [ ] **Step 2: Bump packages**

In `apps/web-ui/package.json` set:

```json
"ai": "^7.0.0",
"@ai-sdk/react": "^3.0.0",
"@ai-sdk/langchain": "^2.0.0",
"@ai-sdk/amazon-bedrock": "^4.0.0",
"@ai-sdk/anthropic": "^3.0.0",
```

Note: these are the expected major lines for the v7 release train. Before editing, confirm the actual versions with `npm view ai version` and `npm view @ai-sdk/react version` and use the real latest majors (all `@ai-sdk/*` packages must be on the same release train as `ai`).

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/ai-ops && bun install`
Expected: install succeeds (peer warnings acceptable).

- [ ] **Step 3: Run the official v7 codemod**

Run: `cd apps/web-ui && npx @ai-sdk/codemod v7 .`
Expected: codemod reports transformed files. Review the diff with `git diff --stat`.

- [ ] **Step 4: Fix residual compile errors in the SDK-consuming files**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "chat/route|ask-ai|chat-interface" `
Fix each reported error manually. Known semantic changes to check by hand (codemods don't cover these):
- `useChat` callback signatures (`onFinish` message shape).
- `sendMessage` message shape — v7 uses `parts` arrays on UIMessage; the custom `role:'tool'` resume message in `handleToolApproval` (chat-interface.tsx:1026) is our own convention that the server parses from raw JSON — keep it working as-is (the server reads `req.json()` directly, not through SDK types).
- `experimental_attachments` → v7 file parts. If the codemod renames it, keep the server contract by mapping in `handleFormSubmit` (the server-side `validateAttachments` in route.ts reads `experimental_attachments`; update BOTH sides together if renamed).
- `UIMessageChunk` member names used in `processStream`: `text-start/delta/end`, `reasoning-start/delta/end`, `tool-input-start`, `tool-input-available`, `tool-output-available`, `start`, `finish`, `error`. Verify each still exists: `grep -o "'[a-z-]*'" node_modules/ai/dist/index.d.ts | sort -u | grep -E "tool-|text-|reasoning-"` and adjust names if renamed.

- [ ] **Step 5: Verify the build**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/ai-ops && bun run build:web`
Expected: build succeeds.

- [ ] **Step 6: Verify tests are at baseline**

Run: `cd apps/web-ui && bun run test 2>&1 | tail -5`
Expected: pass/fail counts equal to the Step 1 baseline (no new failures).

- [ ] **Step 7: Manual smoke test**

Run: `docker compose up -d postgres` (repo root), then `bun run dev`, open `http://localhost:3001/app/agent`, send "hello" in Fast mode.
Expected: streamed reply renders; no console errors about unknown chunk types.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore(deps): upgrade AI SDK to v7 (codemod-assisted)"
```

---

### Task 2: Move tool-classifier to shared lib/agent

The classifier at `apps/web-ui/lib/agent-ops/tool-classifier.ts` becomes shared between Agent Ops and chat.

**Files:**
- Create: `apps/web-ui/lib/agent/tool-classifier.ts` (moved content, verbatim)
- Modify: `apps/web-ui/lib/agent-ops/tool-classifier.ts` (becomes a re-export shim)
- Test: `apps/web-ui/lib/agent/__tests__/tool-classifier.test.ts`

**Interfaces:**
- Produces: `classifyTool(toolName: string, toolArgs?: Record<string, unknown>): { isMutative: boolean; reason: string }` and `filterMutativeToolCalls(toolCalls)` importable from `@/lib/agent/tool-classifier`. Existing Agent Ops imports (`@/lib/agent-ops/tool-classifier`) keep working through the shim.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/lib/agent/__tests__/tool-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyTool } from '@/lib/agent/tool-classifier';

describe('classifyTool (shared location)', () => {
    it('classifies read-only allowlisted tools as safe', () => {
        expect(classifyTool('get_aws_credentials').isMutative).toBe(false);
        expect(classifyTool('list_aws_accounts').isMutative).toBe(false);
    });

    it('classifies read-only aws CLI commands via execute_command as safe', () => {
        const r = classifyTool('execute_command', { command: 'aws ec2 describe-instances --output json' });
        expect(r.isMutative).toBe(false);
    });

    it('classifies mutative aws CLI commands via execute_command as mutative', () => {
        const r = classifyTool('execute_command', { command: 'aws ec2 terminate-instances --instance-ids i-0abc' });
        expect(r.isMutative).toBe(true);
    });

    it('classifies rm -rf as mutative', () => {
        expect(classifyTool('execute_command', { command: 'rm -rf /tmp/x' }).isMutative).toBe(true);
    });

    it('classifies name-pattern mutations (write_file) as mutative', () => {
        expect(classifyTool('write_file', { file_path: 'a', content: 'b' }).isMutative).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/tool-classifier.test.ts`
Expected: FAIL — cannot resolve `@/lib/agent/tool-classifier`.

- [ ] **Step 3: Move the file and add the shim**

```bash
git mv apps/web-ui/lib/agent-ops/tool-classifier.ts apps/web-ui/lib/agent/tool-classifier.ts
```

Then create the shim at the old path:

```typescript
// apps/web-ui/lib/agent-ops/tool-classifier.ts
// Moved to lib/agent so chat graphs and Agent Ops share one classifier.
export * from '@/lib/agent/tool-classifier';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/tool-classifier.test.ts && bunx vitest run tests/agent-ops 2>&1 | tail -3`
Expected: new tests PASS; agent-ops suite at its prior state (shim keeps old imports working).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(agent): move tool-classifier to lib/agent (shared with agent-ops)"
```

---

### Task 3: GuardVerdict state + ask_user tool

**Files:**
- Modify: `apps/web-ui/lib/agent/agent-shared.ts` (types + state channel, after `PlanStep` at ~line 59 and in `graphState` at ~line 87)
- Modify: `apps/web-ui/lib/agent/tools.ts` (add `askUserTool`)
- Modify: `apps/web-ui/lib/agent/model-factory.ts` (`assembleTools` at line 235 — include `askUserTool` in the base tool list)
- Test: `apps/web-ui/lib/agent/__tests__/ask-user-tool.test.ts`

**Interfaces:**
- Produces:
  - `interface GuardVerdict { toolCallId: string; toolName: string; isMutative: boolean; severity: 'LOW' | 'MEDIUM' | 'HIGH'; action: string; blastRadius: string; reversible: boolean; saferPath: string; reason: string }` exported from `agent-shared.ts`.
  - `ReflectionState.guardVerdicts: Record<string, GuardVerdict>` with channel reducer `(x, y) => y` and default `() => ({})` (each guard pass replaces the batch wholesale).
  - `askUserTool` exported from `tools.ts` with name `ask_user`, schema `{ question: string, options?: string[] }`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/lib/agent/__tests__/ask-user-tool.test.ts
import { describe, it, expect } from 'vitest';
import { askUserTool } from '@/lib/agent/tools';

describe('askUserTool', () => {
    it('is registered under the exact name ask_user', () => {
        expect(askUserTool.name).toBe('ask_user');
    });

    it('returns a no-answer sentinel if it ever executes directly', async () => {
        // The approval_gate interrupt normally intercepts ask_user before execution;
        // direct execution means no answer was provided — the model must not invent one.
        const out = await askUserTool.invoke({ question: 'Which instance?', options: ['a', 'b'] });
        expect(String(out)).toContain('No answer was provided');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/ask-user-tool.test.ts`
Expected: FAIL — `askUserTool` is not exported.

- [ ] **Step 3: Add the GuardVerdict type and state channel**

In `agent-shared.ts`, directly after the `PlanStep` interface:

```typescript
/** Verdict produced by the guard node for one pending tool call. */
export interface GuardVerdict {
    toolCallId: string;
    toolName: string;
    isMutative: boolean;
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    /** One-sentence statement of what the call does (e.g. "Terminates EC2 instance i-0abc"). */
    action: string;
    /** What is affected if this runs (data loss, downstream services, cost). */
    blastRadius: string;
    reversible: boolean;
    /** A less-destructive alternative, or "" when none applies. */
    saferPath: string;
    /** Classifier/LLM reason string for observability. */
    reason: string;
}
```

Add to `ReflectionState`:

```typescript
    guardVerdicts: Record<string, GuardVerdict>; // keyed by toolCallId, replaced per guard pass
```

Add to `graphState` channels:

```typescript
    guardVerdicts: {
        reducer: (x: Record<string, GuardVerdict>, y: Record<string, GuardVerdict>) => y,
        default: () => ({}),
    },
```

- [ ] **Step 4: Add the ask_user tool**

In `tools.ts` (near the other simple tools, following the existing `tool()` pattern):

```typescript
/**
 * ask_user — mid-run clarification. This tool NEVER produces an answer itself:
 * the guard router always sends ask_user calls to the approval_gate interrupt,
 * where the user's reply is written as this call's ToolMessage before resume.
 * If it executes directly (gate bypassed — should not happen), it returns a
 * sentinel telling the model no answer exists, so the model cannot hallucinate one.
 */
export const askUserTool = tool(
    async ({ question }: { question: string; options?: string[] }) => {
        return `No answer was provided for: "${question}". Proceed with your best judgment or finish and state the open question.`;
    },
    {
        name: 'ask_user',
        description:
            'Ask the user a clarifying question when the request is ambiguous or a decision is theirs to make ' +
            '(e.g. which of several matching resources to act on). Provide 2-4 suggested answers in `options` when possible. ' +
            'The run pauses until the user answers; the answer arrives as this tool\'s result.',
        schema: z.object({
            question: z.string().describe('The specific question to ask the user'),
            options: z.array(z.string()).optional().describe('Suggested answers shown as one-click choices'),
        }),
    },
);
```

- [ ] **Step 5: Register ask_user in assembleTools**

In `model-factory.ts`, find `assembleTools` (line ~235). Locate where the base tools array is assembled (the list containing `execute_command` / file tools) and append `askUserTool` unconditionally (both fast and planning agents get it; deep agent is out of scope and does not call `assembleTools`). Import: `import { askUserTool } from './tools';`

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/ask-user-tool.test.ts`
Expected: PASS. Also `bunx tsc --noEmit 2>&1 | grep -c "agent-shared\|tools.ts\|model-factory"` reports no NEW errors in these files.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): GuardVerdict state channel + ask_user clarification tool"
```

---

### Task 4: Guard node module

A factory producing the graph node that classifies every pending tool call and runs one batched LLM risk assessment for the mutative ones.

**Files:**
- Create: `apps/web-ui/lib/agent/guard.ts`
- Test: `apps/web-ui/lib/agent/__tests__/guard.test.ts`

**Interfaces:**
- Consumes: `classifyTool` from `@/lib/agent/tool-classifier`; `GuardVerdict`, `ReflectionState` from `./agent-shared`.
- Produces: `createGuardNode(deps: { riskModel: { invoke(msgs: unknown[]): Promise<{ content: unknown }> } }): (state: ReflectionState) => Promise<Partial<ReflectionState>>` — returns `{ guardVerdicts }`. Also exports `pendingToolCallsOf(state): ToolCall[]` (the last AIMessage's tool_calls that have no ToolMessage result yet) reused by routers and the route.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web-ui/lib/agent/__tests__/guard.test.ts
import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createGuardNode, pendingToolCallsOf } from '@/lib/agent/guard';

const baseState = (messages: unknown[]) => ({ messages } as any);

const aiWithCalls = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) =>
    new AIMessage({ content: '', tool_calls: calls.map(c => ({ ...c, type: 'tool_call' as const })) });

const okRiskModel = {
    invoke: async () => ({
        content: JSON.stringify([{
            toolCallId: 't1', severity: 'HIGH',
            action: 'Terminates EC2 instance i-0abc', blastRadius: 'Instance destroyed',
            reversible: false, saferPath: 'Stop the instance instead',
        }]),
    }),
};

describe('pendingToolCallsOf', () => {
    it('returns only calls without an existing ToolMessage result', () => {
        const msgs = [
            new HumanMessage('do it'),
            aiWithCalls([{ id: 't1', name: 'execute_command', args: {} }, { id: 't2', name: 'read_file', args: {} }]),
            new ToolMessage({ tool_call_id: 't2', content: 'done' }),
        ];
        const pending = pendingToolCallsOf(baseState(msgs));
        expect(pending.map(c => c.id)).toEqual(['t1']);
    });
});

describe('guard node', () => {
    it('read-only calls get non-mutative verdicts without invoking the risk model', async () => {
        let invoked = false;
        const node = createGuardNode({ riskModel: { invoke: async () => { invoked = true; return { content: '[]' }; } } });
        const msgs = [aiWithCalls([{ id: 't1', name: 'get_aws_credentials', args: { accountId: 'x' } }])];
        const out = await node(baseState(msgs));
        expect(out.guardVerdicts!['t1'].isMutative).toBe(false);
        expect(invoked).toBe(false);
    });

    it('mutative calls get an LLM risk assessment', async () => {
        const node = createGuardNode({ riskModel: okRiskModel });
        const msgs = [aiWithCalls([{ id: 't1', name: 'execute_command', args: { command: 'aws ec2 terminate-instances --instance-ids i-0abc' } }])];
        const out = await node(baseState(msgs));
        const v = out.guardVerdicts!['t1'];
        expect(v.isMutative).toBe(true);
        expect(v.severity).toBe('HIGH');
        expect(v.reversible).toBe(false);
        expect(v.saferPath).toContain('Stop');
    });

    it('fail-closed: risk model failure yields HIGH severity mutative verdict', async () => {
        const node = createGuardNode({ riskModel: { invoke: async () => { throw new Error('throttled'); } } });
        const msgs = [aiWithCalls([{ id: 't1', name: 'execute_command', args: { command: 'aws s3 rm s3://x --recursive' } }])];
        const out = await node(baseState(msgs));
        expect(out.guardVerdicts!['t1'].severity).toBe('HIGH');
        expect(out.guardVerdicts!['t1'].isMutative).toBe(true);
    });

    it('ask_user calls get a non-mutative verdict (gate routing is the router\'s job)', async () => {
        const node = createGuardNode({ riskModel: okRiskModel });
        const msgs = [aiWithCalls([{ id: 't1', name: 'ask_user', args: { question: 'which one?' } }])];
        const out = await node(baseState(msgs));
        expect(out.guardVerdicts!['t1'].isMutative).toBe(false);
    });

    it('returns empty verdicts when the last message has no tool calls', async () => {
        const node = createGuardNode({ riskModel: okRiskModel });
        const out = await node(baseState([new AIMessage({ content: 'plain text' })]));
        expect(out.guardVerdicts).toEqual({});
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/guard.test.ts`
Expected: FAIL — module `@/lib/agent/guard` not found.

- [ ] **Step 3: Implement guard.ts**

```typescript
// apps/web-ui/lib/agent/guard.ts
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { classifyTool } from './tool-classifier';
import type { GuardVerdict, ReflectionState } from './agent-shared';

export interface PendingToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

/**
 * The last AIMessage's tool_calls that do not yet have a ToolMessage result
 * anywhere after that message. Used by the guard node, the gate routers, and
 * the /api/chat resume handler — one definition of "pending".
 */
export function pendingToolCallsOf(state: Pick<ReflectionState, 'messages'>): PendingToolCall[] {
    const messages = state.messages ?? [];
    let lastAiIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._getType() === 'ai') { lastAiIdx = i; break; }
    }
    if (lastAiIdx === -1) return [];
    const ai = messages[lastAiIdx] as AIMessage;
    const calls = (ai.tool_calls ?? []).filter(c => !!c.id);
    if (calls.length === 0) return [];
    const resolved = new Set<string>();
    for (let i = lastAiIdx + 1; i < messages.length; i++) {
        const m = messages[i] as { tool_call_id?: string };
        if (messages[i]._getType() === 'tool' && m.tool_call_id) resolved.add(m.tool_call_id);
    }
    return calls
        .filter(c => !resolved.has(c.id!))
        .map(c => ({ id: c.id!, name: c.name, args: (c.args ?? {}) as Record<string, unknown> }));
}

interface RiskModel { invoke(msgs: unknown[]): Promise<{ content: unknown }> }

const RISK_SYSTEM_PROMPT = `You are a cloud-operations safety reviewer. For each proposed tool call below, produce a risk assessment.
Respond with ONLY a JSON array, one object per tool call, in the same order:
[{ "toolCallId": "<id>", "severity": "LOW" | "MEDIUM" | "HIGH", "action": "<one sentence: what this does, naming the exact resource>", "blastRadius": "<what is affected: data loss, downstream services, cost>", "reversible": true | false, "saferPath": "<a less destructive alternative, or empty string>" }]
Severity guide: HIGH = irreversible destruction/termination/deletion or IAM/security changes; MEDIUM = reversible state changes (stop, scale, restart, config update); LOW = minor mutations (tags, non-prod writes).`;

function failClosedVerdict(call: PendingToolCall, reason: string): GuardVerdict {
    return {
        toolCallId: call.id, toolName: call.name, isMutative: true, severity: 'HIGH',
        action: `Executes ${call.name} (risk assessment unavailable)`,
        blastRadius: 'Unknown — the risk assessor failed, so worst case is assumed.',
        reversible: false, saferPath: '', reason,
    };
}

/**
 * Guard node factory. Deterministic classifier first (zero cost); one batched
 * LLM call for the mutative subset. Fail-closed on every error path.
 */
export function createGuardNode(deps: { riskModel: RiskModel }) {
    return async function guardNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const pending = pendingToolCallsOf(state);
        if (pending.length === 0) return { guardVerdicts: {} };

        const verdicts: Record<string, GuardVerdict> = {};
        const mutative: PendingToolCall[] = [];

        for (const call of pending) {
            const cls = classifyTool(call.name, call.args);
            if (!cls.isMutative || call.name === 'ask_user') {
                verdicts[call.id] = {
                    toolCallId: call.id, toolName: call.name, isMutative: false, severity: 'LOW',
                    action: '', blastRadius: '', reversible: true, saferPath: '', reason: cls.reason,
                };
            } else {
                mutative.push(call);
                verdicts[call.id] = failClosedVerdict(call, cls.reason); // placeholder until LLM refines
            }
        }

        if (mutative.length > 0) {
            try {
                const callList = mutative
                    .map(c => `- toolCallId=${c.id} tool=${c.name} args=${JSON.stringify(c.args).slice(0, 500)}`)
                    .join('\n');
                const res = await deps.riskModel.invoke([
                    new SystemMessage(RISK_SYSTEM_PROMPT),
                    new HumanMessage(`Assess these tool calls:\n${callList}`),
                ]);
                const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
                const jsonMatch = text.match(/\[[\s\S]*\]/);
                const parsed: Array<Record<string, unknown>> = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
                for (const item of parsed) {
                    const id = String(item.toolCallId ?? '');
                    const call = mutative.find(c => c.id === id);
                    if (!call) continue;
                    const sev = item.severity === 'LOW' || item.severity === 'MEDIUM' || item.severity === 'HIGH'
                        ? item.severity : 'HIGH';
                    verdicts[id] = {
                        toolCallId: id, toolName: call.name, isMutative: true, severity: sev,
                        action: String(item.action ?? '') || `Executes ${call.name}`,
                        blastRadius: String(item.blastRadius ?? '') || 'Unspecified',
                        reversible: item.reversible === true,
                        saferPath: String(item.saferPath ?? ''),
                        reason: verdicts[id].reason,
                    };
                }
                // Any mutative call the LLM skipped keeps its fail-closed placeholder.
            } catch (err) {
                console.warn(`[Guard] risk model failed — fail-closed HIGH for ${mutative.length} call(s):`, err);
                // placeholders already fail-closed
            }
        }

        console.log(`🛡️ [GUARD] ${pending.length} call(s): ${Object.values(verdicts).filter(v => v.isMutative).length} mutative`);
        return { guardVerdicts: verdicts };
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/guard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): guard node — classifier + batched LLM risk assessment, fail-closed"
```

---

### Task 5: Wire guard + approval_gate into both chat graphs

Insert `guard` → router → (`approval_gate` | `tools`) between the model node and `tools`, in both `planning-agent.ts` and `fast-agent.ts`. Always compile with `interruptBefore: ["approval_gate"]`.

**Files:**
- Create: `apps/web-ui/lib/agent/gate-routing.ts` (shared router logic)
- Modify: `apps/web-ui/lib/agent/planning-agent.ts` (graph construction ~lines 678-787)
- Modify: `apps/web-ui/lib/agent/fast-agent.ts` (graph construction ~lines 393-470)
- Test: `apps/web-ui/lib/agent/__tests__/gate-routing.test.ts`

**Interfaces:**
- Consumes: `pendingToolCallsOf` from `./guard`, `GuardVerdict` from `./agent-shared`.
- Produces: `routeAfterGuard(state: ReflectionState, autoApprove: boolean): 'approval_gate' | 'tools'` from `@/lib/agent/gate-routing`. Graph node names `"guard"` and `"approval_gate"` (the route in Task 7/8 checks `state.next` for `"approval_gate"`).

- [ ] **Step 1: Write the failing router tests**

```typescript
// apps/web-ui/lib/agent/__tests__/gate-routing.test.ts
import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { routeAfterGuard } from '@/lib/agent/gate-routing';

const stateWith = (calls: Array<{ id: string; name: string }>, verdicts: Record<string, { isMutative: boolean }>) => ({
    messages: [new AIMessage({ content: '', tool_calls: calls.map(c => ({ ...c, args: {}, type: 'tool_call' as const })) })],
    guardVerdicts: Object.fromEntries(Object.entries(verdicts).map(([id, v]) => [id, { toolCallId: id, toolName: 'x', severity: 'HIGH', action: '', blastRadius: '', reversible: false, saferPath: '', reason: '', ...v }])),
} as any);

describe('routeAfterGuard', () => {
    it('all read-only + autoApprove on → tools', () => {
        const s = stateWith([{ id: 't1', name: 'read_file' }], { t1: { isMutative: false } });
        expect(routeAfterGuard(s, true)).toBe('tools');
    });

    it('any mutative → approval_gate even with autoApprove on', () => {
        const s = stateWith([{ id: 't1', name: 'read_file' }, { id: 't2', name: 'execute_command' }],
            { t1: { isMutative: false }, t2: { isMutative: true } });
        expect(routeAfterGuard(s, true)).toBe('approval_gate');
    });

    it('autoApprove off → approval_gate even for read-only', () => {
        const s = stateWith([{ id: 't1', name: 'read_file' }], { t1: { isMutative: false } });
        expect(routeAfterGuard(s, false)).toBe('approval_gate');
    });

    it('ask_user always → approval_gate', () => {
        const s = stateWith([{ id: 't1', name: 'ask_user' }], { t1: { isMutative: false } });
        expect(routeAfterGuard(s, true)).toBe('approval_gate');
    });

    it('missing verdict for a pending call → approval_gate (fail-closed)', () => {
        const s = stateWith([{ id: 't1', name: 'mystery_tool' }], {});
        expect(routeAfterGuard(s, true)).toBe('approval_gate');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/gate-routing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement gate-routing.ts**

```typescript
// apps/web-ui/lib/agent/gate-routing.ts
import type { ReflectionState } from './agent-shared';
import { pendingToolCallsOf } from './guard';

/**
 * After the guard node: decide whether pending tool calls may execute directly
 * or must pause at the approval_gate interrupt.
 *
 * approval_gate when ANY of:
 *  - a pending call is ask_user (clarification always pauses)
 *  - a pending call is mutative (guard policy: even with auto-approve on)
 *  - a pending call has NO verdict (fail-closed)
 *  - autoApprove is off (user asked to review everything)
 */
export function routeAfterGuard(state: ReflectionState, autoApprove: boolean): 'approval_gate' | 'tools' {
    const pending = pendingToolCallsOf(state);
    if (pending.length === 0) return 'tools'; // nothing to gate; tools node no-ops
    if (!autoApprove) return 'approval_gate';
    for (const call of pending) {
        if (call.name === 'ask_user') return 'approval_gate';
        const verdict = state.guardVerdicts?.[call.id];
        if (!verdict || verdict.isMutative) return 'approval_gate';
    }
    return 'tools';
}
```

- [ ] **Step 4: Wire into planning-agent.ts**

Imports to add:

```typescript
import { createGuardNode } from './guard';
import { routeAfterGuard } from './gate-routing';
```

Inside `createReflectionGraph` (after `memorySaveNode` creation):

```typescript
    const guardNode = createGuardNode({ riskModel: reflectorModel });
    // approval_gate is a no-op marker node: the interrupt BEFORE it is the pause.
    async function approvalGateNode(): Promise<Partial<ReflectionState>> {
        console.log('⏸️ [APPROVAL GATE] resuming after human decision');
        return {};
    }
```

Change `shouldContinueFromGenerate` (line ~678) and `shouldContinueFromRevise` (line ~710) to return `"guard"` where they currently return `"tools"` (rename the return type unions accordingly).

Graph construction — replace the current node/edge block with:

```typescript
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("memory_recall", memoryRecallNode)
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("guard", guardNode)
        .addNode("approval_gate", approvalGateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("revise", reviseNode)
        .addNode("final", finalNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "planner")
        .addEdge("planner", "generate")

        .addConditionalEdges("generate", shouldContinueFromGenerate, {
            guard: "guard",
            reflect: "reflect",
            final: "final"
        })

        .addConditionalEdges("guard", (state: ReflectionState) => routeAfterGuard(state, autoApprove), {
            approval_gate: "approval_gate",
            tools: "tools"
        })
        .addEdge("approval_gate", "tools")

        .addConditionalEdges("tools", shouldContinueFromTools, {
            generate: "generate",
            reflect: "reflect"
        })

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            revise: "revise",
            final: "final"
        })

        .addConditionalEdges("revise", shouldContinueFromRevise, {
            guard: "guard",
            reflect: "reflect"
        })

        .addEdge("final", "memory_save")
        .addEdge("memory_save", END);

    // The gate is ALWAYS compiled in; routeAfterGuard decides whether flow enters it.
    console.log(`[Graph] Compiling with approval_gate interrupt (autoApprove=${autoApprove} affects routing only)`);
    return workflow.compile({
        checkpointer,
        ...(store && { store }),
        interruptBefore: ["approval_gate"],
    });
```

Delete the old `if (autoApprove) { … } else { … }` compile block.

- [ ] **Step 5: Wire into fast-agent.ts**

Same pattern: add the two imports, create `guardNode` + `approvalGateNode` inside `createFastGraph`, change `shouldContinue` to return `"guard"` instead of `"tools"`, and rebuild the graph:

```typescript
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("memory_recall", memoryRecallNode)
        .addNode("agent", agentNode)
        .addNode("guard", guardNode)
        .addNode("approval_gate", approvalGateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("finalize", finalizeNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "agent")

        .addConditionalEdges("agent", shouldContinue, {
            guard: "guard",
            reflect: "reflect",
            finalize: "finalize",
            memory_save: "memory_save"
        })

        .addConditionalEdges("guard", (state: ReflectionState) => routeAfterGuard(state, autoApprove), {
            approval_gate: "approval_gate",
            tools: "tools"
        })
        .addEdge("approval_gate", "tools")

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            agent: "agent",
            memory_save: "memory_save"
        })

        .addEdge("tools", "agent")
        .addEdge("finalize", "memory_save")
        .addEdge("memory_save", END);

    return workflow.compile({
        checkpointer,
        ...(store && { store }),
        interruptBefore: ["approval_gate"],
    });
```

Also update `route.ts` `getPhaseFromNode` (line ~456): add `case 'guard': case 'approval_gate': return 'execution';` so any streamed output from these nodes renders under the execution phase.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/gate-routing.test.ts && bunx tsc --noEmit 2>&1 | grep -E "planning-agent|fast-agent" | head`
Expected: router tests PASS; no new type errors in the two agent files.

- [ ] **Step 7: Manual smoke — guard fires on mutative call with auto-approve ON**

With `bun run dev`, in Fast mode with Auto-approve checked, prompt: "Run this command for me: aws ec2 stop-instances --instance-ids i-00000 (do not ask, just run it)".
Expected: server log shows `🛡️ [GUARD]` then the run PAUSES (no execution). (The old UI won't render an approval card in auto-approve mode yet — that's Task 8 + Plan B; the pause itself proves the gate.) Prompt "list files in your working directory" must still run straight through with no pause.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): guard + approval_gate nodes in fast/planning graphs — mutative calls always pause"
```

---

### Task 6: collectingToolNode skips already-resolved tool calls

The graph-level fix for "approve one, run all": before invoking `ToolNode`, drop tool calls that already have a `ToolMessage` (written by reject / ask_user answers).

**Files:**
- Modify: `apps/web-ui/lib/agent/agent-shared.ts` (new helper `withUnresolvedToolCallsOnly`)
- Modify: `apps/web-ui/lib/agent/planning-agent.ts` `collectingToolNode` (~line 290)
- Modify: `apps/web-ui/lib/agent/fast-agent.ts` `collectingToolNode` (~line 147)
- Test: `apps/web-ui/lib/agent/__tests__/unresolved-tool-calls.test.ts`

**Interfaces:**
- Produces: `withUnresolvedToolCallsOnly(state: { messages: BaseMessage[] }): { messages: BaseMessage[] } | null` exported from `agent-shared.ts` — a shallow state view whose last AIMessage carries only unresolved tool_calls; `null` when nothing is unresolved (tools node should return `{}`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/lib/agent/__tests__/unresolved-tool-calls.test.ts
import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { withUnresolvedToolCallsOnly } from '@/lib/agent/agent-shared';

const ai = (calls: Array<{ id: string; name: string }>) =>
    new AIMessage({ content: '', tool_calls: calls.map(c => ({ ...c, args: {}, type: 'tool_call' as const })) });

describe('withUnresolvedToolCallsOnly', () => {
    it('filters out tool calls that already have ToolMessage results', () => {
        const state = {
            messages: [
                new HumanMessage('go'),
                ai([{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }, { id: 't3', name: 'c' }]),
                new ToolMessage({ tool_call_id: 't2', content: 'Rejected by user' }),
            ],
        };
        const view = withUnresolvedToolCallsOnly(state as any)!;
        const last = view.messages[view.messages.length - 1] as AIMessage;
        expect(last.tool_calls!.map(c => c.id)).toEqual(['t1', 't3']);
        // original state untouched
        expect((state.messages[1] as AIMessage).tool_calls!.length).toBe(3);
    });

    it('returns null when every call is resolved', () => {
        const state = {
            messages: [
                ai([{ id: 't1', name: 'a' }]),
                new ToolMessage({ tool_call_id: 't1', content: 'answer' }),
            ],
        };
        expect(withUnresolvedToolCallsOnly(state as any)).toBeNull();
    });

    it('passes through untouched when nothing is resolved', () => {
        const state = { messages: [ai([{ id: 't1', name: 'a' }])] };
        const view = withUnresolvedToolCallsOnly(state as any)!;
        expect((view.messages[0] as AIMessage).tool_calls!.length).toBe(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/unresolved-tool-calls.test.ts`
Expected: FAIL — export missing.

- [ ] **Step 3: Implement the helper in agent-shared.ts**

```typescript
/**
 * Build a state VIEW for ToolNode whose last AIMessage carries only the tool
 * calls that do not yet have a ToolMessage result (per-tool reject / ask_user
 * answers write results BEFORE the tools node runs). ToolNode executes every
 * tool_call on the last AI message — without this filter, a rejected call
 * would execute anyway. Returns null when nothing is left to execute.
 * The underlying graph state is never mutated.
 */
export function withUnresolvedToolCallsOnly(
    state: { messages: BaseMessage[] },
): { messages: BaseMessage[] } | null {
    const messages = state.messages ?? [];
    let lastAiIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._getType() === 'ai') { lastAiIdx = i; break; }
    }
    if (lastAiIdx === -1) return null;
    const ai = messages[lastAiIdx] as AIMessage;
    const calls = ai.tool_calls ?? [];
    if (calls.length === 0) return null;

    const resolved = new Set<string>();
    for (let i = lastAiIdx + 1; i < messages.length; i++) {
        const m = messages[i] as unknown as { tool_call_id?: string };
        if (messages[i]._getType() === 'tool' && m.tool_call_id) resolved.add(m.tool_call_id);
    }
    const unresolved = calls.filter(c => c.id && !resolved.has(c.id));
    if (unresolved.length === 0) return null;
    if (unresolved.length === calls.length) return { messages };

    const filteredAi = new AIMessage({
        content: ai.content,
        tool_calls: unresolved,
        additional_kwargs: ai.additional_kwargs,
        response_metadata: ai.response_metadata,
        id: ai.id,
    });
    const view = [...messages];
    view[lastAiIdx] = filteredAi;
    return { messages: view };
}
```

- [ ] **Step 4: Use it in both collectingToolNodes**

In `planning-agent.ts` `collectingToolNode`, replace `const result = await toolNode.invoke(state);` with:

```typescript
        const view = withUnresolvedToolCallsOnly(state);
        if (!view) {
            console.log('⚙️ [TOOLS] All tool calls already resolved (rejected/answered) — skipping execution.');
            return {};
        }
        const result = await toolNode.invoke({ ...state, messages: view.messages });
```

Add `withUnresolvedToolCallsOnly` to the `agent-shared` import list. Apply the identical change in `fast-agent.ts` `collectingToolNode`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/__tests__/unresolved-tool-calls.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(ai-ops): tools node skips tool calls that already have results — rejected calls never execute"
```

---

### Task 7: /api/chat resume with per-tool decisions + audit

New resume contract alongside the legacy one. The client will send (Plan B) `body.decisions`; the route validates completeness against the pending interrupt, writes ToolMessages for rejections and ask_user answers, audits mutative decisions, and resumes.

**Files:**
- Modify: `apps/web-ui/app/api/chat/route.ts` (the `lastMessage.role === 'tool'` block, lines ~238-270)
- Test: `apps/web-ui/tests/chat-route-decisions.test.ts`

**Interfaces:**
- Consumes: `pendingToolCallsOf` from `@/lib/agent/guard`; `AuditService.logAgentEvent` from `@/lib/audit-service`.
- Produces: request contract — `POST /api/chat` with `{ threadId, decisions: Array<{ toolCallId: string; approved: boolean; reason?: string; answer?: string }>, ...usual body }` (messages array still present; last message may be anything). Response: normal stream, or 400 `{ error }` on partial/unknown decisions. Exported pure helper `applyDecisions` for tests.

- [ ] **Step 1: Write the failing test for the pure decision logic**

The route body is hard to test directly; extract the decision→ToolMessage logic as an exported pure function and test that.

```typescript
// apps/web-ui/tests/chat-route-decisions.test.ts
import { describe, it, expect } from 'vitest';
import { buildDecisionToolMessages } from '@/app/api/chat/decisions';

const pending = [
    { id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances --instance-ids i-1' } },
    { id: 't2', name: 'read_file', args: { file_path: 'x' } },
    { id: 't3', name: 'ask_user', args: { question: 'which region?' } },
];

describe('buildDecisionToolMessages', () => {
    it('rejects partial batches', () => {
        const r = buildDecisionToolMessages(pending, [{ toolCallId: 't1', approved: true }]);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/undecided/i);
    });

    it('rejects unknown toolCallIds', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: true }, { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: true, answer: 'us-east-1' }, { toolCallId: 'ghost', approved: true },
        ]);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/unknown/i);
    });

    it('produces ToolMessages only for rejections and ask_user answers', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: false, reason: 'too risky' },
            { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: true, answer: 'ap-south-1' },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.toolMessages).toHaveLength(2);
        const byId = Object.fromEntries(r.toolMessages.map(m => [m.tool_call_id, String(m.content)]));
        expect(byId['t1']).toContain('Rejected by user');
        expect(byId['t1']).toContain('too risky');
        expect(byId['t3']).toBe('ap-south-1');
    });

    it('requires a non-empty answer for approved ask_user', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: true }, { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: true, answer: '   ' },
        ]);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/answer/i);
    });

    it('rejected ask_user gets a dismissal ToolMessage', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: true }, { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: false },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(String(r.toolMessages[0].content)).toContain('declined to answer');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run tests/chat-route-decisions.test.ts`
Expected: FAIL — module `@/app/api/chat/decisions` not found.

- [ ] **Step 3: Implement the decisions module**

```typescript
// apps/web-ui/app/api/chat/decisions.ts
import { ToolMessage } from '@langchain/core/messages';

export interface ToolDecision {
    toolCallId: string;
    approved: boolean;
    /** Human reason attached to rejections (fed back to the model). */
    reason?: string;
    /** Required answer text for approved ask_user calls. */
    answer?: string;
}

interface PendingCall { id: string; name: string; args: Record<string, unknown> }

export type DecisionsResult =
    | { ok: true; toolMessages: ToolMessage[]; approvedIds: string[]; rejectedIds: string[] }
    | { ok: false; error: string };

/**
 * Validate a decision batch against the pending interrupt and produce the
 * ToolMessages to write BEFORE resume. Approved normal tools produce nothing —
 * the tools node executes them. Rejected tools and ask_user calls produce
 * results so withUnresolvedToolCallsOnly() excludes them from execution.
 */
export function buildDecisionToolMessages(pending: PendingCall[], decisions: ToolDecision[]): DecisionsResult {
    const byId = new Map(decisions.map(d => [d.toolCallId, d]));
    const pendingIds = new Set(pending.map(p => p.id));

    const unknown = decisions.filter(d => !pendingIds.has(d.toolCallId));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown toolCallId(s): ${unknown.map(d => d.toolCallId).join(', ')}` };
    }
    const undecided = pending.filter(p => !byId.has(p.id));
    if (undecided.length > 0) {
        return { ok: false, error: `Undecided tool call(s): ${undecided.map(p => `${p.name} (${p.id})`).join(', ')} — every pending tool needs a decision.` };
    }

    const toolMessages: ToolMessage[] = [];
    const approvedIds: string[] = [];
    const rejectedIds: string[] = [];

    for (const call of pending) {
        const d = byId.get(call.id)!;
        if (call.name === 'ask_user') {
            if (d.approved) {
                if (!d.answer || !d.answer.trim()) {
                    return { ok: false, error: `ask_user (${call.id}) requires a non-empty answer.` };
                }
                toolMessages.push(new ToolMessage({ tool_call_id: call.id, content: d.answer.trim() }));
                approvedIds.push(call.id);
            } else {
                toolMessages.push(new ToolMessage({
                    tool_call_id: call.id,
                    content: 'The user declined to answer. Proceed with your best judgment or finish and state the open question.',
                }));
                rejectedIds.push(call.id);
            }
        } else if (d.approved) {
            approvedIds.push(call.id); // no ToolMessage — tools node executes it
        } else {
            const reason = d.reason?.trim();
            toolMessages.push(new ToolMessage({
                tool_call_id: call.id,
                content: `Rejected by user${reason ? ` — reason: ${reason}` : ''}. Do not retry this exact action; adapt or ask.`,
            }));
            rejectedIds.push(call.id);
        }
    }
    return { ok: true, toolMessages, approvedIds, rejectedIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/chat-route-decisions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into route.ts**

In `POST`, destructure `decisions` from the body (alongside `autoApprove` etc.). Then extend the resume branch — BEFORE the existing `if (lastMessage.role === 'tool')` block, add:

```typescript
        if (Array.isArray(decisions) && decisions.length > 0) {
            // Per-tool decision resume (new contract; legacy role:'tool' path below still works)
            const { buildDecisionToolMessages } = await import('./decisions');
            const { pendingToolCallsOf } = await import('@/lib/agent/guard');

            const interruptState = await graph.getState(config);
            preRunMessageCount = interruptState.values?.messages?.length ?? 0;
            const nextNodes: string[] = (interruptState.next as string[] | undefined) ?? [];
            if (!nextNodes.includes('approval_gate')) {
                releaseLock();
                return new Response(JSON.stringify({ error: 'No pending approval on this thread.' }), {
                    status: 409, headers: { 'Content-Type': 'application/json' },
                });
            }
            const pending = pendingToolCallsOf(interruptState.values);
            const result = buildDecisionToolMessages(pending, decisions);
            if (!result.ok) {
                releaseLock();
                return new Response(JSON.stringify({ error: result.error }), {
                    status: 400, headers: { 'Content-Type': 'application/json' },
                });
            }
            if (result.toolMessages.length > 0) {
                await graph.updateState(config, { messages: result.toolMessages });
            }

            // Audit every decision on a mutative call (guard verdicts live in state)
            try {
                const { AuditService } = await import('@/lib/audit-service');
                const verdicts = interruptState.values?.guardVerdicts ?? {};
                for (const call of pending) {
                    const v = verdicts[call.id];
                    if (!v?.isMutative) continue;
                    const approved = result.approvedIds.includes(call.id);
                    await AuditService.logAgentEvent({
                        eventType: 'chat_tool_approval',
                        action: approved ? 'approve_mutative_tool' : 'reject_mutative_tool',
                        userId: resolvedUserId,
                        tenantId: resolvedTenantId,
                        status: 'success',
                        details: `${approved ? 'Approved' : 'Rejected'} ${call.name} (severity ${v.severity}): ${v.action}`,
                        resourceType: 'agent_tool_call',
                        resourceId: call.id,
                        metadata: { toolName: call.name, severity: v.severity, argsHash: JSON.stringify(call.args).slice(0, 200) },
                        correlationId: threadId,
                    });
                }
            } catch (auditErr) {
                console.warn('[Chat API] approval audit failed (non-fatal):', auditErr);
            }

            input = null; // resume from the approval_gate interrupt
        } else if (lastMessage.role === 'tool') {
            // …existing legacy block unchanged…
```

(The existing `else` branch for fresh user messages follows unchanged.)

- [ ] **Step 6: Typecheck + baseline tests**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep "chat/route\|chat/decisions" ; bun run test 2>&1 | tail -3`
Expected: no new type errors in these files; test counts at baseline + new passing tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): per-tool decisions resume contract on /api/chat + mutative approval audit"
```

---

### Task 8: Typed data parts in processStream

Emit `data-plan`, `data-phase` during streaming, and `data-approval` / `data-clarification` / `data-guard` when the run parks at the gate. Phase markers stay (legacy UI). Also shrink the planner's rendered text.

**Files:**
- Modify: `apps/web-ui/app/api/chat/route.ts` (`processStream`, lines ~531-872; the `createUIMessageStreamResponse` call site passes `graph`+`config` already)
- Modify: `apps/web-ui/lib/agent/planning-agent.ts` (planner message, line ~191)
- Test: `apps/web-ui/tests/chat-stream-parts.test.ts`

**Interfaces:**
- Produces wire parts (consumed by Plan B):
  - `{ type: 'data-plan', id: 'plan-<threadId>', data: { steps: Array<{ step: string; status: 'pending'|'in_progress'|'completed'|'failed' }>, updatedBy: string } }`
  - `{ type: 'data-phase', data: { phase: AgentPhase, node: string, ts: number } }`
  - `{ type: 'data-approval', id: 'approval-<threadId>', data: { batchId: string, tools: Array<{ toolCallId, toolName, args, guard: GuardVerdict | null }> } }`
  - `{ type: 'data-clarification', id: 'clarify-<toolCallId>', data: { toolCallId, question: string, options: string[] } }`
- Exported pure helper `buildInterruptParts(stateValues)` for tests.

- [ ] **Step 1: Write the failing test for the interrupt-part builder**

```typescript
// apps/web-ui/tests/chat-stream-parts.test.ts
import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { buildInterruptParts } from '@/app/api/chat/stream-parts';

const ai = (calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>) =>
    new AIMessage({ content: '', tool_calls: calls.map(c => ({ args: {}, ...c, type: 'tool_call' as const })) });

describe('buildInterruptParts', () => {
    it('splits ask_user into data-clarification, rest into one data-approval', () => {
        const values = {
            messages: [ai([
                { id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances' } },
                { id: 't2', name: 'ask_user', args: { question: 'Which region?', options: ['us-east-1'] } },
            ])],
            guardVerdicts: {
                t1: { toolCallId: 't1', toolName: 'execute_command', isMutative: true, severity: 'MEDIUM', action: 'Stops instance', blastRadius: 'Downtime', reversible: true, saferPath: '', reason: 'x' },
                t2: { toolCallId: 't2', toolName: 'ask_user', isMutative: false, severity: 'LOW', action: '', blastRadius: '', reversible: true, saferPath: '', reason: 'x' },
            },
        };
        const parts = buildInterruptParts(values as any, 'thread-1');
        const approval = parts.find(p => p.type === 'data-approval') as any;
        const clarify = parts.find(p => p.type === 'data-clarification') as any;
        expect(approval.data.tools).toHaveLength(1);
        expect(approval.data.tools[0].toolCallId).toBe('t1');
        expect(approval.data.tools[0].guard.severity).toBe('MEDIUM');
        expect(clarify.data.question).toBe('Which region?');
        expect(clarify.data.options).toEqual(['us-east-1']);
    });

    it('returns [] when nothing is pending', () => {
        expect(buildInterruptParts({ messages: [new AIMessage({ content: 'hi' })], guardVerdicts: {} } as any, 't')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run tests/chat-stream-parts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement stream-parts.ts**

```typescript
// apps/web-ui/app/api/chat/stream-parts.ts
import { pendingToolCallsOf } from '@/lib/agent/guard';
import type { GuardVerdict, PlanStep, ReflectionState } from '@/lib/agent/agent-shared';

export interface DataPart { type: `data-${string}`; id?: string; data: unknown }

export function buildPlanPart(threadId: string, steps: PlanStep[], updatedBy: string): DataPart {
    return { type: 'data-plan', id: `plan-${threadId}`, data: { steps, updatedBy } };
}

export function buildPhasePart(phase: string, node: string): DataPart {
    return { type: 'data-phase', data: { phase, node, ts: Date.now() } };
}

/**
 * Parts describing a parked approval_gate interrupt: one data-approval batch
 * for normal tools (each row carrying its guard verdict) and one
 * data-clarification per pending ask_user call.
 */
export function buildInterruptParts(
    values: Pick<ReflectionState, 'messages' | 'guardVerdicts'>,
    threadId: string,
): DataPart[] {
    const pending = pendingToolCallsOf(values);
    if (pending.length === 0) return [];
    const verdicts: Record<string, GuardVerdict> = values.guardVerdicts ?? {};
    const parts: DataPart[] = [];
    const approvalTools: unknown[] = [];

    for (const call of pending) {
        if (call.name === 'ask_user') {
            parts.push({
                type: 'data-clarification',
                id: `clarify-${call.id}`,
                data: {
                    toolCallId: call.id,
                    question: String(call.args.question ?? 'The agent needs your input.'),
                    options: Array.isArray(call.args.options) ? call.args.options.map(String) : [],
                },
            });
        } else {
            approvalTools.push({
                toolCallId: call.id,
                toolName: call.name,
                args: call.args,
                guard: verdicts[call.id] ?? null,
            });
        }
    }
    if (approvalTools.length > 0) {
        parts.push({
            type: 'data-approval',
            id: `approval-${threadId}`,
            data: { batchId: `batch-${threadId}-${Date.now()}`, tools: approvalTools },
        });
    }
    return parts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/chat-stream-parts.test.ts`
Expected: PASS.

- [ ] **Step 5: Emit the parts from processStream**

In `route.ts` `processStream`:

a) Import at top of file: `import { buildPlanPart, buildPhasePart, buildInterruptParts } from './stream-parts';`

b) In the `on_chat_model_start` handler, right after `phaseList.push(currentPhase)`, add:

```typescript
                            safeEnqueue(buildPhasePart(currentPhase, node || '') as UIMessageChunk);
```

c) Add a new event branch for plan snapshots (after the `on_tool_end` branch):

```typescript
                        else if (event.event === "on_chain_end") {
                            // Graph-node completion: stream plan snapshots when a node changed the plan.
                            const node = event.name || "";
                            const output = event.data?.output as { plan?: Array<{ step: string; status: string }> } | undefined;
                            if (
                                threadId &&
                                ["planner", "generate", "reflect", "revise", "tools"].includes(node) &&
                                Array.isArray(output?.plan) && output!.plan.length > 0
                            ) {
                                safeEnqueue(buildPlanPart(threadId, output!.plan as any, node) as UIMessageChunk);
                            }
                        }
```

d) After the `for await` loop ends (before the `hasEmittedTextContent` placeholder block), detect a parked interrupt and emit approval/clarification parts:

```typescript
                // If the run parked at the approval_gate interrupt, describe the pending
                // batch as typed parts so the client can render decision cards.
                if (threadId && graph && config) {
                    try {
                        const parked = await graph.getState(config);
                        const nextNodes: string[] = (parked?.next as string[] | undefined) ?? [];
                        if (nextNodes.includes('approval_gate')) {
                            for (const part of buildInterruptParts(parked.values ?? {}, threadId)) {
                                safeEnqueue(part as UIMessageChunk);
                            }
                        }
                    } catch (e) {
                        console.warn('[Chat API] interrupt part emission failed (non-fatal):', e);
                    }
                }
```

Note: if `UIMessageChunk` in the installed v7 `ai` package rejects the `data-*` cast, check its union for the data chunk member (`grep -n "data-" node_modules/ai/dist/index.d.ts | head`) and match its exact shape (v5/v7 both model custom data parts as `{ type: 'data-<name>', id?, data }`).

- [ ] **Step 6: Shrink the planner text message**

In `planning-agent.ts` line ~191, replace the AIMessage content:

```typescript
            messages: [tagMessagePhase(new AIMessage({ content: `📋 **Plan Created:**\n${planText}` }), 'planning')],
```

with:

```typescript
            // Keep a short text (with phase marker) for legacy rendering + history;
            // the structured plan streams as data-plan parts.
            messages: [tagMessagePhase(new AIMessage({ content: `📋 Created a ${planSteps.length}-step execution plan.` }), 'planning')],
```

Note: the legacy UI's plan checklist parses this text — after this change it shows only the one-liner until Plan B lands. That is an accepted, temporary regression on the `ai-ops` branch (Plan B follows immediately); if unacceptable, keep the old text until Plan B Task 8 and revisit.

- [ ] **Step 7: Manual verification of the wire**

With `bun run dev`, run a Plan & Execute prompt and inspect the network tab's `/api/chat` SSE frames.
Expected: `data-phase` frames on each phase change; `data-plan` frames with step statuses progressing (`pending` → `in_progress` → `completed`); on a mutative prompt, a final `data-approval` frame with the guard verdict.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): typed data parts — live plan snapshots, phases, approval/clarification batches"
```

---

### Task 9: History/pending-state restore endpoint additions

A mid-approval page reload must restore the pending card, and reloaded threads should show the final plan. Extend the history route to read graph state from the checkpointer.

**Files:**
- Modify: `apps/web-ui/app/api/threads/[threadId]/history/route.ts` (GET handler; `getCheckpointer` is already imported)
- Test: `apps/web-ui/tests/thread-history-pending.test.ts`

**Interfaces:**
- Produces: history response gains `pendingInterrupt: { parts: DataPart[] } | null` and `plan: PlanStep[] | null` fields. Exported pure helper `extractThreadRunState(channelValues, nextNodes, threadId)`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/thread-history-pending.test.ts
import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { extractThreadRunState } from '@/app/api/threads/[threadId]/run-state';

describe('extractThreadRunState', () => {
    it('returns plan and pending interrupt parts when parked at approval_gate', () => {
        const values = {
            plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }],
            messages: [new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances' }, type: 'tool_call' as const }] })],
            guardVerdicts: { t1: { toolCallId: 't1', toolName: 'execute_command', isMutative: true, severity: 'MEDIUM', action: 'stops', blastRadius: 'x', reversible: true, saferPath: '', reason: '' } },
        };
        const rs = extractThreadRunState(values as any, ['approval_gate'], 'th-1');
        expect(rs.plan).toHaveLength(2);
        expect(rs.pendingInterrupt!.parts.some(p => p.type === 'data-approval')).toBe(true);
    });

    it('returns null pendingInterrupt when not parked', () => {
        const rs = extractThreadRunState({ plan: [], messages: [], guardVerdicts: {} } as any, [], 'th-1');
        expect(rs.pendingInterrupt).toBeNull();
        expect(rs.plan).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run tests/thread-history-pending.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement run-state.ts**

```typescript
// apps/web-ui/app/api/threads/[threadId]/run-state.ts
import { buildInterruptParts, DataPart } from '@/app/api/chat/stream-parts';
import type { PlanStep, ReflectionState } from '@/lib/agent/agent-shared';

export interface ThreadRunState {
    plan: PlanStep[] | null;
    pendingInterrupt: { parts: DataPart[] } | null;
}

export function extractThreadRunState(
    channelValues: Partial<ReflectionState> | undefined,
    nextNodes: string[],
    threadId: string,
): ThreadRunState {
    const plan = Array.isArray(channelValues?.plan) && channelValues!.plan!.length > 0
        ? channelValues!.plan!
        : null;
    let pendingInterrupt: ThreadRunState['pendingInterrupt'] = null;
    if (nextNodes.includes('approval_gate')) {
        const parts = buildInterruptParts(
            { messages: channelValues?.messages ?? [], guardVerdicts: channelValues?.guardVerdicts ?? {} },
            threadId,
        );
        if (parts.length > 0) pendingInterrupt = { parts };
    }
    return { plan, pendingInterrupt };
}
```

- [ ] **Step 4: Wire into the history GET handler**

In `history/route.ts`, locate where the response JSON is assembled (the `NextResponse.json({ messages … })` at the end of GET). Before it, add:

```typescript
        // Live run state from the LangGraph checkpointer: final plan + any parked interrupt.
        let plan = null;
        let pendingInterrupt = null;
        try {
            const checkpointer = await getCheckpointer();
            const tuple = await (checkpointer as any).getTuple({ configurable: { thread_id: threadId } });
            if (tuple?.checkpoint) {
                const { extractThreadRunState } = await import('./run-state');
                const channelValues = tuple.checkpoint.channel_values ?? {};
                // Parked node names live in checkpoint metadata's writes/next; LangGraph
                // stores pending nodes in tuple.checkpoint.channel_versions + metadata.
                // The reliable source is metadata.writes === null && next nodes in
                // tuple.metadata; fall back to [] when unavailable.
                const nextNodes: string[] = (tuple as any).metadata?.next ?? (tuple as any).next ?? [];
                const rs = extractThreadRunState(channelValues, nextNodes, threadId);
                plan = rs.plan;
                pendingInterrupt = rs.pendingInterrupt;
            }
        } catch (e) {
            console.warn('[History] run-state extraction failed (non-fatal):', e);
        }
```

and add `plan, pendingInterrupt` to the response JSON object.

**Verification note:** the checkpointer tuple's "next nodes" location differs between `@langchain/langgraph-checkpoint-postgres` versions. After wiring, verify empirically (Step 5) and, if `nextNodes` comes back empty while an interrupt is genuinely pending, switch to compiling a throwaway graph and calling `graph.getState()` exactly as `route.ts` does (the graph factories are importable here; heavier but guaranteed). Do not ship the feature with `nextNodes` silently always-empty — the test in Step 5 is the gate.

- [ ] **Step 5: Manual verification**

Start a manual-approve run (auto-approve OFF), wait for the pause, reload the page, then:
Run: `curl -s http://localhost:3001/api/threads/<threadId>/history -H "Cookie: <session cookie>" | jq '{plan: .plan | length, pending: .pendingInterrupt != null}'`
Expected: `pending: true` while parked; after deciding, `pending: false` and `plan` reflects final statuses.

- [ ] **Step 6: Run tests + commit**

Run: `cd apps/web-ui && bunx vitest run tests/thread-history-pending.test.ts`
Expected: PASS.

```bash
git add -A
git commit -m "feat(ai-ops): thread history returns live plan + parked approval state for reload restore"
```

---

### Task 10: Prompt guidance for the new execution model

**Files:**
- Modify: `apps/web-ui/lib/agent/prompt-templates.ts` (`buildAutoApproveGuidance`, lines 196-216)

**Interfaces:**
- Produces: same function signature; new copy. No other task depends on the exact wording.

- [ ] **Step 1: Replace the function body**

```typescript
export function buildAutoApproveGuidance(autoApprove: boolean): string {
    const guardRules = `
## Safety Gate (always active)
A safety guard reviews every tool call before execution:
- Read-only calls (describe/list/get) run without interruption${autoApprove ? '' : ' once the user approves them'}.
- Mutating calls (create/update/delete/stop/start/terminate/deploy/scale/…) ALWAYS pause for explicit human approval — even in auto-approve mode. Expect the pause; do not treat it as an error.
- When proposing a mutation, state the exact target (resource ID/ARN, account, region) and the expected impact in your message BEFORE the tool call, so the approval decision is informed.
- If a tool result says "Rejected by user", do not retry the same action. Adapt your approach, propose the suggested safer path if one was given, or ask the user with ask_user.

## Asking the User (ask_user)
When the request is ambiguous or a decision belongs to the user (which resource, which environment, destructive vs safe option), call the ask_user tool with a specific question and 2-4 suggested options. Do not guess on high-impact choices. Do not use ask_user for things you can discover with read-only tools.`;

    if (autoApprove) {
        return `
## Execution Mode: Auto-Approved (read-only)
Read-only tool calls execute immediately without confirmation. Optimize for throughput:
- Run independent read-only queries in parallel; batch freely.
- For multi-account tasks: acquire credentials for all accounts first, then query in parallel.
- Chain multi-step read-only sequences without pausing.
${guardRules}`;
    }
    return `
## Execution Mode: Human-in-the-Loop
Every tool call pauses for user approval before execution. You MAY batch multiple tool calls in one turn — the user approves or rejects each one individually, and only approved calls execute. Group related calls into one batch rather than dribbling them one per turn.
- Before each batch, briefly explain what the calls will do and why.
- After execution, summarize the results before proposing the next batch.
${guardRules}`;
}
```

- [ ] **Step 2: Verify + commit**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep prompt-templates`
Expected: no errors.

```bash
git add -A
git commit -m "feat(ai-ops): prompt guidance for guard gate, batched HITL approvals, ask_user"
```

---

### Task 11: End-to-end backend verification

**Files:** none new — verification pass.

- [ ] **Step 1: Full test suite at baseline-or-better**

Run: `cd apps/web-ui && bun run test 2>&1 | tail -5`
Expected: all new tests pass; failure count ≤ Task 1 baseline.

- [ ] **Step 2: Build**

Run: `bun run build:web`
Expected: success.

- [ ] **Step 3: Manual scenario matrix** (dev server + `/app/agent`)

| Scenario | Expected |
|---|---|
| Fast mode, auto-approve ON, read-only prompt ("list your working directory files") | Runs straight through, no pause |
| Fast mode, auto-approve ON, mutative prompt ("stop instance i-00000, just do it") | Pauses at gate; server log shows 🛡️ GUARD + interrupt; `data-approval` frame in SSE with HIGH/MEDIUM verdict |
| Plan mode, auto-approve OFF, any tool prompt | Pauses; legacy Approve & Run button still resumes (legacy contract) |
| Legacy reject on one tool of a batch, then legacy approve | Rejected tool does NOT execute (check server tool logs) — the Task 6 fix |
| Prompt "start one of my stopped instances" with several stopped | Agent calls ask_user; run parks; `data-clarification` frame present |
| Plan mode run | `data-plan` frames progress through statuses |

- [ ] **Step 4: Commit any fixes + push**

```bash
git add -A
git commit -m "test(ai-ops): backend overhaul verification fixes"
```

---

## Self-Review Notes

- Spec coverage: guard node (T4), gate + always-interrupt (T5), per-tool decisions + skip-resolved (T6/T7), ask_user (T3/T7/T8), data-plan/data-phase/data-guard-in-approval/data-clarification (T8), persistence + pending restore (T9), audit (T7), prompt relaxation (T10), v7 upgrade (T1). Native-v7-approval-chunk emission is intentionally deferred: the spec's documented escape hatch (custom `data-approval`) is the implemented wire format because it is deterministic from a LangGraph server; the client machinery in Plan B is shaped so a later swap to native approval parts is contained in one hook.
- Legacy compatibility: legacy resume path untouched (T7 adds a parallel branch); phase markers still emitted; old UI functional throughout.
- Known temporary regression: planner text shrinks in T8 Step 6 → legacy plan checklist shows a one-liner until Plan B lands (accepted; noted inline).
