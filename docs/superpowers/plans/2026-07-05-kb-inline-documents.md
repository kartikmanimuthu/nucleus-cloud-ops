# KB Inline Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users author markdown documents in a Knowledge Base, edit them inline, and add more over time — feeding the same embedding/RAG pipeline as uploads.

**Architecture:** A document is a `DataSource` with `sourceType: 'document'` whose markdown is stored in a new `data_sources.content` column. On save the route chunks + embeds the content synchronously via the existing web-ui `embedder.ts` (provider-configured, 1024-dim) into `kb_document_chunks`; on edit it deletes the old vectors and re-embeds. Retrieval is unchanged — document chunks are searched like any other source.

**Tech Stack:** Next.js 15 App Router, Prisma (Postgres + pgvector), TanStack Query, React Hook Form + Zod 4, sonner, react-markdown, Vitest.

## Global Constraints

- **Multi-tenant safety:** every route resolves `getSessionTenantId()` and checks KB ownership via `KnowledgeBaseService.getKnowledgeBase(kbId, tenantId)` → 403 on miss; all DB access is tenant-scoped through the repository/service layer. Never call Prisma directly from routes.
- **Embeddings are fixed 1024-dim** — always use `embedder.ts` (`getTenantEmbeddings` provider factory), never a hardcoded Bedrock client. The `kb_document_chunks.embedding` column is `vector(1024)`.
- **New UI uses:** TanStack Query hooks (`lib/queries/`), `toast` from `"sonner"`, React Hook Form + `@hookform/resolvers/zod` with a Zod v4 schema. No manual `useState` forms.
- **Audit:** create/update call `AuditService.logUserAction(...).catch(() => {})`, mirroring the existing KB routes.
- **RBAC:** KB CRUD routes use session + tenant-ownership only (not `authorize()`), consistent with the existing module. Do **not** add `authorize()` here.
- **Indentation:** 4 spaces in `lib/`/route files, 2 spaces in `components/`.
- **Imports:** use the `@/` alias for cross-directory imports.
- **Document size cap:** `MAX_DOCUMENT_CHARS = 200_000`.
- **Tests:** Vitest. Run one file with `cd apps/web-ui && bunx vitest run <path>`; full suite `cd apps/web-ui && bun run test`.

## Architecture note — content is write-through, not in the read DTO

`content` lives on the `data_sources` table and is an allowed **update** field, but `rowToDS()` deliberately does **not** map it into the `DataSource` DTO. This keeps the list/detail payloads lean and removes any risk of leaking full document bodies through the two endpoints that list sources (`GET /api/knowledge-base/[kbId]` and `GET .../sources`). The editor reads a document's body through a dedicated `GET /api/knowledge-base/[kbId]/documents/[dsId]` endpoint instead. (This refines the spec's "include content in sources GET + strip from list" bullet into a dedicated content endpoint — same design, safer surface.)

---

### Task 1: Schema, migration, types, and repository `content` support

**Files:**
- Modify: `libs/prisma/schema.prisma` (DataSource model, ~line 284)
- Create: `libs/prisma/migrations/20260705120000_add_data_source_content/migration.sql`
- Modify: `apps/web-ui/lib/knowledge-base/types.ts`
- Modify: `apps/web-ui/lib/db/repositories/data-source/postgres.ts`
- Modify: `apps/web-ui/lib/db/repositories/data-source/interface.ts`
- Test: `apps/web-ui/lib/db/repositories/data-source/postgres.test.ts`

**Interfaces:**
- Produces:
  - `DataSourceType` now includes `'document'`.
  - `DocumentConfig = { format: 'markdown'; chunkCount: number }` (added to the `DataSourceConfig` union).
  - `DataSource.content?: string` (write-through; never populated by `rowToDS`).
  - `IDataSourceRepository.getDataSourceContent(kbId: string, dsId: string, tenantId: string): Promise<string | null>`.
  - `DataSourcePostgresRepository.updateDataSource` now whitelists `content`.

- [ ] **Step 1: Write the failing repo tests**

Add to `apps/web-ui/lib/db/repositories/data-source/postgres.test.ts` inside the first `describe('DataSourcePostgresRepository', ...)` block:

```typescript
    describe('updateDataSource — content', () => {
        it('writes content when provided', async () => {
            mockPrisma.dataSource.updateMany.mockResolvedValue({ count: 1 });

            const repo = new DataSourcePostgresRepository();
            await repo.updateDataSource('kb-1', 'ds-1', { content: '# Hello', status: 'synced' }, 'tenant-1');

            const callArg = mockPrisma.dataSource.updateMany.mock.calls[0][0];
            expect(callArg.data.content).toBe('# Hello');
            expect(callArg.data.status).toBe('synced');
        });
    });

    describe('getDataSourceContent', () => {
        it('returns content string, scoped by tenant/kb/ds', async () => {
            mockPrisma.dataSource.findFirst.mockResolvedValue({ content: '# Doc body' });

            const repo = new DataSourcePostgresRepository();
            const result = await repo.getDataSourceContent('kb-1', 'ds-1', 'tenant-1');

            expect(result).toBe('# Doc body');
            expect(mockPrisma.dataSource.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'ds-1', knowledgeBaseId: 'kb-1', tenantId: 'tenant-1' }),
                    select: { content: true },
                })
            );
        });

        it('returns null when row not found', async () => {
            mockPrisma.dataSource.findFirst.mockResolvedValue(null);
            const repo = new DataSourcePostgresRepository();
            expect(await repo.getDataSourceContent('kb-1', 'missing', 'tenant-1')).toBeNull();
        });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/data-source/postgres.test.ts`
Expected: FAIL — `getDataSourceContent is not a function`; content assertion fails.

- [ ] **Step 3: Update the Prisma schema**

In `libs/prisma/schema.prisma`, in `model DataSource` (after the `config` line, ~line 291) add:

```prisma
  content         String?   @db.Text  // markdown body for sourceType='document'; null otherwise
```

- [ ] **Step 4: Write the migration SQL**

Create `libs/prisma/migrations/20260705120000_add_data_source_content/migration.sql`:

```sql
-- Add editable document body column
ALTER TABLE "data_sources" ADD COLUMN "content" TEXT;

-- Allow the new 'document' source type
ALTER TABLE "data_sources" DROP CONSTRAINT "data_sources_source_type_check";
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_source_type_check"
    CHECK ("sourceType" IN ('file-upload', 's3-bucket', 'confluence', 'bitbucket', 'document'));
```

- [ ] **Step 5: Update the TypeScript types**

In `apps/web-ui/lib/knowledge-base/types.ts`:

Change the union (line 15):
```typescript
export type DataSourceType = 'file-upload' | 's3-bucket' | 'confluence' | 'bitbucket' | 'document';
```

Add `content` to the `DataSource` interface (after `vectorKeys: string[];`):
```typescript
  /** Markdown body for sourceType='document'. Write-through: never returned by list/detail DTOs — read via the documents content endpoint. */
  content?: string;
```

Add a config variant (after `BitbucketConfig`, before the `DataSourceConfig` union):
```typescript
export interface DocumentConfig {
  format: 'markdown';
  chunkCount: number;
}
```

Extend the union:
```typescript
export type DataSourceConfig =
  | FileUploadConfig
  | S3BucketConfig
  | ConfluenceConfig
  | BitbucketConfig
  | DocumentConfig;
```

- [ ] **Step 6: Update the repository interface**

In `apps/web-ui/lib/db/repositories/data-source/interface.ts`, add to `IDataSourceRepository`:

```typescript
    getDataSourceContent(kbId: string, dsId: string, tenantId: string): Promise<string | null>;
```

- [ ] **Step 7: Update the repository implementation**

In `apps/web-ui/lib/db/repositories/data-source/postgres.ts`:

Add `content` to the `allowedFields` array in `updateDataSource` (after `'config',`):
```typescript
                'content',
```

Add the new method after `getDataSource`:
```typescript
    async getDataSourceContent(kbId: string, dsId: string, tenantId: string): Promise<string | null> {
        try {
            const row = await getTenantClient(tenantId).dataSource.findFirst({
                where: { id: dsId, knowledgeBaseId: kbId, tenantId },
                select: { content: true },
            });
            return row?.content ?? null;
        } catch (error: unknown) {
            console.error('[DataSourcePostgresRepository] Error getting data source content:', error);
            throw new Error(`Failed to get data source content: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
```

Note: leave `rowToDS` unchanged — `content` is intentionally not mapped into the DTO. (Add `content: string | null` to `rowToDS`'s row param type only if the TS build complains about the Prisma row shape; do not add it to the return object.)

- [ ] **Step 8: Regenerate the Prisma client and run the tests**

Run:
```bash
cd apps/web-ui && bun run db:generate
bunx vitest run lib/db/repositories/data-source/postgres.test.ts
```
Expected: PASS (all tests, including the two new suites).

- [ ] **Step 9: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/20260705120000_add_data_source_content apps/web-ui/lib/knowledge-base/types.ts apps/web-ui/lib/db/repositories/data-source
git commit -m "feat(kb): add data_sources.content column + document source type"
```

---

### Task 2: Document validation helper

**Files:**
- Create: `apps/web-ui/lib/knowledge-base/document-validation.ts`
- Test: `apps/web-ui/lib/knowledge-base/document-validation.test.ts`

**Interfaces:**
- Produces: `validateDocumentInput(input: { name?: string; content?: string }): { ok: true; name: string; content: string } | { ok: false; error: string }` and `export const MAX_DOCUMENT_CHARS = 200_000;`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/knowledge-base/document-validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateDocumentInput, MAX_DOCUMENT_CHARS } from './document-validation';

