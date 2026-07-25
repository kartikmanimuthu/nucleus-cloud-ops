# AI Ops History Reasoning-Block Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a reopened AI Ops history session, render reasoning that was persisted as an array of content blocks the same way the live stream does (empty reasoning → nothing; reasoning-with-text → a "Thought for Ns" block), instead of showing raw `[{"type":"reasoning",...}]` JSON.

**Architecture:** A new pure module `lib/agent-chat/ai-content-parts.ts` reconstructs typed UI parts from an AI message's content-block array (reasoning → `reasoning` part, dropping empty ones; text → `text` part; tool_use skipped). The history route (`app/api/threads/[threadId]/history/route.ts`) calls it first in the AI branch of `convertPlainMessage` and `convertMessage`, falling back to the existing string/marker path when it returns `null`. Read-path only — storage, the write path, and the live stream are untouched, so it fixes existing and future sessions with no migration.

**Tech Stack:** TypeScript, LangChain `@langchain/core/messages` (`AIMessage`), Next.js App Router route handler, Vitest (web-ui), Bun.

## Global Constraints

- Language/style: `app/api/threads/[threadId]/history/route.ts` and `lib/agent-chat/*` use **4-space indentation**. Match it.
- Comments: default to none; a single concise line only where the WHY is non-obvious (user + repo convention). No multi-line comment blocks.
- Surgical: only create `lib/agent-chat/ai-content-parts.ts` + its test, and modify `app/api/threads/[threadId]/history/route.ts`. No refactoring of adjacent code, no change to the write path (`app/api/chat/route.ts`) or storage.
- Do NOT export non-handler functions from `route.ts` (Next.js route files accept only HTTP-method/config exports) — the reusable logic lives in the lib module.
- "Match live exactly": empty-text reasoning renders as nothing; only non-empty reasoning becomes a `reasoning` part. This mirrors the reducer at `lib/agent-chat/events.ts:159-161`.
- The reconstruction is gated to the **AI role only**; the human multimodal path (`extractDisplayText`) and the tool path stay unchanged.
- Tests run from `apps/web-ui`: full suite `bun run test`; a single file `bunx vitest run <path>`.
- Do NOT commit unless the human explicitly asks. The commit step at the end runs only on explicit go-ahead.

---

### Task 1: `reconstructAiContentParts` helper (pure module + tests)

