# AIOps Sub-Agent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut AI Ops chat run time from ~10 minutes by adding intra-turn parallel tool calls and a read-only `dispatch_agent` sub-agent tool with isolated context, bounded by tenant-configurable budgets.

**Architecture:** The orchestrator graph (`planning-agent.ts`) keeps its exact topology. Layer A removes the prompt rules that forbid batching independent tool calls, so `ToolNode`'s existing concurrency is used. Layer B adds `dispatch_agent` as an ordinary tool — the orchestrator emits several in one turn and `ToolNode` fans them out. Each sub-agent is an ephemeral, non-checkpointed ReAct loop restricted to read-only tools that returns one compressed report, so raw tool output never enters the orchestrator's context.

**Tech Stack:** TypeScript 5, Next.js 15.5.15 App Router, LangChain/LangGraph, Prisma 5 (web-ui), Vitest 4, TanStack Query 5, React Hook Form + Zod 4, sonner, Tailwind + Radix (shadcn/ui).

**Spec:** `docs/superpowers/specs/2026-07-26-aiops-subagent-orchestration-design.md`

## Global Constraints

- **Working directory for all commands:** `apps/web-ui` unless stated otherwise. Tests run with `bun run test` (this is `vitest run` — single pass, not watch).
- **Path alias:** `@/` maps to `apps/web-ui/`. Use it for all cross-directory imports; relative imports only within the same directory.
- **Indentation:** 4 spaces in `lib/` and `app/api/` files; 2 spaces in `components/`. Match the file you are editing.
- **Multi-tenant safety:** every DB query is scoped via `getTenantClient(tenantId)`. Data access goes through the repository factory (`@/lib/db/repository-factory`), never Prisma directly from a route or service.
- **API responses:** `NextResponse.json({ success: true, data }, { status })` or `{ success: false, error: string }`.
- **RBAC:** every mutating route calls `authorize(action, Subject)` from `@/lib/rbac/authorize`. The `Agent` subject already maps to the `AIOps` module (`lib/rbac/types.ts:33`) — do not add a new subject.
- **Toasts:** import `toast` from `"sonner"` directly in new code.
- **Forms:** React Hook Form + `@hookform/resolvers/zod` + Zod 4. Do not build forms with manual `useState`.
- **Zod 4:** use `err.issues` (not `.errors`); `z.record()` requires the two-arg key+value form.
- **UI primitives:** consume `components/ui/*`; never modify them.
- **Never claim a step passes without running the command and reading its output.**

---

### Task 1: Make AWS session-profile writes concurrency-safe

Parallel tool calls and parallel sub-agents both call `get_aws_credentials` concurrently. `createSessionProfile` currently does an unlocked read-modify-write of one shared file, so concurrent callers silently lose each other's profiles and the agent then fails with "The config profile could not be found". This task is a hard prerequisite for Tasks 3 and 7.

**Files:**
- Modify: `apps/web-ui/lib/agent/session-manager.ts`
- Modify: `apps/web-ui/lib/agent/aws-credentials-tool.ts:100-121`
- Test: `apps/web-ui/lib/agent/session-manager.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createSessionProfile(accountId: string, credentials: AwsCredentials, tenantId?: string): Promise<SessionProfile>` — unchanged signature, now serialized.
  - `getOrCreateSessionProfile(accountId: string, tenantId: string, assume: () => Promise<AwsCredentials>): Promise<SessionProfile>` — returns a cached profile when it has more than `PROFILE_REFRESH_MARGIN_MS` of life left, otherwise assumes fresh credentials via the `assume` callback.
  - `__resetProfileCacheForTests(): void`

- [ ] **Step 1: Write the failing concurrency test**

Create `apps/web-ui/lib/agent/session-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
    createSessionProfile,
    getOrCreateSessionProfile,
    getTenantCredentialsFilePath,
    __resetProfileCacheForTests,
} from './session-manager';

const TENANT = 'tenant-concurrency-test';

function creds(region = 'us-east-1') {
    return {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        region,
    };
}

beforeEach(() => {
    __resetProfileCacheForTests();
});

afterEach(async () => {
    await fs.rm(path.dirname(getTenantCredentialsFilePath(TENANT)), { recursive: true, force: true });
});

describe('createSessionProfile concurrency', () => {
    it('keeps every profile when 10 callers write at the same time', async () => {
        const accountIds = Array.from({ length: 10 }, (_, i) => `10000000000${i}`);

        const profiles = await Promise.all(
            accountIds.map(id => createSessionProfile(id, creds(), TENANT)),
        );

        const contents = await fs.readFile(getTenantCredentialsFilePath(TENANT), 'utf-8');
        for (const profile of profiles) {
            expect(contents).toContain(`[${profile.profileName}]`);
        }
    });

    it('writes the credentials file atomically (no partial content observed)', async () => {
        await createSessionProfile('222222222222', creds(), TENANT);
        const filePath = getTenantCredentialsFilePath(TENANT);
        const stat = await fs.stat(filePath);
        expect(stat.mode & 0o777).toBe(0o600);

        const dir = path.dirname(filePath);
        const leftovers = (await fs.readdir(dir)).filter(f => f.endsWith('.tmp'));
        expect(leftovers).toEqual([]);
    });
});

describe('getOrCreateSessionProfile caching', () => {
    it('reuses a fresh profile instead of assuming again', async () => {
        const assume = vi.fn().mockResolvedValue(creds());

        const first = await getOrCreateSessionProfile('333333333333', TENANT, assume);
        const second = await getOrCreateSessionProfile('333333333333', TENANT, assume);

        expect(assume).toHaveBeenCalledTimes(1);
        expect(second.profileName).toBe(first.profileName);
    });

    it('re-assumes when the cached profile is near expiry', async () => {
        const assume = vi.fn().mockResolvedValue(creds());

        const first = await getOrCreateSessionProfile('444444444444', TENANT, assume);
        // Force the cached entry to be 30s from expiry — inside the 120s refresh margin.
        first.expiresAt = new Date(Date.now() + 30_000);

        const second = await getOrCreateSessionProfile('444444444444', TENANT, assume);

        expect(assume).toHaveBeenCalledTimes(2);
        expect(second.profileName).not.toBe(first.profileName);
    });

    it('scopes the cache by tenant', async () => {
        const assume = vi.fn().mockResolvedValue(creds());

        await getOrCreateSessionProfile('555555555555', TENANT, assume);
        await getOrCreateSessionProfile('555555555555', `${TENANT}-other`, assume);

        expect(assume).toHaveBeenCalledTimes(2);
        await fs.rm(path.dirname(getTenantCredentialsFilePath(`${TENANT}-other`)), { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/session-manager.test.ts`

Expected: FAIL. `getOrCreateSessionProfile` and `__resetProfileCacheForTests` are not exported, so the import fails to resolve.

- [ ] **Step 3: Add the per-file lock and atomic write**

In `apps/web-ui/lib/agent/session-manager.ts`, add `randomUUID` to the imports:

```typescript
import { randomUUID } from 'crypto';
```

Then add the lock helper immediately after the `PROFILE_PREFIX` constant (around line 53):

```typescript
/**
 * Serializes read-modify-write cycles per credentials file.
 *
 * Node is single-threaded, but `await` between the read and the write yields the
 * event loop: two concurrent callers both read the old content and the second
 * write clobbers the first caller's profile. The victim then runs
 * `aws --profile <name>` against a profile that is not in the file and gets
 * "The config profile could not be found". Chaining every mutation onto a
 * per-path promise removes the interleaving window.
 *
 * The map is keyed by resolved file path, so the legacy shared-file path is
 * covered too. Key count is bounded by tenant count, so it is not a leak.
 */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const previous = fileLocks.get(filePath) ?? Promise.resolve();
    // Run `fn` whether the predecessor resolved or rejected — one caller's
    // failure must not deadlock every later caller on the same file.
    const next = previous.then(fn, fn);
    fileLocks.set(filePath, next.catch(() => undefined));
    return next;
}
```

Replace the body of `writeCredentialsFile` (line 90) with an atomic write:

```typescript
async function writeCredentialsFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename: a concurrent reader (the AWS CLI) never observes a
    // half-written credentials file. The temp file is created in the same
    // directory so the rename stays on one filesystem and is therefore atomic.
    const tmpPath = path.join(dir, `.credentials.${process.pid}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(tmpPath, content, { mode: 0o600 });
        await fs.rename(tmpPath, filePath);
    } catch (error) {
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
```

Wrap the read-modify-write inside `createSessionProfile`. Replace lines 159-172 (from `// Read current credentials file` through the `writeCredentialsFile` call) with:

```typescript
    await withFileLock(credentialsFile, async () => {
        const content = await readCredentialsFile(credentialsFile);
        const profiles = parseCredentialsFile(content);

        const profileCreds = new Map<string, string>();
        profileCreds.set('aws_access_key_id', credentials.accessKeyId);
        profileCreds.set('aws_secret_access_key', credentials.secretAccessKey);
        profileCreds.set('aws_session_token', credentials.sessionToken);
        profileCreds.set('region', credentials.region);
        profiles.set(profileName, profileCreds);

        await writeCredentialsFile(credentialsFile, serializeCredentialsFile(profiles));
    });
```

- [ ] **Step 4: Add the profile cache with refresh-on-near-expiry**

Append to `apps/web-ui/lib/agent/session-manager.ts`, before the module-load cleanup call on line 233:

```typescript
/**
 * Re-assume when a cached profile has less than this much life left. STS
 * credentials here last 900s (see assumeRoleForAccount); handing back a profile
 * with 10s remaining guarantees the next AWS CLI call fails mid-flight.
 */
const PROFILE_REFRESH_MARGIN_MS = 120_000;

const profileCache = new Map<string, SessionProfile>();

function profileCacheKey(tenantId: string, accountId: string): string {
    return `${tenantId}:${accountId}`;
}

/**
 * Return a usable session profile for (tenant, account), assuming fresh
 * credentials only when there is no cached profile or the cached one is within
 * PROFILE_REFRESH_MARGIN_MS of expiry.
 *
 * Fan-out makes this matter twice over: N sub-agents auditing the same account
 * previously triggered N AssumeRole calls, and a long run could hand out a
 * profile that expired before it was used.
 */
export async function getOrCreateSessionProfile(
    accountId: string,
    tenantId: string,
    assume: () => Promise<AwsCredentials>,
): Promise<SessionProfile> {
    const key = profileCacheKey(tenantId, accountId);
    const cached = profileCache.get(key);
    if (cached && cached.expiresAt.getTime() - Date.now() > PROFILE_REFRESH_MARGIN_MS) {
        console.log(`[SessionManager] Reusing cached profile ${cached.profileName} for ${key}`);
        return cached;
    }

    const credentials = await assume();
    const profile = await createSessionProfile(accountId, credentials, tenantId);
    profileCache.set(key, profile);
    return profile;
}

/** Test seam — clears the in-process profile cache between test cases. */
export function __resetProfileCacheForTests(): void {
    profileCache.clear();
    fileLocks.clear();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/session-manager.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Route `get_aws_credentials` through the cache**

In `apps/web-ui/lib/agent/aws-credentials-tool.ts`, change the import on line 5:

```typescript
import { getOrCreateSessionProfile } from './session-manager';
```

Replace lines 100-121 (the assume-then-create block, from `// 2. Assume the role` through the two `console.log` lines that follow profile creation) with:

```typescript
                // 2/3/4. Resolve region, then get a cached-or-fresh session profile.
                // getOrCreateSessionProfile only calls STS when there is no live
                // profile left for this (tenant, account) pair.
                const region = account.regions?.[0] || env.AWS_REGION || env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';

                const profile = await getOrCreateSessionProfile(accountId, tenantId, async () => {
                    const { credentials } = await assumeRoleForAccount(
                        account.roleArn!,
                        account.externalId,
                    );
                    return {
                        accessKeyId: credentials.AccessKeyId!,
                        secretAccessKey: credentials.SecretAccessKey!,
                        sessionToken: credentials.SessionToken!,
                        region,
                    };
                });

                console.log(`[Tool] Profile: ${profile.profileName} for account: ${accountId}`);
                console.log(`[Tool] Profile expires at: ${profile.expiresAt.toISOString()}`);
```

The `region` const previously declared at line 107 is now declared above — delete the old declaration so there is no duplicate binding.

- [ ] **Step 7: Typecheck and run the full agent test suite**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no errors in `lib/agent/session-manager.ts` or `lib/agent/aws-credentials-tool.ts`.

Run: `cd apps/web-ui && bunx vitest run lib/agent/`
Expected: PASS. Note the pre-existing failing mock-harness tests recorded in project memory — compare against the count on `git stash`ed baseline if anything looks new.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/agent/session-manager.ts apps/web-ui/lib/agent/aws-credentials-tool.ts apps/web-ui/lib/agent/session-manager.test.ts
git commit -m "fix(agent): make AWS session-profile writes concurrency-safe

Unlocked read-modify-write on the shared per-tenant credentials file let
concurrent get_aws_credentials calls silently drop each other's profiles,
surfacing as 'The config profile could not be found'. Serialize per file,
write atomically via rename, and cache profiles with refresh-on-near-expiry
so fan-out does not multiply AssumeRole calls."
```

- [ ] **Step 9: Make profile names collision-proof**

Added after Task 3 surfaced this as an intermittent failure of Step 1's
"re-assumes when the cached profile is near expiry" test (roughly 1 run in 3).

`generateProfileName` derives the name from `Date.now()` alone:

```typescript
function generateProfileName(accountId: string): string {
    const timestamp = Date.now();
    return `${PROFILE_PREFIX}${accountId}_${timestamp}`;
}
```

Two profiles for the same account created within the same millisecond therefore
get **identical names**, and the second silently overwrites the first's section in
the credentials file — the same lost-profile bug class this task exists to remove,
just reached by a different route. The mutex cannot help: each call is individually
serialized and still produces a colliding name. Parallel fan-out (Task 3) and
parallel sub-agents (Task 8) make same-millisecond creation routine rather than
theoretical.

Replace it with:

```typescript
function generateProfileName(accountId: string): string {
    // Date.now() alone collides when two profiles for one account are created in
    // the same millisecond — which parallel get_aws_credentials calls do routinely.
    // A colliding name means the second profile overwrites the first's section and
    // the first caller's handle silently points at someone else's credentials.
    return `${PROFILE_PREFIX}${accountId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}
```

`randomUUID` is already imported at the top of the file from Step 3.

Add this regression test to `session-manager.test.ts`, inside the
`describe('createSessionProfile concurrency', ...)` block:

```typescript
    it('gives every profile a unique name even within the same millisecond', async () => {
        // 50 back-to-back creations for ONE account will land many in the same ms.
        const profiles = await Promise.all(
            Array.from({ length: 50 }, () => createSessionProfile('999999999999', creds(), TENANT)),
        );

        const names = new Set(profiles.map(p => p.profileName));
        expect(names.size).toBe(50);

        // And every one of them must actually be present in the file.
        const contents = await fs.readFile(getTenantCredentialsFilePath(TENANT), 'utf-8');
        for (const name of names) {
            expect(contents).toContain(`[${name}]`);
        }
    });
```

Run: `cd apps/web-ui && bunx vitest run lib/agent/session-manager.test.ts` — expect 6/6.

Then run it **five times in a row** and confirm 6/6 every time; the bug this fixes
is intermittent, so a single green run proves nothing:

```bash
cd apps/web-ui && for i in 1 2 3 4 5; do bunx vitest run lib/agent/session-manager.test.ts 2>&1 | grep -E "^ +Tests "; done
```

```bash
git add apps/web-ui/lib/agent/session-manager.ts apps/web-ui/lib/agent/session-manager.test.ts
git commit -m "fix(agent): make session profile names collision-proof

Date.now() alone collides when two profiles for one account are created in the
same millisecond, so the second silently overwrote the first's section — the
same lost-profile bug the mutex was added to prevent, reached by a different
route. Surfaced as an intermittent test failure once parallel tool calls landed."
```

---

### Task 2: Per-run timing summary

Establishes the measurement baseline before any behaviour changes, so Layer A's and Layer B's contributions are attributable rather than assumed. `llmAuditLog` already computes per-call latency and token counts but discards them unless `LLM_AUDIT` is on.

**Files:**
- Create: `apps/web-ui/lib/agent/run-timings.ts`
- Create: `apps/web-ui/lib/agent/run-timings.test.ts`
- Modify: `apps/web-ui/lib/agent/planning-agent.ts` (5 call sites)
- Modify: `apps/web-ui/app/api/chat/route.ts` (stream teardown)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `recordNodeTiming(threadId: string | undefined, node: string, latencyMs: number, tokensIn: number, tokensOut: number): void`
  - `summarizeRun(threadId: string): RunTimingSummary | null`
  - `logRunSummary(threadId: string): void` — logs and then discards the run's entry.
  - `interface RunTimingSummary { totalLlmMs: number; totalTokensIn: number; totalTokensOut: number; byNode: Record<string, { calls: number; ms: number; tokensIn: number; tokensOut: number }> }`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/run-timings.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { recordNodeTiming, summarizeRun, logRunSummary, __resetRunTimingsForTests } from './run-timings';

beforeEach(() => __resetRunTimingsForTests());

describe('run timings', () => {
    it('aggregates calls per node', () => {
        recordNodeTiming('t1', 'EXECUTOR', 1000, 500, 100);
        recordNodeTiming('t1', 'EXECUTOR', 2000, 600, 150);
        recordNodeTiming('t1', 'REFLECTOR', 500, 200, 50);

        const summary = summarizeRun('t1')!;

        expect(summary.totalLlmMs).toBe(3500);
        expect(summary.totalTokensIn).toBe(1300);
        expect(summary.totalTokensOut).toBe(300);
        expect(summary.byNode.EXECUTOR).toEqual({ calls: 2, ms: 3000, tokensIn: 1100, tokensOut: 250 });
        expect(summary.byNode.REFLECTOR.calls).toBe(1);
    });

    it('keeps runs isolated by threadId', () => {
        recordNodeTiming('t1', 'EXECUTOR', 1000, 10, 10);
        recordNodeTiming('t2', 'EXECUTOR', 5000, 20, 20);

        expect(summarizeRun('t1')!.totalLlmMs).toBe(1000);
        expect(summarizeRun('t2')!.totalLlmMs).toBe(5000);
    });

    it('ignores calls with no threadId rather than throwing', () => {
        expect(() => recordNodeTiming(undefined, 'EXECUTOR', 100, 1, 1)).not.toThrow();
        expect(summarizeRun('t1')).toBeNull();
    });

    it('discards the run after logging its summary', () => {
        recordNodeTiming('t1', 'EXECUTOR', 100, 1, 1);
        logRunSummary('t1');
        expect(summarizeRun('t1')).toBeNull();
    });

    it('returns null for an unknown thread', () => {
        expect(summarizeRun('never-seen')).toBeNull();
    });

    it('does not evict a run that is still recording', () => {
        // The eviction backstop must target the most IDLE run, not the
        // oldest-started one. A 10-minute agent run is exactly the run whose
        // numbers matter most, and it is also the one that has been in the map
        // longest — evicting it would silently discard the measurement.
        recordNodeTiming('long-runner', 'EXECUTOR', 1000, 10, 10);

        // Fill past capacity with other threads, while the long runner keeps working.
        for (let i = 0; i < 250; i++) {
            recordNodeTiming(`other-${i}`, 'EXECUTOR', 1, 1, 1);
            recordNodeTiming('long-runner', 'EXECUTOR', 1000, 10, 10);
        }

        const summary = summarizeRun('long-runner');
        expect(summary).not.toBeNull();
        expect(summary!.byNode.EXECUTOR.calls).toBe(251);
    });

    it('still bounds the map when runs never reach teardown', () => {
        for (let i = 0; i < 300; i++) {
            recordNodeTiming(`abandoned-${i}`, 'EXECUTOR', 1, 1, 1);
        }
        // The earliest abandoned runs must have been evicted.
        expect(summarizeRun('abandoned-0')).toBeNull();
        expect(summarizeRun('abandoned-299')).not.toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/run-timings.test.ts`
Expected: FAIL — cannot resolve `./run-timings`.

- [ ] **Step 3: Implement the module**

Create `apps/web-ui/lib/agent/run-timings.ts`:

```typescript
/**
 * Per-run LLM timing accumulator.
 *
 * llmAuditLog already measures latency and tokens for every model call, but
 * throws the numbers away unless LLM_AUDIT is enabled. This module keeps a
 * lightweight always-on aggregate so a run's wall time can be attributed to
 * specific graph nodes — the baseline needed to tell whether parallelism
 * actually helped.
 *
 * Keyed by threadId because runs are concurrent within one process.
 */

export interface NodeTiming {
    calls: number;
    ms: number;
    tokensIn: number;
    tokensOut: number;
}

export interface RunTimingSummary {
    totalLlmMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
    byNode: Record<string, NodeTiming>;
}

/** Backstop against unbounded growth if a run never reaches its teardown. */
const MAX_TRACKED_RUNS = 200;

const runs = new Map<string, Record<string, NodeTiming>>();

export function recordNodeTiming(
    threadId: string | undefined,
    node: string,
    latencyMs: number,
    tokensIn: number,
    tokensOut: number,
): void {
    if (!threadId) return;

    let byNode = runs.get(threadId);
    if (!byNode) {
        if (runs.size >= MAX_TRACKED_RUNS) {
            const oldest = runs.keys().next().value;
            if (oldest !== undefined) runs.delete(oldest);
        }
        byNode = {};
    } else {
        // Refresh position: Map keeps INSERTION order, and .set() on an
        // existing key does not move it. Without this, eviction targets the
        // oldest-STARTED run — which is exactly the long run we most want to
        // measure. Delete-then-set makes it least-recently-ACTIVE.
        runs.delete(threadId);
    }
    runs.set(threadId, byNode);

    const entry = byNode[node] ?? { calls: 0, ms: 0, tokensIn: 0, tokensOut: 0 };
    entry.calls += 1;
    entry.ms += latencyMs;
    entry.tokensIn += tokensIn;
    entry.tokensOut += tokensOut;
    byNode[node] = entry;
}

export function summarizeRun(threadId: string): RunTimingSummary | null {
    const byNode = runs.get(threadId);
    if (!byNode) return null;

    let totalLlmMs = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    for (const entry of Object.values(byNode)) {
        totalLlmMs += entry.ms;
        totalTokensIn += entry.tokensIn;
        totalTokensOut += entry.tokensOut;
    }

    return { totalLlmMs, totalTokensIn, totalTokensOut, byNode };
}

export function logRunSummary(threadId: string): void {
    const summary = summarizeRun(threadId);
    runs.delete(threadId);
    if (!summary) return;

    const rows = Object.entries(summary.byNode)
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([node, t]) =>
            `   ${node.padEnd(12)} calls=${String(t.calls).padStart(3)}  llm=${(t.ms / 1000).toFixed(1)}s  in=${t.tokensIn}  out=${t.tokensOut}`);

    console.log(
        `\n📊 [RUN SUMMARY] thread=${threadId}\n` +
        `   TOTAL        llm=${(summary.totalLlmMs / 1000).toFixed(1)}s  in=${summary.totalTokensIn}  out=${summary.totalTokensOut}\n` +
        rows.join('\n'),
    );
}

/** Test seam. */
export function __resetRunTimingsForTests(): void {
    runs.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/run-timings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Record timings from the planning-agent nodes**

In `apps/web-ui/lib/agent/planning-agent.ts`, add to the imports from `./run-timings`:

```typescript
import { recordNodeTiming } from "./run-timings";
```

Three nodes do not currently receive the runtime config. Change their signatures so a threadId is available:

- `planNode(state: ReflectionState)` → `planNode(state: ReflectionState, runtimeConfig?: any)`
- `reflectNode(state: ReflectionState)` → `reflectNode(state: ReflectionState, runtimeConfig?: any)`
- `finalNode(state: ReflectionState)` → `finalNode(state: ReflectionState, runtimeConfig?: any)`

LangGraph already passes `(state, config)` to every node, so no `addNode` call changes.

Then, immediately after each `llmAuditLog(...)` call, add the matching `recordNodeTiming` line. There are five call sites; each uses the `_auditStart_*` timestamp already in scope:

```typescript
// after llmAuditLog('PLANNER', _auditInputs_plan, response, _auditStart_plan);
recordNodeTiming(runtimeConfig?.configurable?.thread_id, 'PLANNER', Date.now() - _auditStart_plan,
    (response as any).usage_metadata?.input_tokens ?? 0, (response as any).usage_metadata?.output_tokens ?? 0);
```

Repeat with these node labels and variables:

| Node function | Label | Start var | Response var |
|---|---|---|---|
| `planNode` | `'PLANNER'` | `_auditStart_plan` | `response` |
| `generateNode` | `'EXECUTOR'` | `_auditStart_exec` | `response` |
| `reflectNode` | `'REFLECTOR'` | `_auditStart_ref` | `response` |
| `reviseNode` | `'REVISER'` | `_auditStart_rev` | `response` |
| `finalNode` | `'FINAL'` | `_auditStart_fin` | `summaryResponse` |

`generateNode` and `reviseNode` already receive `runtimeConfig`.

- [ ] **Step 6: Log the summary when the stream ends**

In `apps/web-ui/app/api/chat/route.ts`, add the import:

```typescript
import { logRunSummary } from '@/lib/agent/run-timings';
```

Find the `for await (const event of stream)` loop (line 826). Locate the enclosing `try`/`finally` (or the point where the stream completes and the controller is closed) and add to the teardown path:

```typescript
                    // Emit the per-run timing breakdown regardless of how the run ended,
                    // so aborted and errored runs are measured too.
                    logRunSummary(threadId);
```

- [ ] **Step 7: Verify typecheck and tests**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

Run: `cd apps/web-ui && bunx vitest run lib/agent/`
Expected: PASS (same pre-existing failures as the Task 1 baseline, no new ones).

- [ ] **Step 8: Capture the baseline manually**

Start the app (`docker compose up -d postgres` at repo root, then `cd apps/web-ui && bun run dev`), run one representative slow AI Ops chat task, and copy the `📊 [RUN SUMMARY]` block from the server log into the commit message. This is the number every later task is measured against.

- [ ] **Step 9: Commit**

```bash
git add apps/web-ui/lib/agent/run-timings.ts apps/web-ui/lib/agent/run-timings.test.ts apps/web-ui/lib/agent/planning-agent.ts apps/web-ui/app/api/chat/route.ts
git commit -m "feat(agent): per-run LLM timing summary

Aggregates the latency and token counts llmAuditLog already computes into a
per-node breakdown logged at run end, so the cost of each graph node is
attributable before parallelism changes land."
```

---

### Task 3: Layer A — allow batched parallel tool calls

`ToolNode` already executes multiple `tool_calls` from one AI message concurrently. The executor prompt forbids using that, turning an N-way independent sweep into N serial laps. This task removes the prohibition and bounds the resulting shell-command concurrency.

**Files:**
- Create: `apps/web-ui/lib/agent/concurrency.ts`
- Create: `apps/web-ui/lib/agent/concurrency.test.ts`
- Modify: `apps/web-ui/lib/agent/tools.ts:101-157` (`executeCommandTool`)
- Modify: `apps/web-ui/lib/agent/planning-agent.ts:402-407` (executor prompt), `:291-292` (planner prompt), `:750-759` (reviser prompt)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class Semaphore { constructor(limit: number); run<T>(fn: () => Promise<T>): Promise<T> }`

- [ ] **Step 1: Write the failing semaphore test**

Create `apps/web-ui/lib/agent/concurrency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Semaphore } from './concurrency';

const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
};

describe('Semaphore', () => {
    it('never runs more than `limit` tasks at once', async () => {
        const sem = new Semaphore(2);
        let active = 0;
        let peak = 0;

        const task = async () => sem.run(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 5));
            active--;
        });

        await Promise.all(Array.from({ length: 10 }, task));

        expect(peak).toBe(2);
        expect(active).toBe(0);
    });

    it('releases the slot when a task throws', async () => {
        const sem = new Semaphore(1);

        await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

        // If the slot leaked, this would hang rather than resolve.
        await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    });

    it('queues callers beyond the limit and runs them as slots free', async () => {
        const sem = new Semaphore(1);
        const first = defer();
        const order: string[] = [];

        const a = sem.run(async () => { order.push('a-start'); await first.promise; order.push('a-end'); });
        const b = sem.run(async () => { order.push('b-start'); });

        expect(order).toEqual(['a-start']);
        first.resolve();
        await Promise.all([a, b]);
        expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    });

    it('treats a limit below 1 as 1', async () => {
        const sem = new Semaphore(0);
        await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/concurrency.test.ts`
Expected: FAIL — cannot resolve `./concurrency`.

- [ ] **Step 3: Implement the semaphore**

Create `apps/web-ui/lib/agent/concurrency.ts`:

```typescript
/**
 * Minimal counting semaphore.
 *
 * Once the executor is allowed to emit many tool calls in one turn, ToolNode
 * runs them all concurrently. That is the point — but execute_command spawns a
 * real subprocess per call, so an unbounded 45-call turn would fork 45 shells
 * inside the web-ui container. This bounds that specific blast radius.
 */
export class Semaphore {
    private available: number;
    private readonly waiters: Array<() => void> = [];

    constructor(limit: number) {
        this.available = Math.max(1, Math.floor(limit));
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        // Deliberately NOT `await this.acquire()` here: awaiting any promise —
        // even one already resolved — yields a microtask before continuing, so
        // a caller that finds a free slot would still run `fn` one tick late.
        // Callers (and this file's own tests) rely on a free slot starting
        // `fn` synchronously within the `run()` call.
        if (this.available > 0) {
            this.available--;
        } else {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private release(): void {
        const next = this.waiters.shift();
        if (next) {
            // Hand the slot straight to the next waiter — do not increment, or a
            // third caller could take the slot we just promised away.
            next();
            return;
        }
        this.available++;
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/concurrency.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Bound shell-command concurrency**

In `apps/web-ui/lib/agent/tools.ts`, add the import near the top:

```typescript
import { Semaphore } from './concurrency';
```

Add below the `MAX_OUTPUT_LENGTH` constant (line 83):

```typescript
/**
 * Caps concurrent shell subprocesses across the whole process. Other tools
 * (AWS SDK, Prisma, MCP) are network/DB calls that are already pooled by their
 * own clients, so only execute_command needs an explicit bound.
 */
const TOOL_CONCURRENCY = Number(process.env.TOOL_CONCURRENCY) || 6;
const commandSemaphore = new Semaphore(TOOL_CONCURRENCY);
```

In `executeCommandTool`, wrap the `execAsync` call (line 131). Replace:

```typescript
            const { stdout, stderr } = await execAsync(command, {
```

with:

```typescript
            const { stdout, stderr } = await commandSemaphore.run(() => execAsync(command, {
```

and close the extra paren on the options object — the closing `});` on line 136 becomes `}));`.

- [ ] **Step 6: Replace the anti-batching prompt rules**

In `apps/web-ui/lib/agent/planning-agent.ts`, in `generateNode`'s `## Execution Discipline` block, replace this line (line 404):

```
- Execute exactly the current step — do not skip ahead or bundle future steps into a single call.
```

with:

```
- Execute the current step. When that step covers several INDEPENDENT read-only lookups (different accounts, regions, or services), issue them as MULTIPLE tool calls in this single turn — they run in parallel. One call per turn for independent reads wastes minutes.
- Calls that DEPEND on each other must stay sequential: if call B needs call A's output (an account id, a resource id, a profile name), make call A now and call B on the next turn.
- Never batch mutations. Issue at most ONE state-changing call per turn so each is reviewed and approved individually.
- Do not skip ahead to later plan steps.
```

In `planNode`'s `## Rules for Plan Steps`, replace line 292:

```
- Keep the plan SHORT: never more than 7 steps. Merge related read-only queries into a single step (e.g., one step for "inventory EC2 + RDS + EBS across regions", not one step per service per region).
```

with:

```
- Keep the plan SHORT: never more than 7 steps. Merge related read-only queries into a single step (e.g., one step for "inventory EC2 + RDS + EBS across regions", not one step per service per region). The executor issues the individual queries in that step as parallel tool calls, so a merged step costs no more time than a narrow one.
```

In `reviseNode`'s `## Revision Approach`, append a ninth item after item 8 (line 759):

```
9. When the fix requires several independent read-only re-checks, issue them as multiple tool calls in this single turn rather than one per turn.
```

- [ ] **Step 7: Verify typecheck and tests**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

Run: `cd apps/web-ui && bunx vitest run lib/agent/`
Expected: PASS with no new failures.

- [ ] **Step 8: Measure against the Task 2 baseline**

Re-run the same representative task used in Task 2 Step 8. Compare the `📊 [RUN SUMMARY]` `EXECUTOR calls=` count and total wall time. A large drop in executor call count is the signal this task worked. Record both numbers in the commit message.

- [ ] **Step 9: Commit**

```bash
git add apps/web-ui/lib/agent/concurrency.ts apps/web-ui/lib/agent/concurrency.test.ts apps/web-ui/lib/agent/tools.ts apps/web-ui/lib/agent/planning-agent.ts
git commit -m "perf(agent): allow batched parallel tool calls in one executor turn

ToolNode already ran multiple tool_calls concurrently; the executor prompt
forbade emitting them, so an N-way independent sweep cost N serial LLM laps.
Independent read-only calls now batch into one turn while dependent calls and
mutations stay sequential. Shell subprocesses are bounded by TOOL_CONCURRENCY."
```

---

### Task 4: Sub-agent budget resolution

Pure configuration logic with no I/O beyond the tenant-config read, so it is fully unit-testable and can land before anything consumes it. Mirrors `lib/agent-ops/agent-ops-defaults.ts`.

**Files:**
- Create: `apps/web-ui/lib/agent/subagent-budget.ts`
- Create: `apps/web-ui/lib/agent/subagent-budget.test.ts`

**Interfaces:**
- Consumes: `TenantConfigService.getConfig` from `@/lib/tenant-config-service`.
- Produces:
  - `const SUBAGENT_CONFIG_KEY = 'aiops-subagents'`
  - `interface SubagentBudgetConfig { enabled: boolean; maxConcurrentSubagents: number; maxSubagentsPerRun: number; maxSubagentTokensPerRun: number; subagentMaxIterations: number; subagentTimeoutMs: number }`
  - `const BUDGET_BOUNDS: Record<keyof Omit<SubagentBudgetConfig, 'enabled'>, { min: number; max: number; default: number }>`
  - `platformSubagentsEnabled(): boolean`
  - `clampBudget(input: Partial<SubagentBudgetConfig> | null): SubagentBudgetConfig`
  - `resolveSubagentBudget(tenantId: string): Promise<SubagentBudgetConfig>`
  - `validateBudgetInput(input: unknown): string | null`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/subagent-budget.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn() },
}));

import { TenantConfigService } from '@/lib/tenant-config-service';
import {
    clampBudget,
    resolveSubagentBudget,
    validateBudgetInput,
    platformSubagentsEnabled,
    BUDGET_BOUNDS,
} from './subagent-budget';

beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUBAGENTS_ENABLED = 'true';
});
afterEach(() => {
    delete process.env.SUBAGENTS_ENABLED;
    delete process.env.SUBAGENT_MAX_CONCURRENCY;
});

describe('platformSubagentsEnabled', () => {
    it('is false unless SUBAGENTS_ENABLED is exactly "true"', () => {
        delete process.env.SUBAGENTS_ENABLED;
        expect(platformSubagentsEnabled()).toBe(false);
        process.env.SUBAGENTS_ENABLED = 'false';
        expect(platformSubagentsEnabled()).toBe(false);
        process.env.SUBAGENTS_ENABLED = 'true';
        expect(platformSubagentsEnabled()).toBe(true);
    });
});

describe('clampBudget', () => {
    it('returns defaults for null input', () => {
        const budget = clampBudget(null);
        expect(budget.maxConcurrentSubagents).toBe(BUDGET_BOUNDS.maxConcurrentSubagents.default);
        expect(budget.enabled).toBe(false);
    });

    it('clamps a value above the ceiling down', () => {
        expect(clampBudget({ maxConcurrentSubagents: 50 }).maxConcurrentSubagents)
            .toBe(BUDGET_BOUNDS.maxConcurrentSubagents.max);
    });

    it('clamps a value below the floor up', () => {
        expect(clampBudget({ maxSubagentsPerRun: 0 }).maxSubagentsPerRun)
            .toBe(BUDGET_BOUNDS.maxSubagentsPerRun.min);
    });

    it('rounds non-integers', () => {
        expect(clampBudget({ subagentMaxIterations: 7.6 }).subagentMaxIterations).toBe(8);
    });

    it('falls back to the default for non-numeric values', () => {
        expect(clampBudget({ subagentTimeoutMs: 'abc' as unknown as number }).subagentTimeoutMs)
            .toBe(BUDGET_BOUNDS.subagentTimeoutMs.default);
    });

    it('honours an env ceiling lower than the built-in max', () => {
        process.env.SUBAGENT_MAX_CONCURRENCY = '2';
        expect(clampBudget({ maxConcurrentSubagents: 6 }).maxConcurrentSubagents).toBe(2);
    });

    it('IGNORES an env ceiling above the built-in max', () => {
        // The load-bearing multi-tenant isolation invariant: web-ui is a shared
        // ECS task, so no operator misconfiguration may let a tenant exceed the
        // hard cap and saturate the box for co-tenants.
        process.env.SUBAGENT_MAX_CONCURRENCY = '100';
        expect(clampBudget({ maxConcurrentSubagents: 100 }).maxConcurrentSubagents)
            .toBe(BUDGET_BOUNDS.maxConcurrentSubagents.max);
    });
});

describe('resolveSubagentBudget', () => {
    it('returns a disabled budget when the platform kill-switch is off', async () => {
        process.env.SUBAGENTS_ENABLED = 'false';
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true } as never);

        expect((await resolveSubagentBudget('t1')).enabled).toBe(false);
    });

    it('returns tenant config clamped when the platform allows it', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            enabled: true, maxConcurrentSubagents: 99,
        } as never);

        const budget = await resolveSubagentBudget('t1');
        expect(budget.enabled).toBe(true);
        expect(budget.maxConcurrentSubagents).toBe(BUDGET_BOUNDS.maxConcurrentSubagents.max);
    });

    it('returns defaults (disabled) when the tenant has no config', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null as never);
        expect((await resolveSubagentBudget('t1')).enabled).toBe(false);
    });

    it('never throws when the config read fails', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('db down'));
        await expect(resolveSubagentBudget('t1')).resolves.toMatchObject({ enabled: false });
    });
});