describe('validateDocumentInput', () => {
    it('accepts a valid document and trims the name', () => {
        const r = validateDocumentInput({ name: '  Runbook  ', content: '# Steps' });
        expect(r).toEqual({ ok: true, name: 'Runbook', content: '# Steps' });
    });

    it('rejects an empty name', () => {
        const r = validateDocumentInput({ name: '   ', content: 'body' });
        expect(r).toEqual({ ok: false, error: 'name is required' });
    });

    it('rejects empty content', () => {
        const r = validateDocumentInput({ name: 'Doc', content: '   ' });
        expect(r).toEqual({ ok: false, error: 'content is required' });
    });

    it('rejects content over the size cap', () => {
        const r = validateDocumentInput({ name: 'Doc', content: 'a'.repeat(MAX_DOCUMENT_CHARS + 1) });
        expect(r.ok).toBe(false);
        expect((r as { error: string }).error).toContain('too large');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/knowledge-base/document-validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/web-ui/lib/knowledge-base/document-validation.ts`:

```typescript
/**
 * Validation for inline (authored) knowledge-base documents.
 * Pure — no I/O — so it is shared by the create route and the edit route.
 */

export const MAX_DOCUMENT_CHARS = 200_000;

export type DocumentValidationResult =
    | { ok: true; name: string; content: string }
    | { ok: false; error: string };

export function validateDocumentInput(input: { name?: string; content?: string }): DocumentValidationResult {
    const name = (input.name ?? '').trim();
    const content = (input.content ?? '').trim();

    if (!name) return { ok: false, error: 'name is required' };
    if (!content) return { ok: false, error: 'content is required' };
    if (content.length > MAX_DOCUMENT_CHARS) {
        return { ok: false, error: `Document is too large (max ${MAX_DOCUMENT_CHARS.toLocaleString()} characters)` };
    }
    return { ok: true, name, content };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/knowledge-base/document-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/knowledge-base/document-validation.ts apps/web-ui/lib/knowledge-base/document-validation.test.ts
git commit -m "feat(kb): add inline document validation helper"
```

---

### Task 3: Document API routes (create + read-content)

**Files:**
- Create: `apps/web-ui/app/api/knowledge-base/[kbId]/documents/route.ts` (POST — create)
- Create: `apps/web-ui/app/api/knowledge-base/[kbId]/documents/[dsId]/route.ts` (GET — read content)
- Test: `apps/web-ui/app/api/knowledge-base/[kbId]/documents/documents-route.test.ts`

**Interfaces:**
- Consumes: `validateDocumentInput` (Task 2); `KnowledgeBaseService.{getKnowledgeBase,createDataSource,updateDataSource,updateDataSourceCount,updateVectorCount}`; `getDataSourceContent` via `KnowledgeBaseService`; `chunkText`, `embedAndStoreChunks` from `@/lib/knowledge-base/embedder`.
- Produces:
  - `POST /api/knowledge-base/[kbId]/documents` `{ name, content }` → `201 { dataSource }` (embedded, status `synced`), `400 { error }` on validation / provider error, `403`/`500`.
  - `GET /api/knowledge-base/[kbId]/documents/[dsId]` → `200 { id, name, content }`, `404`/`403`.
  - `KnowledgeBaseService.getDataSourceContent(kbId, dsId, tenantId): Promise<string | null>` (delegates to the repo method from Task 1).

- [ ] **Step 1: Add the service passthrough**

In `apps/web-ui/lib/knowledge-base/service.ts`, add after `getDataSource`:

```typescript
    static async getDataSourceContent(kbId: string, dsId: string, tenantId: string): Promise<string | null> {
        return getDataSourceRepository().getDataSourceContent(kbId, dsId, tenantId);
    }
```

- [ ] **Step 2: Write the failing route test**

Create `apps/web-ui/app/api/knowledge-base/[kbId]/documents/documents-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-a'),
    getSessionUserId: vi.fn(),
}));
vi.mock('next-auth', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { email: 'test@example.com' } }),
}));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn(),
        createDataSource: vi.fn(),
        updateDataSource: vi.fn(),
        updateDataSourceCount: vi.fn(),
        updateVectorCount: vi.fn(),
    },
}));
vi.mock('@/lib/knowledge-base/embedder', () => ({
    chunkText: vi.fn(() => [{ text: 'c1', index: 0, total: 1, contentHash: 'h1' }]),
    embedAndStoreChunks: vi.fn().mockResolvedValue(['kb_kb-1_ds-1_0_h1']),
    deleteVectors: vi.fn().mockResolvedValue(undefined),
}));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { chunkText, embedAndStoreChunks } from '@/lib/knowledge-base/embedder';
import { POST } from '@/app/api/knowledge-base/[kbId]/documents/route';

