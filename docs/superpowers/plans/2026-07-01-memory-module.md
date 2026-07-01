# Memory Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated "Memory" UI module that lists, searches, filters, and deletes the agent-generated memories already stored in the `agent_memories` table.

**Architecture:** A standard vertical slice mirroring the certificate-manager module: a pure category helper → repository (interface + postgres, tenant-scoped via `getTenantClient`) → API routes (`GET` list, `GET`/`DELETE` by id) guarded by `authorize(action,'Memory')` → TanStack Query hooks → a client table UI with category filter + search + detail/delete dialogs → nav entry. No Prisma schema migration and no agent-code changes — the `AgentMemory` model and its writer (`memorySaveNode`) already exist.

**Tech Stack:** Next.js 15 App Router, React 19, Prisma (`db.agentMemory`), TanStack Query v5, sonner toasts, Radix/shadcn UI primitives (`table`, `dialog`, `alert-dialog`, `dropdown-menu`, `select`, `input`, `badge`), Vitest.

## Global Constraints

- **Repository pattern:** API routes never call Prisma directly — go through `@/lib/db/repository-factory`. Repositories use `getTenantClient(tenantId)` from `@/lib/db/pg-config` (auto-scopes `WHERE tenant_id`).
- **Tenant scope:** every query/mutation is scoped to the caller's tenant; cross-tenant access returns 404.
- **No schema change:** do NOT edit `libs/prisma/schema.prisma`. The `AgentMemory` model (`@@map("agent_memories")`, fields `id, tenantId, userId, namespace, key, value Json, embedding, createdAt, updatedAt, expiresAt`) already exists. Prisma client accessor is `db.agentMemory`.
- **`value` JSON shape:** `{ fact: string; source: string; confidence: "high"|"medium"|"low" }` — but treat every field as possibly-missing/wrong-typed; extract defensively.
- **RBAC:** new subject `Memory` mapped to existing module `AIOps`. `read` to view, `delete` to remove. No new module in the permission matrix.
- **API envelope:** `NextResponse.json({ success: true, data })` or `{ success: false, error: string }`; 401 on `Unauthenticated`, 403 from `authorize`, 404 on missing/cross-tenant, 500 otherwise.
- **Path alias:** `@/` → `apps/web-ui/`. Indentation in lib/service/API files is 4 spaces; UI components use 2 or 4 spaces (match neighboring files in the same folder).
- **Test runner:** `cd apps/web-ui && bun run test` runs Vitest once (`vitest run`). Run a single file with `bunx vitest run <path>`.

---

### Task 1: Category helper (pure function)

**Files:**
- Create: `apps/web-ui/lib/agent-memory/category.ts`
- Test: `apps/web-ui/lib/agent-memory/category.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MemoryCategory = 'infra' | 'user' | 'patterns' | 'errors' | 'other'`
  - `const KNOWN_CATEGORIES: MemoryCategory[]` (the four non-`other` values, in display order)
  - `function categoryFromNamespace(namespace: string): MemoryCategory` — lower-cases the first `/`-segment of the namespace and maps it to a known category, else `'other'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web-ui/lib/agent-memory/category.test.ts
import { describe, it, expect } from 'vitest';
import { categoryFromNamespace, KNOWN_CATEGORIES } from './category';

describe('categoryFromNamespace', () => {
    it('maps known first segments to their category', () => {
        expect(categoryFromNamespace('infra/acct-123')).toBe('infra');
        expect(categoryFromNamespace('user/preferences')).toBe('user');
        expect(categoryFromNamespace('patterns/ecs')).toBe('patterns');
        expect(categoryFromNamespace('errors/rds')).toBe('errors');
    });

    it('is case-insensitive on the first segment', () => {
        expect(categoryFromNamespace('INFRA/x')).toBe('infra');
    });

    it('matches a bare segment with no slash', () => {
        expect(categoryFromNamespace('user')).toBe('user');
    });

    it('falls back to "other" for unknown or empty namespaces', () => {
        expect(categoryFromNamespace('billing/x')).toBe('other');
        expect(categoryFromNamespace('')).toBe('other');
    });

    it('exposes the four known categories in display order', () => {
        expect(KNOWN_CATEGORIES).toEqual(['infra', 'user', 'patterns', 'errors']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-memory/category.test.ts`
Expected: FAIL — cannot resolve `./category`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web-ui/lib/agent-memory/category.ts

