# KB ↔ AIOps + Agent Ops Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Knowledge Bases a first-class, autonomous capability for the AIOps agent and the Agent Ops executor — the agent decides for itself when to consult a KB, retrieval works across multiple KBs, and when the user picks no KB in the console it auto-scopes to the relevant ones.

**Architecture:** A reusable pgvector search primitive (`searchKbChunks`) backs both the existing `/api/knowledge-base/query` route and a new bound LangChain tool `search_knowledge_base`. The agent calls the tool on its own initiative (autonomy). A cloned auto-selection step (`autoSelectKb`, mirroring `auto-skill-select.ts`) resolves relevant KB ids when none are selected. `knowledgeBaseIds` threads UI → `/api/chat` → `GraphConfig` → `assembleTools`, and through the Agent Ops run config + evaluator.

**Tech Stack:** Next.js 15, LangGraph/LangChain, pgvector (Prisma raw SQL), TanStack Query, Zod, Vitest.

## Global Constraints

- **Multi-tenant safety:** every KB read is scoped by `tenantId`; the tool and auto-select derive `tenantId` from `GraphConfig`/session, never trust client-supplied tenant. KB-id inputs are validated against `KnowledgeBaseService.listKnowledgeBases(tenantId)` before use.
- **Embeddings fixed 1024-dim** via `getEmbedding(text, tenantId)` (`lib/knowledge-base/embedder.ts`) — never a hardcoded Bedrock client.
- **Manual selection always wins:** auto-KB-selection runs ONLY when the user selected no KB (mirror `selectedSkill || null` at `chat/route.ts:142`).
- **Never throw from auto-select or the tool:** both degrade gracefully (auto-select returns `[]`, tool returns a "no results / unavailable" string) — an agent turn must not crash because KB retrieval failed.
- **Feature flags:** `AUTO_KB_SELECTION_ENABLED` (default on) gates auto-selection, mirroring `AUTO_SKILL_SELECTION_ENABLED`.
- **Reuse, don't duplicate:** the vector SQL lives in exactly one place after Task 1 (`searchKbChunks`); the query route must call it.
- Indentation: 4 spaces in `lib/`/route files, 2 spaces in components. `@/` alias for cross-dir imports.
- Tests: Vitest. One file: `cd apps/web-ui && bunx vitest run <path>`.

## Design decisions (locked)

- **Tool-first autonomy** over a deterministic `kb_recall` node: the agent decides when to retrieve (matches "checks if a KB is required"). No new graph node is added; the tool is bound alongside existing tools.
- **Tool scoping precedence:** an explicit `knowledgeBaseIds` arg on the tool call wins; else the resolved `defaultKbIds` captured in the factory closure (from console selection or auto-select); else tenant-wide search (all chunks). This is the "default to checking relevant KBs" behavior.
- **Multi-KB** everywhere: `knowledgeBaseIds` is always a `string[]`.

---

### Task 1: Reusable `searchKbChunks` primitive + query-route refactor

**Files:**
- Create: `apps/web-ui/lib/knowledge-base/retrieval.ts`
- Modify: `apps/web-ui/app/api/knowledge-base/query/route.ts` (replace inline SQL, lines ~122-149, with a call to the primitive)
- Test: `apps/web-ui/lib/knowledge-base/retrieval.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface KbChunkHit {
      vectorKey: string; documentName: string; sourceType: string;
      chunkIndex: number; totalChunks: number;
      knowledgeBaseId: string; dataSourceId: string; textContent: string; score: number;
  }
  export async function searchKbChunks(params: {
      tenantId: string; query: string;
      knowledgeBaseIds?: string[];   // empty/undefined → all tenant chunks
      limit?: number;                // default 10
      minScore?: number;             // default 0 (no threshold)
  }): Promise<KbChunkHit[]>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/knowledge-base/retrieval.test.ts`. Mock `getEmbedding` and `getPrismaClient`; assert the SQL scoping and param shape for three cases (no ids → tenant-only where clause; ids → `ANY($3::text[])` with the array; `minScore` filters rows):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/knowledge-base/embedder', () => ({ getEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]) }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));

import { getEmbedding } from '@/lib/knowledge-base/embedder';
import { getPrismaClient } from '@/lib/db/pg-config';
import { searchKbChunks } from './retrieval';

