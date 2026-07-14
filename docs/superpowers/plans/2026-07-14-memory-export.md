# Memory Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Markdown export (report + portable frontmatter modes, per-memory and export-all) to the agent memory module, mirroring the skills export.

**Architecture:** New `lib/memory-export.ts` with pure builders + thin Blob/zip wrappers (same split as `lib/skill-export.ts`). Shared helpers (`fence`, `anchor`, `downloadBlob`, `downloadText`, `fileSafe`, `yamlScalar`) extracted to `lib/export-utils.ts` and consumed by both export modules. No API or schema change — memory list DTOs already carry the full `value`; export-all paginates the existing `GET /api/agent-memories`.

**Tech Stack:** Next.js 15 App Router, React 19, TanStack Query, Vitest, `jszip` (already a dep, dynamically imported), `sonner` toasts, shadcn `DropdownMenu`.

## Global Constraints

- Run all commands from `apps/web-ui/` unless noted.
- Vitest single-run: `bunx vitest run <file>` (NOT watch).
- TypeScript strict; tsc baseline is **182 errors** (pre-existing, none in changed files) — do not increase it.
- Lint: `bun run lint` — changed source files must introduce zero new errors.
- Memory `kind` is the `MemoryKind` enum in declaration order: `SEMANTIC`, `EPISODIC`, `PROCEDURAL`.
- `MemoryRow.value` is `Record<string, unknown>`; render fields by `kind` (see `lib/agent/memory/types.ts`).
- Embeddings are never in the DTO — nothing to strip.
- RBAC `authorize('read','Memory')` already gates `GET /api/agent-memories`; no new permission.
- Export-all scope = whole tenant, no filters (per brainstorm decision).
- Frontmatter is lean: `kind`, `namespace`, `key`, `category`, `confidence` (omitted when null), `created_at`, `updated_at`. No `tenantId`/`userId`.
- No raw JSON embedded (user chose "Markdown + frontmatter", not sidecar JSON).

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `apps/web-ui/lib/export-utils.ts` | Shared export helpers: `fence`, `anchor`, `downloadBlob`, `downloadText`, `fileSafe`, `yamlScalar` | Create |
| `apps/web-ui/lib/skill-export.ts` | Import the six helpers from `export-utils` instead of defining them | Modify |
| `apps/web-ui/lib/memory-export.ts` | Pure builders (`buildMemoryMarkdown`, `buildAllMemoriesMarkdown`, `buildMemoryFile`, `renderValueBody`) + impure wrappers (`exportMemoryToMarkdown`, `exportAllMemoriesToMarkdown`, `exportMemoryToFile`, `exportAllMemoriesToZip`) | Create |
| `apps/web-ui/lib/memory-export.test.ts` | Vitest unit tests for the pure builders | Create |
| `apps/web-ui/lib/queries/agent-memories.ts` | Add exported `fetchAllAgentMemories()` (paginated, safety-capped) | Modify |
| `apps/web-ui/components/memory/memory-client-component.tsx` | Per-row export items + "Export all ▾" toolbar dropdown + handlers/state | Modify |

---

### Task 1: Extract shared helpers to `lib/export-utils.ts`

**Files:**
- Create: `apps/web-ui/lib/export-utils.ts`
- Modify: `apps/web-ui/lib/skill-export.ts` (remove the six helper definitions, import them instead)
- Test: `apps/web-ui/lib/skill-export.test.ts` (existing — must still pass unchanged)

**Interfaces:**
- Produces (exported from `export-utils.ts`): `fence(content: string, lang?: string): string`, `anchor(text: string): string`, `downloadBlob(blob: Blob, filename: string): void`, `downloadText(content: string, filename: string, mimeType?: string): void`, `fileSafe(text: string, fallback?: string): string`, `yamlScalar(value: string): string`.

- [ ] **Step 1: Create `apps/web-ui/lib/export-utils.ts`**

```typescript
/**
 * Shared helpers for Markdown/Blob export modules (skills, memory, and future
 * exporters). Pure helpers (fence/anchor/fileSafe/yamlScalar) are unit-tested
 * via their consumers; downloadBlob/downloadText are thin DOM wrappers.
 */

/**
 * Wrap content in a code fence that cannot be terminated early: the fence is
 * one backtick longer than the longest backtick run inside the content.
 */
export function fence(content: string, lang = "markdown"): string {
    const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
    const marker = "`".repeat(Math.max(3, longestRun + 1));
    return `${marker}${lang}\n${content}\n${marker}`;
}