/** UI bucket derived from an AgentMemory namespace's first path segment. */
export type MemoryCategory = 'infra' | 'user' | 'patterns' | 'errors' | 'other';

/** The four agent-written namespace prefixes, in the order the UI shows them. */
export const KNOWN_CATEGORIES: MemoryCategory[] = ['infra', 'user', 'patterns', 'errors'];

/**
 * Memories store `namespace` as a slash-joined string (e.g. "infra/<account-id>",
 * "user/preferences"). The category is the first segment, lower-cased; anything
 * outside the known set falls into "other".
 */
export function categoryFromNamespace(namespace: string): MemoryCategory {
    const first = (namespace || '').split('/')[0]?.toLowerCase() ?? '';
    return (KNOWN_CATEGORIES as string[]).includes(first)
        ? (first as MemoryCategory)
        : 'other';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-memory/category.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent-memory/category.ts apps/web-ui/lib/agent-memory/category.test.ts
git commit -m "feat(memory): add namespace→category helper"
```

---

### Task 2: Repository (interface + postgres) + factory + RBAC subject

**Files:**
- Create: `apps/web-ui/lib/db/repositories/agent-memory/interface.ts`
- Create: `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts`
- Create: `apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts`
- Modify: `apps/web-ui/lib/db/repository-factory.ts`
- Modify: `apps/web-ui/lib/rbac/types.ts:38` (add to `SUBJECT_TO_MODULE`)

**Interfaces:**
- Consumes: `categoryFromNamespace`, `MemoryCategory`, `KNOWN_CATEGORIES` from Task 1; `getTenantClient` from `@/lib/db/pg-config`.
- Produces:
  - `interface AgentMemoryRecord { id; tenantId; userId; namespace; category: MemoryCategory; key; fact: string; source: string | null; confidence: string | null; value: Record<string, unknown>; createdAt: string; updatedAt: string; expiresAt: string }`
  - `interface AgentMemoryFilters { tenantId: string; category?: MemoryCategory; search?: string; page?: number; limit?: number }`
  - `interface AgentMemoryPage { memories: AgentMemoryRecord[]; total: number }`
  - `interface IAgentMemoryRepository { listByTenant(filters): Promise<AgentMemoryPage>; getById(tenantId, id): Promise<AgentMemoryRecord | null>; deleteById(tenantId, id): Promise<void> }`
  - `function getAgentMemoryRepository(): IAgentMemoryRepository` (factory)

- [ ] **Step 1: Write the interface file**

```ts
// apps/web-ui/lib/db/repositories/agent-memory/interface.ts
import type { MemoryCategory } from '@/lib/agent-memory/category';

export interface AgentMemoryRecord {
    id: string;
    tenantId: string;
    userId: string;
    namespace: string;
    category: MemoryCategory;
    key: string;
    fact: string;
    source: string | null;
    confidence: string | null;
    /** Full raw `value` JSON for the detail view. */
    value: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}

export interface AgentMemoryFilters {
    tenantId: string;
    category?: MemoryCategory;
    search?: string;
    page?: number;
    limit?: number;
}

export interface AgentMemoryPage {
    memories: AgentMemoryRecord[];
    total: number;
}

export interface IAgentMemoryRepository {
    listByTenant(filters: AgentMemoryFilters): Promise<AgentMemoryPage>;
    getById(tenantId: string, id: string): Promise<AgentMemoryRecord | null>;
    deleteById(tenantId: string, id: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing repository test**

```ts
// apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
    getTenantClient: vi.fn(),
}));

import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import { AgentMemoryPostgresRepository } from './postgres';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'mem-1',
    tenantId: 't1',
    userId: 'u1',
    namespace: 'infra/acct-123',
    key: 'prod-ecs-region',
    value: { fact: 'prod ECS runs in us-east-1', source: 'discovery scan', confidence: 'high' },
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-02T00:00:00Z'),
    expiresAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
});

describe('AgentMemoryPostgresRepository', () => {
    let mockPrisma: {
        agentMemory: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma = {
            agentMemory: {
                findMany: vi.fn().mockResolvedValue([makeRow()]),
                count: vi.fn().mockResolvedValue(1),
                findFirst: vi.fn().mockResolvedValue(makeRow()),
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('listByTenant scopes to tenantId and flattens value into fact/source/confidence/category', async () => {
        const repo = new AgentMemoryPostgresRepository();
        const result = await repo.listByTenant({ tenantId: 't1' });

        expect(getTenantClient).toHaveBeenCalledWith('t1');
        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.tenantId).toBe('t1');
        expect(result.total).toBe(1);
        expect(result.memories[0]).toMatchObject({
            id: 'mem-1',
            category: 'infra',
            fact: 'prod ECS runs in us-east-1',
            source: 'discovery scan',
            confidence: 'high',
        });
    });

    it('listByTenant translates a known category to a namespace startsWith/equals predicate', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', category: 'patterns' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            { OR: [{ namespace: { startsWith: 'patterns/' } }, { namespace: 'patterns' }] },
        ]);
    });

    it('listByTenant translates the "other" category to a negated known-prefix filter', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', category: 'other' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND[0]).toHaveProperty('NOT.OR');
    });

    it('listByTenant searches key and value.fact', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', search: 'ecs' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            {
                OR: [
                    { key: { contains: 'ecs', mode: 'insensitive' } },
                    { value: { path: ['fact'], string_contains: 'ecs' } },
                ],
            },
        ]);
    });

    it('getById is scoped by tenantId — cross-tenant returns null', async () => {
        mockPrisma.agentMemory.findFirst.mockResolvedValue(null);
        const repo = new AgentMemoryPostgresRepository();
        const result = await repo.getById('other-tenant', 'mem-1');

        expect(mockPrisma.agentMemory.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'mem-1', tenantId: 'other-tenant' } })
        );
        expect(result).toBeNull();
    });

    it('deleteById deletes only the tenant-scoped row', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.deleteById('t1', 'mem-1');

        expect(getTenantClient).toHaveBeenCalledWith('t1');
        expect(mockPrisma.agentMemory.deleteMany).toHaveBeenCalledWith({
            where: { id: 'mem-1', tenantId: 't1' },
        });
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: FAIL — cannot resolve `./postgres`.

- [ ] **Step 4: Write the repository implementation**

```ts
// apps/web-ui/lib/db/repositories/agent-memory/postgres.ts
import { getTenantClient } from '@/lib/db/pg-config';
import { categoryFromNamespace, KNOWN_CATEGORIES } from '@/lib/agent-memory/category';
import type {
    IAgentMemoryRepository,
    AgentMemoryRecord,
    AgentMemoryFilters,
    AgentMemoryPage,
} from './interface';

type MemoryRow = {
    id: string;
    tenantId: string;
    userId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
};

function asString(v: unknown): string | null {
    return typeof v === 'string' ? v : null;
}

function toRecord(row: MemoryRow): AgentMemoryRecord {
    const value = (row.value && typeof row.value === 'object' ? row.value : {}) as Record<
        string,
        unknown
    >;
    return {
        id: row.id,
        tenantId: row.tenantId,
        userId: row.userId,
        namespace: row.namespace,
        category: categoryFromNamespace(row.namespace),
        key: row.key,
        fact: asString(value.fact) ?? '',
        source: asString(value.source),
        confidence: asString(value.confidence),
        value,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
    };
}

export class AgentMemoryPostgresRepository implements IAgentMemoryRepository {
    async listByTenant(filters: AgentMemoryFilters): Promise<AgentMemoryPage> {
        const db = getTenantClient(filters.tenantId);
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 50;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { tenantId: filters.tenantId };
        const and: unknown[] = [];

        if (filters.category && filters.category !== 'other') {
            const c = filters.category;
            and.push({ OR: [{ namespace: { startsWith: `${c}/` } }, { namespace: c }] });
        } else if (filters.category === 'other') {
            and.push({
                NOT: {
                    OR: KNOWN_CATEGORIES.flatMap((c) => [
                        { namespace: { startsWith: `${c}/` } },
                        { namespace: c },
                    ]),
                },
            });
        }

        if (filters.search) {
            and.push({
                OR: [
                    { key: { contains: filters.search, mode: 'insensitive' } },
                    // JSON path filter on value.fact (Postgres). string_contains is
                    // case-sensitive in Prisma — acceptable for a fact substring match.
                    { value: { path: ['fact'], string_contains: filters.search } },
                ],
            });
        }

        if (and.length) where.AND = and;

        const [rows, total] = await Promise.all([
            db.agentMemory.findMany({
                where,
                orderBy: { updatedAt: 'desc' },
                skip,
                take: limit,
            }),
            db.agentMemory.count({ where }),
        ]);

        return { memories: (rows as MemoryRow[]).map(toRecord), total };
    }

    async getById(tenantId: string, id: string): Promise<AgentMemoryRecord | null> {
        const db = getTenantClient(tenantId);
        const row = await db.agentMemory.findFirst({ where: { id, tenantId } });
        return row ? toRecord(row as MemoryRow) : null;
    }

    async deleteById(tenantId: string, id: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.agentMemory.deleteMany({ where: { id, tenantId } });
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Register the repository in the factory**

In `apps/web-ui/lib/db/repository-factory.ts`, add the type import near the other repo imports (after line 27):

```ts
import type { IAgentMemoryRepository } from './repositories/agent-memory/interface';
```

And add the factory function (after `getPricingCatalogRepository`, before `isUsingPostgres`):

```ts
export function getAgentMemoryRepository(): IAgentMemoryRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentMemoryPostgresRepository } = require('./repositories/agent-memory/postgres');
    return new AgentMemoryPostgresRepository();
}
```

- [ ] **Step 7: Add the RBAC subject**

In `apps/web-ui/lib/rbac/types.ts`, inside the `SUBJECT_TO_MODULE` object, add this line directly after the `Agent: 'AIOps',` entry (line 33):

```ts
    Memory: 'AIOps',        // Agent memory module — gated with AI Ops (read=view, delete=prune)
```

- [ ] **Step 8: Typecheck and commit**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'agent-memory|repository-factory|rbac/types' || echo "no new type errors in touched files"`
Expected: `no new type errors in touched files` (the repo has a pre-existing tsc baseline; only confirm the new/edited files are clean).

```bash
git add apps/web-ui/lib/db/repositories/agent-memory apps/web-ui/lib/db/repository-factory.ts apps/web-ui/lib/rbac/types.ts
git commit -m "feat(memory): add agent-memory repository, factory, and RBAC subject"
```

---

### Task 3: API routes (list + detail/delete) with auth test

**Files:**
- Create: `apps/web-ui/app/api/agent-memories/route.ts`
- Create: `apps/web-ui/app/api/agent-memories/[id]/route.ts`
- Create: `apps/web-ui/app/api/agent-memories/agent-memories-api.test.ts`

**Interfaces:**
- Consumes: `getAgentMemoryRepository` (Task 2), `getSessionTenantId` from `@/lib/auth-session`, `authorize` from `@/lib/rbac/authorize`, `AuditService` from `@/lib/audit-service`, `getServerSession` + `authOptions`.
- Produces HTTP contracts:
  - `GET /api/agent-memories?category=&search=&page=&limit=` → `{ success: true, data: AgentMemoryRecord[], total: number }`
  - `GET /api/agent-memories/[id]` → `{ success: true, data: AgentMemoryRecord }` | 404
  - `DELETE /api/agent-memories/[id]` → `{ success: true }` | 404

- [ ] **Step 1: Write the failing API test**

```ts
// apps/web-ui/app/api/agent-memories/agent-memories-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
}));
vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn(),
}));
vi.mock('@/lib/db/repository-factory', () => ({
    getAgentMemoryRepository: vi.fn(),
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn() },
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { email: 'x@y.z' } }) }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { GET } from '@/app/api/agent-memories/route';
import { DELETE } from '@/app/api/agent-memories/[id]/route';