const params = Promise.resolve({ kbId: 'kb-1' });

function req(body: unknown) {
    return new Request('http://t/api/knowledge-base/kb-1/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/knowledge-base/[kbId]/documents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1' } as any);
        vi.mocked(KnowledgeBaseService.createDataSource).mockResolvedValue({ id: 'ds-1', knowledgeBaseId: 'kb-1', name: 'Doc', sourceType: 'document', status: 'pending', config: {}, vectorCount: 0, vectorKeys: [], createdAt: '', updatedAt: '' } as any);
    });

    it('creates a document, embeds it, and returns 201', async () => {
        const res = await POST(req({ name: 'Doc', content: '# Body' }), { params });
        expect(res.status).toBe(201);
        expect(chunkText).toHaveBeenCalledWith('# Body', 'Doc');
        expect(embedAndStoreChunks).toHaveBeenCalledWith(
            expect.objectContaining({ sourceType: 'document', knowledgeBaseId: 'kb-1', dataSourceId: 'ds-1', tenantId: 'tenant-a' })
        );
        // marks synced with the returned vector keys
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb-1', 'ds-1',
            expect.objectContaining({ status: 'synced', vectorKeys: ['kb_kb-1_ds-1_0_h1'], vectorCount: 1, content: '# Body' }),
            'tenant-a',
        );
        expect(KnowledgeBaseService.updateVectorCount).toHaveBeenCalledWith('kb-1', 1, 'tenant-a');
    });

    it('rejects empty content with 400', async () => {
        const res = await POST(req({ name: 'Doc', content: '' }), { params });
        expect(res.status).toBe(400);
        expect(embedAndStoreChunks).not.toHaveBeenCalled();
    });

    it('returns 403 when the KB is not owned by the tenant', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await POST(req({ name: 'Doc', content: '# Body' }), { params });
        expect(res.status).toBe(403);
    });

    it('sets status=error but preserves content when embedding fails', async () => {
        vi.mocked(embedAndStoreChunks).mockRejectedValueOnce(new Error('bedrock down'));
        const res = await POST(req({ name: 'Doc', content: '# Body' }), { params });
        expect(res.status).toBe(500);
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb-1', 'ds-1',
            expect.objectContaining({ status: 'error', content: '# Body' }),
            'tenant-a',
        );
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run "app/api/knowledge-base/[kbId]/documents/documents-route.test.ts"`
Expected: FAIL — route module not found.

- [ ] **Step 4: Implement the create route**

Create `apps/web-ui/app/api/knowledge-base/[kbId]/documents/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { validateDocumentInput } from '@/lib/knowledge-base/document-validation';
import { chunkText, embedAndStoreChunks } from '@/lib/knowledge-base/embedder';

// POST /api/knowledge-base/[kbId]/documents — create an inline markdown document
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ kbId: string }> },
) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { kbId } = await params;
    const tenantId = await getSessionTenantId();
    const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
    if (!kb) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const valid = validateDocumentInput(body as { name?: string; content?: string });
    if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });
    const { name, content } = valid;

    // Create the record first (pending), then embed synchronously.
    const ds = await KnowledgeBaseService.createDataSource(kbId, {
        name,
        sourceType: 'document',
        config: { format: 'markdown', chunkCount: 0 },
    }, tenantId);
    await KnowledgeBaseService.updateDataSourceCount(kbId, 1, tenantId);

    try {
        const chunks = chunkText(content, name);
        const vectorKeys = await embedAndStoreChunks({
            chunks,
            knowledgeBaseId: kbId,
            dataSourceId: ds.id,
            sourceType: 'document',
            documentName: name,
            tenantId,
        });

        await KnowledgeBaseService.updateDataSource(kbId, ds.id, {
            content,
            status: 'synced',
            vectorKeys,
            vectorCount: vectorKeys.length,
            config: { format: 'markdown', chunkCount: vectorKeys.length },
            lastSyncAt: new Date().toISOString(),
        }, tenantId);
        await KnowledgeBaseService.updateVectorCount(kbId, vectorKeys.length, tenantId);

        AuditService.logUserAction({
            eventType: 'kb.document.created', severity: 'low',
            apiRoute: 'POST /api/knowledge-base/[kbId]/documents', httpMethod: 'POST',
            action: 'Created Document', resourceType: 'kb', resourceId: ds.id, resourceName: name,
            user: session?.user?.email || 'unknown', userType: 'user', status: 'success',
            details: `Created document "${name}" in knowledge base ${kbId}`,
            metadata: { tenantId, kbId, chunkCount: vectorKeys.length },
        }).catch(() => {});

        const updated = await KnowledgeBaseService.getDataSource(kbId, ds.id, tenantId);
        return NextResponse.json({ dataSource: updated }, { status: 201 });
    } catch (error) {
        const isProviderError = error instanceof Error && error.name === 'ProviderConfigError';
        const message = error instanceof Error ? error.message : 'Failed to embed document';
        // Preserve content so the user can retry with an edit.
        await KnowledgeBaseService.updateDataSource(kbId, ds.id, {
            content,
            status: 'error',
            lastErrorMessage: isProviderError ? 'No embedding provider configured' : 'Failed to process document',
            lastErrorDetail: message,
        }, tenantId).catch(() => {});
        return NextResponse.json({ error: message }, { status: isProviderError ? 400 : 500 });
    }
}
```

- [ ] **Step 5: Implement the read-content route**

Create `apps/web-ui/app/api/knowledge-base/[kbId]/documents/[dsId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';

// GET /api/knowledge-base/[kbId]/documents/[dsId] — read a document's markdown body
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ kbId: string; dsId: string }> },
) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { kbId, dsId } = await params;
    const tenantId = await getSessionTenantId();
    const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
    if (!kb) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

    const ds = await KnowledgeBaseService.getDataSource(kbId, dsId, tenantId);
    if (!ds || ds.sourceType !== 'document') {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    const content = await KnowledgeBaseService.getDataSourceContent(kbId, dsId, tenantId);
    return NextResponse.json({ id: ds.id, name: ds.name, content: content ?? '' });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run "app/api/knowledge-base/[kbId]/documents/documents-route.test.ts"`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/knowledge-base/service.ts "apps/web-ui/app/api/knowledge-base/[kbId]/documents"
git commit -m "feat(kb): document create + read-content API routes"
```

---

### Task 4: Extend the source PUT for document re-embed

**Files:**
- Modify: `apps/web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts`
- Test: `apps/web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/put-document.test.ts`

**Interfaces:**
- Consumes: `validateDocumentInput`, `chunkText`, `embedAndStoreChunks`, `deleteVectors`, `KnowledgeBaseService.{getDataSource,updateDataSource,updateVectorCount}`.
- Produces: `PUT /api/knowledge-base/[kbId]/sources/[dsId]` — when the source is a `document` and `content` is present, deletes old vectors, re-embeds, updates `content`/`vectorKeys`/`vectorCount`, and reconciles the KB vector count by the delta. Non-document behavior (name/config merge) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/put-document.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn().mockResolvedValue('tenant-a') }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { email: 'u@e.com' } }) }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn().mockResolvedValue({ id: 'kb-1' }),
        getDataSource: vi.fn(),
        updateDataSource: vi.fn(),
        updateVectorCount: vi.fn(),
    },
}));
vi.mock('@/lib/knowledge-base/embedder', () => ({
    chunkText: vi.fn(() => [{ text: 'a', index: 0, total: 1, contentHash: 'h' }, { text: 'b', index: 1, total: 2, contentHash: 'h2' }]),
    embedAndStoreChunks: vi.fn().mockResolvedValue(['k1', 'k2']),
    deleteVectors: vi.fn().mockResolvedValue(undefined),
}));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { deleteVectors, embedAndStoreChunks } from '@/lib/knowledge-base/embedder';
import { PUT } from '@/app/api/knowledge-base/[kbId]/sources/[dsId]/route';

