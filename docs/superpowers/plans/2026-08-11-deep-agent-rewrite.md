# Deep Agent Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Deep Agent mode on the current `deepagents` API so it is the most capable of the three modes — every tool the platform has, native skills, todos, subagents and HITL — without touching Fast or Plan & Execute.

**Architecture:** `createDeepGraph` becomes a thin `createDeepAgent` call over a `FilesystemBackend` rooted at a per-tenant working directory. Framework middleware supplies todos, filesystem tools, subagents, skills and summarization. New glue lives in four small focused modules under `lib/agent/deep/` — workdir/skills, HITL translation, stream adaptation, memory middleware — each independently testable. `app/api/chat/route.ts` changes only inside its `mode === 'deep'` branches.

**Tech Stack:** TypeScript, Next.js 15 App Router, `deepagents`, `@langchain/langgraph`, `@langchain/core`, Vitest.

## Global Constraints

- **Do not modify** `lib/agent/fast-agent.ts` or `lib/agent/planning-agent.ts`. Fast and Plan & Execute must behave identically after this work.
- **Do not modify** `lib/agent/decisions.ts` or `lib/agent/guard.ts`. Fast/plan still consume them; deep stops calling them.
- **Do not modify** `lib/agent/memory/working-memory.ts`. Deep uses the framework's summarization instead.
- `lib/agent/tools.ts` may only be changed **additively** — add `createExecuteCommandTool`; leave the `executeCommandTool` singleton export byte-identical.
- All `route.ts` edits must sit inside a `mode === 'deep'` conditional. No shared code path may change behaviour for fast/plan.
- Indentation: 4 spaces in `lib/` files (matches surrounding code).
- No comments unless the *why* is non-obvious. No docstrings.
- Tests: Vitest. Run with `cd apps/web-ui && bun run test`.
- Never commit unless explicitly asked — the commit steps below are written out, but ask before running them.
- Repo root: `/Users/H2702/.superset/worktrees/nucleus-cloud-ops/feature/deep-agent-rewrite`. All paths below are relative to `apps/web-ui/` unless stated.

## Known Secondary Deep Agent Implementation

`lib/deep-agent/` is an **existing** `deepagents`-based deep agent serving the standalone `/deep-agent` page (`app/app/deep-agent/page.tsx`) via `app/api/deep-agent/chat/route.ts` and `app/api/deep-agent/approve/route.ts`. It already uses `createDeepAgent`, `CompositeBackend`, `StateBackend`, and `StoreBackend`.

**This plan targets only `lib/agent/deep-agent.ts`** (the three-mode chat system). `lib/deep-agent/` is explicitly **out of scope** for this rewrite. We document it here because the Step 4 blast-radius check found it; it will be reconciled in a follow-up after deep mode earns confidence in the main chat.

## Reference documents

- Spec: `docs/superpowers/specs/2026-08-11-deep-agent-rewrite-design.md`
- API research: `docs/research/deepagents-js-api.md`
- Ground truth types: `node_modules/deepagents/dist/agent-DURA4_mf.d.ts`
- Ground truth runtime: `node_modules/deepagents/dist/langsmith-wdF8zG42.js`
- HITL types: `node_modules/langchain/dist/agents/middleware/hitl.d.ts`