describe('validateBudgetInput', () => {
    it('accepts a well-formed payload', () => {
        expect(validateBudgetInput({
            enabled: true, maxConcurrentSubagents: 3, maxSubagentsPerRun: 8,
            maxSubagentTokensPerRun: 400000, subagentMaxIterations: 8, subagentTimeoutMs: 180000,
        })).toBeNull();
    });

    it('rejects a non-object', () => {
        expect(validateBudgetInput(null)).toMatch(/object/i);
    });

    it('rejects a non-boolean enabled', () => {
        expect(validateBudgetInput({ enabled: 'yes' })).toMatch(/enabled/i);
    });

    it('rejects an out-of-range number with a message naming the field', () => {
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: 999 }))
            .toMatch(/maxConcurrentSubagents/);
    });

    it('rejects non-number types rather than coercing them', () => {
        // This function guards the PUT /api/settings/aiops trust boundary, so it
        // must not accept `true` as 1 or "3" as 3.
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: true }))
            .toMatch(/maxConcurrentSubagents/);
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: '3' }))
            .toMatch(/maxConcurrentSubagents/);
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: null }))
            .toMatch(/maxConcurrentSubagents/);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/subagent-budget.test.ts`
Expected: FAIL — cannot resolve `./subagent-budget`.

- [ ] **Step 3: Implement the module**

Create `apps/web-ui/lib/agent/subagent-budget.ts`:

```typescript
/**
 * Sub-agent budget configuration.
 *
 * web-ui runs as a SHARED ECS task, so these limits cannot be purely
 * tenant-controlled: one tenant setting concurrency to 50 would saturate the
 * container's event loop for every co-tenant and flood their LLM provider quota.
 * Env vars are therefore CEILINGS, not overrides:
 *
 *     effective = clamp(tenantConfig ?? default, MIN, envCeiling)
 *
 * Clamping runs on READ (not only on write) so lowering a ceiling retroactively
 * binds config rows written while it was higher.
 *
 * SUBAGENTS_ENABLED is an absolute platform kill-switch: tenant config can
 * never re-enable the feature when it is off.
 */
import { TenantConfigService } from '@/lib/tenant-config-service';

export const SUBAGENT_CONFIG_KEY = 'aiops-subagents';

export interface SubagentBudgetConfig {
    enabled: boolean;
    maxConcurrentSubagents: number;
    maxSubagentsPerRun: number;
    maxSubagentTokensPerRun: number;
    subagentMaxIterations: number;
    subagentTimeoutMs: number;
}

type NumericKey = keyof Omit<SubagentBudgetConfig, 'enabled'>;

interface Bound { min: number; max: number; default: number; envCeiling: string }

/**
 * `max` is the hard platform ceiling. `envCeiling` names an env var that may
 * lower it further (never raise it) for a given deployment.
 */
const BOUNDS_SPEC: Record<NumericKey, Bound> = {
    maxConcurrentSubagents:  { min: 1,      max: 6,       default: 3,       envCeiling: 'SUBAGENT_MAX_CONCURRENCY' },
    maxSubagentsPerRun:      { min: 1,      max: 16,      default: 8,       envCeiling: 'SUBAGENT_MAX_PER_RUN' },
    maxSubagentTokensPerRun: { min: 50_000, max: 1_000_000, default: 400_000, envCeiling: 'SUBAGENT_MAX_TOKENS_PER_RUN' },
    subagentMaxIterations:   { min: 2,      max: 16,      default: 8,       envCeiling: 'SUBAGENT_MAX_ITERATIONS' },
    subagentTimeoutMs:       { min: 30_000, max: 300_000, default: 180_000, envCeiling: 'SUBAGENT_TIMEOUT_MS' },
};

export const BUDGET_BOUNDS = BOUNDS_SPEC;

/** The effective ceiling: the built-in max, lowered (never raised) by env. */
function ceilingFor(key: NumericKey): number {
    const spec = BOUNDS_SPEC[key];
    const fromEnv = Number(process.env[spec.envCeiling]);
    if (!Number.isFinite(fromEnv) || fromEnv <= 0) return spec.max;
    return Math.min(spec.max, Math.round(fromEnv));
}

/** Absolute platform kill-switch. Defaults to OFF. */
export function platformSubagentsEnabled(): boolean {
    return process.env.SUBAGENTS_ENABLED === 'true';
}

export function clampBudget(input: Partial<SubagentBudgetConfig> | null): SubagentBudgetConfig {
    const result: Record<string, unknown> = { enabled: input?.enabled === true };

    for (const key of Object.keys(BOUNDS_SPEC) as NumericKey[]) {
        const spec = BOUNDS_SPEC[key];
        const raw = Number(input?.[key]);
        const value = Number.isFinite(raw) ? Math.round(raw) : spec.default;
        result[key] = Math.min(ceilingFor(key), Math.max(spec.min, value));
    }

    return result as unknown as SubagentBudgetConfig;
}

/**
 * Read a tenant's budget, clamped. Never throws: a config-store failure must
 * degrade to "sub-agents off", not break the chat run.
 */
export async function resolveSubagentBudget(tenantId: string): Promise<SubagentBudgetConfig> {
    if (!platformSubagentsEnabled()) {
        return { ...clampBudget(null), enabled: false };
    }

    const stored = await TenantConfigService
        .getConfig<Partial<SubagentBudgetConfig>>(SUBAGENT_CONFIG_KEY, tenantId)
        .catch(() => null);

    return clampBudget(stored);
}

/** Validate a PUT payload. Returns an error string for a 400, or null. */
export function validateBudgetInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return 'Request body must be an object';
    }
    const body = input as Record<string, unknown>;

    if (typeof body.enabled !== 'boolean') {
        return 'enabled must be a boolean';
    }

    for (const key of Object.keys(BOUNDS_SPEC) as NumericKey[]) {
        if (body[key] === undefined) continue;
        const spec = BOUNDS_SPEC[key];
        // Type-check BEFORE coercing: this function is the trust boundary for the
        // PUT /api/settings/aiops route, and Number() would silently accept
        // `true` as 1 or "3" as 3.
        if (typeof body[key] !== 'number') {
            return `${key} must be a number`;
        }
        const value = Number(body[key]);
        const ceiling = ceilingFor(key);
        if (!Number.isInteger(value) || value < spec.min || value > ceiling) {
            return `${key} must be an integer between ${spec.min} and ${ceiling}`;
        }
    }

    return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/subagent-budget.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Declare the env vars**

In `apps/web-ui/env.ts`, add to the `server:` block alongside the other optional string vars (near `LLM_AUDIT` on line 51):

```typescript
        SUBAGENTS_ENABLED: z.string().optional(),
        SUBAGENT_MAX_CONCURRENCY: z.string().optional(),
        SUBAGENT_MAX_PER_RUN: z.string().optional(),
        SUBAGENT_MAX_TOKENS_PER_RUN: z.string().optional(),
        SUBAGENT_MAX_ITERATIONS: z.string().optional(),
        SUBAGENT_TIMEOUT_MS: z.string().optional(),
        TOOL_CONCURRENCY: z.string().optional(),
```

Add matching commented entries to the repo-root `.env.example`:

```bash
# AI Ops sub-agents (Layer B). SUBAGENTS_ENABLED is an absolute platform
# kill-switch — tenant settings cannot re-enable it when false.
# The SUBAGENT_MAX_* vars are CEILINGS that lower (never raise) the built-in
# maximums a tenant may configure.
SUBAGENTS_ENABLED=false
# SUBAGENT_MAX_CONCURRENCY=6
# SUBAGENT_MAX_PER_RUN=16
# SUBAGENT_MAX_TOKENS_PER_RUN=1000000
# SUBAGENT_MAX_ITERATIONS=16
# SUBAGENT_TIMEOUT_MS=300000
# Max concurrent shell subprocesses from execute_command (Layer A).
# TOOL_CONCURRENCY=6
```

- [ ] **Step 6: Verify typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent/subagent-budget.ts apps/web-ui/lib/agent/subagent-budget.test.ts apps/web-ui/env.ts .env.example
git commit -m "feat(agent): sub-agent budget config with platform ceilings

Tenant-configurable sub-agent limits resolved as
clamp(tenantConfig ?? default, MIN, envCeiling), applied on read so lowering a
ceiling binds existing rows. SUBAGENTS_ENABLED is an absolute kill-switch."
```

---

### Task 5: AI Ops settings API route

**Files:**
- Create: `apps/web-ui/app/api/settings/aiops/route.ts`
- Create: `apps/web-ui/app/api/settings/aiops/route.test.ts`

**Interfaces:**
- Consumes: `resolveSubagentBudget`, `validateBudgetInput`, `clampBudget`, `platformSubagentsEnabled`, `BUDGET_BOUNDS`, `SUBAGENT_CONFIG_KEY` from Task 4.
- Produces: `GET /api/settings/aiops` → `{ success: true, data: { budget: SubagentBudgetConfig, bounds, platformEnabled: boolean } }`; `PUT` → `{ success: true, data: { budget: SubagentBudgetConfig } }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/app/api/settings/aiops/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn() },
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT } from './route';

const putRequest = (body: unknown) =>
    ({ json: async () => body }) as unknown as Parameters<typeof PUT>[0];

beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUBAGENTS_ENABLED = 'true';
    vi.mocked(authorize).mockResolvedValue(null as never);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1' as never);
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.com' } } as never);
    vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null as never);
});
afterEach(() => { delete process.env.SUBAGENTS_ENABLED; });

describe('GET /api/settings/aiops', () => {
    it('returns the effective budget, bounds, and platform flag', async () => {
        const body = await (await GET()).json();

        expect(body.success).toBe(true);
        expect(body.data.platformEnabled).toBe(true);
        expect(body.data.budget.maxConcurrentSubagents).toBe(3);
        expect(body.data.bounds.maxConcurrentSubagents.max).toBe(6);
    });

    it('propagates an RBAC denial', async () => {
        const denied = { status: 403 };
        vi.mocked(authorize).mockResolvedValue(denied as never);
        expect(await GET()).toBe(denied);
    });

    it('403s with no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue(null as never);
        expect((await GET()).status).toBe(403);
    });
});

describe('PUT /api/settings/aiops', () => {
    const valid = {
        enabled: true, maxConcurrentSubagents: 4, maxSubagentsPerRun: 8,
        maxSubagentTokensPerRun: 400000, subagentMaxIterations: 8, subagentTimeoutMs: 180000,
    };

    it('saves a valid payload and audits it', async () => {
        const res = await PUT(putRequest(valid));
        const body = await res.json();

        expect(body.success).toBe(true);
        expect(body.data.budget.maxConcurrentSubagents).toBe(4);
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'aiops-subagents', expect.objectContaining({ maxConcurrentSubagents: 4 }), 't1', 'a@b.com',
        );
        expect(AuditService.logUserAction).toHaveBeenCalled();
    });

    it('400s on an out-of-range value', async () => {
        const res = await PUT(putRequest({ ...valid, maxConcurrentSubagents: 999 }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/maxConcurrentSubagents/);
    });

    it('400s when enabled is missing', async () => {
        const { enabled, ...rest } = valid;
        expect((await PUT(putRequest(rest))).status).toBe(400);
    });

    it('persists the clamped value, not the raw one', async () => {
        process.env.SUBAGENT_MAX_CONCURRENCY = '2';
        await PUT(putRequest({ ...valid, maxConcurrentSubagents: 2 }));
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'aiops-subagents', expect.objectContaining({ maxConcurrentSubagents: 2 }), 't1', 'a@b.com',
        );
        delete process.env.SUBAGENT_MAX_CONCURRENCY;
    });

    it('propagates an RBAC denial', async () => {
        const denied = { status: 403 };
        vi.mocked(authorize).mockResolvedValue(denied as never);
        expect(await PUT(putRequest(valid))).toBe(denied);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run app/api/settings/aiops/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the route**

Create `apps/web-ui/app/api/settings/aiops/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';
import {
    SUBAGENT_CONFIG_KEY,
    BUDGET_BOUNDS,
    clampBudget,
    platformSubagentsEnabled,
    resolveSubagentBudget,
    validateBudgetInput,
} from '@/lib/agent/subagent-budget';

export async function GET() {
    console.log('API - GET /api/settings/aiops - Fetching sub-agent budget');

    const authError = await authorize('read', 'Agent');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const budget = await resolveSubagentBudget(tenantId);

        return NextResponse.json({
            success: true,
            data: {
                budget,
                // The UI renders sliders bounded by these, and explains why a
                // ceiling is what it is rather than silently clipping input.
                bounds: BUDGET_BOUNDS,
                platformEnabled: platformSubagentsEnabled(),
            },
        });
    } catch (error) {
        console.error('API - Error fetching AI Ops settings:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch AI Ops settings' },
            { status: 500 },
        );
    }
}

export async function PUT(request: NextRequest) {
    console.log('API - PUT /api/settings/aiops - Saving sub-agent budget');

    const authError = await authorize('update', 'Agent');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const body = await request.json();
        const validationError = validateBudgetInput(body);
        if (validationError) {
            return NextResponse.json({ success: false, error: validationError }, { status: 400 });
        }

        // Persist the CLAMPED value so a stored row can never exceed the ceiling
        // that was in force when it was written.
        const budget = clampBudget(body);

        const session = await getServerSession(authOptions);
        const updatedBy = session?.user?.email || 'api-user';

        await TenantConfigService.saveConfig(SUBAGENT_CONFIG_KEY, budget, tenantId, updatedBy);

        await AuditService.logUserAction({
            eventType: 'aiops.subagents.settings.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/settings/aiops',
            httpMethod: 'PUT',
            action: 'Update AI Ops Sub-Agent Settings',
            resourceType: 'settings',
            resourceId: SUBAGENT_CONFIG_KEY,
            resourceName: 'AI Ops Sub-Agent Budget',
            user: updatedBy,
            userType: 'user',
            status: 'success',
            details: `Sub-agents ${budget.enabled ? 'enabled' : 'disabled'}; concurrency=${budget.maxConcurrentSubagents}, perRun=${budget.maxSubagentsPerRun}, tokenBudget=${budget.maxSubagentTokensPerRun}`,
            tenantId,
        });

        return NextResponse.json({ success: true, data: { budget } });
    } catch (error) {
        console.error('API - Error saving AI Ops settings:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to save AI Ops settings' },
            { status: 500 },
        );
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run app/api/settings/aiops/route.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

```bash
git add apps/web-ui/app/api/settings/aiops/
git commit -m "feat(api): GET/PUT /api/settings/aiops for sub-agent budget

Reuses the Agent RBAC subject (already mapped to the AIOps module) and stores
the clamped budget under the aiops-subagents tenant-config key."
```

---

### Task 6: AI Ops settings UI

**Files:**
- Create: `apps/web-ui/lib/queries/aiops-settings.ts`
- Create: `apps/web-ui/components/settings/aiops-subagent-settings.tsx`
- Create: `apps/web-ui/app/app/agent-ops/settings/subagents/page.tsx`
- Modify: `apps/web-ui/lib/queries/query-keys.ts`

**Interfaces:**
- Consumes: `GET`/`PUT /api/settings/aiops` from Task 5; `SubagentBudgetConfig` from Task 4.
- Produces: `useAiopsSubagentSettings()`, `useSaveAiopsSubagentSettings()`, `<AiopsSubagentSettings />`.

- [ ] **Step 1: Add the query key**

In `apps/web-ui/lib/queries/query-keys.ts`, add a domain entry alongside the others:

```typescript
    aiopsSettings: {
        all: ['aiops-settings'] as const,
        subagents: () => [...queryKeys.aiopsSettings.all, 'subagents'] as const,
    },
```

- [ ] **Step 2: Write the query hooks**

Create `apps/web-ui/lib/queries/aiops-settings.ts`:

```typescript
'use client';

/**
 * TanStack Query hooks for the AI Ops sub-agent budget (per-tenant).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';

export interface SubagentBudget {
    enabled: boolean;
    maxConcurrentSubagents: number;
    maxSubagentsPerRun: number;
    maxSubagentTokensPerRun: number;
    subagentMaxIterations: number;
    subagentTimeoutMs: number;
}

export interface SubagentBound { min: number; max: number; default: number }

export interface AiopsSubagentSettings {
    budget: SubagentBudget;
    bounds: Record<keyof Omit<SubagentBudget, 'enabled'>, SubagentBound>;
    /** False when SUBAGENTS_ENABLED is off for the whole deployment. */
    platformEnabled: boolean;
}

export function useAiopsSubagentSettings() {
    return useQuery({
        queryKey: queryKeys.aiopsSettings.subagents(),
        queryFn: async (): Promise<AiopsSubagentSettings> => {
            const res = await fetch('/api/settings/aiops');
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load AI Ops settings');
            }
            return json.data as AiopsSubagentSettings;
        },
    });
}

export function useSaveAiopsSubagentSettings() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: SubagentBudget): Promise<SubagentBudget> => {
            const res = await fetch('/api/settings/aiops', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to save AI Ops settings');
            }
            return json.data.budget as SubagentBudget;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.aiopsSettings.all }),
    });
}
```

- [ ] **Step 3: Build the settings panel**

Create `apps/web-ui/components/settings/aiops-subagent-settings.tsx`. Note 2-space indentation (components convention) and React Hook Form + Zod per the global constraints:

```tsx
'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Bot, Gauge, Save } from 'lucide-react';

