# Inline Documents for Knowledge Base — Design

**Date:** 2026-07-05
**Status:** Approved (design)
**Branch:** `kb-rewrite`

## Problem

The Knowledge Base module only supports ingesting content through **import connectors**
(S3, Confluence, Bitbucket) and **blob file upload**. Users cannot author a document in the
app, cannot edit content once ingested, and have no way to build up a set of documents over
time within a knowledge base. We want users to **create markdown documents inline, edit them
in place, and add more over time** — all feeding the same semantic search / RAG pipeline.

## Current architecture (as-is)

- **Model:** `KnowledgeBase` → many `DataSource`. There is **no document entity** — a document
  *is* a `DataSource`. `DataSource.sourceType ∈ {file-upload, s3-bucket, confluence, bitbucket}`,
  with `config` (JSON), `vectorKeys[]`, `status`, and sync/error fields.
- **Chunk store:** `KbDocumentChunk` (table `kb_document_chunks`) — pgvector `vector(1024)`; the
  only place content persists (chunk `textContent` ≤ ~2000 chars). No full-document store.
- **Upload path:** `POST /api/knowledge-base/[kbId]/upload` stages the file to S3, creates a
  `file-upload` DataSource in `syncing`, and enqueues a pg-boss `kb-sync` job. The worker
  (`apps/workers/src/jobs/kb-sync/handlers/file-upload.ts`) parses → chunks → embeds → upserts
  into `kb_document_chunks`.
- **Key enabler:** `apps/web-ui/lib/knowledge-base/embedder.ts` is a complete, self-contained
  embedder that runs **inside the Next process** — `chunkText`, `embedAndStoreChunks`
  (provider-configured embeddings, pgvector upsert), and `deleteVectors`. The DELETE route
  already calls `deleteVectors(ds.vectorKeys)`. This makes **synchronous in-request embedding**
  feasible with no worker round-trip.
- **Retrieval:** `POST /api/knowledge-base/query` embeds the question and runs pgvector cosine
  search across all chunks in the KB, then streams an LLM answer with citations.

### Gaps vs. goal

- No authoring surface — inputs are import connectors + blob upload only. (The inline upload
  dropzone in `[kbId]/page.tsx` is currently commented out.)
- The Edit dialog treats `file-upload` as having no editable content — rename only, no content
  edit.
- No concept of a document created in-app and revised over time.

## Approved decisions

1. **Data model:** New `'document'` source type (each authored doc is a `DataSource`), not a
   separate `KbDocument` entity. Lowest friction; reuses the list UI, query, and delete paths.
2. **Editor:** Markdown editor with live preview.
3. **Embed timing:** Synchronous on save via `embedder.ts` — instant searchability, immediate
   error feedback, no worker dependency.

Two implementation judgment calls (approved): the editor is a **dialog** (not a dedicated
route), and edits **reuse the existing `sources/[dsId]` PUT** (create gets its own route because
it must embed).

## Design

### 1. Concept

A **document** is a first-class, in-app-authored markdown file stored as a `DataSource` with
`sourceType: 'document'`. Its text lives on the record, is chunked + embedded synchronously on
save, and is searched by the existing query path. "Add documents over time" = create more;
"inline edit" = re-save, which re-embeds. Reuses the entire chunk → embed → pgvector → RAG stack.

### 2. Data model

`libs/prisma/schema.prisma` + migration:

- Add `'document'` to the `DataSourceType` union in `apps/web-ui/lib/knowledge-base/types.ts`.
- Add **`content String? @db.Text`** to `DataSource` — null for connector/upload sources; holds
  markdown for documents.
- Migration:
  - `ALTER TABLE data_sources ADD COLUMN content text;`
  - Update the `sourceType` CHECK constraint to allow `'document'` (constraints are defined in
    migration SQL, not Prisma-native).
- Add `content` to the update-whitelist in `apps/web-ui/lib/db/repositories/data-source/postgres.ts`.
- New `DocumentConfig` type `{ format: 'markdown'; chunkCount: number }` — keeps `config` uniform
  with the other source types.

### 3. API

Thin additions, maximum reuse.

- **Create** — new `POST /api/knowledge-base/[kbId]/documents` `{ name, content }`:
  1. Create DataSource (`sourceType: 'document'`, `content`, status `syncing`).
  2. `chunkText(content, name)` + `embedAndStoreChunks({ ..., sourceType: 'document' })` from
     `embedder.ts`.
  3. Set status `synced`, `vectorKeys`, `vectorCount`; bump KB `dataSourceCount` + `vectorCount`.
  4. Return the DataSource. Audit `kb.document.created`.
- **Edit** — extend existing `PUT /api/knowledge-base/[kbId]/sources/[dsId]`: when
  `sourceType === 'document'` and `content` changed → `deleteVectors(old keys)` → re-chunk →
  `embedAndStoreChunks` → update `content` / `vectorKeys` / counts (by delta). Audit
  `kb.document.updated`.