/** GitHub-style heading anchor: lowercase, trim, spaces → hyphens, drop non-alnum. */
export function anchor(text: string): string {
    return text.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

/** Trigger a client-side download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/** Trigger a client-side download of `content` as `filename`. */
export function downloadText(content: string, filename: string, mimeType = "text/markdown;charset=utf-8"): void {
    downloadBlob(new Blob([content], { type: mimeType }), filename);
}

/** Lowercase, alnum+hyphen-only, trimmed; falls back to `fallback` (default "item") when empty. */
export function fileSafe(text: string, fallback = "item"): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

/**
 * Emit a YAML scalar safe to embed in frontmatter. Single-line values use
 * double-quoted form (backslash + double-quote escaped); multi-line values use
 * a block scalar so newlines are preserved verbatim.
 */
export function yamlScalar(value: string): string {
    const v = value ?? "";
    if (v.includes("\n")) {
        const indented = v.split("\n").map((l) => `  ${l}`).join("\n");
        return `|-\n${indented}`;
    }
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
```

- [ ] **Step 2: Refactor `apps/web-ui/lib/skill-export.ts` to import the helpers**

Replace the six local helper definitions (the `fence` function at lines 13–21, `anchor` at 23–26, `downloadBlob` at 76–86, `downloadText` at 88–91, `fileSafe` at 93–95, `yamlScalar` at 97–109) with a single import. Keep everything else (the `build*`/`export*` functions) byte-identical.

Change the top of the file so the import block reads:

```typescript
import type { SkillDTO } from "@/lib/client-skill-service";
import { fence, anchor, downloadBlob, downloadText, fileSafe, yamlScalar } from "@/lib/export-utils";
```

Delete the now-duplicated `function fence(...)`, `function anchor(...)`, `function downloadBlob(...)`, `function downloadText(...)`, `function fileSafe(...)`, and `function yamlScalar(...)` definitions from `skill-export.ts`. The `buildSkillMarkdown`, `buildAllSkillsMarkdown`, `buildSkillFile`, and the four `export*` functions remain unchanged and continue to call these names (now imported).

Note: `fileSafe`'s empty-input fallback changes from `"skill"` to `"item"`. This is unreachable in practice (skills require a non-empty `name`), and no existing test exercises an empty name, so `skill-export.test.ts` stays green.

- [ ] **Step 3: Run the existing skill-export tests to confirm no regression**

Run: `cd apps/web-ui && bunx vitest run lib/skill-export.test.ts`
Expected: `Test Files 1 passed (1)` / `Tests 17 passed (17)`.

- [ ] **Step 4: Typecheck + lint the two files**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "export-utils|skill-export"`
Expected: no output (zero errors in these files).

Run: `cd apps/web-ui && bun run lint 2>&1 | grep -E "export-utils|skill-export\.ts"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/export-utils.ts apps/web-ui/lib/skill-export.ts
git commit -m "refactor(export): extract shared markdown/blob helpers to lib/export-utils.ts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `renderValueBody` + `buildMemoryMarkdown` (report, single)

**Files:**
- Create: `apps/web-ui/lib/memory-export.ts`
- Test: `apps/web-ui/lib/memory-export.test.ts`

**Interfaces:**
- Consumes: `MemoryRow` from `@/lib/queries/agent-memories`; `MemoryKind` from `@/lib/agent/memory/types`; `fence` not needed yet (body is prose); no helpers needed for this task.
- Produces: `buildMemoryMarkdown(memory: MemoryRow): string` (pure) and the module-private `renderValueBody(memory: MemoryRow): string` (pure).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/lib/memory-export.test.ts`:

```typescript
/**
 * Unit tests for the Memory → Markdown export builders. Mirrors
 * lib/skill-export.test.ts: only the pure builders are tested; the Blob/zip
 * wrappers are thin DOM code identical to skill-export's.
 */
import { describe, it, expect } from 'vitest';
import { buildMemoryMarkdown } from './memory-export';
import type { MemoryRow } from './queries/agent-memories';

function makeMemory(overrides: Partial<MemoryRow> = {}): MemoryRow {
    return {
        id: 'cm1a2b3c',
        userId: 'user-1',
        namespace: 'infra:ec2',
        category: 'infra',
        key: 'prod-stop-schedule',
        fact: 'Prod EC2 stops at 7pm.',
        source: 'scheduler-discovery-2026-07',
        confidence: 'high',
        value: { fact: 'Prod EC2 stops at 7pm.', source: 'scheduler-discovery-2026-07', confidence: 'high' },
        kind: 'SEMANTIC',
        sourceThreadId: null,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
        expiresAt: '2026-10-11T00:00:00.000Z',
        supersededById: null,
        supersededAt: null,
        ...overrides,
    };
}

describe('buildMemoryMarkdown', () => {
    it('renders the key as H1 and a metadata table', () => {
        const md = buildMemoryMarkdown(makeMemory());
        expect(md).toContain('# prod-stop-schedule');
        expect(md).toContain('| Kind | SEMANTIC |');
        expect(md).toContain('| Namespace | infra:ec2 |');
        expect(md).toContain('| Category | infra |');
        expect(md).toContain('| Confidence | high |');
        expect(md).toContain('| Source | scheduler-discovery-2026-07 |');
        expect(md).toContain('| Created | 2026-07-13T00:00:00.000Z |');
    });

    it('uses an em-dash for null confidence and source', () => {
        const md = buildMemoryMarkdown(makeMemory({ confidence: null, source: null }));
        expect(md).toContain('| Confidence | — |');
        expect(md).toContain('| Source | — |');
    });

    it('renders the superseded-by row', () => {
        const md = buildMemoryMarkdown(makeMemory({ supersededById: 'cm999' }));
        expect(md).toContain('| Superseded by | cm999 |');
    });

    it('renders SEMANTIC value body as Fact/Source/Confidence', () => {
        const md = buildMemoryMarkdown(makeMemory({ kind: 'SEMANTIC' }));
        expect(md).toContain('**Fact:** Prod EC2 stops at 7pm.');
        expect(md).toContain('**Source:** scheduler-discovery-2026-07');
        expect(md).toContain('**Confidence:** high');
    });

    it('renders EPISODIC value body as Context/Reasoning/Action/Outcome', () => {
        const md = buildMemoryMarkdown(
            makeMemory({
                kind: 'EPISODIC',
                confidence: null,
                value: { context: 'High CPU', reasoning: 'Scale up', action: 'Bumped ASG max', outcome: 'CPU normalized' },
            })
        );
        expect(md).toContain('**Context:** High CPU');
        expect(md).toContain('**Reasoning:** Scale up');
        expect(md).toContain('**Action:** Bumped ASG max');
        expect(md).toContain('**Outcome:** CPU normalized');
    });

    it('renders PROCEDURAL value body as Instruction/Trigger/Evidence/Confidence', () => {
        const md = buildMemoryMarkdown(
            makeMemory({
                kind: 'PROCEDURAL',
                confidence: 'medium',
                value: { instruction: 'Restart RDS', trigger: 'failover event', evidence: 'worked 3x', confidence: 'medium' },
            })
        );
        expect(md).toContain('**Instruction:** Restart RDS');
        expect(md).toContain('**Trigger:** failover event');
        expect(md).toContain('**Evidence:** worked 3x');
        expect(md).toContain('**Confidence:** medium');
    });

    it('renders an em-dash for missing value fields', () => {
        const md = buildMemoryMarkdown(
            makeMemory({ kind: 'EPISODIC', confidence: null, value: { context: 'only context' } })
        );
        expect(md).toContain('**Context:** only context');
        expect(md).toContain('**Reasoning:** —');
        expect(md).toContain('**Action:** —');
        expect(md).toContain('**Outcome:** —');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts`
Expected: FAIL — "Failed to resolve import './memory-export'" (module not created yet).

- [ ] **Step 3: Create `apps/web-ui/lib/memory-export.ts` with the builders**

```typescript
/**
 * Memory → Markdown export.
 *
 * Mirrors lib/skill-export.ts: buildMemoryMarkdown()/buildAllMemoriesMarkdown()
 * are the pure cores of the human-readable "report" export;
 * buildMemoryFile() is the pure core of the portable frontmatter export (for
 * reuse with other AI tools). export*ToMarkdown()/exportAllMemoriesToZip() wrap
 * them in Blob/zip downloads. Embeddings are never in the MemoryRow DTO, so
 * there is nothing to strip.
 */

import type { MemoryRow } from "@/lib/queries/agent-memories";
import type { MemoryKind } from "@/lib/agent/memory/types";
// `fence` is intentionally NOT imported: memory bodies are prose, never fenced.
// The other helpers come online in later tasks (anchor in Task 3, yamlScalar in
// Task 4, the download/fileSafe trio in Task 5). Unused-import warnings are
// non-failing (noUnusedLocals=false; lint no-unused-vars is a warning), so
// importing them all up front is safe and avoids repeated edits to this line.
import { anchor, downloadBlob, downloadText, fileSafe, yamlScalar } from "@/lib/export-utils";

const KIND_ORDER: MemoryKind[] = ["SEMANTIC", "EPISODIC", "PROCEDURAL"];

/** Read a string field from the raw `value` JSON, or "—" if absent/empty. */
function field(value: Record<string, unknown>, key: string): string {
    const v = value?.[key];
    return typeof v === "string" && v.length ? v : "—";
}

/**
 * Render the kind-specific `value` fields as labeled Markdown prose. Shared by
 * the report and portable builders so they never drift. Pure.
 */
function renderValueBody(memory: MemoryRow): string {
    const v = memory.value ?? {};
    switch (memory.kind) {
        case "SEMANTIC":
            return [
                `**Fact:** ${field(v, "fact")}`,
                `**Source:** ${field(v, "source")}`,
                `**Confidence:** ${memory.confidence ?? "—"}`,
                "",
            ].join("\n");
        case "EPISODIC":
            return [
                `**Context:** ${field(v, "context")}`,
                `**Reasoning:** ${field(v, "reasoning")}`,
                `**Action:** ${field(v, "action")}`,
                `**Outcome:** ${field(v, "outcome")}`,
                "",
            ].join("\n");
        case "PROCEDURAL":
            return [
                `**Instruction:** ${field(v, "instruction")}`,
                `**Trigger:** ${field(v, "trigger")}`,
                `**Evidence:** ${field(v, "evidence")}`,
                `**Confidence:** ${memory.confidence ?? "—"}`,
                "",
            ].join("\n");
        default:
            return "";
    }
}

/** Build the human-readable Markdown report for a single memory. Pure. */
export function buildMemoryMarkdown(memory: MemoryRow): string {
    const lines: string[] = [
        `# ${memory.key}`,
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| Kind | ${memory.kind} |`,
        `| Namespace | ${memory.namespace} |`,
        `| Category | ${memory.category} |`,
        `| Confidence | ${memory.confidence ?? "—"} |`,
        `| Source | ${memory.source ?? "—"} |`,
        `| Created | ${memory.createdAt} |`,
        `| Updated | ${memory.updatedAt} |`,
        `| Superseded by | ${memory.supersededById ?? "—"} |`,
        "",
        renderValueBody(memory),
    ];
    return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts`
Expected: PASS — `Tests 8 passed (8)`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/memory-export.ts apps/web-ui/lib/memory-export.test.ts
git commit -m "feat(memory): add buildMemoryMarkdown report builder + kind-aware body

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `buildAllMemoriesMarkdown` (report, all)

**Files:**
- Modify: `apps/web-ui/lib/memory-export.ts` (add `buildAllMemoriesMarkdown`)
- Test: `apps/web-ui/lib/memory-export.test.ts` (append tests)

**Interfaces:**
- Consumes: `buildMemoryMarkdown` from Task 2; `anchor` from `export-utils`; `KIND_ORDER` defined in Task 2.
- Produces: `buildAllMemoriesMarkdown(memories: MemoryRow[]): string` (pure).

- [ ] **Step 1: Append the failing tests**

Add to `apps/web-ui/lib/memory-export.test.ts` (update the `import` line to also import `buildAllMemoriesMarkdown`):

```typescript
import { buildMemoryMarkdown, buildAllMemoriesMarkdown } from './memory-export';
```

Append this `describe` block at the end of the file:

```typescript
describe('buildAllMemoriesMarkdown', () => {
    it('renders a header with the record count', () => {
        const md = buildAllMemoriesMarkdown([makeMemory(), makeMemory({ id: 'b', key: 'second' })]);
        expect(md).toContain('# Memory export');
        expect(md).toContain('Exported 2 memory record(s).');
    });

    it('renders an empty-state message when there are no memories', () => {
        const md = buildAllMemoriesMarkdown([]);
        expect(md).toContain('Exported 0 memory record(s).');
        expect(md).toContain('_No memories to export._');
    });

    it('groups the table of contents by kind in enum order', () => {
        const md = buildAllMemoriesMarkdown([
            makeMemory({ id: 'p', key: 'proc', kind: 'PROCEDURAL' }),
            makeMemory({ id: 's', key: 'sem', kind: 'SEMANTIC' }),
            makeMemory({ id: 'e', key: 'ep', kind: 'EPISODIC' }),
        ]);
        expect(md).toContain('### SEMANTIC');
        expect(md).toContain('### EPISODIC');
        expect(md).toContain('### PROCEDURAL');
        expect(md.indexOf('### SEMANTIC')).toBeLessThan(md.indexOf('### EPISODIC'));
        expect(md.indexOf('### EPISODIC')).toBeLessThan(md.indexOf('### PROCEDURAL'));
    });

    it('links TOC entries to key anchors', () => {
        const md = buildAllMemoriesMarkdown([makeMemory({ key: 'prod-stop-schedule' })]);
        expect(md).toContain('- [prod-stop-schedule](#prod-stop-schedule)');
    });

    it('sorts memories within a kind by createdAt descending', () => {
        const md = buildAllMemoriesMarkdown([
            makeMemory({ id: 'old', key: 'old', kind: 'SEMANTIC', createdAt: '2026-01-01T00:00:00.000Z' }),
            makeMemory({ id: 'new', key: 'new', kind: 'SEMANTIC', createdAt: '2026-07-01T00:00:00.000Z' }),
        ]);
        expect(md.indexOf('# new')).toBeLessThan(md.indexOf('# old'));
    });

    it('separates each memory with a horizontal rule and includes bodies', () => {
        const md = buildAllMemoriesMarkdown([
            makeMemory({ id: 'a', key: 'alpha' }),
            makeMemory({ id: 'b', key: 'beta' }),
        ]);
        expect(md).toContain('# alpha');
        expect(md).toContain('# beta');
        expect(md).toContain('\n---\n');
    });

    it('omits a kind group entirely when no memories of that kind exist', () => {
        const md = buildAllMemoriesMarkdown([makeMemory({ kind: 'PROCEDURAL' })]);
        expect(md).not.toContain('### SEMANTIC');
        expect(md).toContain('### PROCEDURAL');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts`
Expected: FAIL — `buildAllMemoriesMarkdown is not exported from ./memory-export` (or resolve error).

- [ ] **Step 3: Implement `buildAllMemoriesMarkdown` in `apps/web-ui/lib/memory-export.ts`**

Append after `buildMemoryMarkdown`:

```typescript
/** Build the combined human-readable Markdown report for all memories (TOC + each memory). Pure. */
export function buildAllMemoriesMarkdown(memories: MemoryRow[]): string {
    const header: string[] = [
        "# Memory export",
        "",
        `Exported ${memories.length} memory record(s).`,
        "",
    ];
    if (memories.length === 0) {
        header.push("_No memories to export._", "");
        return header.join("\n");
    }
    const byKind = new Map<MemoryKind, MemoryRow[]>();
    for (const m of memories) {
        const arr = byKind.get(m.kind) ?? [];
        arr.push(m);
        byKind.set(m.kind, arr);
    }
    for (const arr of byKind.values()) {
        arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    header.push("## Table of contents", "");
    for (const kind of KIND_ORDER) {
        const arr = byKind.get(kind);
        if (!arr || arr.length === 0) continue;
        header.push(`### ${kind}`, "");
        for (const m of arr) header.push(`- [${m.key}](#${anchor(m.key)})`);
        header.push("");
    }
    header.push("---", "");
    const body: string[] = [];
    for (const kind of KIND_ORDER) {
        const arr = byKind.get(kind);
        if (!arr || arr.length === 0) continue;
        for (const m of arr) {
            body.push(buildMemoryMarkdown(m), "---", "");
        }
    }
    return `${header.join("\n")}\n${body.join("\n")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts`
Expected: PASS — `Tests 15 passed (15)` (8 from Task 2 + 7 here).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/memory-export.ts apps/web-ui/lib/memory-export.test.ts
git commit -m "feat(memory): add buildAllMemoriesMarkdown combined report builder

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `buildMemoryFile` (portable, single)

**Files:**
- Modify: `apps/web-ui/lib/memory-export.ts` (add `buildMemoryFile`)
- Test: `apps/web-ui/lib/memory-export.test.ts` (append tests)

**Interfaces:**
- Consumes: `renderValueBody` (module-private, Task 2); `yamlScalar` from `export-utils`.
- Produces: `buildMemoryFile(memory: MemoryRow): string` (pure) — YAML frontmatter + kind-aware body.

- [ ] **Step 1: Append the failing tests**

Update the import line in `apps/web-ui/lib/memory-export.test.ts`:

```typescript
import { buildMemoryMarkdown, buildAllMemoriesMarkdown, buildMemoryFile } from './memory-export';
```

Append:

```typescript
describe('buildMemoryFile (portable frontmatter)', () => {
    it('emits YAML frontmatter delimited by --- fences', () => {
        const md = buildMemoryFile(makeMemory());
        expect(md.startsWith('---\n')).toBe(true);
        expect(md).toMatch(/\n---\n/);
    });

    it('places kind, namespace, key, category, created_at, updated_at in frontmatter', () => {
        const md = buildMemoryFile(makeMemory());
        expect(md).toContain('kind: SEMANTIC');
        expect(md).toContain('namespace: "infra:ec2"');
        expect(md).toContain('key: "prod-stop-schedule"');
        expect(md).toContain('category: infra');
        expect(md).toContain('created_at: 2026-07-13T00:00:00.000Z');
        expect(md).toContain('updated_at: 2026-07-13T00:00:00.000Z');
    });

    it('includes confidence when present', () => {
        const md = buildMemoryFile(makeMemory({ confidence: 'high' }));
        expect(md).toContain('confidence: high');
    });

    it('omits the confidence line when null', () => {
        const md = buildMemoryFile(makeMemory({ confidence: null }));
        expect(md).not.toMatch(/^confidence:/m);
    });

    it('puts the kind-aware body after the frontmatter', () => {
        const md = buildMemoryFile(makeMemory({ kind: 'SEMANTIC' }));
        const bodyStart = md.indexOf('\n---\n') + '\n---\n'.length;
        const body = md.slice(bodyStart);
        expect(body).toContain('**Fact:** Prod EC2 stops at 7pm.');
        expect(body).toContain('**Source:** scheduler-discovery-2026-07');
        expect(body).toContain('**Confidence:** high');
    });

    it('escapes double quotes and backslashes in namespace/key', () => {
        const md = buildMemoryFile(makeMemory({ namespace: 'a"b', key: 'c\\d' }));
        expect(md).toContain('namespace: "a\\"b"');
        expect(md).toContain('key: "c\\\\d"');
    });

    it('uses a YAML block scalar for multi-line namespaces', () => {
        const md = buildMemoryFile(makeMemory({ namespace: 'line one\nline two' }));
        expect(md).toContain('namespace: |-\n  line one\n  line two');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts`
Expected: FAIL — `buildMemoryFile is not exported`.

- [ ] **Step 3: Implement `buildMemoryFile` in `apps/web-ui/lib/memory-export.ts`**

Append:

```typescript
/**
 * Build a portable `.md` for a memory: YAML frontmatter (kind, namespace, key,
 * category, confidence, created_at, updated_at) + the kind-aware `value` body.
 * Re-importable by other AI tools that read Markdown + frontmatter. Pure.
 */
export function buildMemoryFile(memory: MemoryRow): string {
    const fm: string[] = [
        "---",
        `kind: ${memory.kind}`,
        `namespace: ${yamlScalar(memory.namespace)}`,
        `key: ${yamlScalar(memory.key)}`,
        `category: ${memory.category}`,
    ];
    if (memory.confidence) fm.push(`confidence: ${memory.confidence}`);
    fm.push(`created_at: ${memory.createdAt}`, `updated_at: ${memory.updatedAt}`, "---", "");
    return `${fm.join("\n")}\n${renderValueBody(memory)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts`
Expected: PASS — `Tests 22 passed (22)` (15 + 7).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/memory-export.ts apps/web-ui/lib/memory-export.test.ts
git commit -m "feat(memory): add buildMemoryFile portable frontmatter builder

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Impure wrappers (Blob + zip downloads)

**Files:**
- Modify: `apps/web-ui/lib/memory-export.ts` (add the four `export*` functions)

**Interfaces:**
- Consumes: `buildMemoryMarkdown`, `buildAllMemoriesMarkdown`, `buildMemoryFile` (Tasks 2–4); `downloadText`, `downloadBlob`, `fileSafe` from `export-utils`; dynamic `import("jszip")`.
- Produces: `exportMemoryToMarkdown(memory: MemoryRow): void`, `exportAllMemoriesToMarkdown(memories: MemoryRow[]): void`, `exportMemoryToFile(memory: MemoryRow): void`, `exportAllMemoriesToZip(memories: MemoryRow[]): Promise<void>`.

These are thin DOM/Blob wrappers (no unit tests — identical pattern to `skill-export.ts`).

- [ ] **Step 1: Append the four wrappers to `apps/web-ui/lib/memory-export.ts`**

```typescript
/** Download a single memory as a human-readable `.md` report. Impure (DOM + Blob). */
export function exportMemoryToMarkdown(memory: MemoryRow): void {
    downloadText(buildMemoryMarkdown(memory), `${fileSafe(memory.key, memory.id)}.md`);
}

/** Download all memories as a single combined `.md` report. Impure (DOM + Blob). */
export function exportAllMemoriesToMarkdown(memories: MemoryRow[]): void {
    downloadText(buildAllMemoriesMarkdown(memories), `memory-export-${new Date().toISOString().slice(0, 10)}.md`);
}

/** Download a single memory as a portable frontmatter `.md` file. Impure (DOM + Blob). */
export function exportMemoryToFile(memory: MemoryRow): void {
    downloadText(buildMemoryFile(memory), `${fileSafe(memory.key, memory.id)}.md`);
}

/**
 * Download all memories as a `.zip` of portable frontmatter files, one per memory
 * at `memories/<KIND>/<id>.md`, grouped into per-kind folders so a consuming
 * tool can ingest by kind. jszip is dynamically imported so it stays out of the
 * main bundle. Impure (DOM + Blob + dynamic import).
 */
export async function exportAllMemoriesToZip(memories: MemoryRow[]): Promise<void> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const root = zip.folder("memories");
    if (!root) throw new Error("Failed to create memories folder in zip");
    const ordered = KIND_ORDER.flatMap((kind) => memories.filter((m) => m.kind === kind));
    for (const m of ordered) root.file(`${m.kind}/${m.id}.md`, buildMemoryFile(m));
    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `memories-export-${new Date().toISOString().slice(0, 10)}.zip`);
}
```

- [ ] **Step 2: Typecheck + lint the wrappers**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "memory-export"`
Expected: no output.