import {
  useAiopsSubagentSettings,
  useSaveAiopsSubagentSettings,
  type SubagentBudget,
} from '@/lib/queries/aiops-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';

const schema = z.object({
  enabled: z.boolean(),
  maxConcurrentSubagents: z.number().int(),
  maxSubagentsPerRun: z.number().int(),
  maxSubagentTokensPerRun: z.number().int(),
  subagentMaxIterations: z.number().int(),
  subagentTimeoutMs: z.number().int(),
});

type FormValues = z.infer<typeof schema>;

const FIELDS: Array<{
  name: keyof Omit<SubagentBudget, 'enabled'>;
  label: string;
  help: string;
}> = [
  {
    name: 'maxConcurrentSubagents',
    label: 'Concurrent sub-agents',
    help: 'How many sub-agents may run at the same time. Higher finishes fan-out work faster but increases the chance of provider throttling.',
  },
  {
    name: 'maxSubagentsPerRun',
    label: 'Sub-agents per run',
    help: 'Total sub-agents a single chat run may dispatch before it falls back to working serially.',
  },
  {
    name: 'maxSubagentTokensPerRun',
    label: 'Token budget per run',
    help: 'Combined sub-agent token spend allowed in one run. When exhausted, the agent completes the work itself instead of failing.',
  },
  {
    name: 'subagentMaxIterations',
    label: 'Iterations per sub-agent',
    help: 'Reasoning/tool laps a single sub-agent may take before it must report what it has found.',
  },
  {
    name: 'subagentTimeoutMs',
    label: 'Sub-agent timeout (ms)',
    help: 'Wall-clock limit for one sub-agent. On timeout it returns partial findings rather than failing the run.',
  },
];

