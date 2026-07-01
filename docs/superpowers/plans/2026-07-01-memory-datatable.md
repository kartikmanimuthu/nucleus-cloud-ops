# Memory Module shadcn Data-Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Memory module list view into the standard shadcn data-table (server-side pagination, debounced search, faceted multi-select category filter, per-row action dropdown).

**Architecture:** Backend gains multi-category filtering (repo + API) on top of its existing `page`/`limit`/`total` support. The shared `DataTable` primitive gets opt-in manual (server) pagination props. A new shadcn faceted-filter primitive is added. `memory-client-component.tsx` is rewritten to render the `DataTable` in manual-pagination mode with a search + faceted-category toolbar and a per-row `DropdownMenu` (View / Delete). Existing detail + delete dialogs and the delete API route are reused unchanged.

**Tech Stack:** Next.js 15 / React 19, TanStack Query v5, TanStack Table v8, shadcn/ui (Radix), Tailwind, Prisma (repository pattern), Vitest.

## Global Constraints

- Data access only via the repository factory (`@/lib/db/repository-factory`) — never Prisma directly in routes. (Repo internals use `getTenantClient`.)
- Every query is tenant-scoped; mutating routes call `authorize(action, Subject)`. (No new routes here — reuse existing.)
- UI: TanStack Query hooks in `lib/queries/<domain>.ts` (keys via `lib/queries/query-keys.ts`); toasts via `import { toast } from "sonner"`; `cn()` from `@/lib/utils`; `@/` import alias.
- Do NOT modify `components/ui/*` primitives except the two explicitly named here (`data-table.tsx` — additive props; new `data-table-faceted-filter.tsx`).
- Indentation: 4 spaces in `lib/`/service/api files; 2 spaces in `components/ui/*`. Match the file you edit.
- web-ui tests: `cd apps/web-ui && bun run test` (Vitest, `vitest run`). Lint: `cd apps/web-ui && bun run lint`.
- The single-row delete endpoint (`DELETE /api/agent-memories/[id]`) and RBAC (`read`/`delete` on `Memory`) are unchanged. No bulk actions.

---

### Task 1: Repository — multi-category filter

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/interface.ts`
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts`
- Test: `apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts`

**Interfaces:**
- Consumes: existing `AgentMemoryFilters`, `KNOWN_CATEGORIES`, `categoryFromNamespace`, `MemoryCategory`.
- Produces: `AgentMemoryFilters.categories?: MemoryCategory[]`. When `categories` is non-empty it takes precedence over the single `category`; the `where.AND` gets `[{ OR: [<per-category clause>, …] }]` for >1 category, or the bare per-category clause for exactly 1 (preserving current single-category shape). Single-category clause = `{ OR: [{ namespace: { startsWith: `${c}/` } }, { namespace: c }] }`; `other` = `{ NOT: { OR: <all known prefix clauses> } }`.

- [ ] **Step 1: Add the `categories` field to the filter interface**

In `interface.ts`, add one line inside `AgentMemoryFilters`:

```typescript
export interface AgentMemoryFilters {
    tenantId: string;
    category?: MemoryCategory;
    /** Multi-select category filter; takes precedence over `category` when non-empty. */
    categories?: MemoryCategory[];
    search?: string;
    page?: number;
    limit?: number;
}
```

- [ ] **Step 2: Write the failing tests**

Append these tests inside the `describe('AgentMemoryPostgresRepository', …)` block in `postgres.test.ts`:

```typescript
    it('listByTenant builds an OR of per-category predicates for multiple categories', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', categories: ['infra', 'user'] });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            {
                OR: [
                    { OR: [{ namespace: { startsWith: 'infra/' } }, { namespace: 'infra' }] },
                    { OR: [{ namespace: { startsWith: 'user/' } }, { namespace: 'user' }] },
                ],
            },
        ]);
    });

    it('listByTenant with a single-element categories array keeps the bare per-category shape', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', categories: ['patterns'] });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            { OR: [{ namespace: { startsWith: 'patterns/' } }, { namespace: 'patterns' }] },
        ]);
    });

    it('listByTenant paginates via skip/take and returns count as total', async () => {
        mockPrisma.agentMemory.count.mockResolvedValue(42);
        const repo = new AgentMemoryPostgresRepository();
        const result = await repo.listByTenant({ tenantId: 't1', page: 3, limit: 10 });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.skip).toBe(20);
        expect(arg.take).toBe(10);
        expect(result.total).toBe(42);
    });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: the two `categories` tests FAIL (current code ignores `categories`, so `where.AND` is `[]` / `undefined`). The pagination test should PASS already (it documents existing behavior).

- [ ] **Step 4: Implement multi-category filtering**

In `postgres.ts`, add the `MemoryCategory` type import and a `categoryClause` helper, then replace the existing single-category `if/else if` block.

Change the import line at the top:

```typescript
import { categoryFromNamespace, KNOWN_CATEGORIES } from '@/lib/agent-memory/category';
import type { MemoryCategory } from '@/lib/agent-memory/category';
```

Add this helper above the class (after `toRecord`):

```typescript
/** Prisma `where` predicate matching a single derived category via its namespace prefix. */
function categoryClause(c: MemoryCategory): Record<string, unknown> {
    if (c === 'other') {
        return {
            NOT: {
                OR: KNOWN_CATEGORIES.flatMap((k) => [
                    { namespace: { startsWith: `${k}/` } },
                    { namespace: k },
                ]),
            },
        };
    }
    return { OR: [{ namespace: { startsWith: `${c}/` } }, { namespace: c }] };
}
```

Replace this existing block:

```typescript
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
```

with:

```typescript
        const categories =
            filters.categories?.length ? filters.categories : filters.category ? [filters.category] : [];
        if (categories.length === 1) {
            and.push(categoryClause(categories[0]));
        } else if (categories.length > 1) {
            and.push({ OR: categories.map(categoryClause) });
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: PASS (all tests, including the pre-existing single-`category` and `other` tests — the refactor preserves their shapes).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/db/repositories/agent-memory/interface.ts apps/web-ui/lib/db/repositories/agent-memory/postgres.ts apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts
git commit -m "feat(memory): repository multi-category namespace filter"
```

---

### Task 2: API route — comma-separated category parsing

**Files:**
- Modify: `apps/web-ui/app/api/agent-memories/route.ts`
- Test: `apps/web-ui/app/api/agent-memories/agent-memories-api.test.ts`

**Interfaces:**
- Consumes: `AgentMemoryFilters.categories` (Task 1), `VALID_CATEGORIES`, `MemoryCategory`.
- Produces: `GET` splits the `category` query param on `,`, trims, validates each against `VALID_CATEGORIES`, and passes `categories: MemoryCategory[]` (empty array when none) to `repo.listByTenant`. The single `category` field is no longer passed.

- [ ] **Step 1: Update the existing test + add new CSV tests**

In `agent-memories-api.test.ts`, change the first `GET` test's assertion from `category: 'infra'` to `categories: ['infra']`:

```typescript
    it('scopes the list query to the session tenant and returns the envelope', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [{ id: 'mem-1' }], total: 1 });
        const req = new Request('http://localhost/api/agent-memories?category=infra&search=ecs');
        const res = await GET(req as any);
        const body = await res.json();

        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-a', categories: ['infra'], search: 'ecs' })
        );
        expect(body).toEqual({ success: true, data: [{ id: 'mem-1' }], total: 1 });
    });
```

Add two more tests inside the `describe('GET /api/agent-memories', …)` block:

```typescript
    it('parses a comma-separated category param into a validated categories array', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [], total: 0 });
        const req = new Request('http://localhost/api/agent-memories?category=infra,user,bogus');
        await GET(req as any);
        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ categories: ['infra', 'user'] })
        );
    });

    it('passes an empty categories array when no category param is present', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [], total: 0 });
        const req = new Request('http://localhost/api/agent-memories');
        await GET(req as any);
        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ categories: [] })
        );
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run app/api/agent-memories/agent-memories-api.test.ts`
Expected: the updated + two new tests FAIL (route still passes `category`, not `categories`).

- [ ] **Step 3: Implement CSV parsing in the route**

In `route.ts`, replace this block:

```typescript
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
```

with:

```typescript
        const { searchParams } = new URL(request.url);
        const categories = (searchParams.get('category') ?? '')
            .split(',')
            .map((c) => c.trim())
            .filter((c): c is MemoryCategory => VALID_CATEGORIES.has(c as MemoryCategory));

        const repo = getAgentMemoryRepository();
        const result = await repo.listByTenant({
            tenantId,
            categories,
            search: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '100', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
        });