- **Read content** — existing `GET .../sources/[dsId]` already returns the DataSource; ensure
  `content` is included.
- **List** — strip `content` in the sources-list serializer (keep list payloads small); return it
  only on the single-source GET.
- **Delete** — no change; the existing DELETE runs `deleteVectors` + count decrements for any type.

Guards:

- Reject empty content.
- Cap size (~1 MB / ~200k chars → ≤ ~140 chunks; embedder batches 5 concurrently → a few seconds).
- On embed failure set status `error` but **preserve `content`** so a re-save retries.
- Map `ProviderConfigError` (no embedding provider configured) → 400 with a friendly message.

### 4. Auth / tenant / audit

Follow the sibling routes' existing pattern: `getServerSession` + tenant-ownership
(`getKnowledgeBase(kbId, tenantId)` → 403 on miss), tenant-scoped repositories, and
`AuditService` on create/update. The module's CRUD routes do not use the `authorize()` RBAC helper
today; we stay consistent with the neighbors rather than introduce a one-off. **Optional hardening
(out of scope):** add `authorize('create' | 'update', 'KnowledgeBase')` uniformly across the KB
CRUD routes.

### 5. UI

- **KB detail page** (`apps/web-ui/app/app/knowledge-base/[kbId]/page.tsx`): add a **"New
  Document"** button beside "Add Data Source". Document rows render in the same Data Sources list
  (a `FileText` / `Pencil` icon), with the re-sync action hidden (same as file-upload).
- **Editor** — new `apps/web-ui/components/knowledge-base/kb-document-editor.tsx`: React Hook Form
  + Zod (`name`, `content`), split **write / preview** panes using the same react-markdown renderer
  the chat already uses, with a Write/Preview toggle on mobile. Opened as a large dialog. Save →
  create/update API → toast → refresh.
- **Edit branch**: the detail page's existing `EditDialog` branches — `document` type opens the
  markdown editor (fetches the single source for `content`); other types keep today's config
  editor. **View** for a document renders read-only markdown.
- Optionally add a 5th "Document" card to
  `apps/web-ui/components/knowledge-base/kb-source-type-selector.tsx` for discoverability (routes to
  the editor). Primary entry is the "New Document" button.

### 6. Data fetching

Add `useCreateDocument` / `useUpdateDocument` mutations to
`apps/web-ui/lib/queries/knowledge-base.ts` (per the frontend TanStack Query convention); on
success they trigger the detail page's KB refresh. No polling needed — embedding is synchronous.

### 7. Retrieval — unchanged

Document chunks land in `kb_document_chunks` like everything else; the query / RAG route needs
zero changes. Citations surface the document's name (`documentName`).

## Out of scope (YAGNI)

- Folders / nesting / document tree.
- Versioning / edit history.
- Collaborative / real-time editing (last-write-wins on concurrent edits).
- Per-chunk viewing.
- The optional RBAC `authorize()` hardening noted in §4.

## Files touched (anticipated)

**Schema / DB**
- `libs/prisma/schema.prisma` — `DataSource.content`.
- `libs/prisma/migrations/<new>/migration.sql` — add column + update `sourceType` CHECK.
- `apps/web-ui/lib/db/repositories/data-source/postgres.ts` — whitelist `content`.

**Types / service**
- `apps/web-ui/lib/knowledge-base/types.ts` — `'document'` in union, `DocumentConfig`.

**API**
- `apps/web-ui/app/api/knowledge-base/[kbId]/documents/route.ts` — new (POST create).
- `apps/web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts` — extend PUT for content
  re-embed; include `content` in single GET.
- `apps/web-ui/app/api/knowledge-base/[kbId]/sources/route.ts` — strip `content` in list serializer.

**UI**
- `apps/web-ui/components/knowledge-base/kb-document-editor.tsx` — new.
- `apps/web-ui/app/app/knowledge-base/[kbId]/page.tsx` — "New Document" button, edit/view branch.
- `apps/web-ui/components/knowledge-base/kb-source-type-selector.tsx` — optional 5th card.
- `apps/web-ui/lib/queries/knowledge-base.ts` — document mutations.

## Testing

- **Unit:** chunking/edit-diff behavior already covered by embedder; add a test that editing a
  document deletes old vector keys and writes new ones (count delta correct).
- **Integration (API):** create document → chunks appear in `kb_document_chunks`; edit → old keys
  gone, new keys present, KB `vectorCount` reflects delta; delete → vectors removed. Empty content
  rejected; oversize rejected; `ProviderConfigError` → 400.
- **E2E (Playwright):** create a document via the editor, verify it appears in the Data Sources
  list, edit it, then ask the KB a question that only the document answers and confirm it is cited.