Run: `cd apps/web-ui && bun run lint 2>&1 | grep -E "memory-export\.ts"`
Expected: no output (unused-import warnings from earlier tasks are non-falling; by end of Task 5 all of `anchor/yamlScalar/downloadBlob/downloadText/fileSafe` are used).

- [ ] **Step 3: Re-run the pure-builder tests (must stay green)**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts`
Expected: `Tests 22 passed (22)`.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/memory-export.ts
git commit -m "feat(memory): add Blob + zip export wrappers (report + portable)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `fetchAllAgentMemories` (paginated, safety-capped)

**Files:**
- Modify: `apps/web-ui/lib/queries/agent-memories.ts` (add exported function)

**Interfaces:**
- Consumes: `MemoryRow` (defined in this file); `GET /api/agent-memories?limit=&page=&sort=createdAt&dir=asc` (RBAC `authorize('read','Memory')` already enforced).
- Produces: `fetchAllAgentMemories(): Promise<{ memories: MemoryRow[]; total: number }>` — exported, non-hook.

- [ ] **Step 1: Add the function to `apps/web-ui/lib/queries/agent-memories.ts`**

Append at the end of the file (after `useDeleteAgentMemory`):

```typescript
/**
 * Fetch every memory in the tenant for export-all, paging through
 * GET /api/agent-memories until the known `total` is reached. Safety-capped at
 * MAX_PAGES so an unexpected runaway cannot loop forever; callers compare
 * `memories.length < total` to detect truncation and warn. Not a hook — call
 * from an event handler, not render.
 */