```

(`VALID_CATEGORIES` and the `MemoryCategory` import already exist in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run app/api/agent-memories/agent-memories-api.test.ts`
Expected: PASS (all GET + DELETE tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/agent-memories/route.ts apps/web-ui/app/api/agent-memories/agent-memories-api.test.ts
git commit -m "feat(memory): parse comma-separated category filter in list API"
```

---

### Task 3: Shared DataTable — opt-in manual (server) pagination

**Files:**
- Modify: `apps/web-ui/components/ui/data-table.tsx`

**Interfaces:**
- Consumes: `PaginationState`, `OnChangeFn` from `@tanstack/react-table`.
- Produces: four new optional `DataTableProps` — `manualPagination?: boolean`, `rowCount?: number`, `pagination?: PaginationState`, `onPaginationChange?: OnChangeFn<PaginationState>`. When `manualPagination` is set, the table uses the controlled `pagination`/`onPaginationChange` (or internal state as fallback), sets TanStack `manualPagination: true` + `rowCount`, and omits `getPaginationRowModel`. Consumers passing none of these props get the current client-side behavior unchanged.

- [ ] **Step 1: Extend the import to include `OnChangeFn`**

Add `OnChangeFn` to the existing `@tanstack/react-table` import block (it already imports `PaginationState`):

```typescript
import {
  ColumnDef,
  SortingState,
  ColumnFiltersState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  PaginationState,
  OnChangeFn,
} from '@tanstack/react-table';
```

- [ ] **Step 2: Add the four props to the interface**

Add to `interface DataTableProps<TData, TValue>` (after `pageSizeOptions?`):

```typescript
  manualPagination?: boolean;
  rowCount?: number;
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
```

- [ ] **Step 3: Destructure the new props with defaults**

Add them to the component's destructured parameter list (after `pageSizeOptions`):

```typescript
  manualPagination = false,
  rowCount,
  pagination: controlledPagination,
  onPaginationChange,
```

- [ ] **Step 4: Wire controlled-vs-internal pagination state**

Replace the existing internal pagination `useState`:

```typescript
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: defaultPageSize,
  });
```

with:

```typescript
  const [internalPagination, setInternalPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: defaultPageSize,
  });
  const pagination = controlledPagination ?? internalPagination;
  const setPagination: OnChangeFn<PaginationState> = onPaginationChange ?? setInternalPagination;
```

- [ ] **Step 5: Pass manual-pagination options to `useReactTable`**

In the `useReactTable({ … })` call, update the pagination-related options. The `state.pagination`, `onPaginationChange` lines already reference `pagination`/`setPagination` (now the resolved values). Change the `getPaginationRowModel` line and add `manualPagination` + `rowCount`:

```typescript
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: enableFiltering ? getFilteredRowModel() : undefined,
    getPaginationRowModel:
      enablePagination && !manualPagination ? getPaginationRowModel() : undefined,
    getSortedRowModel: enableSorting ? getSortedRowModel() : undefined,
    manualPagination,
    rowCount: manualPagination ? rowCount : undefined,
```

- [ ] **Step 6: Verify types compile and Skills is unaffected**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors introduced by `data-table.tsx` (compare against the pre-existing baseline — this repo carries a known tsc error baseline; the diff must add zero errors in `data-table.tsx`, `skills-client.tsx`, or their imports).

Run: `cd apps/web-ui && bun run lint`
Expected: no new lint errors in `components/ui/data-table.tsx`.

Manual reasoning check (no code change): `skills-client.tsx` passes none of `manualPagination`/`rowCount`/`pagination`/`onPaginationChange`, so `manualPagination` defaults `false`, `pagination` falls back to internal state, and `getPaginationRowModel` is still applied — identical to before.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/components/ui/data-table.tsx
git commit -m "feat(ui): opt-in manual/server pagination for shared DataTable"
```