**Files:**
- Create: `apps/web-ui/lib/agent-chat/ai-content-parts.ts`
- Test: `apps/web-ui/lib/agent-chat/__tests__/ai-content-parts.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. Imports `buildTranscript` from `../events` in the test only (to prove render parity).
- Produces: `export function reconstructAiContentParts(rawContent: unknown): Array<{ type: 'reasoning' | 'text'; text: string }> | null`. Returns `null` when `rawContent` is not a content-block array (caller keeps its existing string path); returns a parts array (possibly empty) when it is. Task 2 consumes this.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/lib/agent-chat/__tests__/ai-content-parts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconstructAiContentParts } from '../ai-content-parts';
import { buildTranscript } from '../events';

const noOpts = {
    isStreaming: false,
    toolVisibility: new Map<string, string>(),
    decisions: new Map<string, { approved: boolean; answer?: string }>(),
};

describe('reconstructAiContentParts', () => {
    it('returns null for a plain (non-array) string so the caller keeps the marker path', () => {
        expect(reconstructAiContentParts('PLANNING_PHASE_START\nplan text')).toBeNull();
        expect(reconstructAiContentParts('just an answer')).toBeNull();
    });

    it('returns [] for an array of only empty-text reasoning blocks', () => {
        const raw = JSON.stringify([{ type: 'reasoning', reasoning: '', signature: 'sig' }]);
        expect(reconstructAiContentParts(raw)).toEqual([]);
    });

    it('reconstructs a reasoning block that has text into a single reasoning part', () => {
        const raw = JSON.stringify([{ type: 'reasoning', reasoning: 'Let me think about X.' }]);
        expect(reconstructAiContentParts(raw)).toEqual([{ type: 'reasoning', text: 'Let me think about X.' }]);
    });

    it('reconstructs a mixed [reasoning, text] array preserving order', () => {
        const raw = JSON.stringify([
            { type: 'thinking', thinking: 'thinking hard' },
            { type: 'text', text: 'the answer' },
        ]);
        expect(reconstructAiContentParts(raw)).toEqual([
            { type: 'reasoning', text: 'thinking hard' },
            { type: 'text', text: 'the answer' },
        ]);
    });

    it('extracts the raw Bedrock reasoningContent shape', () => {
        const raw = JSON.stringify([{ reasoningContent: { reasoningText: { text: 'deep thought' } } }]);
        expect(reconstructAiContentParts(raw)).toEqual([{ type: 'reasoning', text: 'deep thought' }]);
    });

    it('drops a reasoningContent block whose text is null', () => {
        const raw = JSON.stringify([{ reasoningContent: { reasoningText: { text: null } } }]);
        expect(reconstructAiContentParts(raw)).toEqual([]);
    });

    it('skips tool_use blocks (tool calls come from metadata)', () => {
        const raw = JSON.stringify([
            { type: 'reasoning', reasoning: '' },
            { type: 'tool_use', id: 't1', name: 'do_it', input: {} },
        ]);
        expect(reconstructAiContentParts(raw)).toEqual([]);
    });

    it('skips empty/whitespace text blocks', () => {
        const raw = JSON.stringify([{ type: 'text', text: '   ' }, { type: 'text', text: 'real' }]);
        expect(reconstructAiContentParts(raw)).toEqual([{ type: 'text', text: 'real' }]);
    });

    it('accepts an already-parsed array (checkpoint-fallback path)', () => {
        expect(reconstructAiContentParts([{ type: 'text', text: 'hi' }])).toEqual([{ type: 'text', text: 'hi' }]);
    });
});

describe('render parity with live (via buildTranscript)', () => {
    it('a reasoning part with text yields a thinking event, like live', () => {
        const parts = reconstructAiContentParts(JSON.stringify([{ type: 'reasoning', reasoning: 'hmm' }]))!;
        const events = buildTranscript({ id: 'm1', role: 'assistant', parts } as any, noOpts);
        expect(events).toEqual([expect.objectContaining({ kind: 'thinking', text: 'hmm' })]);
    });

    it('the reducer renders nothing for an empty reasoning part (documents live behavior)', () => {
        const events = buildTranscript({ id: 'm1', role: 'assistant', parts: [{ type: 'reasoning', text: '' }] } as any, noOpts);
        expect(events).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent-chat/__tests__/ai-content-parts.test.ts`
Expected: FAIL — `reconstructAiContentParts` cannot be imported (module does not exist yet).

- [ ] **Step 3: Create the helper module**

Create `apps/web-ui/lib/agent-chat/ai-content-parts.ts`:

```ts
// Reconstructs typed UI parts from an AI message whose persisted content is an
// array of content blocks (Anthropic extended-thinking / Bedrock shapes). Without
// this, the history read path renders such arrays as raw JSON.
type AiContentPart = { type: 'reasoning' | 'text'; text: string };

function normalizeToBlockArray(raw: unknown): unknown[] | null {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        if (!raw.trimStart().startsWith('[')) return null;
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

function isReasoningBlock(b: Record<string, unknown>): boolean {
    if ('reasoningContent' in b || 'reasoning_content' in b) return true;
    const t = b.type;
    return t === 'reasoning' || t === 'thinking' || t === 'reasoning_content'
        || t === 'redacted_reasoning' || t === 'redacted_thinking';
}

function extractReasoningText(b: Record<string, unknown>): string {
    if (typeof b.reasoning === 'string') return b.reasoning;
    if (typeof b.thinking === 'string') return b.thinking;
    const rc = b.reasoningContent as { reasoningText?: { text?: unknown } } | undefined;
    if (rc?.reasoningText && typeof rc.reasoningText.text === 'string') return rc.reasoningText.text;
    return '';
}

// Returns null when rawContent is not a content-block array (caller keeps the
// string/marker path); otherwise the reconstructed parts (possibly empty).
export function reconstructAiContentParts(rawContent: unknown): AiContentPart[] | null {
    const blocks = normalizeToBlockArray(rawContent);
    if (blocks === null) return null;

    const parts: AiContentPart[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
            if (b.text.trim().length > 0) parts.push({ type: 'text', text: b.text });
            continue;
        }
        if (isReasoningBlock(b)) {
            const text = extractReasoningText(b);
            if (text.trim().length > 0) parts.push({ type: 'reasoning', text });
        }
        // tool_use / image / unknown → skipped (tool calls come from metadata.tool_calls)
    }
    return parts;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent-chat/__tests__/ai-content-parts.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Lint the new file**

Run: `cd apps/web-ui && bun run lint`
Expected: no new errors attributable to `lib/agent-chat/ai-content-parts.ts` (the repo has pre-existing lint failures elsewhere; compare against baseline if unsure — the new file should add none).

---

### Task 2: Wire the helper into the history route

**Files:**
- Modify: `apps/web-ui/app/api/threads/[threadId]/history/route.ts` (add import; rewrite the AI branch of `convertPlainMessage` ~lines 115-123 and `convertMessage` ~lines 139-147)

**Interfaces:**
- Consumes: `reconstructAiContentParts` from Task 1 (`@/lib/agent-chat/ai-content-parts`).
- Produces: no new exports. `convertPlainMessage`/`convertMessage` behavior for array-content AI messages changes to emit reconstructed reasoning/text parts; all other inputs are unchanged.

- [ ] **Step 1: Add the import**

In `apps/web-ui/app/api/threads/[threadId]/history/route.ts`, add to the imports (after line 6, the `normalizeLegacyContent` import):

```ts
import { reconstructAiContentParts } from '@/lib/agent-chat/ai-content-parts';
```

- [ ] **Step 2: Rewrite the AI branch of `convertPlainMessage`**

Replace the current AI branch (lines 115-123):

```ts
    if (role === 'ai') {
        const toolCalls = metadata?.tool_calls as Array<{ id?: string; name: string; args: Record<string, unknown> }> | undefined;
        const parts: HistoryMessage['parts'] = content ? [...(buildPhaseParts(content) ?? [])] : [];
        for (const tc of toolCalls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args, state: 'call' });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content, parts };
    }
```

with:

```ts
    if (role === 'ai') {
        const toolCalls = metadata?.tool_calls as Array<{ id?: string; name: string; args: Record<string, unknown> }> | undefined;
        // Content-block arrays (extended-thinking) are reconstructed block-by-block; everything else keeps the marker path.
        const reconstructed = reconstructAiContentParts(msg.content);
        const parts: HistoryMessage['parts'] = reconstructed !== null
            ? [...reconstructed]
            : (content ? [...(buildPhaseParts(content) ?? [])] : []);
        const displayContent = reconstructed !== null
            ? reconstructed.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : content;
        for (const tc of toolCalls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args, state: 'call' });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content: displayContent, parts };
    }
```

(`msg.content` is the raw stored string; `content` at line 109 is the `extractDisplayText`-processed value used only by the fallback path.)

- [ ] **Step 3: Rewrite the AI branch of `convertMessage` (checkpoint fallback)**

Replace the current AI branch (lines 139-147):

```ts
    if (msgType === 'ai') {
        const aiMsg = msg as AIMessage;
        const parts: HistoryMessage['parts'] = content ? [...(buildPhaseParts(content) ?? [])] : [];
        for (const tc of aiMsg.tool_calls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args as Record<string, unknown>, state: 'call' });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content: content || '', parts };
    }
