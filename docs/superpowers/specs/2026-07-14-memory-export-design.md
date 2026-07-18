# Memory Export — Design

**Date:** 2026-07-14
**Branch:** `agent-ops`
**Status:** Approved (brainstorm)
**Depends on:** existing memory module (`/app/memory`, `/api/agent-memories`, `lib/agent/memory/*`) and the just-shipped skills export (`lib/skill-export.ts`).

## Goal

Add Markdown export to the agent memory module — both per-memory (from the grid's row actions) and export-all (from the toolbar) — in two formats:

1. **Report Markdown** — a human/LLM-readable document (single memory, or a combined doc for all).
2. **Portable Markdown + YAML frontmatter** — one `.md` per memory following a defined convention so memories can be **reused with other AI tools**. Export-all bundles these as a zip.

This mirrors the skills export's dual-mode pattern (`skill-export.ts`).

## Background & constraints

- Memory UI is a TanStack `DataTable` grid at `/app/memory` (`components/memory/memory-client-component.tsx`) with a per-row actions dropdown (View details / Promote to skill / Delete) and a toolbar `header` (search + category faceted filter + Reset).
- `AgentMemory` is **kind-discriminated** (`MemoryKind`: `SEMANTIC` | `EPISODIC` | `PROCEDURAL`); the `value: Json` shape depends on `kind`:
  - `SemanticValue { fact, source, confidence }`
  - `EpisodicValue { context, reasoning, action, outcome }`
  - `ProceduralValue { instruction, trigger, evidence, confidence? }`
- The memory **list DTO already includes the full `value`** (`AgentMemoryRecord` / `MemoryRow`). Unlike skills, **no `withContent`-style round-trip is needed**; per-memory export uses row data already in hand.
- **Embeddings are never in the DTO** — the `embedding` column is `Unsupported("vector(1024)")` in Prisma and structurally excluded from the client type and repository mapper. There is nothing to strip from exports.
- RBAC subject is `'Memory'` (module `'AIOps'`); `authorize('read', 'Memory')` already gates `GET /api/agent-memories`. Export is a read; **no new permission**.
- Decisions confirmed during brainstorm:
  - **Purpose:** reuse memories with other AI tools → portable format required.
  - **Portable format:** Markdown + YAML frontmatter (no industry standard exists; we define the convention).
  - **Export-all scope:** whole tenant, ignoring search/category/pagination.

## Architecture

New file **`apps/web-ui/lib/memory-export.ts`**, following the established pure-core + thin-Blob-wrapper split (same convention as `lib/skill-export.ts`, `lib/agent-ops/export-markdown.ts`, `lib/chat-export.ts`).

### Shared helpers — extract to `apps/web-ui/lib/export-utils.ts`

Move these six helpers out of `skill-export.ts` into a shared `lib/export-utils.ts`, and make `skill-export.ts` a thin importer:
`fence()`, `anchor()`, `downloadBlob()`, `downloadText()`, `fileSafe()`, `yamlScalar()`.

This avoids duplicating the helpers a second time in `memory-export.ts` and keeps both export modules consistent. The change to `skill-export.ts` is minimal (import instead of define) and directly serves this work.

### Pure builders (unit-tested)

- `renderValueBody(memory: MemoryRow): string` — switches on `kind` and renders the `value` fields as labeled Markdown sections. **Shared by both the report and portable builders so they never drift.**
- `buildMemoryMarkdown(memory: MemoryRow): string` — single memory as a readable report doc.
- `buildAllMemoriesMarkdown(memories: MemoryRow[]): string` — combined report with a TOC grouped by kind.
- `buildMemoryFile(memory: MemoryRow): string` — single portable `.md` (YAML frontmatter + kind-aware body).

### Impure wrappers (DOM/Blob)

- `exportMemoryToMarkdown(memory: MemoryRow): void` — single `.md` report download.
- `exportAllMemoriesToMarkdown(memories: MemoryRow[]): void` — combined report download.
- `exportMemoryToFile(memory: MemoryRow): void` — single portable `.md` download.
- `exportAllMemoriesToZip(memories: MemoryRow[]): Promise<void>` — dynamic-imports `jszip` (already a dependency), builds `memories/<KIND>/<id>.md`, downloads `.zip`.

## Markdown formats

### Kind-aware body (shared `renderValueBody`)

Each `value` shape becomes labeled prose. Unknown/missing fields render as `—`. Fields are kept as prose (not fenced) so an LLM reading the file sees natural text.

- **SEMANTIC** → `**Fact:**` / `**Source:**` / `**Confidence:**`
- **EPISODIC** → `**Context:**` / `**Reasoning:**` / `**Action:**` / `**Outcome:**`
- **PROCEDURAL** → `**Instruction:**` / `**Trigger:**` / `**Evidence:**` / `**Confidence:**`

Per the "Markdown + frontmatter" choice, **no raw JSON is embedded** in either format — each file is clean prose + frontmatter.

### Report mode

**Single memory:** H1 = `key`; metadata table (kind, namespace, category, confidence, source, created, updated, superseded-by); then the kind-aware body.

**Export-all:** combined doc — `# Memory export` header with count, a table of contents grouped by kind (`### SEMANTIC` / `### EPISODIC` / `### PROCEDURAL`, in `MemoryKind` enum declaration order) with anchor links to each `key`, then each memory separated by `---`. Sorted by kind (enum order), then `createdAt` desc within each kind. Empty state: `_No memories to export._`.

### Portable mode

**Single memory:** one `.md`:

```markdown
---
kind: SEMANTIC
namespace: "infra:ec2"
key: "prod-instances-stop-schedule"
category: infra
confidence: high
created_at: 2026-07-13T00:00:00.000Z
updated_at: 2026-07-13T00:00:00.000Z
---

**Fact:** Prod EC2 instances follow a 7pm stop / 7am start schedule.
**Source:** scheduler-discovery-2026-07
**Confidence:** high
```

Frontmatter is intentionally lean: `kind`, `namespace`, `key`, `category`, `confidence`, `created_at`, `updated_at`. `tenantId`/`userId` are omitted (internal IDs meaningless to another tool). The `confidence` line is **omitted when null** (rather than written as `null`). `yamlScalar()` handles double-quote/backslash escaping and multi-line block scalars (`|-`).

The single-memory download filename is `<fileSafe(key)>.md` (falling back to `<id>.md` if `key` sanitizes to empty), so a downloaded file is human-readable.

**Export-all:** `memories-export-<date>.zip` with one file per memory at `memories/<KIND>/<id>.md` (e.g. `memories/SEMANTIC/cm1a2b3c.md`), grouped into per-kind folders so a consuming tool can ingest by kind. (The zip uses the stable `<id>` — not `key` — as the filename to guarantee uniqueness, since `key` is only unique within `tenantId + namespace + key`.)

## Data flow

Per-memory export: **no fetch** — the `MemoryRow` already in hand carries `value`.

Export-all (whole tenant, no filters): a new exported non-hook function `fetchAllAgentMemories(): Promise<MemoryRow[]>` in `lib/queries/agent-memories.ts` loops pages (`limit=500`, incrementing `page`) until accumulated length ≥ `total` (the API returns `{ data, total }`), with a safety cap of 100 pages (50k records) that emits a truncation warning toast if ever hit.

```
Export-all click → fetchAllAgentMemories()
                 → GET /api/agent-memories?limit=500&page=1..N  (RBAC authorize('read','Memory') already enforced)
                 → buildAllMemoriesMarkdown / exportAllMemoriesToZip
                 → Blob / zip download
```

No API or schema change. No new permission.

## UI wiring — `components/memory/memory-client-component.tsx`

- **Per-row actions dropdown** (after *View details* / *Promote to skill*, before *Delete*):
  - **"Export markdown"** (`FileDown` icon) → `onExportMemory` → `exportMemoryToMarkdown(row)`.
  - **"Export memory (.md)"** (`FileCode` icon) → `onExportMemoryFile` → `exportMemoryToFile(row)`.
  - Both use row data already in hand; no extra request.
- **DataTable `header`** (after the *Reset* button):
  - An **"Export all ▾"** `DropdownMenu` with a `variant="outline"` trigger (`Download` + `ChevronDown`; `Loader2` spinner while `exporting`). Disabled when `total === 0`.
  - Items: **"Markdown (one file)"** (`FileDown`) → `onExportAll`; **"Portable .md (zip)"** (`FileArchive`) → `onExportAllZip`.
- `exporting` state flag; four handlers, each with `toast` success/error, mirroring `skills-client.tsx`.

## Error handling

- Per-memory: `try/catch` → `toast.error("Export failed", …)` (failures are DOM/Blob-only; no fetch).
- Export-all: `exporting` re-entry guard; empty result → `toast.error("Nothing to export", …)`; fetch/zip failure → `toast.error`; safety-cap truncation → `toast.warning("Export truncated", …)`.
- `jszip` dynamic-import failure → caught by the same `try/catch`.

## Testing — `apps/web-ui/lib/memory-export.test.ts`

Pure-builder unit tests mirroring `lib/skill-export.test.ts`:

- `buildMemoryMarkdown`: metadata table fields; kind-aware body for each of the 3 kinds; missing-field → `—`; supersession row.
- `buildAllMemoriesMarkdown`: header + count; TOC grouped by kind; sort order (kind, then `createdAt` desc); empty state; `---` separators.
- `buildMemoryFile`: `---` frontmatter delimiters; all frontmatter fields present; kind-aware body; `yamlScalar` quote/backslash escaping; multi-line block scalar.
- `fence` behavior (imported from `export-utils`) for any fenced content.

No E2E/integration tests — the Blob/zip wrappers are thin and identical to the proven skill-export wrappers; the pure builders carry all the logic and are fully unit-testable.

## Files touched

| File | Change |
|---|---|
| `apps/web-ui/lib/export-utils.ts` | **New** — shared `fence/anchor/downloadBlob/downloadText/fileSafe/yamlScalar`. |
| `apps/web-ui/lib/skill-export.ts` | Import the six helpers from `export-utils` instead of defining them. |
| `apps/web-ui/lib/memory-export.ts` | **New** — pure builders + impure wrappers (report + portable). |
| `apps/web-ui/lib/memory-export.test.ts` | **New** — unit tests for the pure builders. |
| `apps/web-ui/lib/queries/agent-memories.ts` | Add exported `fetchAllAgentMemories()` (paginated, safety-capped). |
| `apps/web-ui/components/memory/memory-client-component.tsx` | Per-row export items + "Export all ▾" toolbar dropdown + handlers/state. |

## Out of scope / future

- **Server-side export endpoint** (Approach C from brainstorm): if a tenant's memory volume ever makes client-side export slow, add `GET /api/agent-memories/export` that streams a zip server-side. Not needed now.
- **JSON / sidecar JSON** portable format: deliberately not shipped (user chose Markdown + frontmatter). Can be added later if a concrete target tool needs structured ingestion.
- **Re-import / restore**: not part of this work (purpose is outbound reuse, not backup-restore).