const params = Promise.resolve({ kbId: 'kb-1', dsId: 'ds-1' });
function req(body: unknown) {
    return new Request('http://t', { method: 'PUT', body: JSON.stringify(body) }) as unknown as import('next/server').NextRequest;
}

describe('PUT sources/[dsId] — document re-embed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.getDataSource)
            .mockResolvedValue({ id: 'ds-1', knowledgeBaseId: 'kb-1', name: 'Doc', sourceType: 'document', status: 'synced', config: {}, vectorCount: 1, vectorKeys: ['old1'], createdAt: '', updatedAt: '' } as any);
    });

    it('deletes old vectors, re-embeds, and reconciles the KB count by delta', async () => {
        await PUT(req({ content: '# New body' }), { params });
        expect(deleteVectors).toHaveBeenCalledWith(['old1']);
        expect(embedAndStoreChunks).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'document', dataSourceId: 'ds-1' }));
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb-1', 'ds-1',
            expect.objectContaining({ content: '# New body', vectorKeys: ['k1', 'k2'], vectorCount: 2, status: 'synced' }),
            'tenant-a',
        );
        // old count 1 → new count 2, delta +1
        expect(KnowledgeBaseService.updateVectorCount).toHaveBeenCalledWith('kb-1', 1, 'tenant-a');
    });

    it('does not re-embed when content is absent (name-only edit)', async () => {
        await PUT(req({ name: 'Renamed' }), { params });
        expect(deleteVectors).not.toHaveBeenCalled();
        expect(embedAndStoreChunks).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run "app/api/knowledge-base/[kbId]/sources/[dsId]/put-document.test.ts"`
Expected: FAIL — content path not handled (deleteVectors never called).

- [ ] **Step 3: Implement the PUT branch**

In `apps/web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts`:

Add imports at the top:
```typescript
import { chunkText, embedAndStoreChunks, deleteVectors } from '@/lib/knowledge-base/embedder';
import { validateDocumentInput } from '@/lib/knowledge-base/document-validation';
```

Replace the body-parsing + update section of `PUT` (the block from `const body = await request.json()...` down to `const updated = await KnowledgeBaseService.getDataSource(...)`) with:

```typescript
    const body = await request.json() as { name?: string; content?: string; config?: Record<string, unknown> };
    const updates: Partial<DataSource> = {};
    if (body.name?.trim()) updates.name = body.name.trim();

    // Document content edit → re-embed.
    if (ds.sourceType === 'document' && body.content !== undefined) {
        const valid = validateDocumentInput({ name: body.name ?? ds.name, content: body.content });
        if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });
        try {
            if (ds.vectorKeys.length > 0) await deleteVectors(ds.vectorKeys);
            const chunks = chunkText(valid.content, valid.name);
            const vectorKeys = await embedAndStoreChunks({
                chunks, knowledgeBaseId: kbId, dataSourceId: dsId,
                sourceType: 'document', documentName: valid.name, tenantId,
            });
            updates.content = valid.content;
            updates.vectorKeys = vectorKeys;
            updates.vectorCount = vectorKeys.length;
            updates.status = 'synced';
            updates.config = { format: 'markdown', chunkCount: vectorKeys.length };
            updates.lastSyncAt = new Date().toISOString();
            await KnowledgeBaseService.updateDataSource(kbId, dsId, updates, tenantId);
            await KnowledgeBaseService.updateVectorCount(kbId, vectorKeys.length - ds.vectorCount, tenantId);
        } catch (error) {
            const isProviderError = error instanceof Error && error.name === 'ProviderConfigError';
            const message = error instanceof Error ? error.message : 'Failed to embed document';
            await KnowledgeBaseService.updateDataSource(kbId, dsId, {
                content: valid.content, status: 'error',
                lastErrorMessage: isProviderError ? 'No embedding provider configured' : 'Failed to process document',
                lastErrorDetail: message,
            }, tenantId).catch(() => {});
            return NextResponse.json({ error: message }, { status: isProviderError ? 400 : 500 });
        }
    } else {
        if (body.config) updates.config = { ...ds.config, ...body.config } as DataSource['config'];
        await KnowledgeBaseService.updateDataSource(kbId, dsId, updates, tenantId);
    }

    const updated = await KnowledgeBaseService.getDataSource(kbId, dsId, tenantId);