export async function fetchAllAgentMemories(): Promise<{ memories: MemoryRow[]; total: number }> {
    const LIMIT = 500;
    const MAX_PAGES = 100;
    const memories: MemoryRow[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetch(`/api/agent-memories?limit=${LIMIT}&page=${page}&sort=createdAt&dir=asc`);
        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json.error || 'Failed to load memories');
        }
        const rows = json.data as MemoryRow[];
        total = json.total ?? 0;
        memories.push(...rows);
        if (rows.length < LIMIT || memories.length >= total) break;
    }
    return { memories, total };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "agent-memories"`
Expected: no output.

Run: `cd apps/web-ui && bun run lint 2>&1 | grep -E "queries/agent-memories"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/queries/agent-memories.ts
git commit -m "feat(memory): add fetchAllAgentMemories paginated tenant-wide fetch for export

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Wire the UI — per-row export + "Export all" dropdown

**Files:**
- Modify: `apps/web-ui/components/memory/memory-client-component.tsx`

**Interfaces:**
- Consumes: `exportMemoryToMarkdown`, `exportMemoryToFile`, `exportAllMemoriesToMarkdown`, `exportAllMemoriesToZip` from `@/lib/memory-export`; `fetchAllAgentMemories` from `@/lib/queries/agent-memories`; lucide icons `Download`, `FileDown`, `FileCode`, `FileArchive`, `ChevronDown`, `Loader2`.