**Rule for implementers:** before asking a question, check those files. No invented abstractions — if the framework offers a documented option, use it.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/agent/tools.ts` | **Modify (additive only).** Add `createExecuteCommandTool({ cwd })`. |
| `lib/agent/deep/workdir.ts` | **Create.** Per-tenant working directory resolution + writing DB skills to disk as `SKILL.md`. |
| `lib/agent/deep/hitl.ts` | **Create.** Interrupt detection and the UI-decisions ↔ `Command` translation. |
| `lib/agent/deep/stream-adapt.ts` | **Create.** `todos` → `PlanStep`, and `task` tool events → `SubagentEvent`. |
| `lib/agent/deep/memory-middleware.ts` | **Create.** Wraps the existing memory recall/save nodes as `beforeAgent`/`afterAgent` middleware — restores semantic recall, episodic, procedural, reconciliation and autonomous skill synthesis for deep. |
| `lib/agent/deep-agent.ts` | **Rewrite.** `createDeepGraph` on `createDeepAgent`. |
| `app/api/chat/route.ts` | **Modify.** Deep-only branches: KB resolution, resume path, stream adaptation. |
| `lib/agent/deep/__tests__/*.test.ts` | **Create.** Unit tests for the three glue modules. |

---

## Task 1: Pin the deepagents version

Installed is 1.10.5; latest is 1.12.2. `createDeepAgent` is **synchronous** in 1.10.5 (it returns `createAgent({...})` directly) while the docs show `await createDeepAgent(...)`. Settle this before building on it, because every later task depends on the API surface.

**Files:**
- Modify: `package.json` (root workspace, `dependencies.deepagents`)

**Interfaces:**
- Produces: a known-good pinned `deepagents` version for all later tasks.

- [ ] **Step 1: Record the current API shape**

Run from the repo root:

```bash
node -e "const {createDeepAgent}=require('deepagents'); console.log(typeof createDeepAgent, createDeepAgent.constructor.name)"
```

Expected on 1.10.5: `function Function` (not `AsyncFunction`).

- [ ] **Step 2: Upgrade to 1.12.2**

```bash
cd /Users/H2702/.superset/worktrees/nucleus-cloud-ops/feature/deep-agent-rewrite
bun add deepagents@1.12.2
```

- [ ] **Step 3: Re-check the API shape and the built-in tool names**

```bash
node -e "const d=require('deepagents'); console.log(typeof d.createDeepAgent, d.createDeepAgent.constructor.name); console.log(Object.keys(d).filter(k=>/Backend|Middleware/.test(k)).sort().join(','))"
```

Confirm `FilesystemBackend`, `StateBackend`, `CompositeBackend`, `createSkillsMiddleware` are all still exported. If `createDeepAgent` is now `AsyncFunction`, every later task must `await` it — note that in the plan file before continuing.

- [ ] **Step 4: Confirm nothing else imports deepagents**

```bash
cd apps/web-ui && grep -rn "from ['\"]deepagents" --include='*.ts' --include='*.tsx' . | grep -v node_modules
```

Expected: only `lib/agent/deep-agent.ts`. If anything else appears, stop and report — the blast radius is larger than the spec assumes.

- [ ] **Step 5: Measure what the framework detects about our Bedrock model**

**This platform is multi-provider — the deep agent must not assume any one vendor.** `ProviderModel.provider` (`libs/prisma/schema.prisma:104`) is `bedrock | openai | anthropic | ollama | vllm | lmstudio | litellm | openai-compatible`, defaulting to `openai-compatible`. `createAgentModels` routes them to `ChatOpenAI` (+`baseURL`), `ChatAnthropic`, or `ChatBedrockConverse` (`model-factory.ts:82-99`).

`getModelProvider` / `isAnthropicModel` key off **class name**, matching only `ChatAnthropic` / `ChatOpenAI` / `ChatGoogleGenerativeAI` / `ConfigurableModel` (`langsmith-*.js:2672-2695`). So seven of eight providers resolve; only `ChatBedrockConverse` does not.

Check all three classes the app can construct:

```bash
cd apps/web-ui && bunx tsx -e "
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatBedrockConverse } from '@langchain/aws';
for (const m of [
  new ChatOpenAI({ model: 'gpt-4o', apiKey: 'x' }),
  new ChatAnthropic({ model: 'claude-sonnet-4-5-20250929', apiKey: 'x' }),
  new ChatBedrockConverse({ model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', region: 'ap-south-1' }),
]) console.log(m.getName());
"
```

Expected: `ChatOpenAI`, `ChatAnthropic`, `ChatBedrockConverse` — the first two recognised, the third not.

Then test whether `initChatModel` closes the gap for **every** provider while preserving per-tenant `baseUrl` / `apiKey` / credentials (a bare string spec cannot carry those, so it is not an option here):

```bash
cd apps/web-ui && bunx tsx -e "
import { initChatModel } from 'langchain';
const m = await initChatModel('gpt-4o', { modelProvider: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: 'x' });
console.log('getName:', m.getName());
console.log('modelProvider:', (m as any)._defaultConfig?.modelProvider);
"
```

If `getName()` is `ConfigurableModel` and `modelProvider` is set, then routing through `initChatModel` gives every provider — Bedrock included — the harness profile, prompt caching and model-derived summarization.

Report the findings and pick one; do **not** silently decide:
1. route the deep model through `initChatModel` for all providers (best if it accepts Bedrock's region/credential shape)
2. add the caching middleware manually via `middleware:` for the Bedrock path only
3. accept the loss and document it

Do **not** refactor `createAgentModels` on a hypothesis — fast/plan depend on it.

- [ ] **Step 6: Verify the existing build still passes**

```bash
cd apps/web-ui && bunx tsc --noEmit
```

Expected: PASS (the current `deep-agent.ts` still compiles against 1.12.2). If it fails, record every error — those are the exact API breaks the rewrite must handle.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): pin deepagents to 1.12.2 for the deep agent rewrite"
```

---

## Task 2: Tenant-scoped execute_command factory

`execute_command` currently calls `execAsync` with **no `cwd`** (`tools.ts:161-166`), so it runs in the Next process's directory while the file tools jail to `AGENT_WORKDIR`. The deep agent needs both pointed at one per-tenant directory.

**Files:**
- Modify: `lib/agent/tools.ts` (add a factory beside the existing `executeCommandTool`)
- Test: `lib/agent/deep/__tests__/execute-cwd.test.ts`

**Interfaces:**
- Produces: `createExecuteCommandTool(opts: { cwd: string }): DynamicStructuredTool` — a tool named `execute_command`, identical to the singleton except it runs commands with `cwd: opts.cwd`.
- The existing `export const executeCommandTool` must remain unchanged and is still imported by `model-factory.ts`.

- [ ] **Step 1: Write the failing test**

Create `lib/agent/deep/__tests__/execute-cwd.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execMock = vi.fn();
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (orig) => {
    const actual = await orig<typeof import('util')>();
    return { ...actual, promisify: () => execMock };
});

describe('createExecuteCommandTool', () => {
    beforeEach(() => {
        execMock.mockReset();
        execMock.mockResolvedValue({ stdout: 'ok', stderr: '' });
    });

    it('runs the command with the configured cwd', async () => {
        const { createExecuteCommandTool } = await import('@/lib/agent/tools');
        const tool = createExecuteCommandTool({ cwd: '/tmp/nucleus-agent/tenant-a' });

        await tool.invoke(
            { command: 'echo hi' },
            { configurable: { tenant_id: 'tenant-a' } },
        );

        expect(execMock).toHaveBeenCalledTimes(1);
        expect(execMock.mock.calls[0][1]).toMatchObject({ cwd: '/tmp/nucleus-agent/tenant-a' });
    });

    it('is named execute_command so it does not collide with a deepagents builtin', async () => {
        const { createExecuteCommandTool } = await import('@/lib/agent/tools');
        expect(createExecuteCommandTool({ cwd: '/tmp/x' }).name).toBe('execute_command');
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/execute-cwd.test.ts
```

Expected: FAIL — `createExecuteCommandTool is not a function`.

- [ ] **Step 3: Implement the factory**

In `lib/agent/tools.ts`, refactor so the singleton and the factory share one body. Extract the current tool body into a builder, then keep the original export pointing at it with no `cwd`:

```typescript
function buildExecuteCommandTool(opts: { cwd?: string } = {}) {
    return tool(
        async ({ command }: { command: string }, config) => {
            const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
            const tenantId = configurable.tenant_id as string | undefined;
            // ... existing audit block, unchanged ...
            try {
                const { stdout, stderr } = await commandSemaphore.run(() => execAsync(command, {
                    shell: '/bin/bash',
                    timeout: 120000,
                    maxBuffer: 1024 * 1024 * 10,
                    env: buildCommandEnv(tenantId) as NodeJS.ProcessEnv,
                    ...(opts.cwd ? { cwd: opts.cwd } : {}),
                }));
                // ... existing success/error handling, unchanged ...
            } catch (error: any) {
                // ... existing, unchanged ...
            }
        },
        {
            name: 'execute_command',
            description: /* existing description, unchanged */,
            schema: /* existing schema, unchanged */,
        }
    );
}

export const executeCommandTool = buildExecuteCommandTool();

export function createExecuteCommandTool(opts: { cwd: string }) {
    return buildExecuteCommandTool(opts);
}
```

Move the whole existing tool body into `buildExecuteCommandTool` verbatim — the only new line is the conditional `cwd` spread. Do not change the audit calls, semaphore, timeout, buffer size, env handling, description or schema.

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/execute-cwd.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Confirm fast/plan are unaffected**

```bash
cd apps/web-ui && bunx vitest run lib/agent && bunx tsc --noEmit
```

Expected: PASS. The singleton export is unchanged, so every existing `executeCommandTool` consumer behaves as before.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/tools.ts apps/web-ui/lib/agent/deep/__tests__/execute-cwd.test.ts
git commit -m "feat(agent): add createExecuteCommandTool factory with configurable cwd"
```

---

## Task 3: Per-tenant workdir and skill materialisation