export function AiopsSubagentSettings() {
  const { data, isLoading, error } = useAiopsSubagentSettings();
  const saveMutation = useSaveAiopsSubagentSettings();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: false,
      maxConcurrentSubagents: 3,
      maxSubagentsPerRun: 8,
      maxSubagentTokensPerRun: 400000,
      subagentMaxIterations: 8,
      subagentTimeoutMs: 180000,
    },
  });

  useEffect(() => {
    if (data?.budget) form.reset(data.budget);
  }, [data, form]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const platformEnabled = data?.platformEnabled ?? false;
  const bounds = data?.bounds;

  // Zod rejects a blank number input as NaN before onSubmit ever runs. Without an
  // invalid handler the click is a silent no-op with zero feedback, so surface it.
  const onInvalid = () => {
    toast.error('Some values are invalid — check the highlighted fields.');
  };

  const onSubmit = async (values: FormValues) => {
    // Bounds are enforced server-side too; this only produces a friendlier message.
    for (const field of FIELDS) {
      const bound = bounds?.[field.name];
      const value = values[field.name];
      if (bound && (value < bound.min || value > bound.max)) {
        toast.error(`${field.label} must be between ${bound.min} and ${bound.max}`);
        return;
      }
    }
    try {
      await saveMutation.mutateAsync(values);
      toast.success('Sub-agent settings saved — new runs will use this configuration');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save sub-agent settings');
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="flex-1 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sub-Agents</h1>
        <p className="text-muted-foreground mt-1">
          Sub-agents let one AI Ops run investigate several accounts or regions at the same time.
          They are read-only: anything that changes infrastructure still runs on the main agent
          under your normal approval flow.
        </p>
      </div>

      {!platformEnabled && (
        <Alert>
          <AlertDescription>
            Sub-agents are disabled for this deployment, so these settings are read-only. An
            administrator must enable the feature before they can be changed.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Enable sub-agents
          </CardTitle>
          <CardDescription>
            When off, every run executes serially exactly as before.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="enabled"
              checked={form.watch('enabled')}
              onCheckedChange={(checked) => form.setValue('enabled', checked, { shouldDirty: true })}
              disabled={!platformEnabled}
            />
            <Label htmlFor="enabled">Dispatch sub-agents for parallel investigation</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            Budget limits
          </CardTitle>
          <CardDescription>
            These bound how much work and spend one run may fan out. Exceeding a limit never fails
            the run — the agent finishes the work serially instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {FIELDS.map((field) => {
            const bound = bounds?.[field.name];
            return (
              <div key={field.name} className="space-y-2">
                <Label htmlFor={field.name}>{field.label}</Label>
                <Input
                  id={field.name}
                  type="number"
                  className="w-48"
                  min={bound?.min}
                  max={bound?.max}
                  disabled={!platformEnabled}
                  {...form.register(field.name, { valueAsNumber: true })}
                />
                <p className="text-xs text-muted-foreground">{field.help}</p>
                {bound && (
                  <p className="text-xs text-muted-foreground">
                    Allowed: {bound.min}–{bound.max}. Default {bound.default}.
                  </p>
                )}
                {form.formState.errors[field.name] && (
                  <p className="text-xs text-destructive">
                    Enter a whole number between {bound?.min} and {bound?.max}.
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Button type="submit" disabled={saveMutation.isPending || !platformEnabled}>
        {saveMutation.isPending ? (
          <Spinner size="sm" className="mr-2" />
        ) : (
          <Save className="h-4 w-4 mr-2" />
        )}
        Save settings
      </Button>
    </form>
  );
}
```

- [ ] **Step 4: Add the page**

Create `apps/web-ui/app/app/agent-ops/settings/subagents/page.tsx`:

```tsx
'use client';

import { AiopsSubagentSettings } from '@/components/settings/aiops-subagent-settings';

export default function AiopsSubagentSettingsPage() {
  return (
    <div className="flex-1 bg-background p-6">
      <AiopsSubagentSettings />
    </div>
  );
}
```

- [ ] **Step 5: Confirm the Switch and Spinner primitives exist**

Run: `ls apps/web-ui/components/ui/switch.tsx apps/web-ui/components/ui/spinner.tsx`
Expected: both files listed. If `switch.tsx` is absent, add it with `bunx shadcn@latest add switch` from `apps/web-ui` — do not hand-write a primitive.

- [ ] **Step 6: Typecheck, lint, and verify in the browser**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

Run: `cd apps/web-ui && bun run lint`
Expected: no new errors.

Start the dev server and open `http://localhost:3001/app/agent-ops/settings/subagents`. Confirm: values load, the platform-disabled alert shows when `SUBAGENTS_ENABLED` is unset, saving fires a success toast, and an out-of-range value produces an error toast.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/queries/aiops-settings.ts apps/web-ui/lib/queries/query-keys.ts apps/web-ui/components/settings/aiops-subagent-settings.tsx apps/web-ui/app/app/agent-ops/settings/subagents/
git commit -m "feat(ui): AI Ops sub-agent budget settings panel"
```

---

### Task 7: Sub-agent runtime with the read-only jail

The core of Layer B. An ephemeral ReAct loop that cannot mutate anything, cannot spawn further sub-agents, and always returns a bounded report string.

**Files:**
- Create: `apps/web-ui/lib/agent/subagent.ts`
- Create: `apps/web-ui/lib/agent/subagent.test.ts`

**Interfaces:**
- Consumes: `classifyTool` from `./tool-classifier`; `Semaphore` from `./concurrency` (Task 3); `SubagentBudgetConfig` from `./subagent-budget` (Task 4); `contentToText`, `truncateOutput`, `sanitizeMessagesForBedrock` from `./agent-shared`.
- Produces:
  - `const SUBAGENT_REPORT_MAX_CHARS = 6000`
  - `interface SubagentSpec { role: string; task: string; expectedOutput: string }`
  - `interface SubagentResult { report: string; toolCount: number; tokensIn: number; tokensOut: number; status: 'done' | 'failed'; transcript: Array<{ kind: 'ai' | 'tool'; name?: string; text: string }> }`
  - `isReadOnlyForSubagent(name: string, args?: Record<string, unknown>): { allowed: boolean; reason: string }`
  - `filterReadOnlyTools<T extends { name: string }>(tools: T[]): T[]`
  - `runSubagent(spec: SubagentSpec, deps: SubagentDeps): Promise<SubagentResult>`
  - `interface SubagentDeps { model: { bindTools?: (t: unknown[]) => any; invoke: (m: unknown[]) => Promise<any> }; tools: Array<{ name: string; invoke: (args: Record<string, unknown>) => Promise<unknown> }>; budget: SubagentBudgetConfig; onEvent?: (e: { toolCount: number; tokensIn: number; tokensOut: number }) => void }`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/subagent.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
    isReadOnlyForSubagent,
    filterReadOnlyTools,
    runSubagent,
    SUBAGENT_REPORT_MAX_CHARS,
    type SubagentSpec,
} from './subagent';

const BUDGET = {
    enabled: true,
    maxConcurrentSubagents: 3,
    maxSubagentsPerRun: 8,
    maxSubagentTokensPerRun: 400_000,
    subagentMaxIterations: 4,
    subagentTimeoutMs: 5_000,
};

const SPEC: SubagentSpec = {
    role: 'EC2 auditor',
    task: 'List idle instances in account 111111111111',
    expectedOutput: 'instance ids with CPU below 5%',
};

/** Model stub: returns each scripted response in turn. */
function scriptedModel(responses: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>) {
    let i = 0;
    const model: any = {
        bindTools: () => model,
        invoke: vi.fn(async () => {
            const r = responses[Math.min(i, responses.length - 1)];
            i++;
            return { content: r.content, tool_calls: r.tool_calls ?? [], usage_metadata: { input_tokens: 100, output_tokens: 20 } };
        }),
    };
    return model;
}

const readTool = { name: 'describe_instances', invoke: vi.fn(async () => 'i-123 running') };
const shellRead = { name: 'execute_command', invoke: vi.fn(async () => 'ok') };
const writeTool = { name: 'write_file', invoke: vi.fn(async () => 'written') };

describe('isReadOnlyForSubagent', () => {
    it('allows an explicit read-only tool', () => {
        expect(isReadOnlyForSubagent('describe_instances').allowed).toBe(true);
    });

    it('allows a read-only shell command', () => {
        expect(isReadOnlyForSubagent('execute_command', { command: 'aws ec2 describe-instances' }).allowed).toBe(true);
    });

    it('blocks a mutative shell command', () => {
        const verdict = isReadOnlyForSubagent('execute_command', { command: 'aws ec2 terminate-instances --instance-ids i-1' });
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/mutat/i);
    });

    it('blocks a mutative tool name', () => {
        expect(isReadOnlyForSubagent('write_file').allowed).toBe(false);
    });

    it('blocks an unknown-named tool (fail closed)', () => {
        // classifyTool returns isMutative:false, matchedRule:false for unknowns.
        // In the orchestrator that means "ask the human"; here there is no human,
        // so it must mean "block".
        const verdict = isReadOnlyForSubagent('some_mcp_thing');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/not on the verified read-only list/i);
    });

    it('blocks dispatch_agent so sub-agents cannot recurse', () => {
        expect(isReadOnlyForSubagent('dispatch_agent').allowed).toBe(false);
    });

    it('blocks ask_user — no human is reachable inside a tool call', () => {
        expect(isReadOnlyForSubagent('ask_user').allowed).toBe(false);
    });

    it('blocks denylisted tools regardless of case', () => {
        // classifyTool lowercases internally, so once dispatch_agent joins its
        // READ_ONLY_ALLOWLIST (Task 8) a case-sensitive denylist would let
        // "Dispatch_Agent" through as allowlisted-read-only — re-enabling
        // sub-agent recursion. Pin the lowercasing.
        for (const name of ['Dispatch_Agent', 'DISPATCH_AGENT', 'Ask_User', 'ASK_USER']) {
            expect(isReadOnlyForSubagent(name).allowed).toBe(false);
        }
    });
});

describe('filterReadOnlyTools', () => {
    it('keeps read-only tools and drops the rest', () => {
        const kept = filterReadOnlyTools([readTool, shellRead, writeTool, { name: 'dispatch_agent' }]);
        expect(kept.map(t => t.name)).toEqual(['describe_instances', 'execute_command']);
    });
});

describe('runSubagent', () => {
    it('returns the final prose as the report', async () => {
        const model = scriptedModel([{ content: 'Found 2 idle instances: i-1, i-2' }]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(result.status).toBe('done');
        expect(result.report).toContain('i-1');
        expect(result.tokensIn).toBe(100);
    });

    it('executes an allowed tool call and loops', async () => {
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }] },
            { content: 'Instance i-123 is running' },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(readTool.invoke).toHaveBeenCalled();
        expect(result.toolCount).toBe(1);
        expect(result.report).toContain('i-123');
    });

    it('refuses a mutative tool call instead of executing it', async () => {
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'write_file', args: { file_path: 'x', content: 'y' } }] },
            { content: 'Understood — reporting instead.' },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [readTool, writeTool], budget: BUDGET });

        expect(writeTool.invoke).not.toHaveBeenCalled();
        expect(result.status).toBe('done');
    });

    it('stops at the iteration cap and marks the report incomplete', async () => {
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }] },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: { ...BUDGET, subagentMaxIterations: 2 } });

        expect(result.report).toMatch(/incomplete/i);
        expect(model.invoke).toHaveBeenCalledTimes(2);
    });

    it('truncates an over-long report', async () => {
        const model = scriptedModel([{ content: 'x'.repeat(SUBAGENT_REPORT_MAX_CHARS + 5000) }]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(result.report.length).toBeLessThanOrEqual(SUBAGENT_REPORT_MAX_CHARS + 100);
        expect(result.report).toMatch(/TRUNCATED/);
    });

    it('returns a failed status instead of throwing when the model errors', async () => {
        const model: any = { bindTools: () => model, invoke: vi.fn().mockRejectedValue(new Error('provider down')) };
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(result.status).toBe('failed');
        expect(result.report).toMatch(/provider down/);
    });

    it('returns partial findings on timeout', async () => {
        const model: any = {
            bindTools: () => model,
            invoke: vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ content: 'late', tool_calls: [] }), 500))),
        };
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: { ...BUDGET, subagentTimeoutMs: 50 } });

        expect(result.report).toMatch(/timed out/i);
    });

    it('reports a failing tool without aborting the loop', async () => {
        const boom = { name: 'describe_instances', invoke: vi.fn().mockRejectedValue(new Error('AccessDenied')) };
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }] },
            { content: 'Could not read: AccessDenied' },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [boom], budget: BUDGET });

        expect(result.status).toBe('done');
        expect(result.report).toContain('AccessDenied');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/subagent.test.ts`
Expected: FAIL — cannot resolve `./subagent`.

- [ ] **Step 3: Implement the sub-agent runtime**

Create `apps/web-ui/lib/agent/subagent.ts`:

```typescript
/**
 * Sub-agent runtime — the Claude Code `Task` pattern.
 *
 * An ephemeral ReAct loop with its OWN message list. The orchestrator sees only
 * the returned report, never the raw tool output, which is what keeps the
 * orchestrator's context (and therefore its per-lap latency) flat.
 *
 * Sub-agents are strictly READ-ONLY. LangGraph cannot interrupt inside a tool
 * call, so a mutation attempted here could never reach the guard node's human
 * approval gate. Mutations stay on the orchestrator's guarded path.
 *
 * Not checkpointed: a sub-agent is not resumable, so a checkpointer would cost a
 * Postgres write per lap for no benefit.
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { classifyTool } from './tool-classifier';
import { contentToText, truncateOutput } from './agent-shared';
import type { SubagentBudgetConfig } from './subagent-budget';

/** ~1500 tokens. Enforced in characters so the bound is deterministic and testable. */
export const SUBAGENT_REPORT_MAX_CHARS = 6000;

/** Per-tool output cap inside a sub-agent — it never leaves this context. */
const SUBAGENT_TOOL_OUTPUT_MAX_CHARS = 4000;

/**
 * Never available to a sub-agent regardless of what the classifier says.
 * - dispatch_agent: depth cap of 1. Recursion makes cost and latency unbounded.
 * - ask_user: pauses for a human, and no human is reachable inside a tool call.
 */
const SUBAGENT_TOOL_DENYLIST = new Set(['dispatch_agent', 'ask_user']);

export interface SubagentSpec {
    role: string;
    task: string;
    expectedOutput: string;
}

export interface SubagentTranscriptEntry {
    kind: 'ai' | 'tool';
    name?: string;
    text: string;
}

export interface SubagentResult {
    report: string;
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    status: 'done' | 'failed';
    transcript: SubagentTranscriptEntry[];
}

interface SubagentToolLike {
    name: string;
    invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface SubagentDeps {
    model: { bindTools?: (tools: unknown[]) => unknown; invoke: (messages: unknown[]) => Promise<unknown> };
    tools: SubagentToolLike[];
    budget: SubagentBudgetConfig;
    onEvent?: (progress: { toolCount: number; tokensIn: number; tokensOut: number }) => void;
}

/**
 * The jail. Fail-closed by design: `classifyTool` returns
 * `{ isMutative: false, matchedRule: false }` for a tool whose name matched no
 * rule at all. In the orchestrator that ambiguity routes to a human; inside a
 * sub-agent there is no human, so an unverified tool is refused.
 */
export function isReadOnlyForSubagent(
    name: string,
    args?: Record<string, unknown>,
): { allowed: boolean; reason: string } {
    // Lowercased: classifyTool() lowercases internally, so once Task 8 adds
    // dispatch_agent to its READ_ONLY_ALLOWLIST a case variant like
    // "Dispatch_Agent" would miss a case-SENSITIVE denylist and then be waved
    // through as allowlisted-read-only. The tool-name lookup below would still
    // catch it, but a safety boundary must not depend on its own backstop.
    if (SUBAGENT_TOOL_DENYLIST.has(name.toLowerCase())) {
        return { allowed: false, reason: `${name} is not available to sub-agents` };
    }

    let classification;
    try {
        classification = classifyTool(name, args);
    } catch (error) {
        return { allowed: false, reason: `classifier error: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (classification.isMutative) {
        return { allowed: false, reason: `mutative call refused: ${classification.reason}` };
    }
    if (!classification.matchedRule) {
        return { allowed: false, reason: `${name} is not on the verified read-only list` };
    }
    return { allowed: true, reason: classification.reason };
}

/** Drop everything a sub-agent may not call, before the model ever sees it. */
export function filterReadOnlyTools<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter(tool => {
        if (SUBAGENT_TOOL_DENYLIST.has(tool.name)) return false;
        // Bash-like tools are judged per call (the command string decides), so keep
        // them in the list and let the runtime check gate each invocation.
        if (tool.name === 'execute_command') return true;
        return isReadOnlyForSubagent(tool.name).allowed;
    });
}

function buildSystemPrompt(spec: SubagentSpec): SystemMessage {
    return new SystemMessage(`You are a focused read-only investigator working as a sub-agent for a cloud-operations platform.

## Your role
${spec.role}

## Your task
${spec.task}

## What to return
${spec.expectedOutput}

## Constraints

- You are READ-ONLY. You cannot create, modify, delete, start, stop, or write anything. If the task appears to need a change, do NOT attempt it — describe the recommended change in your findings and the main agent will carry it out under human approval.
- You cannot ask the user questions. If something is ambiguous, investigate the most likely interpretation and say what you assumed.
- You see none of the parent conversation. Everything you need is in the task above.
- Batch independent read-only calls into a single turn — they run in parallel.

## Output

When you have gathered enough, reply with your findings as plain text. No preamble, no narration of what you did. Structure it as:

**Findings** — what you established, with concrete evidence (resource ids, metric values, region and account names).
**Could not determine** — anything you could not establish, and why. Write "Nothing" if everything was resolved.

Be dense. Your reply is consumed by another agent, not a human.`);
}

function finishReport(text: string, note?: string): string {
    const body = text.trim() || '(no findings produced)';
    const withNote = note ? `${body}\n\n[${note}]` : body;
    return withNote.length > SUBAGENT_REPORT_MAX_CHARS
        ? `${withNote.slice(0, SUBAGENT_REPORT_MAX_CHARS)}\n\n[TRUNCATED — report exceeded ${SUBAGENT_REPORT_MAX_CHARS} characters]`
        : withNote;
}

async function runSubagentLoop(spec: SubagentSpec, deps: SubagentDeps): Promise<SubagentResult> {
    const { budget } = deps;
    const allowedTools = filterReadOnlyTools(deps.tools);
    const toolsByName = new Map(allowedTools.map(t => [t.name, t]));

    const boundModel = deps.model.bindTools
        ? (deps.model.bindTools(allowedTools) as SubagentDeps['model'])
        : deps.model;

    const messages: unknown[] = [buildSystemPrompt(spec), new HumanMessage({ content: spec.task })];
    const transcript: SubagentTranscriptEntry[] = [];

    let toolCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let lastText = '';

    for (let iteration = 0; iteration < budget.subagentMaxIterations; iteration++) {
        const response = (await boundModel.invoke(messages)) as {
            content: unknown;
            tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
            usage_metadata?: { input_tokens?: number; output_tokens?: number };
        };

        tokensIn += response.usage_metadata?.input_tokens ?? 0;
        tokensOut += response.usage_metadata?.output_tokens ?? 0;

        const text = contentToText(response.content);
        if (text.trim()) {
            lastText = text;
            transcript.push({ kind: 'ai', text });
        }

        const toolCalls = response.tool_calls ?? [];
        if (toolCalls.length === 0) {
            deps.onEvent?.({ toolCount, tokensIn, tokensOut });
            return { report: finishReport(lastText), toolCount, tokensIn, tokensOut, status: 'done', transcript };
        }

        messages.push(new AIMessage({ content: text, tool_calls: toolCalls as never }));

        // Independent calls in one turn run concurrently — the same parallelism
        // the orchestrator gets from ToolNode.
        const results = await Promise.all(toolCalls.map(async call => {
            const verdict = isReadOnlyForSubagent(call.name, call.args ?? {});
            if (!verdict.allowed) {
                return {
                    call,
                    output: `REFUSED: ${verdict.reason}. You cannot mutate state. Report the recommended change in your findings; the main agent will execute it under human approval.`,
                };
            }

            const tool = toolsByName.get(call.name);
            if (!tool) {
                return { call, output: `REFUSED: ${call.name} is not available to sub-agents.` };
            }

            try {
                const raw = await tool.invoke(call.args ?? {});
                return { call, output: truncateOutput(typeof raw === 'string' ? raw : JSON.stringify(raw), SUBAGENT_TOOL_OUTPUT_MAX_CHARS) };
            } catch (error) {
                // A failing tool is data, not a crash — the sub-agent should report it.
                return { call, output: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
            }
        }));

        for (const { call, output } of results) {
            if (!output.startsWith('REFUSED:')) toolCount++;
            transcript.push({ kind: 'tool', name: call.name, text: output });
            messages.push(new ToolMessage({ content: output, tool_call_id: call.id ?? `${call.name}-${toolCount}` }));
        }

        deps.onEvent?.({ toolCount, tokensIn, tokensOut });
    }

    return {
        report: finishReport(lastText, `INCOMPLETE — the sub-agent reached its ${budget.subagentMaxIterations}-iteration limit. Findings above are partial.`),
        toolCount, tokensIn, tokensOut, status: 'done', transcript,
    };
}

/**
 * Run one sub-agent. Never throws: every failure path returns a report string,
 * because a sub-agent failure must not abort the orchestrator's run.
 */
export async function runSubagent(spec: SubagentSpec, deps: SubagentDeps): Promise<SubagentResult> {
    const timeoutMs = deps.budget.subagentTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
        const outcome = await Promise.race([runSubagentLoop(spec, deps), timeout]);
        if (outcome === 'timeout') {
            return {
                report: finishReport('', `TIMED OUT after ${Math.round(timeoutMs / 1000)}s — no findings were returned in time.`),
                toolCount: 0, tokensIn: 0, tokensOut: 0, status: 'failed', transcript: [],
            };
        }
        return outcome;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Subagent] "${spec.role}" failed: ${message}`);
        return {
            report: finishReport('', `FAILED — ${message}`),
            toolCount: 0, tokensIn: 0, tokensOut: 0, status: 'failed', transcript: [],
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/subagent.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

```bash
git add apps/web-ui/lib/agent/subagent.ts apps/web-ui/lib/agent/subagent.test.ts
git commit -m "feat(agent): read-only sub-agent runtime

Ephemeral ReAct loop with its own context that returns one bounded findings
report. Fail-closed jail refuses mutative and unverified tools, plus
dispatch_agent (depth cap 1) and ask_user (no human inside a tool call), so
LangGraph's inability to interrupt mid-tool-call is never a safety hole."
```

- [ ] **Step 6: Replace the shell blocklist with an allowlist (CRITICAL)**

Added after an adversarial review broke the shell layer 23 different ways. **This is a
design error in the spec above, not an implementation slip.**

The spec assumed `classifyTool`'s fail-closed default (`matchedRule: false`) covered
shell commands. It does not. For bash-like tool names `classifyTool` returns
`{ isMutative: false, matchedRule: **true**, reason: 'read-only bash command' }` for
*any* command string that misses its seven `MUTATIVE_BASH_PATTERNS` regexes
(`tool-classifier.ts:178`). So `isReadOnlyForSubagent`'s `!matchedRule` branch — this
task's entire premise — **is unreachable for `execute_command`**. Shell was gated by a
blocklist, and inside a tool call (where LangGraph cannot interrupt and no human can
approve) a blocklist is not a boundary.

Proven bypasses, all classified read-only, all reaching `/bin/bash` with live tenant
AWS credentials via `buildCommandEnv(tenantId)`:

```
aws --region us-east-1 ec2 terminate-instances --instance-ids i-1   # a flag before the service
aws ec2 "terminate-instances" --instance-ids i-1                    # one quote
aws ec2 authorize-security-group-ingress --port 22 --cidr 0.0.0.0/0 # verb absent from the list
aws s3 sync ./evil s3://prod-bucket --delete
aws kms schedule-key-deletion --key-id k --pending-window-in-days 7
pulumi destroy --yes                                                # binary need not be aws
python3 -c "import boto3; boto3.client('ec2').terminate_instances(InstanceIds=['i-1'])"
psql $DATABASE_URL -c "DROP TABLE accounts"
rm -r /app/data                                                     # only `rm -rf` was patterned
```

The fix lives in `subagent.ts` only. **Do not touch `tool-classifier.ts`** — the guard
node depends on its current behaviour for the human-approval path, where ambiguity
correctly routes to a person.

Add to `apps/web-ui/lib/agent/subagent.ts`, above `isReadOnlyForSubagent`:

```typescript
/**
 * Shell commands are ALLOWLISTED, not blocklisted.
 *
 * classifyTool treats any bash-like call that misses its mutative regexes as
 * "read-only bash command" WITH matchedRule: true — so the fail-closed
 * !matchedRule rule never fires for shell. That is adequate for the guard node
 * (a human reviews the call) but not here: a sub-agent runs inside a tool call,
 * which LangGraph cannot interrupt, so nothing downstream can stop the command.
 *
 * An adversarial review escaped the blocklist 23 ways — a flag before the
 * service name, a quote around the verb, a verb missing from the list, or simply
 * a different binary (pulumi, psql, python3). Enumerating mutations is
 * unwinnable; enumerating the reads we actually need is not.
 */
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'run_command', 'execute_command']);

/** Metacharacters that allow chaining, substitution, or redirection out of the allowlist. */
const SHELL_METACHAR = /[;&|`$><\n\r]/;

/** Binaries a sub-agent may invoke at all. */
const ALLOWED_SHELL_BINARIES = new Set([
    'aws', 'kubectl', 'cat', 'ls', 'grep', 'head', 'tail', 'wc', 'jq', 'echo',
]);

/** AWS operation prefixes that are read-only by CLI convention. */
const READ_ONLY_AWS_OP_PREFIX = /^(describe|list|get|head|search|lookup|check|batch-get)-/;

/** Read-only AWS operations that do not follow the prefix convention. */
const READ_ONLY_AWS_OP_EXACT = new Set(['ls', 'filter-log-events', 'query', 'scan', 'help']);

/** Read-only kubectl verbs. */
const READ_ONLY_KUBECTL_VERBS = new Set([
    'get', 'describe', 'logs', 'top', 'version', 'api-resources', 'explain',
]);

/** Strip one layer of surrounding quotes: `aws ec2 "terminate-instances"` must not hide the verb. */
function unquote(token: string): string {
    return token.replace(/^['"]|['"]$/g, '');
}

/**
 * Resolve the command string from a bash-like tool's args. Returns null when the
 * args carry no usable command — an array, a number, an empty object. classifyTool
 * fails open on `{}` and stringifies an array into a comma-joined string that
 * matches no pattern, so both must be refused here.
 */
export function resolveShellCommand(args?: Record<string, unknown>): string | null {
    for (const key of ['command', 'cmd', 'input']) {
        const value = args?.[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
        if (value !== undefined) return null; // present but not a usable string
    }
    return null;
}

/** Allowlist verdict for one shell command string. */
export function isReadOnlyShellCommand(cmd: string): { allowed: boolean; reason: string } {
    if (SHELL_METACHAR.test(cmd)) {
        return { allowed: false, reason: 'command contains shell metacharacters (chaining, substitution, or redirection)' };
    }

    // Quotes are stripped per token, so splitting on whitespace is sufficient once
    // metacharacters are already refused.
    const tokens = cmd.trim().split(/\s+/).map(unquote).filter(t => t.length > 0);
    // Drop leading VAR=value assignments (`AWS_PROFILE=x aws ...`).
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens.length === 0) return { allowed: false, reason: 'empty command' };

    const binary = tokens[0];
    if (!ALLOWED_SHELL_BINARIES.has(binary)) {
        return { allowed: false, reason: `binary "${binary}" is not on the sub-agent read-only allowlist` };
    }

    if (binary === 'aws') {
        // Walk past global flags AND their values to find <service> then <operation>.
        // This is what defeated the old regex: it assumed `aws <service> <verb>` adjacency.
        const positional: string[] = [];
        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.startsWith('-')) {
                // A flag's value is the next token when it is not itself a flag.
                if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
                continue;
            }
            positional.push(token);
            if (positional.length === 2) break;
        }
        const operation = positional[1];
        if (!operation) return { allowed: false, reason: 'aws command has no resolvable operation' };
        if (!READ_ONLY_AWS_OP_PREFIX.test(operation) && !READ_ONLY_AWS_OP_EXACT.has(operation)) {
            return { allowed: false, reason: `aws operation "${operation}" is not a verified read-only operation` };
        }
        return { allowed: true, reason: `aws read-only operation "${operation}"` };
    }

    if (binary === 'kubectl') {
        const verb = tokens.slice(1).find(t => !t.startsWith('-'));
        if (!verb || !READ_ONLY_KUBECTL_VERBS.has(verb)) {
            return { allowed: false, reason: `kubectl verb "${verb ?? '(none)'}" is not read-only` };
        }
        return { allowed: true, reason: `kubectl read-only verb "${verb}"` };
    }

    return { allowed: true, reason: `read-only utility "${binary}"` };
}
```

Then, in `isReadOnlyForSubagent`, intercept bash-like tools **before** delegating to
`classifyTool`. Insert immediately after the denylist check:

```typescript
    // Shell is allowlisted here rather than delegated to classifyTool, whose
    // bash handling is a blocklist that reports matchedRule: true on a miss.
    if (SHELL_TOOL_NAMES.has(name.toLowerCase())) {
        const cmd = resolveShellCommand(args);
        if (cmd === null) {
            return { allowed: false, reason: `${name} called without a usable command string` };
        }
        const verdict = isReadOnlyShellCommand(cmd);
        return verdict.allowed
            ? { allowed: true, reason: verdict.reason }
            : { allowed: false, reason: `shell call refused: ${verdict.reason}` };
    }
```

- [ ] **Step 7: Make the timeout actually cancel the loop (IMPORTANT)**

`Promise.race` abandons `runSubagentLoop` but nothing stops it. Measured: `runSubagent`
returned after 2 model calls while the orphaned loop ran **8 more model calls and 9 more
tool calls** against customer AWS — invisible to `maxSubagentTokensPerRun`, and with
Task 8's concurrency semaphore already released, so real concurrency exceeds its cap.

Give the loop a cancellation token and shared progress. Change `runSubagentLoop`'s
signature to accept a control object:

```typescript
interface SubagentControl {
    cancelled: boolean;
    progress: { toolCount: number; tokensIn: number; tokensOut: number };
}
```

Inside the loop, update `control.progress` wherever the local counters are updated, and
bail at two checkpoints — the top of each lap and immediately before each tool invoke:

```typescript
        if (control.cancelled) {
            return {
                report: finishReport(lastText, 'CANCELLED — the sub-agent exceeded its time limit. Findings above are partial.'),
                toolCount, tokensIn, tokensOut, status: 'done', transcript,
            };
        }
```

In `runSubagent`, create the control object, pass it in, and on the timeout branch set
`control.cancelled = true` and report the REAL usage from `control.progress` rather than
hardcoded zeros (the same applies to the catch branch):

```typescript
        if (outcome === 'timeout') {
            control.cancelled = true;
            return {
                report: finishReport('', `TIMED OUT after ${Math.round(timeoutMs / 1000)}s — no findings were returned in time.`),
                toolCount: control.progress.toolCount,
                tokensIn: control.progress.tokensIn,
                tokensOut: control.progress.tokensOut,
                status: 'failed', transcript: [],
            };
        }
```

Also move the `const timeoutMs = deps.budget.subagentTimeoutMs` read **inside** the
`try` — it currently sits outside, so a malformed `deps.budget` throws out of a function
whose contract is that it never throws.

And replace the `toolCount` string-sniffing (`if (!output.startsWith('REFUSED:'))`) with
a boolean carried from the verdict — a real tool whose output happens to begin with
`REFUSED:` (an echoed IAM denial) currently goes uncounted.

- [ ] **Step 8: Add the bypass regression tests**

Every command below is a **proven** bypass of the old blocklist, so these tests have
teeth by construction. Add to `subagent.test.ts`:

```typescript
describe('shell allowlist — proven bypasses of the old blocklist', () => {
    const REFUSED = [
        'aws --region us-east-1 ec2 terminate-instances --instance-ids i-1',
        'aws --profile prod ec2 stop-instances --instance-ids i-1',
        'aws ec2 "terminate-instances" --instance-ids i-1',
        "aws ec2 'delete-security-group' --group-id sg-1",
        'aws ec2 authorize-security-group-ingress --group-id sg-1 --port 22 --cidr 0.0.0.0/0',
        'aws ecs execute-command --cluster c --task t --command /bin/sh',
        'aws s3 sync ./evil s3://prod-bucket --delete',
        'aws s3 cp ./evil.sh s3://prod-bucket/boot.sh',
        'aws rds restore-db-instance-from-db-snapshot --db-instance-identifier x',
        'aws kms schedule-key-deletion --key-id k --pending-window-in-days 7',
        'aws cloudformation cancel-update-stack --stack-name s',
        'pulumi up --stack prod --yes',
        'pulumi destroy --yes',
        'python3 -c import boto3',
        'rm important.tf',
        'rm -r /app/data',
        'kubectl run evil --image=alpine',
        'kubectl delete pod x',
        'npm run deploy:prod',
        'bash deploy.sh',
        'node ./scripts/wipe.js',
        'echo pwned > /app/config.json',                 // metacharacter
        'aws ec2 describe-instances && rm -rf /',         // metacharacter
        'aws ec2 describe-instances; pulumi destroy',     // metacharacter
        'aws ec2 describe-instances $(rm -rf /)',         // metacharacter
    ];

    for (const cmd of REFUSED) {
        it(`refuses: ${cmd}`, () => {
            expect(isReadOnlyForSubagent('execute_command', { command: cmd }).allowed).toBe(false);
        });
    }

    const ALLOWED = [
        'aws ec2 describe-instances --output json',
        'aws --region us-east-1 ec2 describe-instances',
        'AWS_PROFILE=nucleus_agent_1 aws ec2 describe-instances',
        'aws --profile p --region r rds describe-db-instances',
        'aws sts get-caller-identity',
        'aws cloudwatch get-metric-statistics --metric-name CPUUtilization',
        'aws logs filter-log-events --log-group-name x',
        'aws s3 ls s3://bucket',
        'kubectl get pods -n default',
        'kubectl describe pod x',
        'kubectl logs pod/x',
        'cat /tmp/report.json',
        'ls -la /tmp',
        'grep -r error /var/log',
        'jq .Reservations /tmp/out.json',
    ];

    for (const cmd of ALLOWED) {
        it(`allows: ${cmd}`, () => {
            expect(isReadOnlyForSubagent('execute_command', { command: cmd }).allowed).toBe(true);
        });
    }

    it('refuses a bash-like call with no usable command string', () => {
        // classifyTool fails OPEN on {} and stringifies an array into a
        // comma-joined string that matches no mutative pattern.
        expect(isReadOnlyForSubagent('execute_command', {}).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', undefined).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', { command: ['aws', 'ec2', 'terminate-instances'] } as never).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', { command: '' }).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', { command: 0 } as never).allowed).toBe(false);
    });

    it('applies the allowlist to every bash-like tool name, any case', () => {
        for (const name of ['bash', 'shell', 'run_command', 'EXECUTE_COMMAND', 'Bash']) {
            expect(isReadOnlyForSubagent(name, { command: 'pulumi destroy --yes' }).allowed).toBe(false);
            expect(isReadOnlyForSubagent(name, { command: 'aws ec2 describe-instances' }).allowed).toBe(true);
        }
    });
});

describe('timeout cancellation', () => {
    it('stops the loop instead of leaving it running', async () => {
        let laps = 0;
        const model: any = {
            bindTools: () => model,
            invoke: async () => {
                laps++;
                await new Promise(r => setTimeout(r, 30));
                return { content: '', tool_calls: [{ id: `${laps}`, name: 'describe_instances', args: {} }], usage_metadata: { input_tokens: 10, output_tokens: 5 } };
            },
        };
        const tool = { name: 'describe_instances', invoke: async () => 'ok' };

        await runSubagent(SPEC, { model, tools: [tool], budget: { ...BUDGET, subagentMaxIterations: 20, subagentTimeoutMs: 60 } });
        const lapsAtReturn = laps;

        // If the loop were abandoned rather than cancelled it would keep going.
        await new Promise(r => setTimeout(r, 300));
        expect(laps).toBeLessThanOrEqual(lapsAtReturn + 1);
    });

    it('reports real usage on timeout rather than zeros', async () => {
        const model: any = {
            bindTools: () => model,
            invoke: async () => {
                await new Promise(r => setTimeout(r, 30));
                return { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }], usage_metadata: { input_tokens: 100, output_tokens: 20 } };
            },
        };
        const tool = { name: 'describe_instances', invoke: async () => 'ok' };

        const result = await runSubagent(SPEC, { model, tools: [tool], budget: { ...BUDGET, subagentMaxIterations: 20, subagentTimeoutMs: 80 } });
        expect(result.tokensIn).toBeGreaterThan(0);
    });
});

describe('runSubagent totality', () => {
    it('does not throw on a malformed budget', async () => {
        const model: any = { bindTools: () => model, invoke: async () => ({ content: 'x', tool_calls: [] }) };
        await expect(
            runSubagent(SPEC, { model, tools: [], budget: undefined as never }),
        ).resolves.toMatchObject({ status: 'failed' });
    });
});

describe('hallucinated tool names', () => {
    it('refuses a tool that passes the jail but is not in the tool list', async () => {
        // The second layer's whole purpose: the model invents a name it was never given.
        const model: any = {
            bindTools: () => model,
            invoke: vi.fn()
                .mockResolvedValueOnce({ content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }], usage_metadata: {} })
                .mockResolvedValueOnce({ content: 'Could not read it.', tool_calls: [], usage_metadata: {} }),
        };
        const result = await runSubagent(SPEC, { model, tools: [], budget: BUDGET });
        expect(result.status).toBe('done');
        expect(result.transcript.some(e => e.text.includes('REFUSED'))).toBe(true);
    });
});
```

Run: `cd apps/web-ui && bunx vitest run lib/agent/subagent.test.ts`

```bash
git add apps/web-ui/lib/agent/subagent.ts apps/web-ui/lib/agent/subagent.test.ts
git commit -m "fix(agent): allowlist sub-agent shell commands and cancel on timeout

An adversarial review escaped the shell blocklist 23 ways: a flag before the
service name, a quote around the verb, a verb missing from the pattern list, or
simply a different binary (pulumi, psql, python3). classifyTool reports
matchedRule:true for any bash command that misses its regexes, so the
fail-closed rule never applied to shell — and a sub-agent runs inside a tool
call, where LangGraph cannot interrupt and no human can approve.

Replace it with an allowlist: refuse shell metacharacters, then require an
allowlisted binary and a read-only operation resolved by tokenising past global
flags. Also cancel the loop on timeout (it previously ran on unsupervised,
spending untracked tokens), refuse bash-like calls with no usable command
string, and report real usage on the timeout path."
```

---

### Task 8: `dispatch_agent` tool and orchestrator wiring

**Files:**
- Create: `apps/web-ui/lib/agent/dispatch-agent-tool.ts`
- Create: `apps/web-ui/lib/agent/dispatch-agent-tool.test.ts`
- Modify: `apps/web-ui/lib/agent/model-factory.ts` (`AssembleToolsOptions`, `assembleTools`)
- Modify: `apps/web-ui/lib/agent/planning-agent.ts:226` (tool assembly), `:384-420` (executor prompt)
- Modify: `apps/web-ui/lib/agent/tool-classifier.ts` (allowlist entry)

**Interfaces:**
- Consumes: `runSubagent`, `filterReadOnlyTools`, `SubagentSpec`, `SubagentResult` from Task 7; `SubagentBudgetConfig`, `resolveSubagentBudget` from Task 4; `Semaphore` from Task 3.
- Produces:
  - `createRunBudgetLedger(budget: SubagentBudgetConfig): RunBudgetLedger`
  - `interface RunBudgetLedger { tryReserve(): { ok: true } | { ok: false; reason: string }; recordSpend(tokensIn: number, tokensOut: number): void; semaphore: Semaphore }`
  - `createDispatchAgentTool(deps: DispatchAgentDeps)` — returns a LangChain tool named `dispatch_agent`.
  - `interface DispatchAgentDeps { model: unknown; subagentTools: Array<{ name: string; invoke: (a: Record<string, unknown>) => Promise<unknown> }>; ledger: RunBudgetLedger; budget: SubagentBudgetConfig; onSubagentEvent?: (e: SubagentEvent) => void }`
  - `interface SubagentEvent { id: string; role: string; task: string; status: 'running' | 'done' | 'failed'; toolCount: number; tokensIn: number; tokensOut: number; summary?: string; transcript?: SubagentTranscriptEntry[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/dispatch-agent-tool.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./subagent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./subagent')>();
    return { ...actual, runSubagent: vi.fn() };
});

import { runSubagent } from './subagent';
import { createRunBudgetLedger, createDispatchAgentTool } from './dispatch-agent-tool';

const BUDGET = {
    enabled: true,
    maxConcurrentSubagents: 2,
    maxSubagentsPerRun: 3,
    maxSubagentTokensPerRun: 1000,
    subagentMaxIterations: 4,
    subagentTimeoutMs: 5000,
};

const okResult = {
    report: 'Findings: i-123 idle', toolCount: 2, tokensIn: 300, tokensOut: 50,
    status: 'done' as const, transcript: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSubagent).mockResolvedValue(okResult);
});

describe('createRunBudgetLedger', () => {
    it('allows reservations up to maxSubagentsPerRun', () => {
        const ledger = createRunBudgetLedger(BUDGET);
        expect(ledger.tryReserve().ok).toBe(true);
        expect(ledger.tryReserve().ok).toBe(true);
        expect(ledger.tryReserve().ok).toBe(true);

        const fourth = ledger.tryReserve();
        expect(fourth.ok).toBe(false);
        expect((fourth as { reason: string }).reason).toMatch(/per-run sub-agent limit/i);
    });

    it('refuses once the token budget is spent', () => {
        const ledger = createRunBudgetLedger(BUDGET);
        ledger.recordSpend(900, 200);

        const verdict = ledger.tryReserve();
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(/token budget/i);
    });

    it('refuses everything when the budget is disabled', () => {
        const ledger = createRunBudgetLedger({ ...BUDGET, enabled: false });
        expect(ledger.tryReserve().ok).toBe(false);
    });
});

describe('dispatch_agent tool', () => {
    const makeTool = (budget = BUDGET) => createDispatchAgentTool({
        model: {},
        subagentTools: [{ name: 'describe_instances', invoke: async () => 'ok' }],
        ledger: createRunBudgetLedger(budget),
        budget,
    });

    it('returns the sub-agent report', async () => {
        const result = await makeTool().invoke({
            role: 'EC2 auditor', task: 'audit account 1', expectedOutput: 'idle instances',
        });
        expect(result).toContain('i-123 idle');
    });

    it('returns ONLY the report — raw sub-agent tool output never reaches the orchestrator', async () => {
        // The tool's return value becomes a ToolMessage in the orchestrator's
        // message list. If the transcript leaked into it, context isolation — the
        // entire reason sub-agents exist — would be defeated.
        vi.mocked(runSubagent).mockResolvedValue({
            ...okResult,
            transcript: [
                { kind: 'tool', name: 'describe_instances', text: 'RAW_TOOL_DUMP_MARKER' },
                { kind: 'ai', text: 'INTERNAL_REASONING_MARKER' },
            ],
        });

        const result = await makeTool().invoke({ role: 'a', task: 't', expectedOutput: 'e' });

        expect(result).toBe(okResult.report);
        expect(result).not.toContain('RAW_TOOL_DUMP_MARKER');
        expect(result).not.toContain('INTERNAL_REASONING_MARKER');
    });

    it('degrades gracefully instead of throwing when the budget is exhausted', async () => {
        const tool = makeTool({ ...BUDGET, maxSubagentsPerRun: 1 });
        await tool.invoke({ role: 'a', task: 't', expectedOutput: 'e' });

        const second = await tool.invoke({ role: 'b', task: 't', expectedOutput: 'e' });
        expect(second).toMatch(/perform this work yourself/i);
        expect(runSubagent).toHaveBeenCalledTimes(1);
    });

    it('emits running then done events', async () => {
        const events: Array<{ status: string }> = [];
        const budget = BUDGET;
        const tool = createDispatchAgentTool({
            model: {},
            subagentTools: [],
            ledger: createRunBudgetLedger(budget),
            budget,
            onSubagentEvent: e => events.push({ status: e.status }),
        });

        await tool.invoke({ role: 'a', task: 't', expectedOutput: 'e' });

        expect(events[0].status).toBe('running');
        expect(events[events.length - 1].status).toBe('done');
    });

    it('never throws when the sub-agent runtime rejects', async () => {
        vi.mocked(runSubagent).mockRejectedValue(new Error('unexpected'));
        const result = await makeTool().invoke({ role: 'a', task: 't', expectedOutput: 'e' });
        expect(result).toMatch(/unexpected/);
    });

    it('bounds concurrency to maxConcurrentSubagents', async () => {
        let active = 0;
        let peak = 0;
        vi.mocked(runSubagent).mockImplementation(async () => {
            active++; peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 10));
            active--;
            return okResult;
        });

        const budget = { ...BUDGET, maxConcurrentSubagents: 2, maxSubagentsPerRun: 6 };
        const tool = makeTool(budget);
        await Promise.all(Array.from({ length: 5 }, (_, i) =>
            tool.invoke({ role: `r${i}`, task: 't', expectedOutput: 'e' })));

        expect(peak).toBeLessThanOrEqual(2);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/dispatch-agent-tool.test.ts`
Expected: FAIL — cannot resolve `./dispatch-agent-tool`.

- [ ] **Step 3: Implement the ledger and the tool**

Create `apps/web-ui/lib/agent/dispatch-agent-tool.ts`:

```typescript
/**
 * dispatch_agent — the sub-agent fan-out tool.
 *
 * One sub-agent per tool call, deliberately: the orchestrator emits N calls in a
 * single turn and ToolNode's existing concurrency performs the fan-out, so there
 * is no second concurrency mechanism and each sub-agent gets its own tool card
 * in the UI for free.
 *
 * Budget exhaustion NEVER fails the run. The tool returns an instruction to do
 * the work serially, so behaviour degrades to the pre-sub-agent baseline.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { Semaphore } from './concurrency';
import { runSubagent, type SubagentTranscriptEntry } from './subagent';
import type { SubagentBudgetConfig } from './subagent-budget';

export interface SubagentEvent {
    id: string;
    role: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string;
    transcript?: SubagentTranscriptEntry[];
}

export interface RunBudgetLedger {
    tryReserve(): { ok: true } | { ok: false; reason: string };
    recordSpend(tokensIn: number, tokensOut: number): void;
    semaphore: Semaphore;
}

/**
 * Per-run ledger. Runs execute on a single ECS replica, so in-process counters
 * are sufficient — no distributed coordination needed.
 */
export function createRunBudgetLedger(budget: SubagentBudgetConfig): RunBudgetLedger {
    let dispatched = 0;
    let tokensSpent = 0;
    const semaphore = new Semaphore(budget.maxConcurrentSubagents);

    return {
        tryReserve() {
            if (!budget.enabled) {
                return { ok: false, reason: 'sub-agents are disabled for this organization' };
            }
            if (dispatched >= budget.maxSubagentsPerRun) {
                return { ok: false, reason: `per-run sub-agent limit reached (${budget.maxSubagentsPerRun})` };
            }
            if (tokensSpent >= budget.maxSubagentTokensPerRun) {
                return { ok: false, reason: `sub-agent token budget exhausted (${budget.maxSubagentTokensPerRun})` };
            }
            dispatched++;
            return { ok: true };
        },
        recordSpend(tokensIn: number, tokensOut: number) {
            tokensSpent += tokensIn + tokensOut;
        },
        semaphore,
    };
}

export interface DispatchAgentDeps {
    model: unknown;
    subagentTools: Array<{ name: string; invoke: (args: Record<string, unknown>) => Promise<unknown> }>;
    ledger: RunBudgetLedger;
    budget: SubagentBudgetConfig;
    onSubagentEvent?: (event: SubagentEvent) => void;
}

const DEGRADE_PREFIX = 'Sub-agent budget exhausted';

export function createDispatchAgentTool(deps: DispatchAgentDeps) {
    return tool(
        async ({ role, task, expectedOutput }: { role: string; task: string; expectedOutput: string }) => {
            const reservation = deps.ledger.tryReserve();
            if (!reservation.ok) {
                return `${DEGRADE_PREFIX}: ${reservation.reason}. Perform this work yourself, serially, using your own tools.`;
            }

            const id = randomUUID();
            const emit = (event: Partial<SubagentEvent> & Pick<SubagentEvent, 'status'>) =>
                deps.onSubagentEvent?.({
                    id, role, task, toolCount: 0, tokensIn: 0, tokensOut: 0, ...event,
                });

            emit({ status: 'running' });

            try {
                const result = await deps.ledger.semaphore.run(() => runSubagent(
                    { role, task, expectedOutput },
                    {
                        model: deps.model as never,
                        tools: deps.subagentTools,
                        budget: deps.budget,
                        onEvent: progress => emit({ status: 'running', ...progress }),
                    },
                ));

                deps.ledger.recordSpend(result.tokensIn, result.tokensOut);

                emit({
                    status: result.status === 'failed' ? 'failed' : 'done',
                    toolCount: result.toolCount,
                    tokensIn: result.tokensIn,
                    tokensOut: result.tokensOut,
                    summary: result.report,
                    transcript: result.transcript,
                });

                return result.report;
            } catch (error) {
                // runSubagent is already total, but a semaphore or emit failure must
                // not propagate into ToolNode and abort the orchestrator's turn.
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[dispatch_agent] "${role}" failed: ${message}`);
                emit({ status: 'failed', summary: message });
                return `The sub-agent "${role}" failed: ${message}. Continue with the information you already have, or perform this work yourself.`;
            }
        },
        {
            name: 'dispatch_agent',
            description: `Delegate an INDEPENDENT read-only investigation to a sub-agent that works in its own context and returns a compressed findings report.

Use this when the task splits into parts that do not depend on each other — one account each, one region each, one service each. Emit SEVERAL dispatch_agent calls in a SINGLE turn and they run in parallel; that is the entire point.

Do NOT use it for:
- anything that changes state (sub-agents are read-only — do mutations yourself)
- work that depends on another sub-agent's output (they cannot see each other)
- a single quick lookup you could do in one tool call

CRITICAL: "task" must be completely self-contained. The sub-agent sees NONE of this conversation — no account ids, no prior findings, no user context unless you write them into the task. A vague brief returns a useless report.`,
            schema: z.object({
                role: z.string().describe('Short identity for this sub-agent, e.g. "EC2 idle-resource auditor for account 123456789012"'),
                task: z.string().describe('Complete standalone brief: what to investigate, which account ids and regions, which tools to prefer, and any constraints. Assume zero shared context.'),
                expectedOutput: z.string().describe('Exactly what the report must contain, e.g. "instance ids with average CPU below 5% over 14 days, with the metric value for each"'),
            }),
        },
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/dispatch-agent-tool.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mark `dispatch_agent` read-only for the orchestrator's guard**

Without this the guard classifies `dispatch_agent` as mutative (it matches `/\bdispatch\b/`? no — but it is unknown-named, so it goes to the LLM risk batch on every call, adding a round-trip). Add it to the allowlist in `apps/web-ui/lib/agent/tool-classifier.ts`, in `READ_ONLY_ALLOWLIST` next to `'read_file'`:

```typescript
    'dispatch_agent',  // spawns a read-only sub-agent; the sub-agent's own jail enforces that
```

- [ ] **Step 6: Assemble the tool into the orchestrator**

In `apps/web-ui/lib/agent/model-factory.ts`, extend `AssembleToolsOptions`:

```typescript
    /** When set, adds the dispatch_agent fan-out tool built from these deps. */
    dispatchAgentTool?: unknown;
```

and in `assembleTools`, add it to `customTools` after `askUserTool`:

```typescript
        ...(options.dispatchAgentTool ? [options.dispatchAgentTool as never] : []),
```

In `apps/web-ui/lib/agent/planning-agent.ts`, add imports:

```typescript
import { resolveSubagentBudget } from "./subagent-budget";
import { createRunBudgetLedger, createDispatchAgentTool } from "./dispatch-agent-tool";
import { filterReadOnlyTools } from "./subagent";
```

Then replace the tool-assembly block at line 226 with:

```typescript
    // Sub-agent tools are assembled FIRST and without dispatch_agent, so the
    // sub-agents' tool list can never contain the tool that spawns sub-agents.
    const baseTools = await assembleTools({ includeS3Tools: true, includeMemoryTools: false, includeSkillTool: autoLoadSkills, userId: config.userId, mcpServerIds, tenantId, accounts, knowledgeBaseIds: config.knowledgeBaseIds });

    const subagentBudget = tenantId
        ? await resolveSubagentBudget(tenantId)
        : { enabled: false, maxConcurrentSubagents: 1, maxSubagentsPerRun: 1, maxSubagentTokensPerRun: 0, subagentMaxIterations: 2, subagentTimeoutMs: 30_000 };

    const dispatchAgentTool = subagentBudget.enabled
        ? createDispatchAgentTool({
            model,
            subagentTools: filterReadOnlyTools(baseTools as never[]),
            ledger: createRunBudgetLedger(subagentBudget),
            budget: subagentBudget,
            onSubagentEvent: config.onSubagentEvent,
        })
        : null;

    const tools = dispatchAgentTool ? [...baseTools, dispatchAgentTool] : baseTools;
    console.log(`[PlanningAgent] Sub-agents ${subagentBudget.enabled ? `enabled (concurrency=${subagentBudget.maxConcurrentSubagents})` : 'disabled'}`);
    const modelWithTools = model.bindTools!(tools);
    const toolNode = new ToolNode(tools);
```

Add the callback to `GraphConfig` in `apps/web-ui/lib/agent/agent-shared.ts` (after `autoLoadSkills`, line 859):

```typescript
    /** Live sub-agent progress sink. Set by the chat route so dispatch_agent
     *  activity can be streamed as data-subagent parts. */
    onSubagentEvent?: (event: import('./dispatch-agent-tool').SubagentEvent) => void;
```

- [ ] **Step 7: Teach the executor when to fan out**

In `apps/web-ui/lib/agent/planning-agent.ts`, append to the `## Execution Discipline` block in `generateNode` (after the batching rules added in Task 3):

```
## Delegation

- When the current step splits into INDEPENDENT investigations — one per account, region, or service — emit several dispatch_agent calls in THIS turn. They run in parallel and each returns a compressed report.
- Write each sub-agent brief so it stands completely alone: it sees none of this conversation, so spell out account ids, regions, time windows, and what the report must contain.
- Do NOT delegate work that changes state — sub-agents are read-only. Do NOT delegate a single quick lookup. Do NOT chain sub-agents; they cannot see each other's results.
- If dispatch_agent replies that the budget is exhausted, simply do that work yourself with your own tools.
```

- [ ] **Step 8: Verify typecheck and the full suite**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

Run: `cd apps/web-ui && bunx vitest run lib/agent/`
Expected: PASS with no new failures.

- [ ] **Step 9: Commit**

```bash
git add apps/web-ui/lib/agent/dispatch-agent-tool.ts apps/web-ui/lib/agent/dispatch-agent-tool.test.ts apps/web-ui/lib/agent/model-factory.ts apps/web-ui/lib/agent/planning-agent.ts apps/web-ui/lib/agent/agent-shared.ts apps/web-ui/lib/agent/tool-classifier.ts
git commit -m "feat(agent): dispatch_agent fan-out tool with per-run budget ledger

One sub-agent per tool call so ToolNode's existing concurrency performs the
fan-out. Budget exhaustion returns a do-it-yourself instruction rather than an
error, so runs degrade to the serial baseline instead of failing."
```

---

### Task 9: Stream sub-agent progress with a heartbeat

CloudFront's `originReadTimeout` is 60s (`infra/compute/index.ts:962`) while the ALB allows 1200s. Today a 10-minute run survives only because streamed tokens keep resetting the 60s timer. A silent fan-out phase would drop the connection, so the heartbeat is a correctness requirement, not decoration.

**Files:**
- Modify: `apps/web-ui/app/api/chat/stream-parts.ts`
- Modify: `apps/web-ui/app/api/chat/__tests__/stream-parts.test.ts`
- Modify: `apps/web-ui/app/api/chat/route.ts`

**Interfaces:**
- Consumes: `SubagentEvent` from Task 8.
- Produces: `buildSubagentPart(event: SubagentEvent): DataPart` emitting `{ type: 'data-subagent', id: 'subagent-<id>', data: {...} }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web-ui/app/api/chat/__tests__/stream-parts.test.ts`:

```typescript
import { buildSubagentPart } from '../stream-parts';

describe('buildSubagentPart', () => {
    const base = {
        id: 'sa-1', role: 'EC2 auditor', task: 'audit account 1',
        toolCount: 3, tokensIn: 900, tokensOut: 120,
    };

    it('builds a stable id so updates replace rather than append', () => {
        const part = buildSubagentPart({ ...base, status: 'running' });
        expect(part.type).toBe('data-subagent');
        expect(part.id).toBe('subagent-sa-1');
    });

    it('carries progress counters', () => {
        const part = buildSubagentPart({ ...base, status: 'running' });
        expect(part.data).toMatchObject({ role: 'EC2 auditor', status: 'running', toolCount: 3, tokensIn: 900 });
    });

    it('omits the transcript from the stream payload', () => {
        const part = buildSubagentPart({
            ...base, status: 'done', summary: 'found things',
            transcript: [{ kind: 'ai', text: 'internal reasoning' }],
        });
        expect(JSON.stringify(part.data)).not.toContain('internal reasoning');
        expect((part.data as { summary?: string }).summary).toBe('found things');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run app/api/chat/__tests__/stream-parts.test.ts`
Expected: FAIL — `buildSubagentPart` is not exported.

- [ ] **Step 3: Add the stream part**

In `apps/web-ui/app/api/chat/stream-parts.ts`, add after `buildMemoryPart` (line 28):

```typescript
/**
 * One data-subagent part per sub-agent state change. The `id` is stable per
 * sub-agent so the client replaces the card in place rather than appending a new
 * one on every progress tick.
 *
 * The transcript is deliberately NOT sent: it can be large, and the whole point
 * of sub-agents is keeping bulk out of the transcript. It is persisted
 * separately and fetched on demand when a card is expanded.
 */
export function buildSubagentPart(event: {
    id: string;
    role: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string;
}): DataPart {
    return {
        type: 'data-subagent',
        id: `subagent-${event.id}`,
        data: {
            id: event.id,
            role: event.role,
            task: event.task,
            status: event.status,
            toolCount: event.toolCount,
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
            ...(event.summary ? { summary: event.summary } : {}),
        },
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run app/api/chat/__tests__/stream-parts.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the sink and the heartbeat into the chat route**

In `apps/web-ui/app/api/chat/route.ts`, add the imports:

```typescript
import { buildSubagentPart } from './stream-parts';
import type { SubagentEvent } from '@/lib/agent/dispatch-agent-tool';
```

(`stream-parts` is already imported — extend the existing import list rather than adding a second statement.)

Inside the `ReadableStream` `start(controller)` body, before the graph stream is created, add the live sink and heartbeat:

```typescript
            // --- Sub-agent progress ---------------------------------------------
            // Sub-agent tokens deliberately never reach the transcript: three
            // concurrent streams interleaved into one column are unreadable, and the
            // narration was never the deliverable. Collapsed cards instead.
            const liveSubagents = new Map<string, SubagentEvent>();

            const emitSubagent = (event: SubagentEvent) => {
                liveSubagents.set(event.id, event);
                if (event.status !== 'running') liveSubagents.delete(event.id);
                try {
                    controller.enqueue(buildSubagentPart(event));
                } catch {
                    // Client disconnected — the stream teardown handles it.
                }
            };

            // CloudFront's originReadTimeout is 60s (infra/compute/index.ts:962). A
            // sub-agent can think for 90s without producing a byte, so re-emit the
            // in-flight cards on a timer to keep the connection alive.
            const HEARTBEAT_MS = 15_000;
            const heartbeat = setInterval(() => {
                for (const event of liveSubagents.values()) {
                    try {
                        controller.enqueue(buildSubagentPart(event));
                    } catch {
                        // ignore — teardown will clear the interval
                    }
                }
            }, HEARTBEAT_MS);
```

Pass `emitSubagent` into the graph config where `GraphConfig` is assembled (line 230, alongside `autoApprove`):

```typescript
                onSubagentEvent: emitSubagent,
```

Clear the interval in the same teardown path where `logRunSummary(threadId)` was added in Task 2:

```typescript
                    clearInterval(heartbeat);
```

- [ ] **Step 6: Verify the heartbeat manually**

With `SUBAGENTS_ENABLED=true` and sub-agents enabled for the tenant, run a fan-out task and watch the browser network tab: `data-subagent` frames must arrive at least every 15 seconds during the fan-out phase, with no gap approaching 60 seconds.

- [ ] **Step 7: Typecheck and commit**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

```bash
git add apps/web-ui/app/api/chat/stream-parts.ts apps/web-ui/app/api/chat/__tests__/stream-parts.test.ts apps/web-ui/app/api/chat/route.ts
git commit -m "feat(chat): stream sub-agent progress as data-subagent parts

Collapsed-card progress instead of interleaved token streams, plus a 15s
heartbeat so a silent fan-out phase cannot exceed CloudFront's 60s
originReadTimeout and drop the connection."
```

---

### Task 10: Sub-agent cards in the chat UI

**Files:**
- Modify: `apps/web-ui/components/agent/chat/run-state.ts`
- Modify: `apps/web-ui/components/agent/chat/__tests__/run-state.test.ts` (create if absent)
- Create: `apps/web-ui/components/agent/chat/subagent-card.tsx`
- Modify: `apps/web-ui/components/agent/chat/run-rail.tsx`

**Interfaces:**
- Consumes: the `data-subagent` part from Task 9.
- Produces:
  - `interface SubagentState { id: string; role: string; task: string; status: 'running' | 'done' | 'failed'; toolCount: number; tokensIn: number; tokensOut: number; summary?: string }`
  - `RunState.subagents: SubagentState[]`
  - `<SubagentCard subagent={...} threadId={...} />`

- [ ] **Step 1: Write the failing reducer test**

Create `apps/web-ui/components/agent/chat/__tests__/run-state.test.ts` (or append to it if it exists):

```typescript
import { describe, it, expect } from 'vitest';
import { deriveRunState } from '../run-state';

const msg = (parts: unknown[]) => ({ role: 'assistant', id: 'm1', parts } as never);

const subagentPart = (data: Record<string, unknown>) => ({ type: 'data-subagent', data });

describe('deriveRunState — subagents', () => {
    it('collects sub-agents in first-seen order', () => {
        const state = deriveRunState([msg([
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0 }),
            subagentPart({ id: 'b', role: 'B', task: 't', status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0 }),
        ])], new Set());

        expect(state.subagents.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('replaces an earlier update for the same id rather than duplicating', () => {
        const state = deriveRunState([msg([
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'running', toolCount: 1, tokensIn: 10, tokensOut: 2 }),
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'done', toolCount: 5, tokensIn: 900, tokensOut: 80, summary: 'found it' }),
        ])], new Set());

        expect(state.subagents).toHaveLength(1);
        expect(state.subagents[0]).toMatchObject({ status: 'done', toolCount: 5, summary: 'found it' });
    });

    it('marks the run as having structured data', () => {
        const state = deriveRunState([msg([
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0 }),
        ])], new Set());

        expect(state.hasStructuredData).toBe(true);
    });

    it('returns an empty list when no sub-agent parts are present', () => {
        expect(deriveRunState([msg([{ type: 'text', text: 'hi' }])], new Set()).subagents).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/run-state.test.ts`
Expected: FAIL — `state.subagents` is undefined.

- [ ] **Step 3: Extend the reducer**

In `apps/web-ui/components/agent/chat/run-state.ts`, add the interface after `PendingClarification` (line 14):

```typescript
export interface SubagentState {
  id: string;
  role: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  toolCount: number;
  tokensIn: number;
  tokensOut: number;
  summary?: string;
}
```

Add to `RunState` (after `tokenUsage`, line 28):

```typescript
  /** Sub-agents dispatched in this thread, in first-seen order. Later parts for
   *  the same id replace the earlier entry in place. */
  subagents: SubagentState[];
```

Inside `deriveRunState`, declare the accumulator next to the other locals (after line 46):

```typescript
    const subagents = new Map<string, SubagentState>();
```

Add the case to the `switch` (after `case 'data-usage'`, line 103):

```typescript
                case 'data-subagent': {
                    hasStructuredData = true;
                    const id = String(part.data?.id ?? '');
                    if (!id) break;
                    // Map.set on an existing key preserves insertion order, so the
                    // card stays put as it updates from running → done.
                    subagents.set(id, {
                        id,
                        role: String(part.data?.role ?? ''),
                        task: String(part.data?.task ?? ''),
                        status: (part.data?.status === 'done' || part.data?.status === 'failed')
                            ? part.data.status : 'running',
                        toolCount: Number(part.data?.toolCount) || 0,
                        tokensIn: Number(part.data?.tokensIn) || 0,
                        tokensOut: Number(part.data?.tokensOut) || 0,
                        ...(part.data?.summary ? { summary: String(part.data.summary) } : {}),
                    });
                    break;
                }
```

Add to the returned object (after `tokenUsage`, line 124):

```typescript
        subagents: Array.from(subagents.values()),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/run-state.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Build the card**

Create `apps/web-ui/components/agent/chat/subagent-card.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { SubagentState } from './run-state';

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const STATUS_ICON = {
  running: <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />,
  done: <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
} as const;

export function SubagentCard({ subagent }: { subagent: SubagentState }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = subagent.status !== 'running' && !!subagent.summary;

  return (
    <div className="rounded-md border bg-muted/30 text-sm">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          canExpand ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
        )}
        onClick={() => canExpand && setExpanded(v => !v)}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
      >
        {canExpand
          ? (expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />)
          : <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}

        {STATUS_ICON[subagent.status]}

        <span className="flex-1 truncate font-medium">{subagent.role}</span>

        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {subagent.toolCount} tools · {formatTokens(subagent.tokensIn + subagent.tokensOut)} tokens
        </span>
      </button>

      {expanded && subagent.summary && (
        <div className="border-t px-3 py-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Task</p>
          <p className="mb-3 whitespace-pre-wrap text-xs text-muted-foreground">{subagent.task}</p>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Findings</p>
          <p className="whitespace-pre-wrap text-xs">{subagent.summary}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Fix the existing RunRail test fixture**

`apps/web-ui/components/agent/chat/__tests__/run-rail.test.tsx` builds a complete `RunState` literal (`EMPTY_RUN_STATE`, line 7). Adding a required field to `RunState` breaks its typecheck, so update it now — add after `tokenUsage` (line 15):

```tsx
  subagents: [],
```

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/run-rail.test.tsx`
Expected: PASS (unchanged behaviour, fixture now complete).

- [ ] **Step 7: Render the cards in the run rail**

`RunRail` currently takes `{ runState, isStreaming, context }` (line 45) and has no thread id, so add one. In `apps/web-ui/components/agent/chat/run-rail.tsx`:

Add to the imports:

```tsx
import { Bot } from "lucide-react";
import { SubagentCard } from "./subagent-card";
```

(`lucide-react` is already imported — add `Bot` to the existing named import list rather than adding a second statement.)

Extend the props:

```tsx
export function RunRail({
  runState,
  isStreaming,
  context,
  threadId,
}: {
  runState: RunState;
  isStreaming: boolean;
  context: { accountNames: string[]; modelLabel: string; skillName: string | null; toolCount: number | null; kbLabel: string };
  /** Needed to fetch a persisted sub-agent transcript when a card is expanded
   *  after a reload. Optional so the existing rail tests keep compiling. */
  threadId?: string;
}) {
```

Render the group using the file's own `RailSection` wrapper (line 33), placed immediately after the plan `RailSection` block that ends at line 102's closing `)}`:

```tsx
      {runState.subagents.length > 0 && (
        <RailSection
          icon={Bot}
          title={`Sub-agents (${runState.subagents.filter((s) => s.status === "running").length} running)`}
        >
          <div className="space-y-1.5">
            {runState.subagents.map((subagent) => (
              <SubagentCard key={subagent.id} subagent={subagent} threadId={threadId} />
            ))}
          </div>
        </RailSection>
      )}
```

- [ ] **Step 8: Pass the thread id from the session view**

In `apps/web-ui/components/agent/workspace/session-view.tsx:372`, add the prop:

```tsx
            <RunRail runState={runState} isStreaming={isStreaming} context={pickers.railContext} threadId={threadId} />
```

`threadId` is already a `SessionView` prop (line 45), so nothing else needs threading.

- [ ] **Step 9: Typecheck, lint, and verify visually**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

Run: `cd apps/web-ui && bun run lint`
Expected: no new errors.

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/`
Expected: PASS.

With sub-agents enabled, run a fan-out task and confirm: one card per sub-agent, spinners while running, live tool/token counters, green ticks on completion, cards expand to show task and findings, and no sub-agent prose leaks into the transcript.

- [ ] **Step 10: Commit**

```bash
git add apps/web-ui/components/agent/chat/run-state.ts apps/web-ui/components/agent/chat/__tests__/ apps/web-ui/components/agent/chat/subagent-card.tsx apps/web-ui/components/agent/chat/run-rail.tsx apps/web-ui/components/agent/workspace/session-view.tsx
git commit -m "feat(ui): collapsed sub-agent cards in the chat run rail"
```

---

### Task 11: Persist sub-agent transcripts for expansion after reload

Stream data parts are not persisted — chat history is rebuilt from the LangGraph checkpointer. Live expansion works from client state, but a page reload loses it. The transcript must never travel in the `dispatch_agent` ToolMessage, because that message enters the orchestrator's context and would defeat the isolation the whole feature exists to provide.

**Files:**
- Modify: `libs/prisma/schema.prisma`
- Create: `apps/web-ui/lib/db/repositories/subagent/interface.ts`
- Create: `apps/web-ui/lib/db/repositories/subagent/postgres.ts`
- Modify: `apps/web-ui/lib/db/repository-factory.ts`
- Create: `apps/web-ui/app/api/chat/subagents/[threadId]/route.ts`
- Create: `apps/web-ui/app/api/chat/subagents/[threadId]/route.test.ts`
- Modify: `apps/web-ui/app/api/chat/route.ts` (persist on terminal events)
- Modify: `apps/web-ui/components/agent/chat/subagent-card.tsx` (fetch on expand)

**Interfaces:**
- Consumes: `SubagentEvent` from Task 8; `emitSubagent` sink from Task 9.
- Produces:
  - `interface SubagentRunRepository { save(record: SubagentRunRecord): Promise<void>; listByThread(tenantId: string, threadId: string): Promise<SubagentRunRecord[]> }`
  - `getSubagentRunRepository(): SubagentRunRepository`
  - `GET /api/chat/subagents/[threadId]` → `{ success: true, data: SubagentRunRecord[] }`

- [ ] **Step 1: Add the Prisma model**

In `libs/prisma/schema.prisma`, add next to `ChatMessage` (line 615):

```prisma
// AgentSubagentRun — one row per dispatch_agent sub-agent, so a collapsed card
// can be expanded after a page reload. The transcript lives here and NEVER in
// the orchestrator's message list: putting it there would defeat the context
// isolation that makes sub-agents worthwhile.
model AgentSubagentRun {
  id         String   @id @default(cuid())
  tenantId   String
  threadId   String
  subagentId String
  role       String
  task       String
  status     String // running|done|failed
  toolCount  Int      @default(0)
  tokensIn   Int      @default(0)
  tokensOut  Int      @default(0)
  summary    String?
  transcript Json?
  createdAt  DateTime @default(now())
  expiresAt  DateTime // 30-day TTL, matching ChatMessage

  @@unique([tenantId, threadId, subagentId])
  @@index([tenantId, threadId, createdAt])
  @@index([expiresAt])
  @@map("agent_subagent_runs")
}
```

- [ ] **Step 2: Generate the migration and audit it**

Run: `cd apps/web-ui && bun run db:migrate`
When prompted, name it `add_agent_subagent_runs`.

**Then open the generated SQL under `libs/prisma/migrations/` and read every statement.** Per the project's recorded history, `prisma migrate dev` silently emits `DROP INDEX` for raw-SQL-created HNSW/GIN/IVFFlat indexes it treats as drift. If you find any `DROP INDEX` unrelated to this new table, delete those lines before the migration is applied anywhere else, and add a follow-up idempotent migration recreating anything already dropped locally. Never edit a migration that has already been applied in a shared environment.

Run: `cd apps/web-ui && bun run db:generate && cd ../workers && bun run db:generate`
Expected: both clients regenerate without error.

- [ ] **Step 3: Write the failing route test**

Create `apps/web-ui/app/api/chat/subagents/[threadId]/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/repository-factory', () => ({
    getSubagentRunRepository: vi.fn(),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getSubagentRunRepository } from '@/lib/db/repository-factory';
import { GET } from './route';

const params = (threadId: string) => ({ params: Promise.resolve({ threadId }) });
const listByThread = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorize).mockResolvedValue(null as never);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1' as never);
    vi.mocked(getSubagentRunRepository).mockReturnValue({ save: vi.fn(), listByThread } as never);
    listByThread.mockResolvedValue([{ subagentId: 'a', role: 'A', transcript: [] }]);
});