---

### Task 4: New primitive — DataTable faceted filter

**Files:**
- Create: `apps/web-ui/components/ui/data-table-faceted-filter.tsx`

**Interfaces:**
- Consumes: `Popover*`, `Command*`, `Badge`, `Button`, `Separator`, `cn`, lucide `Check`/`PlusCircle`.
- Produces: `DataTableFacetedFilter` component + `FacetedFilterOption` type. Props: `title: string`, `options: FacetedFilterOption[]` (`{ label; value; icon? }`), `selected: string[]`, `onChange: (values: string[]) => void`. Multi-select; toggling an option calls `onChange` with the next array; a "Clear filters" footer calls `onChange([])`.

- [ ] **Step 1: Create the faceted filter component**

Create `apps/web-ui/components/ui/data-table-faceted-filter.tsx` with exactly:

```tsx
'use client';

import * as React from 'react';
import { Check, PlusCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';

export interface FacetedFilterOption {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
}

interface DataTableFacetedFilterProps {
  title: string;
  options: FacetedFilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}

export function DataTableFacetedFilter({
  title,
  options,
  selected,
  onChange,
}: DataTableFacetedFilterProps) {
  const selectedSet = new Set(selected);

  const toggle = (value: string) => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 border-dashed">
          <PlusCircle className="mr-2 h-4 w-4" />
          {title}
          {selectedSet.size > 0 && (
            <>
              <Separator orientation="vertical" className="mx-2 h-4" />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal lg:hidden">
                {selectedSet.size}
              </Badge>
              <div className="hidden space-x-1 lg:flex">
                {selectedSet.size > 2 ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {selectedSet.size} selected
                  </Badge>
                ) : (
                  options
                    .filter((o) => selectedSet.has(o.value))
                    .map((o) => (
                      <Badge
                        key={o.value}
                        variant="secondary"
                        className="rounded-sm px-1 font-normal"
                      >
                        {o.label}
                      </Badge>
                    ))
                )}
              </div>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selectedSet.has(option.value);
                return (
                  <CommandItem key={option.value} onSelect={() => toggle(option.value)}>
                    <div
                      className={cn(
                        'mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
                        isSelected
                          ? 'bg-primary text-primary-foreground'
                          : 'opacity-50 [&_svg]:invisible'
                      )}
                    >
                      <Check className="h-4 w-4" />
                    </div>
                    {option.icon && (
                      <option.icon className="mr-2 h-4 w-4 text-muted-foreground" />
                    )}
                    <span>{option.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selectedSet.size > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => onChange([])}
                    className="justify-center text-center"
                  >
                    Clear filters
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json`
Expected: zero new errors attributable to `data-table-faceted-filter.tsx`.

Run: `cd apps/web-ui && bun run lint`
Expected: no new lint errors in the new file.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/components/ui/data-table-faceted-filter.tsx
git commit -m "feat(ui): shadcn faceted multi-select filter primitive"
```

---

### Task 5: Query hook + rewrite the Memory client component

**Files:**
- Modify: `apps/web-ui/lib/queries/agent-memories.ts`
- Modify (full rewrite): `apps/web-ui/components/memory/memory-client-component.tsx`

**Interfaces:**
- Consumes: `useAgentMemories`/`useDeleteAgentMemory`/`MemoryRow` (hook), `DataTable` with manual pagination (Task 3), `DataTableFacetedFilter` (Task 4), `MemoryDetailDialog`, `DeleteMemoryDialog`, `KNOWN_CATEGORIES`/`MemoryCategory`, `useDebounce`.
- Produces: `MemoryFilters.categories?: MemoryCategory[]` (serialized to the CSV `category` param); the rewritten `MemoryClientComponent` (same export name).

- [ ] **Step 1: Add `categories` to the query hook**

In `agent-memories.ts`, add the field to `MemoryFilters`:

```typescript
export interface MemoryFilters {
    category?: MemoryCategory;
    categories?: MemoryCategory[];
    search?: string;
    page?: number;
    limit?: number;
}
```

In `useAgentMemories`'s `queryFn`, after the existing single-category line, serialize `categories` to the same `category` param (the array form wins when present):

```typescript
            // The UI passes `undefined` for the All tab, so only real categories arrive here.
            if (filters?.category) params.set('category', filters.category);
            if (filters?.categories?.length) params.set('category', filters.categories.join(','));