const rows = [
    { vectorKey: 'k1', documentName: 'Doc', sourceType: 'document', chunkIndex: 0, totalChunks: 1, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', textContent: 'hello', score: 0.9 },
    { vectorKey: 'k2', documentName: 'Doc', sourceType: 'document', chunkIndex: 1, totalChunks: 2, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', textContent: 'low', score: 0.2 },
];

describe('searchKbChunks', () => {
    let q: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        q = vi.fn().mockResolvedValue(rows);
        vi.mocked(getPrismaClient).mockReturnValue({ $queryRawUnsafe: q } as any);
        vi.mocked(getEmbedding).mockClear();
    });

    it('embeds the query with the tenant id', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q' });
        expect(getEmbedding).toHaveBeenCalledWith('q', 't1');
    });

    it('tenant-only scope when no kb ids', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q' });
        const sql = q.mock.calls[0][0] as string;
        expect(sql).not.toContain('ANY(');
        expect(sql).toContain('"tenantId" = $2');
        expect(q.mock.calls[0].slice(1)).toEqual(['[0.1,0.2]', 't1']);
    });

    it('scopes to multiple kb ids via ANY($3::text[])', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q', knowledgeBaseIds: ['kb1', 'kb2'] });
        const sql = q.mock.calls[0][0] as string;
        expect(sql).toContain('"knowledgeBaseId" = ANY($3::text[])');
        expect(q.mock.calls[0][3]).toEqual(['kb1', 'kb2']);
    });

    it('applies minScore filtering in JS', async () => {
        const hits = await searchKbChunks({ tenantId: 't1', query: 'q', minScore: 0.5 });
        expect(hits.map((h) => h.vectorKey)).toEqual(['k1']);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/knowledge-base/retrieval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `retrieval.ts`**

```typescript
import { getEmbedding } from './embedder';
import { getPrismaClient } from '@/lib/db/pg-config';

export interface KbChunkHit {
    vectorKey: string;
    documentName: string;
    sourceType: string;
    chunkIndex: number;
    totalChunks: number;
    knowledgeBaseId: string;
    dataSourceId: string;
    textContent: string;
    score: number;
}

/**
 * Semantic search over kb_document_chunks (pgvector cosine). Scoped to the
 * tenant; optionally narrowed to a set of knowledge bases. When no ids are
 * given it searches ALL of the tenant's chunks. Never trusts a client tenantId —
 * callers pass the session/graph-resolved tenantId.
 */
export async function searchKbChunks(params: {
    tenantId: string;
    query: string;
    knowledgeBaseIds?: string[];
    limit?: number;
    minScore?: number;
}): Promise<KbChunkHit[]> {
    const { tenantId, query, knowledgeBaseIds, limit = 10, minScore = 0 } = params;
    if (!query.trim()) return [];

    const embedding = await getEmbedding(query, tenantId);
    const vectorLiteral = `[${embedding.join(',')}]`;
    const prisma = getPrismaClient();

    const cols = `"vectorKey", "documentName", "sourceType", "chunkIndex", "totalChunks",
                  "knowledgeBaseId", "dataSourceId", "textContent",
                  1 - (embedding <=> $1::vector) as score`;

    let rows: KbChunkHit[];
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
        rows = await prisma.$queryRawUnsafe<KbChunkHit[]>(
            `SELECT ${cols}
             FROM kb_document_chunks
             WHERE "tenantId" = $2 AND "knowledgeBaseId" = ANY($3::text[])
             ORDER BY embedding <=> $1::vector
             LIMIT ${Number(limit)}`,
            vectorLiteral, tenantId, knowledgeBaseIds,
        );
    } else {
        rows = await prisma.$queryRawUnsafe<KbChunkHit[]>(
            `SELECT ${cols}
             FROM kb_document_chunks
             WHERE "tenantId" = $2
             ORDER BY embedding <=> $1::vector
             LIMIT ${Number(limit)}`,
            vectorLiteral, tenantId,
        );
    }

    return minScore > 0 ? rows.filter((r) => (typeof r.score === 'number' ? r.score : 0) >= minScore) : rows;
}
```
Note: `limit` is interpolated as `Number(limit)` (not a bound param) to avoid a `$N` placeholder for LIMIT; it is coerced to a number so it is injection-safe. `knowledgeBaseIds` is a bound param (`$3`).

- [ ] **Step 4: Refactor the query route to use it**

In `apps/web-ui/app/api/knowledge-base/query/route.ts`: remove the inline embed+SQL (lines ~117-149, the `getEmbedding`/`vectorLiteral`/`prisma`/two `$queryRawUnsafe` branches) and replace with:
```typescript
    const results = await searchKbChunks({
        tenantId,
        query,
        knowledgeBaseIds: knowledgeBaseId ? [knowledgeBaseId] : undefined,
    });
```
Add `import { searchKbChunks } from '@/lib/knowledge-base/retrieval';`. Remove the now-unused `getEmbedding` and `getPrismaClient` imports IF nothing else in the file uses them (check — `getEmbedding` and `getPrismaClient` were only used by the removed block). Keep the `ChunkRow`/`results` downstream usage (context build, sources) working — `KbChunkHit` has the same fields as `ChunkRow`, so replace the `ChunkRow` type usage with `KbChunkHit` or keep `ChunkRow` as an alias.

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
cd apps/web-ui && bunx vitest run lib/knowledge-base/retrieval.test.ts
bunx tsc --noEmit 2>&1 | grep -E "knowledge-base/(retrieval|query)" || echo "no new errors in touched files"
```
Expected: PASS; no new type errors in the two touched files.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/knowledge-base/retrieval.ts apps/web-ui/lib/knowledge-base/retrieval.test.ts "apps/web-ui/app/api/knowledge-base/query/route.ts"
git commit -m "feat(kb): extract reusable searchKbChunks primitive (multi-KB) + refactor query route"
```

---

### Task 2: `search_knowledge_base` tool + GraphConfig/assembleTools wiring

**Files:**
- Create: `apps/web-ui/lib/agent/kb-tool.ts`
- Modify: `apps/web-ui/lib/agent/agent-shared.ts` (`GraphConfig`, ~line 494-504)
- Modify: `apps/web-ui/lib/agent/model-factory.ts` (`AssembleToolsOptions` ~134-148; `assembleTools` customTools ~204-217)
- Test: `apps/web-ui/lib/agent/kb-tool.test.ts`

**Interfaces:**
- Consumes: `searchKbChunks` (Task 1); `KnowledgeBaseService.listKnowledgeBases` for validation.
- Produces:
  ```typescript
  export function createSearchKnowledgeBaseTool(tenantId: string, defaultKbIds?: string[]): StructuredTool;
  ```
  Tool name `search_knowledge_base`, schema `{ query: string; knowledgeBaseIds?: string[] }`. Returns a formatted string of ranked chunks (document name + text + score + KB id) or a clear "no relevant documents" message. Never throws.
  - `GraphConfig` gains `knowledgeBaseIds?: string[] | null`.
  - `AssembleToolsOptions` gains `knowledgeBaseIds?: string[] | null` (tenantId already present); `assembleTools` adds the KB tool when `tenantId` is set.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/kb-tool.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/knowledge-base/retrieval', () => ({ searchKbChunks: vi.fn() }));

import { searchKbChunks } from '@/lib/knowledge-base/retrieval';
import { createSearchKnowledgeBaseTool } from './kb-tool';

describe('createSearchKnowledgeBaseTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('searches with the tool-call ids when provided', async () => {
        vi.mocked(searchKbChunks).mockResolvedValue([
            { vectorKey: 'k', documentName: 'Runbook', sourceType: 'document', chunkIndex: 0, totalChunks: 1, knowledgeBaseId: 'kb1', dataSourceId: 'ds', textContent: 'restart the service', score: 0.88 },
        ]);
        const tool = createSearchKnowledgeBaseTool('t1', ['default-kb']);
        const out = await tool.invoke({ query: 'how to restart', knowledgeBaseIds: ['kb1'] });
        expect(searchKbChunks).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', query: 'how to restart', knowledgeBaseIds: ['kb1'] }));
        expect(out).toContain('Runbook');
        expect(out).toContain('restart the service');
    });

    it('falls back to the factory default kb ids when the call omits them', async () => {
        vi.mocked(searchKbChunks).mockResolvedValue([]);
        const tool = createSearchKnowledgeBaseTool('t1', ['default-kb']);
        await tool.invoke({ query: 'q' });
        expect(searchKbChunks).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseIds: ['default-kb'] }));
    });

    it('returns a no-results message, never throws, when search fails', async () => {
        vi.mocked(searchKbChunks).mockRejectedValue(new Error('db down'));
        const tool = createSearchKnowledgeBaseTool('t1');
        const out = await tool.invoke({ query: 'q' });
        expect(typeof out).toBe('string');
        expect(out.toLowerCase()).toContain('no');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/kb-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `kb-tool.ts`**

```typescript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { searchKbChunks } from '@/lib/knowledge-base/retrieval';

/**
 * Autonomous knowledge-base retrieval tool. The agent decides when to call it.
 * Scoping precedence: explicit knowledgeBaseIds arg → factory defaultKbIds →
 * tenant-wide (all KBs). tenantId is captured in the closure, never client-supplied.
 * Never throws — a retrieval failure returns a plain "no results" string so the
 * agent turn continues.
 */
export function createSearchKnowledgeBaseTool(tenantId: string, defaultKbIds?: string[]) {
    return tool(
        async ({ query, knowledgeBaseIds }: { query: string; knowledgeBaseIds?: string[] }) => {
            try {
                const ids = knowledgeBaseIds && knowledgeBaseIds.length > 0
                    ? knowledgeBaseIds
                    : (defaultKbIds && defaultKbIds.length > 0 ? defaultKbIds : undefined);
                const hits = await searchKbChunks({ tenantId, query, knowledgeBaseIds: ids, limit: 8 });
                if (hits.length === 0) {
                    return 'No relevant documents found in the knowledge base for that query.';
                }
                return hits
                    .map((h, i) => `[${i + 1}] ${h.documentName} (kb:${h.knowledgeBaseId}, score:${h.score.toFixed(2)})\n${h.textContent}`)
                    .join('\n\n');
            } catch (err) {
                console.warn(`[search_knowledge_base] failed (non-fatal): ${err instanceof Error ? err.message : err}`);
                return 'No relevant documents found (knowledge base search is temporarily unavailable).';
            }
        },
        {
            name: 'search_knowledge_base',
            description:
                'Search the organization\'s knowledge bases (uploaded docs, wikis, runbooks, synced repos) for information relevant to the user request. Call this whenever the question may be answered by internal/organizational documentation rather than live AWS state or general knowledge. Optionally pass knowledgeBaseIds to restrict the search; omit to search all available knowledge bases.',
            schema: z.object({
                query: z.string().describe('A focused natural-language search query describing what information you need.'),
                knowledgeBaseIds: z.array(z.string()).optional().describe('Optional list of knowledge base ids to restrict the search to. Omit to search across all of the tenant\'s knowledge bases.'),
            }),
        },
    );
}
```

- [ ] **Step 4: Add `knowledgeBaseIds` to `GraphConfig`**

In `apps/web-ui/lib/agent/agent-shared.ts`, in the `GraphConfig` interface (~line 494), add:
```typescript
    knowledgeBaseIds?: string[] | null;
```

- [ ] **Step 5: Wire into `assembleTools`**

In `apps/web-ui/lib/agent/model-factory.ts`:
- Add to `AssembleToolsOptions` (~134-148): `knowledgeBaseIds?: string[] | null;` (it already has `tenantId`).
- Import: `import { createSearchKnowledgeBaseTool } from './kb-tool';`
- In `assembleTools`, in the `customTools` assembly (~204-217), after the memory tools are added and when `options.tenantId` is present, push the KB tool:
```typescript
        if (options.tenantId) {
            customTools.push(
                createSearchKnowledgeBaseTool(options.tenantId, options.knowledgeBaseIds ?? undefined),
            );
        }
```
(Place it consistent with how `createMemoryTools(tenantId, userId)` is conditionally added — match that guard style. If memory tools are already guarded by `if (options.tenantId)`, add the KB tool inside the same block.)

- [ ] **Step 6: Run test + typecheck**

Run:
```bash
cd apps/web-ui && bunx vitest run lib/agent/kb-tool.test.ts
bunx tsc --noEmit 2>&1 | grep -E "agent/(kb-tool|model-factory|agent-shared)" || echo "no new errors in touched files"
```
Expected: PASS; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent/kb-tool.ts apps/web-ui/lib/agent/kb-tool.test.ts apps/web-ui/lib/agent/agent-shared.ts apps/web-ui/lib/agent/model-factory.ts
git commit -m "feat(agent): autonomous search_knowledge_base tool + assembleTools/GraphConfig wiring"
```

---

### Task 3: `autoSelectKb` (auto-KB-selection, clone of auto-skill-select)

**Files:**
- Create: `apps/web-ui/lib/agent/auto-kb-select.ts`
- Test: `apps/web-ui/lib/agent/auto-kb-select.test.ts`

**Interfaces:**
- Consumes: `KnowledgeBaseService.listKnowledgeBases(tenantId)`; `createAgentModels(model).reflector`; `ResolvedModelConfig`.
- Produces:
  ```typescript
  export function autoKbSelectionEnabled(): boolean; // AUTO_KB_SELECTION_ENABLED, default on
  export async function autoSelectKb(params: {
      tenantId: string; message: string; model: ResolvedModelConfig;
  }): Promise<{ kbIds: string[]; reasoning: string }>;  // [] when none relevant; never throws
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/auto-kb-select.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: { listKnowledgeBases: vi.fn() },
}));
vi.mock('./model-factory', () => ({ createAgentModels: vi.fn() }));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { createAgentModels } from './model-factory';
import { autoSelectKb } from './auto-kb-select';