```

Update the audit event type in this handler from `kb.datasource.updated` to remain as-is for config edits; for document edits it is acceptable to keep the same `kb.datasource.updated` event (no change required).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run "app/api/knowledge-base/[kbId]/sources/[dsId]/put-document.test.ts"`
Expected: PASS (2 tests). Also re-run the repo/validation suites to confirm no regressions:
`cd apps/web-ui && bunx vitest run lib/knowledge-base lib/db/repositories/data-source`

- [ ] **Step 5: Commit**

```bash
git add "apps/web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]"
git commit -m "feat(kb): re-embed document content on source PUT"
```

---

### Task 5: TanStack Query mutations for documents

**Files:**
- Modify: `apps/web-ui/lib/queries/knowledge-base.ts`

**Interfaces:**
- Produces:
  - `useCreateDocument(kbId: string)` → mutation `({ name, content }) => Promise<{ dataSource }>`.
  - `useUpdateDocument(kbId: string)` → mutation `({ dsId, name?, content }) => Promise<{ dataSource }>`.
  - Both invalidate `['knowledge-bases']` on success. (The detail page also calls its own `fetchKB()` refresh in `onSuccess` — see Task 6.)

- [ ] **Step 1: Add the hooks**

Append to `apps/web-ui/lib/queries/knowledge-base.ts` (before the final newline):

```typescript
export function useCreateDocument(kbId: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: { name: string; content: string }) => {
            const res = await fetch(`/api/knowledge-base/${kbId}/documents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Failed to create document');
            }
            return res.json();
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeBasesKey }),
    });
}