```

(Everything else in the hook — return shape, `queryKeys.agentMemories.list(filters)`, `placeholderData: (prev) => prev`, `useDeleteAgentMemory` — stays as-is.)

- [ ] **Step 2: Rewrite `memory-client-component.tsx`**

Replace the entire contents of `apps/web-ui/components/memory/memory-client-component.tsx` with:

```tsx
"use client";

import { useMemo, useState } from "react";
import type { ColumnDef, PaginationState } from "@tanstack/react-table";
import { Brain, MoreHorizontal, Eye, Trash2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KNOWN_CATEGORIES, type MemoryCategory } from "@/lib/agent-memory/category";
import {
    useAgentMemories,
    useDeleteAgentMemory,
    type MemoryRow,
} from "@/lib/queries/agent-memories";
import { useDebounce } from "@/hooks/use-debounce";
import { MemoryDetailDialog } from "./memory-detail-dialog";
import { DeleteMemoryDialog } from "./delete-memory-dialog";

const CATEGORY_OPTIONS: { label: string; value: MemoryCategory }[] = [
    ...KNOWN_CATEGORIES,
    "other" as const,
].map((c) => ({ label: c.charAt(0).toUpperCase() + c.slice(1), value: c }));

function confidenceVariant(c: string | null): "default" | "secondary" | "outline" {
    if (c === "high") return "default";
    if (c === "medium") return "secondary";
    return "outline";
}

export function MemoryClientComponent() {
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
    const [searchInput, setSearchInput] = useState("");
    const search = useDebounce(searchInput, 300);
    const [categories, setCategories] = useState<MemoryCategory[]>([]);
    const [detail, setDetail] = useState<MemoryRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<MemoryRow | null>(null);

    const { data, isLoading } = useAgentMemories({
        page: pagination.pageIndex + 1,
        limit: pagination.pageSize,
        categories: categories.length ? categories : undefined,
        search: search || undefined,
    });
    const memories = data?.data ?? [];
    const total = data?.total ?? 0;
    const del = useDeleteAgentMemory();

    // Any server-side filter change must return to the first page.
    const resetToFirstPage = () => setPagination((p) => ({ ...p, pageIndex: 0 }));
    const handleSearchChange = (v: string) => {
        setSearchInput(v);
        resetToFirstPage();
    };
    const handleCategoriesChange = (values: string[]) => {
        setCategories(values as MemoryCategory[]);
        resetToFirstPage();
    };
    const clearFilters = () => {
        setSearchInput("");
        setCategories([]);
        resetToFirstPage();
    };

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

    const columns = useMemo<ColumnDef<MemoryRow>[]>(
        () => [
            {
                accessorKey: "category",
                header: "Category",
                enableSorting: false,
                cell: ({ row }) => <Badge variant="outline">{row.original.category}</Badge>,
            },
            {
                accessorKey: "key",
                header: "Key",
                enableSorting: false,
                cell: ({ row }) => (
                    <button
                        type="button"
                        onClick={() => setDetail(row.original)}
                        className="text-left font-medium hover:underline"
                    >
                        {row.original.key}
                    </button>
                ),
            },
            {
                accessorKey: "fact",
                header: "Fact",
                enableSorting: false,
                cell: ({ row }) => (
                    <span className="block max-w-md truncate">{row.original.fact}</span>
                ),
            },
            {
                accessorKey: "confidence",
                header: "Confidence",
                enableSorting: false,
                cell: ({ row }) =>
                    row.original.confidence ? (
                        <Badge variant={confidenceVariant(row.original.confidence)}>
                            {row.original.confidence}
                        </Badge>
                    ) : (
                        <span className="text-muted-foreground">—</span>
                    ),
            },
            {
                accessorKey: "createdAt",
                header: "Created",
                enableSorting: false,
                cell: ({ row }) => (
                    <span className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(row.original.createdAt).toLocaleDateString()}
                    </span>
                ),
            },
            {
                accessorKey: "expiresAt",
                header: "Expires",
                enableSorting: false,
                cell: ({ row }) => (
                    <span className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(row.original.expiresAt).toLocaleDateString()}
                    </span>
                ),
            },
            {
                id: "actions",
                header: () => <div className="text-right">Actions</div>,
                enableSorting: false,
                cell: ({ row }) => {
                    const m = row.original;
                    return (
                        <div className="flex justify-end">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="h-8 w-8 p-0">
                                        <span className="sr-only">Open actions</span>
                                        <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => setDetail(m)}>
                                        <Eye className="mr-2 h-4 w-4" />
                                        View details
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => setDeleteTarget(m)}
                                        className="text-destructive"
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    );
                },
            },
        ],
        []
    );

    const hasFilters = search.length > 0 || categories.length > 0;

    return (
        <div className="space-y-4">
            <PageHeader
                icon={Brain}
                title="Memory"
                description="What the AI Ops agent has learned across sessions. Review and prune as needed."
            />

            <DataTable
                columns={columns}
                data={memories}
                loading={isLoading}
                enableSorting={false}
                enableFiltering={false}
                manualPagination
                rowCount={total}
                pagination={pagination}
                onPaginationChange={setPagination}
                emptyMessage={
                    hasFilters
                        ? "No memories match your filters."
                        : "No memories yet — the AI Ops agent will populate these as it works."
                }
                header={
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative max-w-xs flex-1">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                placeholder="Search key or fact…"
                                value={searchInput}
                                onChange={(e) => handleSearchChange(e.target.value)}
                                className="pl-9"
                            />
                        </div>
                        <DataTableFacetedFilter
                            title="Category"
                            options={CATEGORY_OPTIONS}
                            selected={categories}
                            onChange={handleCategoriesChange}
                        />
                        {hasFilters && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={clearFilters}
                                className="h-9 px-2 lg:px-3"
                            >
                                Reset
                                <X className="ml-2 h-4 w-4" />
                            </Button>
                        )}
                    </div>
                }
            />

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