The deep agent's `FilesystemBackend` needs a per-tenant root, and the framework's skills middleware reads `SKILL.md` files from that root. Tenant skills live in Postgres, so they must be written out before the agent is constructed.

**Files:**
- Create: `lib/agent/deep/workdir.ts`
- Test: `lib/agent/deep/__tests__/workdir.test.ts`

**Interfaces:**
- Produces:
  - `tenantWorkdir(tenantId: string): string` — absolute path, `<AGENT_WORKDIR>/<sanitised tenantId>`
  - `materializeSkills(tenantId: string, root: string): Promise<number>` — writes each enabled tenant skill to `<root>/skills/<slug>/SKILL.md` with YAML frontmatter, returns the count written
- Consumes: `getSkillContent` and the tenant skill listing from `@/lib/skill-service`; `AGENT_WORKDIR` semantics from `lib/agent/tools.ts:25`.

- [ ] **Step 1: Check what the skill service already exposes**

```bash
cd apps/web-ui && grep -n "^export " lib/skill-service.ts
```

Use the existing tenant-scoped list function for enabled skills. Do not add a new query — if only `getSkillContent` exists, use the repository the service already calls rather than writing raw Prisma.

- [ ] **Step 2: Write the failing test**

Create `lib/agent/deep/__tests__/workdir.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const loadSkillsMock = vi.fn();
const loadAllSkillContentMock = vi.fn();
vi.mock('@/lib/skill-service', () => ({
    loadSkills: (...a: unknown[]) => loadSkillsMock(...a),
    loadAllSkillContent: (...a: unknown[]) => loadAllSkillContentMock(...a),
}));

describe('tenantWorkdir', () => {
    it('scopes the root to the tenant', async () => {
        const { tenantWorkdir } = await import('@/lib/agent/deep/workdir');
        const a = tenantWorkdir('tenant-a');
        const b = tenantWorkdir('tenant-b');
        expect(a).not.toBe(b);
        expect(a.endsWith(path.join('nucleus-agent', 'tenant-a'))).toBe(true);
    });

    it('rejects traversal in the tenant id', async () => {
        const { tenantWorkdir } = await import('@/lib/agent/deep/workdir');
        const p = tenantWorkdir('../../etc');
        expect(p.includes('..')).toBe(false);
    });
});

describe('materializeSkills', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
        loadSkillsMock.mockReset(); loadAllSkillContentMock.mockReset();
    });
    afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

    it('writes each skill as SKILL.md with valid frontmatter', async () => {
        loadSkillsMock.mockResolvedValue([{ slug: 'ec2-triage', description: 'Diagnose EC2 issues' }]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['ec2-triage', '# Steps\n1. Check state']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');

        const count = await materializeSkills('tenant-a', root);

        expect(count).toBe(1);
        const written = await fs.readFile(path.join(root, 'skills', 'ec2-triage', 'SKILL.md'), 'utf-8');
        expect(written).toBe(
            '---\nname: ec2-triage\ndescription: Diagnose EC2 issues\n---\n\n# Steps\n1. Check state\n'
        );
    });

    it('truncates descriptions to the 1024 char framework limit', async () => {
        loadSkillsMock.mockResolvedValue([{ slug: 's', description: 'x'.repeat(2000) }]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['s', 'body']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        await materializeSkills('tenant-a', root);

        const written = await fs.readFile(path.join(root, 'skills', 's', 'SKILL.md'), 'utf-8');
        const description = written.split('\n')[2].replace('description: ', '');
        expect(description.length).toBe(1024);
    });

    it('strips newlines from the description so frontmatter stays valid', async () => {
        loadSkillsMock.mockResolvedValue([{ slug: 's', description: 'line one\nline two' }]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['s', 'body']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        await materializeSkills('tenant-a', root);

        const written = await fs.readFile(path.join(root, 'skills', 's', 'SKILL.md'), 'utf-8');
        expect(written).toContain('description: line one line two');
    });

    it('returns 0 and creates nothing when the tenant has no skills', async () => {
        loadSkillsMock.mockResolvedValue([]);
        loadAllSkillContentMock.mockResolvedValue(new Map());
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        expect(await materializeSkills('tenant-a', root)).toBe(0);
    });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/workdir.test.ts
```

Expected: FAIL — module `@/lib/agent/deep/workdir` not found.

- [ ] **Step 4: Implement**

Create `lib/agent/deep/workdir.ts`:

```typescript
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadSkills, loadAllSkillContent } from '@/lib/skill-service';

const AGENT_WORKDIR = path.resolve(process.env.AGENT_WORKDIR || path.join(os.tmpdir(), 'nucleus-agent'));

const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export function tenantWorkdir(tenantId: string): string {
    const safe = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(AGENT_WORKDIR, safe);
}

export async function materializeSkills(tenantId: string, root: string): Promise<number> {
    const metadata = await loadSkills(tenantId);
    if (metadata.length === 0) return 0;
    const contentBySlug = await loadAllSkillContent(tenantId);

    let written = 0;
    for (const skill of metadata) {
        const content = contentBySlug.get(skill.slug);
        if (!content) continue;
        const name = skill.slug.replace(/[^a-z0-9-]/g, '-').slice(0, 64);
        const description = skill.description.replace(/\s*\n\s*/g, ' ').slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
        const dir = path.join(root, 'skills', name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            path.join(dir, 'SKILL.md'),
            `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`,
            'utf-8',
        );
        written++;
    }
    return written;
}
```

Adjust the import and field names to whatever `skill-service.ts` actually exports (Step 1). If the listing function has a different name, use it and update the test's `vi.mock` to match.

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/workdir.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/deep/workdir.ts apps/web-ui/lib/agent/deep/__tests__/workdir.test.ts
git commit -m "feat(agent): per-tenant deep agent workdir and skill materialisation"
```

---

## Task 4: HITL translation

The highest-risk change. `ActionRequest` carries **no id** — only `name`, `args`, `description?` (`node_modules/langchain/dist/agents/middleware/hitl.d.ts:158-171`), and the docs map decisions positionally. Our UI contract is keyed by `toolCallId`, so this module owns the zip between the two.

**Files:**
- Create: `lib/agent/deep/hitl.ts`
- Test: `lib/agent/deep/__tests__/hitl.test.ts`

**Interfaces:**
- Produces:
  - `interface PendingAction { toolCallId: string; toolName: string; args: Record<string, unknown> }`
  - `pendingActions(state: { values?: { messages?: unknown[] } }, interruptToolNames: string[]): PendingAction[]` — reads the last AI message's `tool_calls`, keeps those whose name is in `interruptToolNames`, in order. That filtered order is exactly the `actionRequests` order.
  - `toCommandDecisions(pending: PendingAction[], decisions: ToolDecision[]): { ok: true; decisions: DeepDecision[] } | { ok: false; error: string }`
  - `type DeepDecision = { type: 'approve' } | { type: 'reject'; message: string } | { type: 'respond'; message: string }`
- Consumes: `ToolDecision` from `@/app/api/chat/decisions` (type import only — do not modify that file).

- [ ] **Step 1: Write the failing test**

Create `lib/agent/deep/__tests__/hitl.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { pendingActions, toCommandDecisions } from '@/lib/agent/deep/hitl';