const model = { provider: 'x', modelId: 'm' } as any;
function mockReflector(content: string) {
    vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke: vi.fn().mockResolvedValue({ content }) } } as any);
}

describe('autoSelectKb', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks' },
            { id: 'kb-hr', name: 'HR', description: 'people policies' },
        ] as any);
    });

    it('returns the KB ids the reflector selected (validated against the catalog)', async () => {
        mockReflector('{"kbIds":["kb-runbooks"],"reasoning":"ops question"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'how do I restart the pipeline', model });
        expect(r.kbIds).toEqual(['kb-runbooks']);
    });

    it('drops hallucinated ids not in the catalog', async () => {
        mockReflector('{"kbIds":["kb-runbooks","kb-ghost"],"reasoning":"x"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(r.kbIds).toEqual(['kb-runbooks']);
    });

    it('returns [] when the reflector picks none', async () => {
        mockReflector('{"kbIds":[],"reasoning":"general question"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'what is 2+2', model });
        expect(r.kbIds).toEqual([]);
    });

    it('returns [] (never throws) when there are no KBs', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([]);
        const r = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(r.kbIds).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/auto-kb-select.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auto-kb-select.ts`**

```typescript
/**
 * auto-kb-select.ts — progressive disclosure for knowledge bases, mirroring
 * auto-skill-select.ts. When the user picked no KB, one cheap reflector call
 * matches the message against the tenant's KB catalog and returns the relevant
 * KB ids (zero, one, or many). Manual selection always wins; never throws.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { ResolvedModelConfig } from './agent-shared';
import { createAgentModels } from './model-factory';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';

export function autoKbSelectionEnabled(): boolean {
    const v = process.env.AUTO_KB_SELECTION_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export async function autoSelectKb(params: {
    tenantId: string;
    message: string;
    model: ResolvedModelConfig;
}): Promise<{ kbIds: string[]; reasoning: string }> {
    const empty = { kbIds: [] as string[], reasoning: '' };
    if (!autoKbSelectionEnabled()) return empty;
    try {
        const kbs = await KnowledgeBaseService.listKnowledgeBases(params.tenantId);
        const active = kbs.filter((k) => (k.vectorCount ?? 0) > 0);
        if (active.length === 0) return empty;

        const catalog = active.map((k) => `- ${k.id}: ${k.name}${k.description ? ` — ${k.description}` : ''}`).join('\n');
        const validIds = new Set(active.map((k) => k.id));

        const { reflector } = createAgentModels(params.model);
        const sys = new SystemMessage(
            `You select which knowledge bases (if any) are relevant to a user request.\n\n` +
            `Available knowledge bases:\n${catalog}\n\n` +
            `Return ONLY a JSON object: {"kbIds": ["<id>", ...], "reasoning": "<one short line>"}\n` +
            `Rules: include a KB id ONLY when its description clearly matches the request. Pick multiple if several are relevant. Return an empty array when none clearly apply.`,
        );
        const resp = await reflector.invoke([sys, new HumanMessage(params.message.slice(0, 4000))]);
        const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) return empty;
        const parsed = JSON.parse(match[0]) as { kbIds?: unknown; reasoning?: string };
        const ids = Array.isArray(parsed.kbIds)
            ? parsed.kbIds.filter((id): id is string => typeof id === 'string' && validIds.has(id))
            : [];
        if (ids.length > 0) {
            console.log(`🎯 [KB AUTO-SELECT] Matched [${ids.join(', ')}] — ${parsed.reasoning ?? '(no reasoning)'}`);
        }
        return { kbIds: ids, reasoning: parsed.reasoning ?? '' };
    } catch (err: any) {
        console.warn(`🎯 [KB AUTO-SELECT] Failed (non-fatal): ${err?.message ?? err}`);
        return empty;
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/auto-kb-select.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/auto-kb-select.ts apps/web-ui/lib/agent/auto-kb-select.test.ts
git commit -m "feat(agent): auto-KB-selection (reflector-based, multi-KB) mirroring auto-skill-select"
```

---

### Task 4: AIOps chat route — resolve KBs + thread into graphs

**Files:**
- Modify: `apps/web-ui/app/api/chat/route.ts` (destructure `knowledgeBaseIds`; run `autoSelectKb` when none; thread into `graphConfig`)
- Modify: `apps/web-ui/lib/agent/fast-agent.ts` (pass `knowledgeBaseIds` to `assembleTools`)
- Modify: `apps/web-ui/lib/agent/planning-agent.ts` (pass `knowledgeBaseIds` to `assembleTools`)
- Test: `apps/web-ui/app/api/chat/chat-kb.test.ts` (focused: KB resolution threading)

**Interfaces:**
- Consumes: `autoSelectKb`, `GraphConfig.knowledgeBaseIds`, `assembleTools({ knowledgeBaseIds })`.
- Produces: `graphConfig.knowledgeBaseIds` = the console-selected ids, or (when empty) the auto-selected ids; both graph builders pass it to `assembleTools`.

- [ ] **Step 1: Read the current chat route** to locate the body destructure (~40-52), the model resolution + `autoSelectSkill` block (~142-150), and the `graphConfig` build (~153-163). Mirror the skill pattern exactly.

- [ ] **Step 2: Write the failing test**

Create `apps/web-ui/app/api/chat/chat-kb.test.ts`. Because the full chat route is heavy to drive, this test targets the resolution helper — so FIRST extract the resolution into a tiny exported pure-ish function in the route module OR test via a thin helper. Given the route's weight, extract a helper `resolveKnowledgeBaseIds` into `apps/web-ui/lib/agent/auto-kb-select.ts` (co-located) and test THAT:

Add to `auto-kb-select.ts`:
```typescript
/** Manual selection wins; otherwise auto-select. Returns the effective KB ids. */
export async function resolveKnowledgeBaseIds(params: {
    tenantId: string; selectedIds?: string[] | null; message: string; model: ResolvedModelConfig;
}): Promise<string[]> {
    if (params.selectedIds && params.selectedIds.length > 0) return params.selectedIds;
    const { kbIds } = await autoSelectKb({ tenantId: params.tenantId, message: params.message, model: params.model });
    return kbIds;
}
```
Test (append to `auto-kb-select.test.ts`):
```typescript
import { resolveKnowledgeBaseIds } from './auto-kb-select';
describe('resolveKnowledgeBaseIds', () => {
    beforeEach(() => { vi.clearAllMocks(); vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([{ id: 'kb-runbooks', name: 'R', description: 'ops', vectorCount: 5 }] as any); });
    it('returns the manual selection without calling the reflector', async () => {
        const spy = vi.mocked(createAgentModels);
        const ids = await resolveKnowledgeBaseIds({ tenantId: 't1', selectedIds: ['kb-x'], message: 'q', model });
        expect(ids).toEqual(['kb-x']);
        expect(spy).not.toHaveBeenCalled();
    });
    it('auto-selects when no manual selection', async () => {
        mockReflector('{"kbIds":["kb-runbooks"],"reasoning":"x"}');
        const ids = await resolveKnowledgeBaseIds({ tenantId: 't1', selectedIds: null, message: 'restart pipeline', model });
        expect(ids).toEqual(['kb-runbooks']);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/auto-kb-select.test.ts`
Expected: FAIL — `resolveKnowledgeBaseIds` not exported.

- [ ] **Step 4: Implement `resolveKnowledgeBaseIds`** (as above in `auto-kb-select.ts`). Run the test → PASS.

- [ ] **Step 5: Wire the chat route**

In `apps/web-ui/app/api/chat/route.ts`:
- Add `knowledgeBaseIds` to the body destructure (near `selectedSkill`, `mcpServerIds`): `knowledgeBaseIds?: string[]`.
- Import `resolveKnowledgeBaseIds` from `@/lib/agent/auto-kb-select`.
- After model resolution and near the `autoSelectSkill` block (~142-150), add (guard `mode !== 'deep'` to match skill handling):
```typescript
    let effectiveKbIds: string[] = Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds : [];
    if (effectiveKbIds.length === 0 && mode !== 'deep') {
        const lastMsg = messages[messages.length - 1];
        const lastUserText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content ?? '');
        effectiveKbIds = await resolveKnowledgeBaseIds({ tenantId: resolvedTenantId, selectedIds: null, message: lastUserText, model: resolvedModel });
    }
```
- In the `graphConfig` object (~153-163) add: `knowledgeBaseIds: effectiveKbIds,`.

- [ ] **Step 6: Pass `knowledgeBaseIds` to `assembleTools` in both graph builders**

In `apps/web-ui/lib/agent/fast-agent.ts` at the `assembleTools({...})` call (~line 68) add `knowledgeBaseIds: config.knowledgeBaseIds,` to the options object. Do the same in `apps/web-ui/lib/agent/planning-agent.ts` at its `assembleTools` call. (Both builders receive the `GraphConfig` — reference the same field name used for `tenantId`.)

- [ ] **Step 7: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "api/chat/route|agent/(fast-agent|planning-agent|auto-kb-select)" || echo "no new errors in touched files"`
Expected: no new errors. Run `bunx vitest run lib/agent/auto-kb-select.test.ts` → all PASS.

- [ ] **Step 8: Commit**

```bash
git add "apps/web-ui/app/api/chat/route.ts" apps/web-ui/lib/agent/fast-agent.ts apps/web-ui/lib/agent/planning-agent.ts apps/web-ui/lib/agent/auto-kb-select.ts apps/web-ui/lib/agent/auto-kb-select.test.ts
git commit -m "feat(agent): resolve + thread knowledgeBaseIds through AIOps chat into the tool"
```

---

### Task 5: Agent Ops executor — KB config plumbing + evaluator selection

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/executor-graphs.ts` (pass `knowledgeBaseIds` to `assembleTools` ~74; extend `evaluatorNode` `RequestEvaluation` + prompt ~123-193; add a `kbSection` in `getDynamicContext` ~95-118 — optional)
- Modify: `apps/web-ui/lib/agent-ops/agent-ops-service.ts` (`createRun` params + `AgentOpsRun` type: add `knowledgeBaseIds?: string[]`)
- Modify: `apps/web-ui/lib/agent-ops/agent-executor.ts` (thread `knowledgeBaseIds` into `graphConfig` in `executeAgentRun` ~101-110 and `resumeApprovedRun` ~528-537)
- Test: `apps/web-ui/lib/agent-ops/executor-kb.test.ts` (evaluator schema includes kbIds OR graphConfig threading)

**Interfaces:**
- Consumes: `GraphConfig.knowledgeBaseIds` (Task 2), `assembleTools({ knowledgeBaseIds })`, `autoSelectKb`/catalog for the evaluator.
- Produces: an Agent Ops run carries `knowledgeBaseIds` end-to-end; the executor binds the KB tool; the evaluator can select KB ids from the catalog when the run specifies none.

- [ ] **Step 1: Read the current files** to confirm exact shapes: `AgentOpsRun` type + `createRun` param bag (`agent-ops-service.ts:28-40`), `executeAgentRun` graphConfig (`agent-executor.ts:101-110`), `resumeApprovedRun` (`:528-537`), and the `evaluatorNode` JSON schema + prompt + `getDynamicContext` (`executor-graphs.ts`).

- [ ] **Step 2: Write the failing test**

Create `apps/web-ui/lib/agent-ops/executor-kb.test.ts`. The reliable, low-setup assertion is that `assembleTools` receives `knowledgeBaseIds` from the graph config. Mock `assembleTools` and assert the executor graph builder forwards `config.knowledgeBaseIds`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/agent/model-factory', async (orig) => {
    const actual = await (orig as any)();
    return { ...actual, assembleTools: vi.fn().mockResolvedValue([]) };
});
import { assembleTools } from '@/lib/agent/model-factory';
import { createDynamicExecutorGraph } from './executor-graphs';

describe('Agent Ops executor — KB tool wiring', () => {
    beforeEach(() => vi.clearAllMocks());
    it('forwards knowledgeBaseIds from config to assembleTools', async () => {
        await createDynamicExecutorGraph({ model: { provider: 'x', modelId: 'm' }, tenantId: 't1', knowledgeBaseIds: ['kb1'] } as any);
        expect(assembleTools).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseIds: ['kb1'], tenantId: 't1' }));
    });
});
```
(If `createDynamicExecutorGraph` needs more of the config to not throw before `assembleTools`, add the minimal fields the read in Step 1 reveals are required.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/executor-kb.test.ts`
Expected: FAIL — `assembleTools` called without `knowledgeBaseIds`.

- [ ] **Step 4: Implement the plumbing**
- `executor-graphs.ts`: at the `assembleTools(...)` call (~74) add `knowledgeBaseIds: config.knowledgeBaseIds,`.
- `agent-ops-service.ts`: add `knowledgeBaseIds?: string[]` to the `AgentOpsRun` type and the `createRun` param bag; persist/pass it through (match how `selectedSkill`/`mcpServerIds` are handled — if those are stored on the run record, store this the same way; if the schema has no column, thread it in-memory only like other transient config — follow the existing pattern for `mcpServerIds`).
- `agent-executor.ts`: in `executeAgentRun`'s `graphConfig` (~101-110) and `resumeApprovedRun` (~528-537) add `knowledgeBaseIds: run.knowledgeBaseIds,`.

- [ ] **Step 5: Evaluator KB selection (autonomy on the Agent Ops side)**
In `executor-graphs.ts` `evaluatorNode` (~123-193): add `knowledgeBaseIds: string[]` to the `RequestEvaluation` structured output, list the tenant KB catalog in the evaluator prompt (mirror how skills are listed ~133-134 — build the catalog from `KnowledgeBaseService.listKnowledgeBases(config.tenantId)` filtered to `vectorCount > 0`), and when the run supplied no `knowledgeBaseIds`, apply the evaluator's choice by setting it into the config/state used for tool assembly. If wiring the evaluator result back into the already-built tool binding is non-trivial (tools are bound at graph construction), scope this step to: (a) still bind the KB tool (so the agent can call it tenant-wide regardless), and (b) inject the evaluator-selected KB ids into the prompt context (`getDynamicContext` `kbSection`) so the agent passes them to the tool. Document whichever path you take in the report.

- [ ] **Step 6: Run test + typecheck**

Run:
```bash
cd apps/web-ui && bunx vitest run lib/agent-ops/executor-kb.test.ts
bunx tsc --noEmit 2>&1 | grep -E "agent-ops/(executor-graphs|agent-ops-service|agent-executor)" || echo "no new errors in touched files"
```
Expected: PASS; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent-ops
git commit -m "feat(agent-ops): thread knowledgeBaseIds through runs + bind KB tool + evaluator KB selection"
```

---

### Task 6: AIOps console — KB multi-select UI

**Files:**
- Modify: `apps/web-ui/components/agent/chat-interface.tsx` (add KB multi-select state + UI; add `knowledgeBaseIds` to the `useChat` body ~617-632)
- Reuse: `useKnowledgeBases()` from `apps/web-ui/lib/queries/knowledge-base.ts` (already exists) to populate the selector

**Interfaces:**
- Consumes: `useKnowledgeBases()` (returns `KnowledgeBase[]`), the chat body channel.
- Produces: `knowledgeBaseIds: string[]` sent in the `useChat` body (empty array/omit → server auto-selects).

- [ ] **Step 1: Read** the skill selector UI (`chat-interface.tsx` ~1644-1689) and the `useChat` body object (~617-632) and the `selectedSkill` state (~504) to mirror the pattern.

- [ ] **Step 2: Add KB selection state + fetch**
```tsx
const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
const { data: knowledgeBases = [] } = useKnowledgeBases();
```
Import `useKnowledgeBases` from `@/lib/queries/knowledge-base`.

- [ ] **Step 3: Add to the `useChat` body**
In the body object (~617-632), add: `knowledgeBaseIds: selectedKbIds.length > 0 ? selectedKbIds : undefined,`.

- [ ] **Step 4: Add the selector UI**
Next to the skill `<Select>` (~1644-1689), add a KB multi-select. Simplest consistent approach: a popover/dropdown of checkboxes built from `knowledgeBases` (each `{ id, name }`), toggling membership in `selectedKbIds`. Reuse existing shadcn primitives (`Popover` + `Checkbox`, or a `DropdownMenu` with checkbox items — whichever the codebase already uses elsewhere; match `chat-interface.tsx`'s existing controls). Show a label like "Knowledge: All (auto)" when `selectedKbIds` is empty, else "Knowledge: N selected". Keep it visually consistent with the skill selector.

- [ ] **Step 5: Verify build + lint**

Run:
```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "components/agent/chat-interface" || echo "no new errors in chat-interface"
bun run lint 2>&1 | grep -E "chat-interface" || echo "no new lint findings in chat-interface"
```
Expected: no NEW errors/findings attributable to the change (the file may have pre-existing ones; report only new).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/components/agent/chat-interface.tsx
git commit -m "feat(agent-ui): KB multi-select in AIOps console (empty = auto-select)"
```

---

## Plan self-review

- **Goal coverage:** autonomous KB use = the bound tool (Task 2) the agent calls at will; multi-KB = `knowledgeBaseIds: string[]` in the primitive/tool/config (Tasks 1,2); "no KB selected → check relevant KBs" = `autoSelectKb` + tool tenant-wide fallback (Tasks 3,4); AIOps console = UI selector + chat threading (Tasks 4,6); Agent Ops = executor plumbing + evaluator selection (Task 5). ✓
- **DRY:** the vector SQL exists only in `searchKbChunks` after Task 1; the query route and the tool both call it. ✓
- **Type consistency:** `knowledgeBaseIds?: string[] | null` on `GraphConfig` + `AssembleToolsOptions`; `searchKbChunks({ knowledgeBaseIds?: string[] })`; tool schema `knowledgeBaseIds?: string[]`; `autoSelectKb` returns `{ kbIds: string[] }`; `resolveKnowledgeBaseIds` returns `string[]`. Consistent. ✓
- **Safety:** tenantId always from server/graph, never client; auto-select + tool never throw; KB ids validated against the tenant catalog in auto-select. ✓
- **Deferred/uncertain:** Task 5 Step 5 (feeding evaluator-chosen KB ids back into an already-bound tool) has a documented fallback (bind tenant-wide + inject ids into prompt context) since tools bind at graph-construction time — the implementer picks and reports the path.