describe('GET /api/chat/subagents/[threadId]', () => {
    it('returns the thread\'s sub-agent runs', async () => {
        const body = await (await GET({} as never, params('thread-1'))).json();

        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(listByThread).toHaveBeenCalledWith('t1', 'thread-1');
    });

    it('propagates an RBAC denial', async () => {
        const denied = { status: 403 };
        vi.mocked(authorize).mockResolvedValue(denied as never);
        expect(await GET({} as never, params('thread-1'))).toBe(denied);
    });

    it('403s with no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue(null as never);
        expect((await GET({} as never, params('thread-1'))).status).toBe(403);
    });

    it('500s when the repository throws', async () => {
        listByThread.mockRejectedValue(new Error('db down'));
        expect((await GET({} as never, params('thread-1'))).status).toBe(500);
    });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run app/api/chat/subagents/`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 5: Implement the repository**

Create `apps/web-ui/lib/db/repositories/subagent/interface.ts`:

```typescript
export interface SubagentTranscriptEntry {
    kind: 'ai' | 'tool';
    name?: string;
    text: string;
}

export interface SubagentRunRecord {
    tenantId: string;
    threadId: string;
    subagentId: string;
    role: string;
    task: string;
    status: string;
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string | null;
    transcript?: SubagentTranscriptEntry[] | null;
}

export interface SubagentRunRepository {
    /** Upsert by (tenantId, threadId, subagentId) — a sub-agent is written once
     *  on completion, but a retried write must not create a duplicate row. */
    save(record: SubagentRunRecord): Promise<void>;
    listByThread(tenantId: string, threadId: string): Promise<SubagentRunRecord[]>;
}
```

Create `apps/web-ui/lib/db/repositories/subagent/postgres.ts`:

```typescript
import { getTenantClient } from '@/lib/db/pg-config';
import type { SubagentRunRecord, SubagentRunRepository, SubagentTranscriptEntry } from './interface';

const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class SubagentRunPostgresRepository implements SubagentRunRepository {
    async save(record: SubagentRunRecord): Promise<void> {
        const db = getTenantClient(record.tenantId);
        const data = {
            tenantId: record.tenantId,
            threadId: record.threadId,
            subagentId: record.subagentId,
            role: record.role,
            task: record.task,
            status: record.status,
            toolCount: record.toolCount,
            tokensIn: record.tokensIn,
            tokensOut: record.tokensOut,
            summary: record.summary ?? null,
            transcript: (record.transcript ?? null) as never,
            expiresAt: new Date(Date.now() + TTL_30_DAYS_MS),
        };

        await db.agentSubagentRun.upsert({
            where: {
                tenantId_threadId_subagentId: {
                    tenantId: record.tenantId,
                    threadId: record.threadId,
                    subagentId: record.subagentId,
                },
            },
            create: data,
            update: data,
        });
    }

    async listByThread(tenantId: string, threadId: string): Promise<SubagentRunRecord[]> {
        const db = getTenantClient(tenantId);
        const rows = await db.agentSubagentRun.findMany({
            where: { threadId },
            orderBy: { createdAt: 'asc' },
        });

        return rows.map(row => ({
            tenantId: row.tenantId,
            threadId: row.threadId,
            subagentId: row.subagentId,
            role: row.role,
            task: row.task,
            status: row.status,
            toolCount: row.toolCount,
            tokensIn: row.tokensIn,
            tokensOut: row.tokensOut,
            summary: row.summary,
            transcript: (row.transcript ?? null) as SubagentTranscriptEntry[] | null,
        }));
    }
}
```

In `apps/web-ui/lib/db/repository-factory.ts`, add the accessor following the existing pattern in that file:

```typescript
import { SubagentRunPostgresRepository } from './repositories/subagent/postgres';
import type { SubagentRunRepository } from './repositories/subagent/interface';

let subagentRunRepository: SubagentRunRepository | null = null;

export function getSubagentRunRepository(): SubagentRunRepository {
    if (!subagentRunRepository) subagentRunRepository = new SubagentRunPostgresRepository();
    return subagentRunRepository;
}
```

- [ ] **Step 6: Implement the route**

Create `apps/web-ui/app/api/chat/subagents/[threadId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getSubagentRunRepository } from '@/lib/db/repository-factory';

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ threadId: string }> },
) {
    console.log('API - GET /api/chat/subagents/[threadId] - Fetching sub-agent runs');

    const authError = await authorize('read', 'Agent');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const { threadId } = await params;
        // listByThread goes through getTenantClient, so the query is tenant-scoped
        // regardless of what threadId the caller supplies.
        const runs = await getSubagentRunRepository().listByThread(tenantId, threadId);

        return NextResponse.json({ success: true, data: runs });
    } catch (error) {
        console.error('API - Error fetching sub-agent runs:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch sub-agent runs' },
            { status: 500 },
        );
    }
}
```

- [ ] **Step 7: Run the route test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run app/api/chat/subagents/`
Expected: PASS, 4 tests.

