# AI Ops Multi-Turn / Resume Crash Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop turn-2 (and resume-and-continue) from crashing Bedrock with "content field is empty" by rewriting reasoning-only AI messages that become empty after reasoning-block stripping into a non-empty placeholder, inside `sanitizeMessagesForBedrock()`.

**Architecture:** On any turn after the first, the backend replays the LangGraph Postgres checkpoint through `sanitizeMessagesForBedrock()` before invoking Bedrock. A turn-1 reasoning-only AI message survives windowing, then `stripReasoningBlocks()` empties its content and it is sent to Bedrock as empty → ValidationException. The fix adds one predicate + in-place content replacement in that single function; message count and role order are preserved so Bedrock's strict Human/AI alternation cannot regress.

**Tech Stack:** TypeScript, LangChain `@langchain/core/messages` (`AIMessage`, `HumanMessage`, `ToolMessage`), Vitest (web-ui), Bun.

## Global Constraints

- Language/style: web-ui files use 4-space indentation in `lib/` service/agent files. Match the existing style in `agent-shared.ts`.
- No comments unless the "why" is non-obvious (repo + user convention). A short "why" comment on the new predicate IS warranted (it prevents a Bedrock crash) — keep it to a couple of lines, no multi-line docblock beyond the existing helper style.
- Surgical change: touch only `sanitizeMessagesForBedrock()` and its new local helper in `apps/web-ui/lib/agent/agent-shared.ts`, plus the test file. No refactoring of adjacent code.
- Placeholder text is exactly `"(reasoning omitted)"`.
- Tests run from `apps/web-ui` with `bun run test` (Vitest `vitest run`, not watch). A single test file runs with `bunx vitest run <path>`.
- Do NOT commit unless the human explicitly asks (user global rule). Steps below include a commit step; execute the `git commit` only on explicit user go-ahead — otherwise stop at `git add` / leave staging to the user.

---

### Task 1: Rewrite empty-after-strip AI messages to a placeholder in `sanitizeMessagesForBedrock`

**Files:**
- Modify: `apps/web-ui/lib/agent/agent-shared.ts` (add a local helper `isEmptyAiMessageContent` near `stripReasoningBlocks` around line 676; edit the push site at lines 711-714)
- Test: `apps/web-ui/lib/agent/sanitize-bedrock.test.ts`

**Interfaces:**
- Consumes: existing `stripReasoningBlocks(msg: BaseMessage): BaseMessage`, `sanitizeMessagesForBedrock(messages: BaseMessage[]): BaseMessage[]`, and `isReasoningBlock` (all already in `agent-shared.ts`). LangChain `AIMessage`, `HumanMessage`, `ToolMessage`, `BaseMessage`.
- Produces: no new exported symbols. `sanitizeMessagesForBedrock` keeps its signature; its behavior changes so that an AI message whose content is empty after stripping and which has no tool calls is emitted with content `"(reasoning omitted)"` instead of empty content. A new module-private helper `isEmptyAiMessageContent(ai: AIMessage): boolean` is added (not exported).

---

- [ ] **Step 1: Write the failing tests**

Append these three tests to `apps/web-ui/lib/agent/sanitize-bedrock.test.ts` inside the existing `describe('sanitizeMessagesForBedrock — reasoning content', ...)` block (or a new adjacent `describe`). The imports `AIMessage, HumanMessage, ToolMessage` already exist at the top of the file.