- [ ] **Step 1: Update imports**

In `apps/web-ui/components/memory/memory-client-component.tsx`:

Change the lucide import (line 5) to add the new icons:

```typescript
import { Brain, MoreHorizontal, Eye, Trash2, Search, X, Sparkles, Download, FileDown, FileCode, FileArchive, ChevronDown, Loader2 } from "lucide-react";
```

Add imports after the existing `@/lib/queries/agent-memories` import block (after line 26):

```typescript
import { fetchAllAgentMemories } from "@/lib/queries/agent-memories";
import {
    exportMemoryToMarkdown,
    exportMemoryToFile,
    exportAllMemoriesToMarkdown,
    exportAllMemoriesToZip,
} from "@/lib/memory-export";
```

- [ ] **Step 2: Add `exporting` state + the export-all handler**

Inside `MemoryClientComponent()`, after the `promote` state (line 62), add:

```typescript
    const [exporting, setExporting] = useState(false);
```

After the `handleDelete` function (after line 112), add:

```typescript
    const runExportAll = async (mode: "report" | "zip") => {
        if (exporting) return;
        setExporting(true);
        try {
            const { memories, total } = await fetchAllAgentMemories();
            if (memories.length === 0) {
                toast.error("Nothing to export", { description: "No memories found." });
                return;
            }
            if (memories.length < total) {
                toast.warning("Export truncated", {
                    description: `Exported ${memories.length} of ${total} records (safety cap).`,
                });
            }
            if (mode === "report") {
                exportAllMemoriesToMarkdown(memories);
                toast.success("Memories exported", { description: `${memories.length} record(s) downloaded` });
            } else {
                await exportAllMemoriesToZip(memories);
                toast.success("Memories exported", { description: `${memories.length} file(s) zipped` });
            }
        } catch (e) {
            toast.error("Export failed", { description: e instanceof Error ? e.message : "Try again" });
        } finally {
            setExporting(false);
        }
    };
```