- [ ] **Step 8: Persist on terminal sub-agent events**

In `apps/web-ui/app/api/chat/route.ts`, extend the `emitSubagent` sink added in Task 9 so terminal events are written:

```typescript
            const emitSubagent = (event: SubagentEvent) => {
                liveSubagents.set(event.id, event);
                if (event.status !== 'running') {
                    liveSubagents.delete(event.id);
                    // Fire-and-forget: a persistence failure must never break the run.
                    if (tenantId) {
                        getSubagentRunRepository().save({
                            tenantId,
                            threadId,
                            subagentId: event.id,
                            role: event.role,
                            task: event.task,
                            status: event.status,
                            toolCount: event.toolCount,
                            tokensIn: event.tokensIn,
                            tokensOut: event.tokensOut,
                            summary: event.summary ?? null,
                            transcript: (event.transcript ?? null) as never,
                        }).catch(err => console.error('[Chat] Failed to persist sub-agent run:', err));
                    }
                }
                try {
                    controller.enqueue(buildSubagentPart(event));
                } catch {
                    // Client disconnected — the stream teardown handles it.
                }
            };
```

Add the import:

```typescript
import { getSubagentRunRepository } from '@/lib/db/repository-factory';
```

- [ ] **Step 9: Fetch the transcript when a card is expanded**