```ts
    it('rewrites a reasoning-only AI message (empty after strip, no tool_calls) to a non-empty placeholder', () => {
        const reasoningOnly = new AIMessage({
            content: [
                { reasoningContent: { reasoningText: { text: null, signature: 'sig' } } } as any,
            ],
        });
        const out = sanitizeMessagesForBedrock([
            new HumanMessage('first question'),
            reasoningOnly,
            new HumanMessage('Proceed.'),
        ]);

        // No AI message may leave sanitize with empty content.
        const emptyAi = out.find((m) => {
            if (m._getType() !== 'ai') return false;
            const c = m.content;
            if (typeof c === 'string') return c.trim() === '';
            return Array.isArray(c) && c.length === 0;
        });
        expect(emptyAi).toBeUndefined();

        // The rewritten message is present, in place, with the placeholder text.
        expect(out).toHaveLength(3);
        expect(out[1]._getType()).toBe('ai');
        expect(out[1].content).toBe('(reasoning omitted)');
    });

    it('preserves message count and role order (no consecutive same-role pair)', () => {
        const input = [
            new HumanMessage('q1'),
            new AIMessage({ content: [{ reasoningContent: { reasoningText: { text: null } } } as any] }),
            new HumanMessage('Proceed.'),
            new AIMessage({ content: 'the real answer' }),
            new HumanMessage('q2'),
        ];
        const out = sanitizeMessagesForBedrock(input);

        expect(out.map((m) => m._getType())).toEqual(['human', 'ai', 'human', 'ai', 'human']);
        for (let i = 1; i < out.length; i++) {
            expect(out[i]._getType()).not.toBe(out[i - 1]._getType());
        }
    });

    it('does NOT rewrite an AI message that is empty-after-strip but has tool_calls', () => {
        const toolTurn = new AIMessage({
            content: [
                { reasoningContent: { reasoningText: { text: null } } } as any,
                { type: 'tool_use', id: 't1', name: 'do_it', input: {} } as any,
            ],
            tool_calls: [{ id: 't1', name: 'do_it', args: {}, type: 'tool_call' }],
        });
        const out = sanitizeMessagesForBedrock([
            toolTurn,
            new ToolMessage({ content: 'ok', tool_call_id: 't1' }),
        ]);

        const ai = out[0] as AIMessage;
        expect(ai._getType()).toBe('ai');
        expect(ai.content).not.toBe('(reasoning omitted)');           // untouched, not rewritten
        expect(Array.isArray(ai.content)).toBe(true);
        expect((ai.content as any[]).some((b) => b.type === 'tool_use')).toBe(true);
        expect(ai.tool_calls?.[0]?.id).toBe('t1');
        // tool result still re-emitted immediately after its owning AI message
        expect(out[1]._getType()).toBe('tool');
        expect((out[1] as any).tool_call_id).toBe('t1');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/sanitize-bedrock.test.ts`

Expected: the first two new tests FAIL. The first fails because today the reasoning-only message is pushed with `content: []` (so `out[1].content` is `[]`, not `'(reasoning omitted)'`, and `emptyAi` is found). The third test (tool_calls guard) may already PASS — that is fine; it is a regression guard, not a red test.

- [ ] **Step 3: Add the `isEmptyAiMessageContent` helper**

In `apps/web-ui/lib/agent/agent-shared.ts`, immediately AFTER the `stripReasoningBlocks` function (it ends at line 675 with its closing `}`), add:

```ts
/**
 * True when an AI message carries no Bedrock-acceptable content AND no tool calls
 * — i.e. an empty/whitespace string, or an array with no tool_use block and no
 * non-empty text block. After stripReasoningBlocks() empties a reasoning-only
 * message, sending it to Bedrock raises "content field ... is empty"; we rewrite
 * such a message to a placeholder (never drop it, so role alternation is kept).
 */
function isEmptyAiMessageContent(ai: AIMessage): boolean {
    if (Array.isArray(ai.tool_calls) && ai.tool_calls.length > 0) return false;

    const content = ai.content;
    if (content == null) return true;
    if (typeof content === 'string') return content.trim() === '';
    if (!Array.isArray(content)) return false; // unknown non-array content — treat as present
    if (content.length === 0) return true;

    // Non-empty array: empty only if EVERY block is an empty/whitespace text block.
    return (content as unknown[]).every((block) => {
        if (block && typeof block === 'object' && (block as any).type === 'text') {
            const text = (block as any).text;
            return typeof text !== 'string' || text.trim() === '';
        }
        return false; // tool_use, image, or any other block => real content
    });
}
```

- [ ] **Step 4: Rewrite the push site to substitute the placeholder**

In `sanitizeMessagesForBedrock`, replace the two lines at 711-714 (the comment + `const cleaned = stripReasoningBlocks(msg); result.push(cleaned);`). Current code:

```ts
        // Strip reasoning/thinking blocks from AI messages — they come back with a
        // null reasoningText after a checkpoint round-trip and Bedrock rejects them.
        const cleaned = stripReasoningBlocks(msg);
        result.push(cleaned);
```

Replace with:

```ts
        // Strip reasoning/thinking blocks from AI messages — they come back with a
        // null reasoningText after a checkpoint round-trip and Bedrock rejects them.
        let cleaned = stripReasoningBlocks(msg);

        // A reasoning-only AI message becomes empty after stripping. Sending empty
        // content to Bedrock raises "content field ... is empty" on the next turn.
        // Rewrite (never drop) so message count + Human/AI alternation are preserved.
        if (cleaned._getType() === 'ai' && isEmptyAiMessageContent(cleaned as AIMessage)) {
            const ai = cleaned as AIMessage;
            cleaned = new AIMessage({
                content: '(reasoning omitted)',
                tool_calls: ai.tool_calls,
                additional_kwargs: ai.additional_kwargs,
                response_metadata: ai.response_metadata,
                id: ai.id,
                name: ai.name,
                usage_metadata: ai.usage_metadata,
            });
        }

        result.push(cleaned);
```

Note: the block below this (`if (msg._getType() !== 'ai') continue;` … `pendingIds` …) is unchanged. For a rewritten message `pendingIds` is empty (no tool calls), so it is a no-op — correct.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/sanitize-bedrock.test.ts`

Expected: all tests in the file PASS (the three new ones plus the three pre-existing reasoning tests).

- [ ] **Step 6: Run the full web-ui test suite to confirm no regression**

Run: `cd apps/web-ui && bun run test`

Expected: PASS with no new failures. Pay attention to `tests/agent-ops/agent-shared.test.ts` (the other file that exercises `sanitizeMessagesForBedrock`) — it must remain green.

- [ ] **Step 7: Type-check / lint the changed file**

Run: `cd apps/web-ui && bun run lint`

Expected: no new errors in `lib/agent/agent-shared.ts`.

- [ ] **Step 8: Commit (only if the human has explicitly asked to commit)**

```bash
git add apps/web-ui/lib/agent/agent-shared.ts apps/web-ui/lib/agent/sanitize-bedrock.test.ts docs/superpowers/specs/2026-07-21-aiops-multiturn-crash-fix-design.md docs/superpowers/plans/2026-07-21-aiops-multiturn-crash-fix.md
git commit -m "fix(agent): rewrite empty-after-strip reasoning messages to placeholder

A turn-1 reasoning-only AI message becomes empty after stripReasoningBlocks()
and crashed Bedrock on turn 2 (and on history-session resume) with
\"content field is empty\". Rewrite it in place to a non-empty placeholder inside
sanitizeMessagesForBedrock() so message count and Human/AI alternation are
preserved.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Manual / integration verification (after Task 1)

These are not automated here (they require the running app + Bedrock) but MUST be checked before considering #2/#3 closed:

1. Fresh chat → ask a question that triggers heavy reasoning → ask a **second** question on the same chat. Expected: turn 2 answers, no `ValidationException`.
2. Reopen a **previous** history session (one that previously failed on the second ask) → ask a new question. Expected: it continues with prior context, no crash.
3. Confirm a normal single-query chat still works unchanged.

## Self-Review (completed by plan author)

- **Spec coverage:** Fix (replace-not-drop) → Task 1 Steps 3-4. Predicate → `isEmptyAiMessageContent` (Step 3). Testing items 1-4 → Step 1 tests + pre-existing untouched-reference test; item 5 → Step 6. Alternation-safety rationale → enforced by "replace not drop" and asserted by the Step 1 alternation test. Out-of-scope items (#1 render, Gap A) → intentionally absent.
- **Placeholder scan:** none — every code step shows full code and exact commands.
- **Type consistency:** helper named `isEmptyAiMessageContent` consistently in Steps 3 and 4; placeholder string `"(reasoning omitted)"` identical in spec, helper doc, Step 1, and Step 4.
