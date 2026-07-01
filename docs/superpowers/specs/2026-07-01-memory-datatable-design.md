# Memory module → shadcn data-table

**Date:** 2026-07-01
**Status:** Approved (design)
**Scope:** Convert the Memory module list view (`components/memory/`) into the standard
shadcn data-table used elsewhere in the app, with server-side pagination, a debounced
search filter, a faceted category filter, and a per-row collapsible action dropdown.

## Motivation

The current Memory view (`memory-client-component.tsx`) renders a plain `<Table>` with
category tab-buttons and a debounced search. It fetches up to 200 rows in one request and
has no pagination UI and only a single inline "Delete" button per row. Agent memories grow
unbounded over time, so the view needs true server-side pagination and a table shape
consistent with the rest of the app (Accounts, Skills).

## Decisions (from brainstorming)

- **Pagination:** server-side. The repo already returns `page`/`limit`/`total`.
- **Bulk actions:** none. Delete stays a single, per-row action. No selection checkboxes.
- **Row actions:** aggregated into one collapsible `DropdownMenu` per row, mirroring the
  Accounts module (`accounts-table.tsx`).
- **Categorization:** a shadcn **faceted column filter** (multi-select) replaces the tab
  buttons.

## Current state (grounding)

- `components/memory/memory-client-component.tsx` — plain table + tabs + search, `limit: 200`.
- `components/memory/memory-detail-dialog.tsx`, `delete-memory-dialog.tsx` — reused as-is.
- `components/ui/data-table.tsx` — shared shadcn DataTable. Client-side sort/filter/pagination.
  Already tracks `rowSelection` internally. Used by `skills/skills-client.tsx` (client mode).
- `components/ui/{popover,command,checkbox,dropdown-menu,badge}.tsx` — all present.
  No faceted-filter component exists yet.
- `lib/queries/agent-memories.ts` — `useAgentMemories(filters)` returns `{ data, total }`,
  `placeholderData: keepPrevious`. `useDeleteAgentMemory()` invalidates
  `queryKeys.agentMemories.all`.
- `app/api/agent-memories/route.ts` — `GET` with `authorize('read','Memory')`; parses a single
  `category`, plus `search`/`limit`/`page`; returns `{ success, data, total }`.
- `app/api/agent-memories/[id]/route.ts` — `DELETE` with `authorize('delete','Memory')` + audit.
- `lib/db/repositories/agent-memory/{interface,postgres}.ts` — `category` is **derived from the
  `namespace` prefix**, not a column; filtering is by `namespace` prefix match. `other` =
  `NOT (any known prefix)`. `listByTenant` returns `{ memories, total }`.

## Architecture

### 1. Repository — multi-category filter

`interface.ts`: add optional `categories?: MemoryCategory[]` to `AgentMemoryFilters`
(keep the single `category` for back-compat; `categories` takes precedence when non-empty).

`postgres.ts` `listByTenant`: when `categories` is non-empty, push a single `OR` clause built
from the per-category namespace conditions:

- For each known category `c` (infra/user/patterns/errors): `{ OR: [{ namespace: { startsWith: `${c}/` } }, { namespace: c }] }`.
- For `other`: `{ NOT: { OR: <all known prefix clauses> } }`.

The combined clause is `{ OR: [<one entry per selected category>] }`, pushed onto the same
`AND` array the search clause already uses. Single-`category` behavior is unchanged.

### 2. API route — CSV category parsing

`GET /api/agent-memories`: read the `category` query param, split on `,`, trim, and validate
each against `VALID_CATEGORIES`. Pass the resulting `categories: MemoryCategory[]` to the repo
(empty array → no category filter → all). `limit`/`page`/`search` unchanged; response
`{ success, data, total }` unchanged. RBAC unchanged.

No new endpoints. Delete remains `DELETE /api/agent-memories/[id]`.

### 3. Shared `DataTable` — opt-in server pagination (non-breaking)

Add optional props:

- `manualPagination?: boolean`
- `rowCount?: number` — total server-side row count
- `pagination?: PaginationState` — controlled state
- `onPaginationChange?: OnChangeFn<PaginationState>`

When `manualPagination` is set: use the controlled `pagination`/`onPaginationChange` (falling
back to internal state if absent), set the table options `manualPagination: true` + `rowCount`,
and omit `getPaginationRowModel` (the `data` prop is already one server page). The existing
`DataTablePagination` footer works unchanged because it drives `table.getPageCount()` /
`nextPage()` / `previousPage()`, which honor `manualPagination` + `rowCount`.

Skills passes none of these props → its client-side behavior is completely unchanged. This is
the "improve the code you're working in" change: the new props are additive and default off.

### 4. New primitive — `components/ui/data-table-faceted-filter.tsx`

Standard shadcn faceted filter: a `Popover` triggered by an outline `Button` (dashed, with a
`PlusCircle` icon and selected-count badges), containing a `Command` list of options with a
`Checkbox`/check indicator per option and a "Clear filters" footer. Generic over an
`options: { label; value; icon? }[]` + controlled `selected: string[]` + `onChange`. Multi-select.

### 5. `memory-client-component.tsx` — rewrite as data table

State: `pagination` (`{ pageIndex, pageSize }`, default `pageSize: 10`), `searchInput` +
debounced `search`, `categories: MemoryCategory[]`, `detail`, `deleteTarget`.

Data: `useAgentMemories({ page: pageIndex + 1, limit: pageSize, categories, search })`.
Changing `search` or `categories` resets `pageIndex` to 0.

Columns (`ColumnDef<MemoryRow>`):

| Column     | Cell |
|------------|------|
| Category   | `<Badge variant="outline">` of `m.category` |
| Key        | clickable button → opens `MemoryDetailDialog` (like Skills' name cell) |
| Fact       | truncated (`max-w-md truncate`) |
| Confidence | small badge (`high`/`medium`/`low` → variant/tint), `—` when null |
| Created    | `toLocaleDateString()` |
| Expires    | `toLocaleDateString()` |
| Actions    | `DropdownMenu` (`MoreHorizontal` ghost trigger, `align="end"`): **View details** (→ detail dialog), **Delete** (`text-destructive` → delete dialog) |

Sorting toggles disabled (`enableSorting={false}`) — the server always orders newest-first
(`updatedAt desc`); page-local client sorting would be misleading under server pagination.
`enableFiltering={false}` (filtering is server-side).

Toolbar via the DataTable `header` slot: debounced search `Input` + the faceted **Category**
filter + a "Reset" button shown only when `search` or `categories` is active.

Rendered with the shared `DataTable` in manual-pagination mode:
`manualPagination`, `rowCount={total}`, controlled `pagination`/`onPaginationChange`,
`loading={isLoading}`, `emptyMessage` (search/filter-aware).

Dialogs: reuse `MemoryDetailDialog` and `DeleteMemoryDialog` unchanged; delete flow keeps the
existing `useDeleteAgentMemory` mutation + sonner toasts.

### 6. Query hook — `lib/queries/agent-memories.ts`

Add `categories?: MemoryCategory[]` to `MemoryFilters`. In `useAgentMemories`, serialize
`categories` to the CSV `category` param (`categories.join(',')`) when non-empty. Return shape,
query key factory, and `useDeleteAgentMemory` unchanged.

## Testing (TDD)

- `lib/db/repositories/agent-memory/postgres.test.ts`: multi-category `OR` filtering (e.g.
  `['infra','user']` returns both; `['other']` excludes known prefixes) and correct `total`
  under pagination (`skip`/`take` + `count` on the same `where`).
- `app/api/agent-memories/agent-memories-api.test.ts`: CSV `category` param parses to the
  expected `categories[]`, invalid values are dropped, empty → no filter.

## Out of scope

- Bulk/multi-select actions.
- Server-side sorting.
- Creating or editing memories (agent-written only).