- [ ] **Step 3: Add the per-row export menu items**

In the actions column's `DropdownMenuContent` (between the `PROCEDURAL` promote block ending at line 216 `) : null}` and the Delete `DropdownMenuItem` at line 217), insert two items. The block should read:

```tsx
                                    {m.kind === "PROCEDURAL" ? (
                                        <DropdownMenuItem
                                            onClick={() => {
                                                const draft = buildSkillDraftFromMemory(m);
                                                if (draft) {
                                                    setPromote({ draft, sourceRunId: m.sourceThreadId ?? null });
                                                } else {
                                                    toast.error("This memory is missing rule fields and can't be promoted");
                                                }
                                            }}
                                        >
                                            <Sparkles className="mr-2 h-4 w-4" />
                                            Promote to skill
                                        </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuItem
                                        onClick={() => {
                                            try {
                                                exportMemoryToMarkdown(m);
                                                toast.success("Memory exported", { description: `${m.key}.md downloaded` });
                                            } catch (e) {
                                                toast.error("Export failed", { description: e instanceof Error ? e.message : "Try again" });
                                            }
                                        }}
                                    >
                                        <FileDown className="mr-2 h-4 w-4" />
                                        Export markdown
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => {
                                            try {
                                                exportMemoryToFile(m);
                                                toast.success("Memory file exported", { description: `${m.key}.md downloaded` });
                                            } catch (e) {
                                                toast.error("Export failed", { description: e instanceof Error ? e.message : "Try again" });
                                            }
                                        }}
                                    >
                                        <FileCode className="mr-2 h-4 w-4" />
                                        Export memory (.md)
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => setDeleteTarget(m)}
                                        className="text-destructive"
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
                                    </DropdownMenuItem>
```