function stateWith(toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
    return { values: { messages: [new HumanMessage('go'), new AIMessage({ content: '', tool_calls: toolCalls })] } };
}

describe('pendingActions', () => {
    it('keeps only tools configured for interrupt, in order', () => {
        const state = stateWith([
            { id: 'a', name: 'read_file', args: { path: '/x' } },
            { id: 'b', name: 'execute_command', args: { command: 'rm -rf /' } },
            { id: 'c', name: 'write_file', args: { path: '/y' } },
        ]);
        const result = pendingActions(state, ['execute_command', 'write_file']);
        expect(result.map(r => r.toolCallId)).toEqual(['b', 'c']);
    });

    it('returns an empty list when the last message is not an AI message', () => {
        expect(pendingActions({ values: { messages: [new HumanMessage('hi')] } }, ['execute_command'])).toEqual([]);
    });

    it('returns an empty list when there are no messages', () => {
        expect(pendingActions({}, ['execute_command'])).toEqual([]);
    });
});

describe('toCommandDecisions', () => {
    const pending = [
        { toolCallId: 'b', toolName: 'execute_command', args: { command: 'rm -rf /' } },
        { toolCallId: 'c', toolName: 'ask_user', args: { question: 'Which region?' } },
    ];

    it('maps approval to approve and an ask_user answer to respond, positionally', () => {
        const result = toCommandDecisions(pending, [
            { toolCallId: 'c', approved: true, answer: 'us-east-1' },
            { toolCallId: 'b', approved: true },
        ]);
        expect(result).toEqual({
            ok: true,
            decisions: [{ type: 'approve' }, { type: 'respond', message: 'us-east-1' }],
        });
    });

    it('maps a rejection to reject and carries the reason through', () => {
        const result = toCommandDecisions(pending, [
            { toolCallId: 'b', approved: false, reason: 'too destructive' },
            { toolCallId: 'c', approved: true, answer: 'eu-west-1' },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.decisions[0]).toEqual({
            type: 'reject',
            message: 'Rejected by user — reason: too destructive. Do not retry this exact action; adapt or ask.',
        });
    });

    it('rejects a declined ask_user with guidance rather than failing', () => {
        const result = toCommandDecisions(pending, [
            { toolCallId: 'b', approved: true },
            { toolCallId: 'c', approved: false },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.decisions[1]).toEqual({
            type: 'respond',
            message: 'The user declined to answer. Proceed with your best judgment or finish and state the open question.',
        });
    });

    it('errors when a pending call has no decision', () => {
        const result = toCommandDecisions(pending, [{ toolCallId: 'b', approved: true }]);
        expect(result).toEqual({ ok: false, error: 'Undecided tool call(s): ask_user (c) — every pending tool needs a decision.' });
    });

    it('errors on an unknown toolCallId', () => {
        const result = toCommandDecisions(pending, [
            { toolCallId: 'b', approved: true },
            { toolCallId: 'c', approved: true, answer: 'x' },
            { toolCallId: 'zzz', approved: true },
        ]);
        expect(result).toEqual({ ok: false, error: 'Unknown toolCallId(s): zzz' });
    });

    it('errors when an approved ask_user has an empty answer', () => {
        const result = toCommandDecisions(pending, [
            { toolCallId: 'b', approved: true },
            { toolCallId: 'c', approved: true, answer: '   ' },
        ]);
        expect(result).toEqual({ ok: false, error: 'ask_user (c) requires a non-empty answer.' });
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/hitl.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/agent/deep/hitl.ts`:

```typescript
import type { ToolDecision } from '@/app/api/chat/decisions';

export interface PendingAction {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
}

export type DeepDecision =
    | { type: 'approve' }
    | { type: 'reject'; message: string }
    | { type: 'respond'; message: string };

export type DeepDecisionsResult =
    | { ok: true; decisions: DeepDecision[] }
    | { ok: false; error: string };

interface ToolCallLike { id?: string; name?: string; args?: Record<string, unknown> }

export function pendingActions(
    state: { values?: { messages?: unknown[] } },
    interruptToolNames: string[],
): PendingAction[] {
    const messages = state.values?.messages ?? [];
    const last = messages[messages.length - 1] as { tool_calls?: ToolCallLike[] } | undefined;
    const calls = last?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return [];

    const configured = new Set(interruptToolNames);
    return calls
        .filter(c => typeof c.name === 'string' && configured.has(c.name))
        .map(c => ({ toolCallId: String(c.id), toolName: String(c.name), args: c.args ?? {} }));
}

export function toCommandDecisions(pending: PendingAction[], decisions: ToolDecision[]): DeepDecisionsResult {
    const byId = new Map(decisions.map(d => [d.toolCallId, d]));
    const pendingIds = new Set(pending.map(p => p.toolCallId));

    const unknown = decisions.filter(d => !pendingIds.has(d.toolCallId));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown toolCallId(s): ${unknown.map(d => d.toolCallId).join(', ')}` };
    }
    const undecided = pending.filter(p => !byId.has(p.toolCallId));
    if (undecided.length > 0) {
        return {
            ok: false,
            error: `Undecided tool call(s): ${undecided.map(p => `${p.toolName} (${p.toolCallId})`).join(', ')} — every pending tool needs a decision.`,
        };
    }

    const out: DeepDecision[] = [];
    for (const call of pending) {
        const d = byId.get(call.toolCallId)!;
        if (call.toolName === 'ask_user') {
            if (d.approved) {
                const answer = d.answer?.trim();
                if (!answer) return { ok: false, error: `ask_user (${call.toolCallId}) requires a non-empty answer.` };
                out.push({ type: 'respond', message: answer });
            } else {
                out.push({ type: 'respond', message: 'The user declined to answer. Proceed with your best judgment or finish and state the open question.' });
            }
        } else if (d.approved) {
            out.push({ type: 'approve' });
        } else {
            const reason = d.reason?.trim();
            out.push({
                type: 'reject',
                message: `Rejected by user${reason ? ` — reason: ${reason}` : ''}. Do not retry this exact action; adapt or ask.`,
            });
        }
    }
    return { ok: true, decisions: out };
}
```

The output order follows `pending`, **not** the caller's decision order — that is what keeps it aligned with `actionRequests`.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/hitl.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/deep/hitl.ts apps/web-ui/lib/agent/deep/__tests__/hitl.test.ts
git commit -m "feat(agent): deep agent HITL decision translation to LangGraph Command"
```

---

## Task 5: Stream adaptation — todos and subagent cards

Deep must drive the existing plan rail from framework `todos`, and rebuild subagent cards from the `task` tool's lifecycle. `run.subagents` is a **v3** projection and `route.ts:545-548` streams **v2**, so this stays on v2 by watching tool events.

**Files:**
- Create: `lib/agent/deep/stream-adapt.ts`
- Test: `lib/agent/deep/__tests__/stream-adapt.test.ts`

**Interfaces:**
- Produces:
  - `todosToPlanSteps(todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>): PlanStep[]`
  - `taskStartEvent(runId: string, args: Record<string, unknown>): SubagentEvent`
  - `taskEndEvent(prev: SubagentEvent, output: string): SubagentEvent`
- Consumes: `PlanStep` from `@/lib/agent/agent-shared`, `SubagentEvent` from wherever `app/api/chat/stream-parts.ts` imports it.

- [ ] **Step 1: Confirm the SubagentEvent shape**

```bash
cd apps/web-ui && grep -rn "interface SubagentEvent" -A 15 lib app | head -25
```

Use the real field names in the implementation below; the test must match them exactly.

- [ ] **Step 2: Write the failing test**

Create `lib/agent/deep/__tests__/stream-adapt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { todosToPlanSteps, taskStartEvent, taskEndEvent } from '@/lib/agent/deep/stream-adapt';

describe('todosToPlanSteps', () => {
    it('renames content to step and preserves status and order', () => {
        expect(todosToPlanSteps([
            { content: 'Check ECS service', status: 'completed' },
            { content: 'Scale up', status: 'in_progress' },
            { content: 'Verify', status: 'pending' },
        ])).toEqual([
            { step: 'Check ECS service', status: 'completed' },
            { step: 'Scale up', status: 'in_progress' },
            { step: 'Verify', status: 'pending' },
        ]);
    });

    it('returns an empty array for no todos', () => {
        expect(todosToPlanSteps([])).toEqual([]);
    });
});

describe('task event adaptation', () => {
    it('opens a running card from the task tool args', () => {
        const e = taskStartEvent('run-1', { description: 'Audit IAM', subagent_type: 'aws-ops' });
        expect(e.id).toBe('run-1');
        expect(e.status).toBe('running');
        expect(e.role).toBe('aws-ops');
        expect(e.task).toBe('Audit IAM');
    });

    it('falls back to general-purpose when no subagent_type is given', () => {
        expect(taskStartEvent('run-1', { description: 'x' }).role).toBe('general-purpose');
    });

    it('closes the card with the returned summary', () => {
        const start = taskStartEvent('run-1', { description: 'Audit IAM', subagent_type: 'aws-ops' });
        const done = taskEndEvent(start, 'Found 3 over-permissive roles');
        expect(done.status).toBe('done');
        expect(done.summary).toBe('Found 3 over-permissive roles');
        expect(done.id).toBe('run-1');
    });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/stream-adapt.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `lib/agent/deep/stream-adapt.ts`:

```typescript
import type { PlanStep } from '@/lib/agent/agent-shared';
import type { SubagentEvent } from '@/lib/agent/dispatch-agent-tool';

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' };

export function todosToPlanSteps(todos: Todo[]): PlanStep[] {
    return todos.map(t => ({ step: t.content, status: t.status }));
}

export function taskStartEvent(runId: string, args: Record<string, unknown>): SubagentEvent {
    return {
        id: runId,
        role: typeof args.subagent_type === 'string' ? args.subagent_type : 'general-purpose',
        task: typeof args.description === 'string' ? args.description : '',
        status: 'running',
        toolCount: 0,
        tokensIn: 0,
        tokensOut: 0,
    };
}

export function taskEndEvent(prev: SubagentEvent, output: string): SubagentEvent {
    return { ...prev, status: 'done', summary: output };
}
```

Adjust field names and the completed-status string to whatever Step 1 found. If `SubagentEvent` is not exported from `stream-parts.ts`, import it from its real home rather than redefining it.

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/stream-adapt.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/deep/stream-adapt.ts apps/web-ui/lib/agent/deep/__tests__/stream-adapt.test.ts
git commit -m "feat(agent): adapt deepagents todos and task events to the existing UI contract"
```

---

## Task 6: Memory middleware — recall, save, and autonomous skill creation

**This task is why deep mode currently loses to fast/plan.** Fast and Plan run memory as
deterministic graph nodes and deliberately turn the memory *tools* off
(`fast-agent.ts:82,86-89`, `planning-agent.ts:398-401,434-437` — "memory_recall and memory_save
graph nodes handle memory deterministically"). The current deep agent has the opposite: the two
tools and no nodes. That means deep gets **none** of semantic recall injection, episodic replay,
procedural rules, save-time reconciliation, or `synthesizeDomainSkills` — the autonomous skill
creation feature — because all of them hang off those two nodes.

`createDeepAgent` has no nodes, but it accepts `middleware`, and `AgentMiddleware` exposes
`beforeAgent` / `afterAgent` hooks (`node_modules/langchain/dist/agents/middleware/types.d.ts:151-215`).
That is the documented seam. The existing node factories are reused unchanged.

**Files:**
- Create: `lib/agent/deep/memory-middleware.ts`
- Test: `lib/agent/deep/__tests__/memory-middleware.test.ts`

**Interfaces:**
- Produces: `createDeepMemoryMiddleware(deps: { reflectorModel: BaseChatModel; tenantId?: string; userId?: string; store: unknown | null; onMemoryEvent?: (op: 'recall' | 'save', summary: string) => void }): AgentMiddleware`
- Consumes: `createMemoryRecallNode`, `createMemorySaveNode` from `@/lib/agent/memory-nodes` — **do not modify that file.**

- [ ] **Step 1: Confirm the node contracts**

```bash
cd apps/web-ui && grep -n "export function createMemoryRecallNode" -A 8 lib/agent/memory-nodes.ts
cd apps/web-ui && grep -n "export function createMemorySaveNode" -A 8 lib/agent/memory-nodes.ts
```

`createMemoryRecallNode` returns `(state: MemoryNodeState) => Promise<{ memoryContext: string; memoryStats: MemoryRecallStats | null }>`. Note what `createMemorySaveNode` returns and what state fields it reads — the middleware must supply them.

- [ ] **Step 2: Write the failing test**

Create `lib/agent/deep/__tests__/memory-middleware.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recallNode = vi.fn();
const saveNode = vi.fn();
vi.mock('@/lib/agent/memory-nodes', () => ({
    createMemoryRecallNode: () => recallNode,
    createMemorySaveNode: () => saveNode,
}));

const deps = { reflectorModel: {} as never, tenantId: 't1', userId: 'u1', store: {} };

describe('createDeepMemoryMiddleware', () => {
    beforeEach(() => {
        recallNode.mockReset().mockResolvedValue({ memoryContext: 'user prefers ap-south-1', memoryStats: null });
        saveNode.mockReset().mockResolvedValue({});
    });

    it('injects recalled memory into the system prompt before the agent runs', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        const result = await mw.beforeAgent!({ messages: [] } as never, {} as never);

        expect(recallNode).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).toContain('user prefers ap-south-1');
    });

    it('runs the save node after the agent finishes', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        await mw.afterAgent!({ messages: [] } as never, {} as never);

        expect(saveNode).toHaveBeenCalledTimes(1);
    });

    it('reports recall and save through onMemoryEvent so the UI can render cards', async () => {
        const onMemoryEvent = vi.fn();
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware({ ...deps, onMemoryEvent });

        await mw.beforeAgent!({ messages: [] } as never, {} as never);
        await mw.afterAgent!({ messages: [] } as never, {} as never);

        expect(onMemoryEvent).toHaveBeenCalledWith('recall', expect.stringContaining('ap-south-1'));
        expect(onMemoryEvent).toHaveBeenCalledWith('save', expect.any(String));
    });

    it('is inert without a tenant so no cross-tenant recall can happen', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware({ ...deps, tenantId: undefined });

        await mw.beforeAgent!({ messages: [] } as never, {} as never);

        expect(recallNode).not.toHaveBeenCalled();
    });

    it('never fails the run when the save node throws', async () => {
        saveNode.mockRejectedValue(new Error('db down'));
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        await expect(mw.afterAgent!({ messages: [] } as never, {} as never)).resolves.not.toThrow();
    });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/memory-middleware.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `lib/agent/deep/memory-middleware.ts`:

```typescript
import { createMiddleware } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMemoryRecallNode, createMemorySaveNode } from '@/lib/agent/memory-nodes';

interface DeepMemoryDeps {
    reflectorModel: BaseChatModel;
    tenantId?: string;
    userId?: string;
    store: unknown | null;
    onMemoryEvent?: (op: 'recall' | 'save', summary: string) => void;
}

export function createDeepMemoryMiddleware(deps: DeepMemoryDeps) {
    // nodeDeps.store MUST be the real store: both memory nodes hard-gate on it
    // (memory-nodes.ts:41,176) and no-op with only a console.log if it is null.
    const { onMemoryEvent, ...nodeDeps } = deps;
    const recall = createMemoryRecallNode(nodeDeps);
    const save = createMemorySaveNode(nodeDeps);
    const enabled = Boolean(nodeDeps.tenantId && nodeDeps.userId && nodeDeps.store);

    return createMiddleware({
        name: 'DeepMemoryMiddleware',
        beforeAgent: async (state) => {
            if (!enabled) return undefined;
            const { memoryContext } = await recall(state as never);
            if (!memoryContext) return undefined;
            onMemoryEvent?.('recall', memoryContext);
            return { memoryContext };
        },
        afterAgent: async (state) => {
            if (!enabled) return undefined;
            try {
                const result = await save(state as never);
                onMemoryEvent?.('save', JSON.stringify(result ?? {}));
            } catch (err) {
                console.error('[DeepMemory] save failed:', err);
            }
            return undefined;
        },
    });
}
```

`memoryContext` must reach the model. `createDeepAgent` merges middleware state into agent state,
so declare it on the middleware's `stateSchema` and inject it in `wrapModelCall` (append to the
system message, mirroring `fast-agent.ts:114-115`'s `## Relevant Context from Memory` heading so
the wording matches the other modes). Check `createMiddleware`'s exact signature in
`node_modules/langchain/dist/agents/middleware/` before writing this — do not guess the hook
shapes.

Running the save node restores `synthesizeDomainSkills` for deep, since `memory-nodes.ts` calls
it from the save path. That is the autonomous skill creation feature.

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
cd apps/web-ui && bunx vitest run lib/agent/deep/__tests__/memory-middleware.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/deep/memory-middleware.ts apps/web-ui/lib/agent/deep/__tests__/memory-middleware.test.ts
git commit -m "feat(agent): deep agent memory middleware restoring recall, save and skill synthesis"
```

---

## Task 7: Rewrite deep-agent.ts

Replace the agent construction. Every prompt string is carried over verbatim from the current file except where noted.

**Files:**
- Rewrite: `lib/agent/deep-agent.ts`

**Interfaces:**
- Consumes: `tenantWorkdir`, `materializeSkills` (Task 3); `createExecuteCommandTool` (Task 2); `createDeepMemoryMiddleware` (Task 6).
- Produces: `createDeepGraph(config: GraphConfig)` — same exported name and signature as today, so `graph-factory.ts` and `route.ts:289` keep working. Also exports `DEEP_INTERRUPT_TOOLS: string[]` so the route knows which tool names are gated (needed by `pendingActions`).

- [ ] **Step 1: Delete the dead store wrapper**

Remove the `getStore()` call and the 20-line tenant-binding wrapper at the current `deep-agent.ts:37-52`, plus the `store` param on `createDeepAgent`. deepagents only reads `store` for `StoreBackend`; with `FilesystemBackend` nothing consumes it. Memory tools reach Postgres through `tenantId`/`userId` closures (`model-factory.ts:207-227`).

- [ ] **Step 2: Write the new file**

```typescript
import { SystemMessage } from "@langchain/core/messages";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import type { SubAgent } from "deepagents";
import {
    webSearchTool,
    askUserTool,
    writeFileToS3Tool,
    getFileFromS3Tool,
    createExecuteCommandTool,
    createGetAwsCredentialsTool,
    createListAwsAccountsTool,
} from "./tools";
import { createGetRightSizingRecommendationsTool } from "./right-sizing-tool";
import { createSearchKnowledgeBaseTool } from "./kb-tool";
import { createAwsReadTool } from "./aws-read-tool";
import { getSkillContent } from "@/lib/skill-service";
import { GraphConfig, getCheckpointer, getActiveMCPTools } from "./agent-shared";
import { createAgentModels, createMemoryTools } from "./model-factory";
import { tenantWorkdir, materializeSkills } from "./deep/workdir";

export const DEEP_INTERRUPT_TOOLS = ['execute_command', 'write_file', 'edit_file', 'ask_user'];

export async function createDeepGraph(config: GraphConfig) {
    const {
        model: modelConfig, autoApprove, accounts, accountId, accountName,
        selectedSkill, mcpServerIds, knowledgeBaseIds, tenantId, userId,
    } = config as any;

    const checkpointer = await getCheckpointer();
    const { main: model } = createAgentModels(modelConfig);

    const root = tenantWorkdir(tenantId ?? 'default');
    const skillCount = await materializeSkills(tenantId ?? 'default', root);
    const backend = new FilesystemBackend({ rootDir: root });

    // Carry these over verbatim from the pre-rewrite file. Retrieve with:
    //   git show HEAD:apps/web-ui/lib/agent/deep-agent.ts | sed -n '54,114p;211,243p'
    //   - lines  54-84  skill loading + effectiveSkillSection (the Base DevOps Engineer block)
    //   - lines  89-114 accountContext (multi-account / single / autonomous discovery)
    //   - lines 211-243 baseIdentity + systemPrompt
    // DROP lines 228-235 ("## Task Decomposition") — that paragraph instructs the model to
    // use write_todos and the task tool, which the framework's own base prompt already
    // covers. systemPrompt is concatenated onto the base prompt, so keeping it duplicates.
    // Change nothing else: the AWS CLI Standards and Response Discipline blocks stay as-is.

    const executeCommand = createExecuteCommandTool({ cwd: root });
    const getAwsCredentials = createGetAwsCredentialsTool(tenantId);
    const listAwsAccounts = createListAwsAccountsTool(tenantId);
    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId, accounts);

    const allTools = [
        executeCommand,
        getAwsCredentials,
        listAwsAccounts,
        askUserTool,
        webSearchTool,
        writeFileToS3Tool,
        getFileFromS3Tool,
        ...(tenantId ? [createGetRightSizingRecommendationsTool(tenantId)] : []),
        ...(tenantId ? [createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined)] : []),
        ...(tenantId && userId ? createMemoryTools(tenantId, userId) : []),
        ...mcpTools,
    ];

    const interruptOn = autoApprove ? undefined : {
        execute_command: true,
        write_file: true,
        edit_file: true,
        ask_user: true,
    };

    // The three description/systemPrompt pairs below are carried over verbatim:
    //   git show HEAD:apps/web-ui/lib/agent/deep-agent.ts | sed -n '155,209p'
    //   - aws-ops   lines 155-176
    //   - research  lines 178-192
    //   - code-iac  lines 194-209
    // Only the `tools` arrays change, for the reasons noted under Step 2.

    const awsOpsSubagent: SubAgent = {
        name: "aws-ops",
        description: /* verbatim, HEAD lines 157 */,
        systemPrompt: /* verbatim, HEAD lines 158-173 */,
        tools: [executeCommand, getAwsCredentials, listAwsAccounts],
        interruptOn,
    };

    const researchSubagent: SubAgent = {
        name: "research",
        description: /* verbatim, HEAD line 180 */,
        systemPrompt: /* verbatim, HEAD lines 181-190 */,
        tools: [
            webSearchTool,
            ...(tenantId ? [createSearchKnowledgeBaseTool(tenantId, knowledgeBaseIds ?? undefined)] : []),
            ...(tenantId ? [createAwsReadTool(tenantId, userId)] : []),
            ...mcpTools,
        ],
    };

    const codeSubagent: SubAgent = {
        name: "code-iac",
        description: /* verbatim, HEAD line 196 */,
        systemPrompt: /* verbatim, HEAD lines 197-206 */,
        tools: [executeCommand],
        interruptOn,
    };

    return createDeepAgent({
        model,
        tools: allTools,
        systemPrompt: new SystemMessage(systemPrompt),
        subagents: [awsOpsSubagent, researchSubagent, codeSubagent],
        backend,
        ...(skillCount > 0 && { skills: ["/skills/"] }),
        checkpointer,
        interruptOn,
    });
}
```

Notes for the implementer:
- **Do not pass** the six filesystem tools. `createDeepAgent` throws `TOOL_NAME_COLLISION` on any tool named `ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep`/`execute`/`task`/`write_todos`. The subagents inherit the built-ins, which is why `code-iac` only lists `executeCommand`.
- `execute` is auto-filtered because `FilesystemBackend` is not a sandbox backend — verified at `langsmith-*.js:2001`.
- Do **not** pass `load_skill`; the skills middleware replaces it for deep only.
- Only set `skills:` when at least one skill was written — pointing at a non-existent directory is avoidable noise.
- If Task 1 found `createDeepAgent` is async in 1.12.2, `await` it.

- [ ] **Step 3: Typecheck**

```bash
cd apps/web-ui && bunx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Confirm the whole agent suite still passes**

```bash
cd apps/web-ui && bunx vitest run lib/agent
```

Expected: PASS. `planner-multi-turn.test.ts` and `final-deliverable.test.ts` exercise `createReflectionGraph` — they must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/deep-agent.ts
git commit -m "feat(agent): rewrite deep agent on createDeepAgent with the full tool set"
```

---

## Task 8: Wire the deep branch in the chat route

**Files:**
- Modify: `app/api/chat/route.ts` — `:224` (KB gate), `:335-380` (decisions resume), `:340-349` (interrupt detection), the stream loop around `:545`, and the interrupt-part emission.

**Interfaces:**
- Consumes: `pendingActions`, `toCommandDecisions` (Task 4); `todosToPlanSteps`, `taskStartEvent`, `taskEndEvent` (Task 5); `DEEP_INTERRUPT_TOOLS` (Task 7).

- [ ] **Step 1: Enable knowledge base for deep — and commit it alone**

This is a deliberate *behaviour* change riding alongside a framework swap. It gets its own commit so a deep-mode regression can be bisected to the right cause.

At `route.ts:224`, drop the `&& mode !== 'deep'` clause so KB ids resolve for every mode:

```typescript
if (effectiveKbIds.length === 0) {
```

`knowledgeBaseIds: effectiveKbIds` is already passed through `graphConfig` at `:281`, and Task 6 already added the KB tool to the deep tool list.

Verify, then commit on its own:

```bash
cd apps/web-ui && bunx tsc --noEmit
git add apps/web-ui/app/api/chat/route.ts
git commit -m "feat(chat): give deep mode knowledge base access"
```

- [ ] **Step 2: Pass only the new message — do not replay client history**

`route.ts:530` sets `input = { messages: validMessages }`, replaying the whole reconstructed client array every turn. That is the old graphs' pattern. The documented deepagents/LangGraph pattern is to send **only the new user message** and let the checkpointer supply history from `thread_id`:

```ts
// Turn 1
await agent.invoke({ messages: [{ role: "user", content: "Hi, my name is Bob." }] },
  { configurable: { thread_id: "thread-1" } });
// Turn 2 — same thread_id, only the new message
await agent.invoke({ messages: [{ role: "user", content: "What's my name?" }] },
  { configurable: { thread_id: "thread-1" } });
```

Replaying the full array would append duplicates (reconstructed messages carry no ids, so `add_messages` cannot dedupe), inflating the history and tripping the summarization middleware early.

For deep, take the last user message only:

```typescript
if (mode === 'deep') {
    const lastUser = [...validMessages].reverse().find(m => m instanceof HumanMessage);
    input = { messages: lastUser ? [lastUser] : validMessages.slice(-1) };
} else {
    input = { messages: validMessages };
}
```

Attachments still need to ride on that message — confirm `validateAttachments` and the attachment content survive on the last `HumanMessage` before finalising this.

`config` already carries `thread_id`, `user_id` and `tenant_id` (`route.ts:303`), so no change is needed there.

- [ ] **Step 3: Branch the resume path**

Inside the `if (Array.isArray(decisions))` block, take a deep-specific path. The existing fast/plan path is untouched in the `else`:

```typescript
if (mode === 'deep') {
    const { pendingActions, toCommandDecisions } = await import('@/lib/agent/deep/hitl');
    const { DEEP_INTERRUPT_TOOLS } = await import('@/lib/agent/deep-agent');
    const { Command } = await import('@langchain/langgraph');

    const interruptState = await graph.getState(config);
    preRunMessageCount = interruptState.values?.messages?.length ?? 0;

    const hasInterrupt = (interruptState.tasks ?? []).some(
        (t: { interrupts?: unknown[] }) => (t.interrupts?.length ?? 0) > 0,
    );
    if (!hasInterrupt) {
        releaseLock();
        return new Response(JSON.stringify({ error: 'No pending approval on this thread.' }), {
            status: 409, headers: { 'Content-Type': 'application/json' },
        });
    }

    const pending = pendingActions(interruptState, DEEP_INTERRUPT_TOOLS);
    const mapped = toCommandDecisions(pending, decisions);
    if (!mapped.ok) {
        releaseLock();
        return new Response(JSON.stringify({ error: mapped.error }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }
    input = new Command({ resume: { decisions: mapped.decisions } }) as never;
} else {
    // existing fast/plan path — buildDecisionToolMessages + updateState — unchanged
}
```

Deep does **not** call `graph.updateState`; the framework writes the ToolMessages itself when the command resumes.

- [ ] **Step 4: Emit interrupt parts from framework state**

Where `buildInterruptParts` is called, branch for deep: build the approval tools list from `pendingActions(state, DEEP_INTERRUPT_TOOLS)` instead of `pendingToolCallsOf(values)`, keeping the emitted part shapes (`data-approval`, `data-clarification`) byte-identical so the client is unchanged. `ask_user` entries still become clarification parts; everything else becomes approval entries with `guard: null` — the guard node does not run in deep mode.

- [ ] **Step 5: Adapt the stream loop for deep**

In the `streamEvents` v2 loop, add deep-only handling:
- on any event carrying `todos` in its state payload → `buildPlanPart(threadId, todosToPlanSteps(todos), 'deep')`
- `on_tool_start` where `event.name === 'task'` → `emitSubagent(taskStartEvent(event.run_id, event.data.input))`
- `on_tool_end` where `event.name === 'task'` → `emitSubagent(taskEndEvent(prev, String(event.data.output)))`, looking `prev` up from `liveSubagents` by `run_id`

Keep the existing `isSubagentModelEvent` filter so subagent tokens still stay out of the transcript.

- [ ] **Step 6: Restore the memory cards for deep**

`data-memory` parts are emitted at `route.ts:1052` only when `currentPhase === 'memory_recall' || 'memory_save'`. Deep has no phases, so without this step the memory cards stay dark even once Task 6 lands.

Wire it the same way `emitSubagent` already works — build the callback before the graph and forward it through `subagentSinkRef`'s sibling:

```typescript
const memorySinkRef: { sink: ((chunk: UIMessageChunk) => void) | null } = { sink: null };
const emitMemory = (op: 'recall' | 'save', summary: string) => {
    try {
        memorySinkRef.sink?.(buildMemoryPart(op, summary) as UIMessageChunk);
    } catch {
        // client disconnected — stream teardown handles it
    }
};
```

Pass `onMemoryEvent: emitMemory` into `graphConfig` for deep only, and set `memorySinkRef.sink` inside `processStream`'s `start(controller)` alongside the existing `subagentSinkRef.sink` assignment. `deep-agent.ts` forwards it into `createDeepMemoryMiddleware`.

Verify the part shape is byte-identical to what fast/plan emit so the existing renderer needs no change.

- [ ] **Step 7: Typecheck and run the full suite**

```bash
cd apps/web-ui && bunx tsc --noEmit && bun run test
```

Expected: PASS.

- [ ] **Step 8: Commit the framework wiring**

```bash
git add apps/web-ui/app/api/chat/route.ts
git commit -m "feat(chat): wire the rewritten deep agent into the chat route"
```

This is the second commit for this task — the KB change landed separately in Step 1.

---

## Task 9: Manual end-to-end verification

Unit tests cannot prove the UI contract survived. Exercise the real thing before calling this done.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d postgres
cd apps/web-ui && bun run dev
```

- [ ] **Step 2: Run the checks**

In Deep mode, confirm each of these and record the result:

1. A plain question answers without tools.
2. A multi-step AWS request populates the plan rail (todos) and it updates as steps complete.
3. With auto-approve **off**, a mutating command raises an approval card; **Approve** runs it; the transcript shows the result under the original card.
4. With auto-approve **off**, **Reject with a reason** — the agent acknowledges and adapts rather than retrying the identical command.
5. An ambiguous request triggers `ask_user`; answering it resumes the run with the answer.
6. A delegated task renders a subagent card that resolves to complete with a summary.
7. A question answerable from the knowledge base cites KB content.
8. With a skill selected, the agent follows it; with none, it discovers skills from the catalogue.
9. Reload mid-approval — the pending card is still there and still decidable.

- [ ] **Step 3: Confirm tenant isolation**

```bash
ls -la ${TMPDIR:-/tmp}/nucleus-agent/
```

Expected: one subdirectory per tenant that has run a deep session, each containing `skills/`. No files at the shared root from this run.

- [ ] **Step 4: Confirm fast and plan are untouched**

Run the same thread in Fast mode and in Plan & Execute mode. Approval, plan rail, subagent cards and KB must behave exactly as before this branch.

---

## Deferred

- Migrating Fast and Plan & Execute onto `createDeepAgent` — the stated end goal, once deep has earned confidence.
- Moving the stream loop to `streamEvents` v3 and `run.subagents`. Better long-term, but it rewrites the loop for all three modes, so it belongs with the migration above.
- Framework `memory:` (AGENTS.md) middleware — deliberately off; our pgvector/episodic/procedural memory is richer.