In `apps/web-ui/components/agent/chat/subagent-card.tsx`, accept a `threadId` prop and lazily load the persisted transcript. Replace the component signature and add the fetch:

```tsx
export function SubagentCard({ subagent, threadId }: { subagent: SubagentState; threadId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = subagent.status !== 'running' && !!subagent.summary;

  // Loaded only on expand, and only when this card came from history (no live
  // summary). Keeps the default render free of network work.
  const { data: transcript } = useQuery({
    queryKey: ['subagent-transcript', threadId, subagent.id],
    enabled: expanded && !!threadId,
    queryFn: async () => {
      const res = await fetch(`/api/chat/subagents/${threadId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load sub-agent transcript');
      const match = (json.data as Array<{ subagentId: string; transcript?: Array<{ kind: string; name?: string; text: string }> }>)
        .find(r => r.subagentId === subagent.id);
      return match?.transcript ?? [];
    },
  });
```

Add the import:

```tsx
import { useQuery } from '@tanstack/react-query';
```

And render the transcript below the findings block inside the `expanded` branch:

```tsx
          {transcript && transcript.length > 0 && (
            <div className="mt-3 border-t pt-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Transcript</p>
              <div className="space-y-1.5">
                {transcript.map((entry, i) => (
                  <div key={i} className="text-xs">
                    <span className="text-muted-foreground">
                      {entry.kind === 'tool' ? `${entry.name ?? 'tool'} → ` : 'thinking: '}
                    </span>
                    <span className="whitespace-pre-wrap">{entry.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
```

`run-rail.tsx` already passes `threadId` into `SubagentCard` (Task 10, Step 7), so no further wiring is needed here.

- [ ] **Step 10: Verify end to end**

Run: `cd apps/web-ui && bunx tsc --noEmit` — no new errors.
Run: `cd apps/web-ui && bun run lint` — no new errors.
Run: `cd apps/web-ui && bun run test` — full suite, no new failures.

Manually: run a fan-out task, wait for completion, **reload the page**, expand a sub-agent card, and confirm the task, findings, and transcript all render from the persisted row.

- [ ] **Step 11: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations apps/web-ui/lib/db/repositories/subagent apps/web-ui/lib/db/repository-factory.ts apps/web-ui/app/api/chat/subagents apps/web-ui/app/api/chat/route.ts apps/web-ui/components/agent/chat/subagent-card.tsx apps/web-ui/components/agent/chat/run-rail.tsx
git commit -m "feat(chat): persist sub-agent transcripts for expansion after reload

Transcripts live in agent_subagent_runs (30-day TTL) and are fetched on demand,
never carried in the dispatch_agent ToolMessage — that message enters the
orchestrator's context and would undo the isolation sub-agents exist to give."
```

---

## Final verification

- [ ] Run the full web-ui suite: `cd apps/web-ui && bun run test`. Compare failures against the pre-Task-1 baseline; there must be no new ones.
- [ ] Run `cd apps/web-ui && bunx tsc --noEmit` and `bun run lint` — clean.
- [ ] Re-run the representative slow task from Task 2 Step 8 with `SUBAGENTS_ENABLED=true` and sub-agents enabled for the tenant. Record the `📊 [RUN SUMMARY]` and compare against both the Task 2 baseline and the Task 3 measurement.
- [ ] Confirm the safety property by inspection: with sub-agents enabled, ask the agent to stop an EC2 instance across several accounts. Every mutation must still surface in the approval card — no mutation may occur inside a sub-agent.