```

with:

```ts
    if (msgType === 'ai') {
        const aiMsg = msg as AIMessage;
        const reconstructed = reconstructAiContentParts(aiMsg.content);
        const parts: HistoryMessage['parts'] = reconstructed !== null
            ? [...reconstructed]
            : (content ? [...(buildPhaseParts(content) ?? [])] : []);
        const displayContent = reconstructed !== null
            ? reconstructed.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : (content || '');
        for (const tc of aiMsg.tool_calls ?? []) {
            parts.push({ type: 'tool-invocation', toolCallId: tc.id ?? `tool-${index}-${tc.name}`, toolName: tc.name, args: tc.args as Record<string, unknown>, state: 'call' });
        }
        if (parts.length === 0) return null;
        return { id: `history-${index}`, role: 'assistant', content: displayContent, parts };
    }
```

(`aiMsg.content` may be an array directly on the checkpoint path; `reconstructAiContentParts` accepts arrays as well as JSON strings.)

- [ ] **Step 4: Type-check the touched route file**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "history/route|ai-content-parts" || echo "no type errors in touched files"`
Expected: `no type errors in touched files` (the repo may have unrelated pre-existing type output; only the two touched files must be clean).

- [ ] **Step 5: Run the full web-ui test suite (regression)**

Run: `cd apps/web-ui && bun run test`
Expected: PASS with no NEW failures versus the known baseline (the same pre-existing failures observed in Phase 1 remain; nothing new). The Task 1 `ai-content-parts.test.ts` is green. Existing `lib/agent-chat/__tests__/*` (events, legacy-normalizer) must stay green — they lock the untouched string/marker path.

- [ ] **Step 6: Lint**

Run: `cd apps/web-ui && bun run lint`
Expected: no new errors attributable to `history/route.ts`.

- [ ] **Step 7: Commit (only if the human has explicitly asked to commit)**

```bash
git add apps/web-ui/lib/agent-chat/ai-content-parts.ts apps/web-ui/lib/agent-chat/__tests__/ai-content-parts.test.ts "apps/web-ui/app/api/threads/[threadId]/history/route.ts" docs/superpowers/specs/2026-07-21-aiops-history-reasoning-render-design.md docs/superpowers/plans/2026-07-21-aiops-history-reasoning-render.md
git commit -m "fix(aiops): render array-content reasoning as thinking blocks in history

History replay stored extended-thinking as JSON.stringify'd content arrays and
rendered them as raw JSON. Reconstruct such arrays on the read path into
reasoning/text parts (dropping empty reasoning, matching the live reducer), so a
reopened session renders reasoning like the live stream. Read-path only; storage
and the write path are unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Manual / integration verification (after Task 2)

1. Reopen a previous session that currently shows a raw `[{"type":"reasoning",...}]` blob → the blob is gone; empty reasoning shows nothing, reasoning-with-text shows a "Thought for Ns" block.
2. Reopen a session with planning/reflection (marker-string) content → unchanged from before.
3. Reopen a session with tool calls → tool cards render once (no duplicates), answers intact.
4. Send a NEW message in a reopened session → still works (Phase 1 behavior unaffected).

## Self-Review (completed by plan author)

- **Spec coverage:** helper + block handling → Task 1 Step 3; empty→dropped and text→reasoning → Task 1 tests + parity tests; wiring in both convert functions, AI-role-only → Task 2 Steps 2-3; `content` string field set from text blocks → Task 2 Steps 2-3; regression for marker/human paths → Task 1 null-return test + Task 2 Step 5 (existing events/legacy-normalizer suites) + manual check 2; no write/storage change → nothing in the plan touches `app/api/chat/route.ts`.
- **Placeholder scan:** none — every code step contains full code and exact commands.
- **Type consistency:** `reconstructAiContentParts` signature identical in Task 1 Produces, the helper source, and both Task 2 call sites; return element type `{ type: 'reasoning' | 'text'; text: string }` is assignable to `HistoryMessage['parts']` elements (`type: string`, `text?: string`).