- [ ] **Step 3: Typecheck and lint**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json`
Expected: zero new errors in `memory-client-component.tsx` or `agent-memories.ts`.

Run: `cd apps/web-ui && bun run lint`
Expected: no new lint errors in the two modified files.

- [ ] **Step 4: Run the full web-ui test suite**

Run: `cd apps/web-ui && bun run test`
Expected: the memory repo + API tests pass; no previously-passing test regresses (this repo has a known set of pre-existing mock-harness failures — compare against baseline, add zero new failures).

- [ ] **Step 5: Manual/Playwright verification against the running app**

Start the dev server (needs Postgres up: `docker compose up -d postgres`): `cd apps/web-ui && bun run dev` (port 3001). Then, using the Playwright MCP server (or manually in a browser), sign in and navigate to `/app/memory`, and verify:

1. The table renders memories with columns Category / Key / Fact / Confidence / Created / Expires / Actions.
2. The pagination footer shows "Page 1 of N", the page-size selector changes rows-per-page, and Next/Prev navigate server pages (the row set changes and the request `?page=` increments — check the Network tab / `browser_network_requests`).
3. Typing in the search box filters after the 300 ms debounce and resets to page 1.
4. The **Category** faceted filter multi-selects (e.g. select Infra + User), narrows results, shows count badges, and "Clear filters" / "Reset" restores the full list.
5. A row's **⋯** dropdown opens with **View details** (opens the detail dialog) and **Delete** (opens the confirm dialog); confirming Delete removes the row, fires a success toast, and the list refetches.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/queries/agent-memories.ts apps/web-ui/components/memory/memory-client-component.tsx
git commit -m "feat(memory): shadcn data-table with server pagination, faceted category filter, row action menu"
```

---

## Notes / known cosmetics

- The shared `DataTablePagination` footer shows a "0 of N row(s) selected." line. Memory has no selection column, so it will read "0 of \<page rows\> row(s) selected." — this is the same benign line already shown by the Skills module and is intentionally left unchanged for consistency (not worth a shared-primitive change).
- Column sorting is intentionally disabled: the server always returns `updatedAt desc`, and TanStack client sorting would only reorder the current page under manual pagination, which would mislead. Server-side sorting is explicitly out of scope.