const repo = {
    listByTenant: vi.fn(),
    getById: vi.fn(),
    deleteById: vi.fn(),
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    vi.mocked(authorize).mockResolvedValue(null); // authorized by default
    vi.mocked(getAgentMemoryRepository).mockReturnValue(repo as any);
});

describe('GET /api/agent-memories', () => {
    it('scopes the list query to the session tenant and returns the envelope', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [{ id: 'mem-1' }], total: 1 });
        const req = new Request('http://localhost/api/agent-memories?category=infra&search=ecs');
        const res = await GET(req as any);
        const body = await res.json();

        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-a', category: 'infra', search: 'ecs' })
        );
        expect(body).toEqual({ success: true, data: [{ id: 'mem-1' }], total: 1 });
    });

    it('returns the 403 from authorize when permission is denied', async () => {
        vi.mocked(authorize).mockResolvedValue(
            NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        );
        const req = new Request('http://localhost/api/agent-memories');
        const res = await GET(req as any);
        expect(res.status).toBe(403);
        expect(repo.listByTenant).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/agent-memories/[id]', () => {
    it('returns 404 for a missing / cross-tenant memory and never deletes', async () => {
        repo.getById.mockResolvedValue(null);
        const req = new Request('http://localhost/api/agent-memories/mem-x', { method: 'DELETE' });
        const res = await DELETE(req as any, { params: Promise.resolve({ id: 'mem-x' }) });
        expect(res.status).toBe(404);
        expect(repo.deleteById).not.toHaveBeenCalled();
    });

    it('deletes an owned memory and returns success', async () => {
        repo.getById.mockResolvedValue({ id: 'mem-1', key: 'k', namespace: 'infra/a' });
        repo.deleteById.mockResolvedValue(undefined);
        const req = new Request('http://localhost/api/agent-memories/mem-1', { method: 'DELETE' });
        const res = await DELETE(req as any, { params: Promise.resolve({ id: 'mem-1' }) });
        const body = await res.json();
        expect(repo.deleteById).toHaveBeenCalledWith('tenant-a', 'mem-1');
        expect(body).toEqual({ success: true });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run app/api/agent-memories/agent-memories-api.test.ts`
Expected: FAIL — cannot resolve the route modules.

- [ ] **Step 3: Write the list route**

```ts
// apps/web-ui/app/api/agent-memories/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import type { MemoryCategory } from '@/lib/agent-memory/category';

const VALID_CATEGORIES = new Set<MemoryCategory>(['infra', 'user', 'patterns', 'errors', 'other']);

export async function GET(request: NextRequest) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Memory');
        if (authError) return authError;

        const { searchParams } = new URL(request.url);
        const rawCategory = searchParams.get('category');
        const category =
            rawCategory && VALID_CATEGORIES.has(rawCategory as MemoryCategory)
                ? (rawCategory as MemoryCategory)
                : undefined;

        const repo = getAgentMemoryRepository();
        const result = await repo.listByTenant({
            tenantId,
            category,
            search: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '100', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
        });

        return NextResponse.json({ success: true, data: result.memories, total: result.total });
    } catch (error: unknown) {
        console.error('API - Error fetching agent memories:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch memories';
        if (message.includes('Unauthenticated')) {
            return NextResponse.json({ success: false, error: message }, { status: 401 });
        }
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
```

- [ ] **Step 4: Write the detail/delete route**

```ts
// apps/web-ui/app/api/agent-memories/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Memory');
        if (authError) return authError;

        const { id } = await params;
        const repo = getAgentMemoryRepository();
        const memory = await repo.getById(tenantId, id);
        if (!memory) {
            return NextResponse.json({ success: false, error: 'Memory not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: memory });
    } catch (error: unknown) {
        console.error('API - Error fetching agent memory:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch memory';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('delete', 'Memory');
        if (authError) return authError;

        const { id } = await params;
        const repo = getAgentMemoryRepository();
        const memory = await repo.getById(tenantId, id);
        if (!memory) {
            return NextResponse.json({ success: false, error: 'Memory not found' }, { status: 404 });
        }

        await repo.deleteById(tenantId, id);

        const session = await getServerSession(authOptions);
        await AuditService.logUserAction({
            action: 'delete',
            resourceType: 'agent_memory',
            resourceId: id,
            resourceName: memory.key,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Agent memory "${memory.key}" (${memory.namespace}) deleted`,
            tenantId,
        });

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('API - Error deleting agent memory:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete memory';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run app/api/agent-memories/agent-memories-api.test.ts`
Expected: PASS (4 tests).

> If `AuditService.logUserAction`'s real signature differs from the fields above, match the call used in `apps/web-ui/app/api/certificates/[id]/route.ts:61` verbatim (it is the source of truth for this codebase) and re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/app/api/agent-memories
git commit -m "feat(memory): add agent-memories list + detail/delete API routes"
```

---

### Task 4: TanStack Query hooks + query keys

**Files:**
- Create: `apps/web-ui/lib/queries/agent-memories.ts`
- Modify: `apps/web-ui/lib/queries/query-keys.ts` (add `agentMemories` block before the closing `} as const;`)

**Interfaces:**
- Consumes: `queryKeys.agentMemories.*` (added this task); the API contracts from Task 3.
- Produces:
  - `interface MemoryRow { id; userId; namespace; category: MemoryCategory; key; fact; source; confidence; value; createdAt; updatedAt; expiresAt }`
  - `interface MemoryFilters { category?: MemoryCategory; search?: string; page?: number; limit?: number }`
  - `useAgentMemories(filters?: MemoryFilters)` → `{ data: { data: MemoryRow[]; total: number } }`
  - `useAgentMemory(id?: string)` → `{ data: MemoryRow }`
  - `useDeleteAgentMemory()` → mutation taking `id: string`

- [ ] **Step 1: Add the query-keys block**

In `apps/web-ui/lib/queries/query-keys.ts`, add this entry inside the `queryKeys` object, after the `kbChat` block (line 62) and before the closing `} as const;`:

```ts
    agentMemories: {
        all: ['agent-memories'] as const,
        lists: () => [...queryKeys.agentMemories.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.agentMemories.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.agentMemories.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.agentMemories.details(), id] as const,
    },
```

- [ ] **Step 2: Write the hooks file**

```ts
// apps/web-ui/lib/queries/agent-memories.ts
'use client';

/**
 * TanStack Query hooks for the Agent Memory module. Mirrors the certificates
 * hooks: each read parses the `{ success, data }` envelope and throws on
 * failure; the delete mutation invalidates `queryKeys.agentMemories.all`.
 * Toasts are fired at call sites via `sonner`, not here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type { MemoryCategory } from '@/lib/agent-memory/category';

export interface MemoryRow {
    id: string;
    userId: string;
    namespace: string;
    category: MemoryCategory;
    key: string;
    fact: string;
    source: string | null;
    confidence: string | null;
    value: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}

export interface MemoryFilters {
    category?: MemoryCategory;
    search?: string;
    page?: number;
    limit?: number;
}

export function useAgentMemories(filters?: MemoryFilters) {
    return useQuery({
        queryKey: queryKeys.agentMemories.list(filters),
        queryFn: async (): Promise<{ data: MemoryRow[]; total: number }> => {
            const params = new URLSearchParams();
            // The UI passes `undefined` for the All tab, so only real categories arrive here.
            if (filters?.category) params.set('category', filters.category);
            if (filters?.search?.trim()) params.set('search', filters.search.trim());
            params.set('limit', String(filters?.limit ?? 100));
            params.set('page', String(filters?.page ?? 1));

            const res = await fetch(`/api/agent-memories?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load memories');
            }
            return { data: json.data as MemoryRow[], total: json.total ?? 0 };
        },
        placeholderData: (prev) => prev,
    });
}

export function useAgentMemory(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.agentMemories.detail(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<MemoryRow> => {
            const res = await fetch(`/api/agent-memories/${id}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load memory');
            }
            return json.data as MemoryRow;
        },
    });
}

export function useDeleteAgentMemory() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            const res = await fetch(`/api/agent-memories/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to delete memory');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.agentMemories.all });
        },
    });
}
```

- [ ] **Step 3: Typecheck the new files**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'queries/agent-memories|query-keys' || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/queries/agent-memories.ts apps/web-ui/lib/queries/query-keys.ts
git commit -m "feat(memory): add agent-memories query hooks + keys"
```

---

### Task 5: UI — page, client component, dialogs, nav entry

**Files:**
- Create: `apps/web-ui/app/app/memory/page.tsx`
- Create: `apps/web-ui/components/memory/memory-client-component.tsx`
- Create: `apps/web-ui/components/memory/memory-detail-dialog.tsx`
- Create: `apps/web-ui/components/memory/delete-memory-dialog.tsx`
- Modify: `apps/web-ui/lib/nav-config.ts` (add a link under the "Agentic Ops" group)

**Interfaces:**
- Consumes: `useAgentMemories`, `useDeleteAgentMemory`, `MemoryRow` (Task 4); `MemoryCategory`, `KNOWN_CATEGORIES` (Task 1); UI primitives from `@/components/ui/*`; `PageHeader` from `@/components/shared/page-header`; `toast` from `sonner`.
- Produces: route `/app/memory`.

- [ ] **Step 1: Add the nav entry**

In `apps/web-ui/lib/nav-config.ts`, inside the `"Agentic Ops"` group's `items` array (after the `"Agent Ops"` link, line 33), add:

```ts
      { title: "Memory", href: "/app/memory" },
```

- [ ] **Step 2: Create the page route**

```tsx
// apps/web-ui/app/app/memory/page.tsx
import { Metadata } from "next";
import { MemoryClientComponent } from "@/components/memory/memory-client-component";

export const metadata: Metadata = {
    title: "Memory — Nucleus",
};

export default function MemoryPage() {
    return <MemoryClientComponent />;
}
```

- [ ] **Step 3: Create the delete confirmation dialog**

```tsx
// apps/web-ui/components/memory/delete-memory-dialog.tsx
"use client";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { MemoryRow } from "@/lib/queries/agent-memories";

export function DeleteMemoryDialog({
    target,
    pending,
    onCancel,
    onConfirm,
}: {
    target: MemoryRow | null;
    pending: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <AlertDialog open={!!target} onOpenChange={(open) => { if (!open) onCancel(); }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {target ? (
                            <>
                                The agent will forget <span className="font-medium">{target.key}</span>{" "}
                                ({target.namespace}). This can&apos;t be undone — but the agent may relearn
                                it on a future run.
                            </>
                        ) : null}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onConfirm} disabled={pending}>
                        {pending ? "Deleting…" : "Delete"}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
```

- [ ] **Step 4: Create the detail dialog**

```tsx
// apps/web-ui/components/memory/memory-detail-dialog.tsx
"use client";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import type { MemoryRow } from "@/lib/queries/agent-memories";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[120px_1fr] gap-2 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="break-words">{value}</span>
        </div>
    );
}

export function MemoryDetailDialog({
    memory,
    onClose,
}: {
    memory: MemoryRow | null;
    onClose: () => void;
}) {
    return (
        <Dialog open={!!memory} onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="break-words">{memory?.key}</DialogTitle>
                    <DialogDescription>{memory?.namespace}</DialogDescription>
                </DialogHeader>
                {memory ? (
                    <div className="space-y-3">
                        <Row label="Fact" value={memory.fact || <em className="text-muted-foreground">none</em>} />
                        <Row label="Source" value={memory.source ?? "—"} />
                        <Row
                            label="Confidence"
                            value={memory.confidence ? <Badge variant="secondary">{memory.confidence}</Badge> : "—"}
                        />
                        <Row label="Category" value={<Badge variant="outline">{memory.category}</Badge>} />
                        <Row label="Created" value={new Date(memory.createdAt).toLocaleString()} />
                        <Row label="Updated" value={new Date(memory.updatedAt).toLocaleString()} />
                        <Row label="Expires" value={new Date(memory.expiresAt).toLocaleString()} />
                        <div className="space-y-1">
                            <span className="text-sm text-muted-foreground">Raw value</span>
                            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
                                {JSON.stringify(memory.value, null, 2)}
                            </pre>
                        </div>
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 5: Create the client component (table + filter + search)**

```tsx
// apps/web-ui/components/memory/memory-client-component.tsx
"use client";

import { useState } from "react";
import { Brain } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { KNOWN_CATEGORIES, type MemoryCategory } from "@/lib/agent-memory/category";
import {
    useAgentMemories,
    useDeleteAgentMemory,
    type MemoryRow,
} from "@/lib/queries/agent-memories";
import { useDebounce } from "@/hooks/use-debounce";
import { MemoryDetailDialog } from "./memory-detail-dialog";
import { DeleteMemoryDialog } from "./delete-memory-dialog";

type Tab = "all" | MemoryCategory;
const TABS: Tab[] = ["all", ...KNOWN_CATEGORIES, "other"];
const TAB_LABEL: Record<Tab, string> = {
    all: "All",
    infra: "Infra",
    user: "User",
    patterns: "Patterns",
    errors: "Errors",
    other: "Other",
};

export function MemoryClientComponent() {
    const [tab, setTab] = useState<Tab>("all");
    const [searchInput, setSearchInput] = useState("");
    const search = useDebounce(searchInput, 300);
    const [detail, setDetail] = useState<MemoryRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<MemoryRow | null>(null);

    const { data, isLoading } = useAgentMemories({
        category: tab === "all" ? undefined : tab,
        search: search || undefined,
        limit: 200,
    });
    const memories = data?.data ?? [];
    const del = useDeleteAgentMemory();

    const handleDelete = () => {
        if (!deleteTarget) return;
        const target = deleteTarget;
        del.mutate(target.id, {
            onSuccess: () => {
                toast.success("Memory deleted", { description: target.key });
                setDeleteTarget(null);
            },
            onError: (e) => {
                toast.error("Failed to delete memory", {
                    description: e instanceof Error ? e.message : undefined,
                });
            },
        });
    };

    return (
        <div className="space-y-4">
            <PageHeader
                icon={Brain}
                title="Memory"
                description="What the AI Ops agent has learned across sessions. Review and prune as needed."
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1">
                    {TABS.map((t) => (
                        <Button
                            key={t}
                            variant={tab === t ? "default" : "outline"}
                            size="sm"
                            onClick={() => setTab(t)}
                        >
                            {TAB_LABEL[t]}
                        </Button>
                    ))}
                </div>
                <Input
                    placeholder="Search key or fact…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="w-full max-w-xs"
                />
            </div>

            {isLoading ? (
                <div className="flex justify-center py-16">
                    <Spinner />
                </div>
            ) : memories.length === 0 ? (
                <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
                    No memories yet — the AI Ops agent will populate these as it works.
                </div>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Category</TableHead>
                                <TableHead>Key</TableHead>
                                <TableHead>Fact</TableHead>
                                <TableHead>Confidence</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead>Expires</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {memories.map((m) => (
                                <TableRow
                                    key={m.id}
                                    className="cursor-pointer"
                                    onClick={() => setDetail(m)}
                                >
                                    <TableCell>
                                        <Badge variant="outline">{m.category}</Badge>
                                    </TableCell>
                                    <TableCell className="font-medium">{m.key}</TableCell>
                                    <TableCell className="max-w-md truncate">{m.fact}</TableCell>
                                    <TableCell>{m.confidence ?? "—"}</TableCell>
                                    <TableCell>{new Date(m.createdAt).toLocaleDateString()}</TableCell>
                                    <TableCell>{new Date(m.expiresAt).toLocaleDateString()}</TableCell>
                                    <TableCell className="text-right">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setDeleteTarget(m);
                                            }}
                                        >
                                            Delete
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <MemoryDetailDialog memory={detail} onClose={() => setDetail(null)} />
            <DeleteMemoryDialog
                target={deleteTarget}
                pending={del.isPending}
                onCancel={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
            />
        </div>
    );
}
```

- [ ] **Step 6: Verify prerequisites used by the component exist**

Run:
```bash
cd apps/web-ui && \
  ls components/shared/page-header.tsx hooks/use-debounce.ts components/ui/spinner.tsx components/ui/alert-dialog.tsx
```
Expected: all five paths listed (no "No such file").

- If `components/shared/page-header.tsx` does not exist or `PageHeader` does not accept `{ icon, title, description }`, open `apps/web-ui/components/certificates/certificate-client-component.tsx` and copy the exact `PageHeader` usage/import it uses, then adjust.
- If `useDebounce` is exported differently (e.g. named `useDebouncedValue`), check `apps/web-ui/hooks/use-debounce.ts` and use the correct export; if no debounce hook exists, drop the import and pass `search: searchInput || undefined` directly.

- [ ] **Step 7: Typecheck the UI files**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'components/memory|app/app/memory|nav-config' || echo "clean"`
Expected: `clean`.

- [ ] **Step 8: Manual smoke check**

Run the dev server and confirm the module renders:
```bash
cd apps/web-ui && bun run dev
```
Then visit `http://localhost:3001/app/memory`:
- "Memory" appears in the sidebar under **Agentic Ops**.
- The page loads (table of memories, or the empty state if `agent_memories` is empty).
- Category tabs filter; the search box narrows results; clicking a row opens the detail dialog; Delete asks for confirmation and removes the row with a success toast.

- [ ] **Step 9: Commit**

```bash
git add apps/web-ui/app/app/memory apps/web-ui/components/memory apps/web-ui/lib/nav-config.ts
git commit -m "feat(memory): add Memory module UI (page, table, dialogs, nav entry)"
```

---

### Final verification

- [ ] **Run the full web-ui test suite** to confirm no regressions from the new files:

Run: `cd apps/web-ui && bun run test 2>&1 | tail -30`
Expected: the three new test files pass; any failures are in the known pre-existing baseline (mock-harness fails noted in project memory), not in `agent-memory`, `agent-memories`, or `category` files.

- [ ] **Lint the touched files:**

Run: `cd apps/web-ui && bun run lint 2>&1 | grep -E 'agent-memor|memory|nav-config|query-keys|repository-factory|rbac' || echo "no lint issues in touched files"`
Expected: `no lint issues in touched files`.