(These per-row handlers are inlined so they only close over stable imports `exportMemoryToMarkdown`/`exportMemoryToFile`/`toast` and the row `m` — they add no new dependencies to the `columns` `useMemo`, whose deps stay `[]`.)

- [ ] **Step 4: Add the "Export all ▾" dropdown to the toolbar `header`**

In the `header` prop's flex container (the `<div className="flex flex-wrap items-center gap-2">` starting at line 262), add the dropdown after the `hasFilters && (...)` Reset block (after line 288, before the closing `</div>` at line 289):

```tsx
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm" disabled={exporting || total === 0} className="h-9">
                                    {exporting ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Download className="mr-2 h-4 w-4" />
                                    )}
                                    Export all
                                    <ChevronDown className="ml-1 h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => runExportAll("report")}>
                                    <FileDown className="mr-2 h-4 w-4" />
                                    Markdown (one file)
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => runExportAll("zip")}>
                                    <FileArchive className="mr-2 h-4 w-4" />
                                    Portable .md (zip)
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
```

- [ ] **Step 5: Typecheck + lint the component**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "memory-client-component"`
Expected: no output.

Run: `cd apps/web-ui && bun run lint 2>&1 | grep -E "memory-client-component"`
Expected: no output.

- [ ] **Step 6: Run the full memory-export test suite once more (sanity)**

Run: `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts lib/skill-export.test.ts`
Expected: both files pass (22 + 17 = 39 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/components/memory/memory-client-component.tsx
git commit -m "feat(memory): add per-memory + export-all Markdown/zip export to memory grid

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final verification (after Task 7)

- [ ] `cd apps/web-ui && bunx vitest run lib/memory-export.test.ts lib/skill-export.test.ts` → all pass.
- [ ] `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -cE "error TS"` → 182 (unchanged baseline).
- [ ] `cd apps/web-ui && bun run lint 2>&1 | grep -E "memory-export|export-utils|skill-export\.ts|memory-client-component|queries/agent-memories"` → no output.

## Out of scope

- Server-side export endpoint (Approach C) — not needed until large-tenant volume is real.
- JSON / sidecar JSON portable format — deliberately not shipped.
- Re-import / restore — outbound reuse only.