export function useUpdateDocument(kbId: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ dsId, ...body }: { dsId: string; name?: string; content: string }) => {
            const res = await fetch(`/api/knowledge-base/${kbId}/sources/${dsId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Failed to update document');
            }
            return res.json();
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeBasesKey }),
    });
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors in `lib/queries/knowledge-base.ts`. (The repo has a known tsc baseline; confirm no *new* errors in this file.)

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/queries/knowledge-base.ts
git commit -m "feat(kb): query hooks for document create/update"
```

---

### Task 6: Document editor UI + detail-page wiring

**Files:**
- Create: `apps/web-ui/components/knowledge-base/kb-document-editor.tsx`
- Modify: `apps/web-ui/app/app/knowledge-base/[kbId]/page.tsx`
- Modify (optional): `apps/web-ui/components/knowledge-base/kb-source-type-selector.tsx`

**Interfaces:**
- Consumes: `useCreateDocument`, `useUpdateDocument` (Task 5); `GET /api/knowledge-base/[kbId]/documents/[dsId]` (Task 3); `MAX_DOCUMENT_CHARS` (Task 2); `ReactMarkdown` + `remarkGfm` (already used in `kb-chat.tsx`).
- Produces: `KBDocumentEditor` — a dialog component:
  ```typescript
  interface KBDocumentEditorProps {
      kbId: string;
      /** Existing document to edit; omit for a new document. */
      doc?: { id: string; name: string };
      open: boolean;
      onClose: () => void;
      onSaved: () => void; // caller refreshes the KB
  }
  export function KBDocumentEditor(props: KBDocumentEditorProps): JSX.Element;
  ```

- [ ] **Step 1: Build the editor component**

Create `apps/web-ui/components/knowledge-base/kb-document-editor.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCreateDocument, useUpdateDocument } from '@/lib/queries/knowledge-base';
import { MAX_DOCUMENT_CHARS } from '@/lib/knowledge-base/document-validation';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  content: z.string().trim().min(1, 'Content is required').max(MAX_DOCUMENT_CHARS, 'Document is too large'),
});
type FormValues = z.infer<typeof schema>;

interface KBDocumentEditorProps {
  kbId: string;
  doc?: { id: string; name: string };
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function KBDocumentEditor({ kbId, doc, open, onClose, onSaved }: KBDocumentEditorProps) {
  const isEdit = !!doc;
  const create = useCreateDocument(kbId);
  const update = useUpdateDocument(kbId);
  const [loadingContent, setLoadingContent] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: doc?.name ?? '', content: '' },
  });
  const content = form.watch('content');

  // Load existing content when editing.
  useEffect(() => {
    if (!open) return;
    if (!doc) { form.reset({ name: '', content: '' }); return; }
    setLoadingContent(true);
    fetch(`/api/knowledge-base/${kbId}/documents/${doc.id}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('Failed to load document')))
      .then((d) => form.reset({ name: d.name ?? doc.name, content: d.content ?? '' }))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load document'))
      .finally(() => setLoadingContent(false));
  }, [open, doc, kbId, form]);

  const submitting = create.isPending || update.isPending;

  const onSubmit = async (values: FormValues) => {
    try {
      if (isEdit && doc) {
        await update.mutateAsync({ dsId: doc.id, name: values.name, content: values.content });
        toast.success(`"${values.name}" updated`);
      } else {
        await create.mutateAsync({ name: values.name, content: values.content });
        toast.success(`"${values.name}" created`);
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Document' : 'New Document'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input placeholder="e.g. Incident runbook" disabled={submitting || loadingContent} {...form.register('name')} />
            {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
          </div>

          <Tabs defaultValue="write">
            <TabsList>
              <TabsTrigger value="write" type="button">Write</TabsTrigger>
              <TabsTrigger value="preview" type="button">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="write">
              <Textarea
                className="min-h-[320px] font-mono text-sm"
                placeholder="Write markdown…"
                disabled={submitting || loadingContent}
                {...form.register('content')}
              />
              {form.formState.errors.content && <p className="text-xs text-destructive">{form.formState.errors.content.message}</p>}
            </TabsContent>
            <TabsContent value="preview">
              <div className="prose prose-sm dark:prose-invert max-w-none min-h-[320px] rounded-md border p-4 overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '_Nothing to preview_'}</ReactMarkdown>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={submitting || loadingContent}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

Note: confirm `@/components/ui/textarea` and `@/components/ui/tabs` exist (shadcn primitives). If `textarea` is missing, add it via the standard shadcn pattern; the repo already uses Radix Tabs elsewhere.

- [ ] **Step 2: Wire the "New Document" button + edit branch into the detail page**

In `apps/web-ui/app/app/knowledge-base/[kbId]/page.tsx`:

1. Import the editor and add `FileText` to the lucide import:
```tsx
import { KBDocumentEditor } from '@/components/knowledge-base/kb-document-editor';
```
Add `FileText` to the existing `lucide-react` import list.

2. Add state near the other dialog state (`const [editDs, setEditDs] = ...`):
```tsx
  const [docEditor, setDocEditor] = useState<{ mode: 'new' } | { mode: 'edit'; doc: { id: string; name: string } } | null>(null);
```

3. In `SOURCE_TYPE_LABELS` add:
```tsx
  'document': 'Document',
```

4. In `DataSourceIcon`, add a case before `default`:
```tsx
    case 'document': return <FileText className={className} />;
```

5. In the "Data Sources" `CardHeader`, add a "New Document" button before the existing "Add Data Source" button:
```tsx
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDocEditor({ mode: 'new' })}>
                <FileText className="h-3.5 w-3.5" /> New Document
              </Button>
```

6. Change the row Edit button so documents open the editor:
```tsx
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => ds.sourceType === 'document'
                          ? setDocEditor({ mode: 'edit', doc: { id: ds.id, name: ds.name } })
                          : setEditDs(ds)}
                        title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
```

7. Render the editor near the bottom, after the existing `EditDialog` block:
```tsx
      {docEditor && (
        <KBDocumentEditor
          kbId={kbId}
          doc={docEditor.mode === 'edit' ? docEditor.doc : undefined}
          open={!!docEditor}
          onClose={() => setDocEditor(null)}
          onSaved={() => { setDocEditor(null); fetchKB(); }}
        />
      )}
```

- [ ] **Step 3: (Optional) Add a "Document" card to the source-type selector**

In `apps/web-ui/components/knowledge-base/kb-source-type-selector.tsx`, add to `SOURCE_TYPE_OPTIONS` (first entry, so it leads):
```tsx
  {
    type: 'document',
    icon: FileText,
    title: 'Document',
    description: 'Write a markdown doc inline',
  },
```
Add `FileText` to the `lucide-react` import. Then in `sources/new/page.tsx`, when the selected type is `'document'`, route to the detail page and open the editor (or render `KBDocumentEditor` inline). If this adds complexity, skip the card — the "New Document" button from Step 2 is the primary entry point.

- [ ] **Step 4: Verify build + lint**

Run:
```bash
cd apps/web-ui && bunx tsc --noEmit && bun run lint
```
Expected: no new type or lint errors in the changed files.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/knowledge-base/kb-document-editor.tsx "apps/web-ui/app/app/knowledge-base/[kbId]/page.tsx" apps/web-ui/components/knowledge-base/kb-source-type-selector.tsx
git commit -m "feat(kb): inline document editor + detail-page wiring"
```

---

### Task 7: End-to-end verification (Playwright)

**Files:**
- Create: `apps/web-ui-e2e/kb-documents.spec.ts`

**Preconditions:** Dev server running (auto-started by the e2e `webServer` config) with a **configured embedding provider** for the test tenant (documents embed synchronously; without a provider, create returns 400 by design). If no provider is configured in the test env, mark this spec `test.skip` with a comment and rely on the unit/route tests.

- [ ] **Step 1: Write the E2E spec**

Create `apps/web-ui-e2e/kb-documents.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

// Requires a knowledge base to exist and an embedding provider configured for the tenant.
test.describe('KB inline documents', () => {
  test('create a document and see it in the data sources list', async ({ page }) => {
    await page.goto('/app/knowledge-base');
    // Open the first knowledge base.
    await page.getByRole('link', { name: /knowledge base/i }).first().click().catch(() => {});
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'New Document' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const name = `E2E Doc ${Date.now()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByPlaceholder('Write markdown…').fill('# Heading\n\nBody text for embedding.');

    // Preview renders markdown.
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page.getByRole('heading', { name: 'Heading' })).toBeVisible();

    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText(name)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the E2E spec**

Run: `cd apps/web-ui-e2e && bunx playwright test kb-documents.spec.ts`
Expected: PASS (or SKIP if no provider is configured — see preconditions).

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui-e2e/kb-documents.spec.ts
git commit -m "test(kb): e2e for inline document create"
```

---

## Plan self-review

- **Spec coverage:** data model (Task 1), synchronous embed on create (Task 3), re-embed on edit with delete-then-insert + count delta (Task 4), markdown editor + preview (Task 6), size cap / empty / provider-error guards (Task 2 + Tasks 3–4), auth+audit pattern (Tasks 3–4), query hooks (Task 5), retrieval unchanged (no task needed), optional selector card (Task 6 Step 3). ✓
- **Refinement vs spec:** content is read via a dedicated `GET /documents/[dsId]` endpoint and kept out of the `DataSource` DTO, rather than being included in the sources GET and stripped from the list — documented at the top. Same design, no leakage risk.
- **Type consistency:** `embedAndStoreChunks({ chunks, knowledgeBaseId, dataSourceId, sourceType, documentName, tenantId })` and `chunkText(text, documentName)` and `deleteVectors(keys)` match `embedder.ts`. `validateDocumentInput` returns `{ ok, name, content } | { ok, error }` consistently across Tasks 2–4. `DataSourceType` includes `'document'` everywhere it is checked.
- **Out of scope (unchanged):** folders, versioning, collaborative editing, per-chunk viewing, RBAC `authorize()` hardening.
