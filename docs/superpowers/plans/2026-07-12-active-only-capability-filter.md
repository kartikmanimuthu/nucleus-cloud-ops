# Active-only capability filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the AIOps (chat) and Agent Ops (scheduled/autonomous) modules, only active skills, MCP servers, knowledge bases, and tools are discoverable in the console pickers and used by the agent; inactive items are hidden and hard-dropped at runtime.

**Architecture:** Two enforcement layers. **Layer A (visibility)** filters the console selection pickers to active items only, leaving Settings/management pages untouched. **Layer B (runtime)** drops inactive items at shared assembly/retrieval choke-points even when a stale id was saved/passed. Skills already satisfy both layers, so no skill work. MCP filtering is centralized in a new pure helper + a single choke-point (`getActiveMCPTools`). KB gets a new deactivation toggle plus status enforcement in retrieval + auto-select.

**Tech Stack:** Next.js 15 / React 19, TanStack Query, Prisma (Postgres), Vitest, sonner toasts. Path alias `@/` → `apps/web-ui/`.

## Global Constraints

- All test commands run from `apps/web-ui`: `cd apps/web-ui && bunx vitest run <path>`.
- Data access goes through the repository factory / services — never Prisma directly from routes.
- `$queryRawUnsafe` / raw SQL is NOT tenant-intercepted — keep manual `"tenantId" = $n` scoping.
- API routes: `authorize`/session guard + `AuditService.logUserAction` on mutations; responses `{ success, ... }` / `{ error }`.
- "Active" fields: Skills `isEnabled` (bool), MCP config `enabled` (bool, from JSON `disabled`), KnowledgeBase `status` (`'active' | 'inactive'`).
- 4-space indent in lib/service files; 2-space in UI components (match each file's existing style).
- Do NOT change management/Settings surfaces (`/api/mcp-servers`, `/api/agent-ops/mcp-settings`, KB repo `listKnowledgeBases`) — they must keep listing all items.

---

### Task 1: MCP — `resolveEnabledServerIds` pure helper

**Files:**
- Modify: `apps/web-ui/lib/agent/mcp-config.ts` (add exported function near `getEnabledMCPServers`, ~line 352)
- Test: `apps/web-ui/lib/agent/mcp-config.test.ts`

**Interfaces:**
- Produces: `resolveEnabledServerIds(requestedIds: string[] | undefined, configs: MCPServerConfig[]): string[]` — when `requestedIds` is empty/undefined, returns all enabled config ids; otherwise returns the requested ids intersected with enabled configs. Disabled servers are always excluded.

- [ ] **Step 1: Write the failing test**

Append to `apps/web-ui/lib/agent/mcp-config.test.ts`:

```typescript
import { resolveEnabledServerIds } from './mcp-config';

describe('resolveEnabledServerIds', () => {
    const configs = [
        { id: 'a', name: 'A', description: '', command: 'x', args: [], enabled: true },
        { id: 'b', name: 'B', description: '', command: 'x', args: [], enabled: false },
        { id: 'c', name: 'C', description: '', command: 'x', args: [], enabled: true },
    ] as any;

    it('returns all enabled ids when none requested', () => {
        expect(resolveEnabledServerIds(undefined, configs)).toEqual(['a', 'c']);
        expect(resolveEnabledServerIds([], configs)).toEqual(['a', 'c']);
    });

    it('intersects requested ids with enabled configs', () => {
        expect(resolveEnabledServerIds(['a', 'b'], configs)).toEqual(['a']);
    });

    it('drops requested ids that are disabled or unknown', () => {
        expect(resolveEnabledServerIds(['b', 'ghost'], configs)).toEqual([]);
    });

    it('preserves requested order', () => {
        expect(resolveEnabledServerIds(['c', 'a'], configs)).toEqual(['c', 'a']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/mcp-config.test.ts`
Expected: FAIL — `resolveEnabledServerIds is not a function` / import has no export.

- [ ] **Step 3: Write minimal implementation**

In `apps/web-ui/lib/agent/mcp-config.ts`, add after `getEnabledMCPServers` (end of file, ~line 354):

```typescript
/**
 * Intersect the requested MCP server ids with the enabled configs.
 * When no ids are requested, returns every enabled server id. Disabled
 * servers are always excluded — this is the single source of truth for
 * "which MCP servers may actually be connected/used".
 */
export function resolveEnabledServerIds(
    requestedIds: string[] | undefined,
    configs: MCPServerConfig[],
): string[] {
    const enabled = configs.filter(c => c.enabled);
    if (!requestedIds || requestedIds.length === 0) {
        return enabled.map(c => c.id);
    }
    const enabledSet = new Set(enabled.map(c => c.id));
    return requestedIds.filter(id => enabledSet.has(id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/mcp-config.test.ts`
Expected: PASS (all `resolveEnabledServerIds` cases + existing tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/mcp-config.ts apps/web-ui/lib/agent/mcp-config.test.ts
git commit -m "feat(agent): add resolveEnabledServerIds MCP helper"
```

---

### Task 2: MCP — runtime hard-enforcement at the choke-points

Wire `resolveEnabledServerIds` into the two runtime paths so a disabled MCP server is never connected or bound, even when explicitly selected.

**Files:**
- Modify: `apps/web-ui/lib/agent/agent-shared.ts` (`getActiveMCPTools`, ~lines 582 + 601)
- Modify: `apps/web-ui/lib/agent-ops/agent-executor.ts` (two sites: ~lines 104–112 and ~575–583)
- Test: `apps/web-ui/lib/agent/mcp-config.test.ts` already covers the helper; this task is verified by typecheck + the helper tests (the two call sites are thin wiring around dynamic imports and are not independently unit-tested).

**Interfaces:**
- Consumes: `resolveEnabledServerIds` from Task 1.

- [ ] **Step 1: Wire into `getActiveMCPTools`**

In `apps/web-ui/lib/agent/agent-shared.ts`, update the dynamic import (~line 582) to also pull the helper:

```typescript
    const { mergeConfigs, resolveEnabledServerIds } = await import('./mcp-config');
```

Then replace the requested-configs line (~line 601):

```typescript
    const requestedConfigs = allConfigs.filter(c => serverIds.includes(c.id));
```

with:

```typescript
    const enabledIds = resolveEnabledServerIds(serverIds, allConfigs);
    const requestedConfigs = allConfigs.filter(c => enabledIds.includes(c.id));
```

(The existing `if (!serverIds || serverIds.length === 0) return [];` guard at the top of the function stays — chat/agent-ops only reach here with an explicit non-empty list.)

- [ ] **Step 2: Wire into `agent-executor.ts` — first site (~lines 104–112)**

Replace:

```typescript
            const { mergeConfigs } = await import('../agent/mcp-config');
            const savedJson = await TenantConfigService.getConfig('mcp-servers', tenantId);
            const allConfigs = mergeConfigs(savedJson);
            if (activeMcpServerIds.length === 0) {
                activeMcpServerIds = allConfigs.filter(c => c.enabled).map(c => c.id);
            }
            if (activeMcpServerIds.length > 0) {
                await mcpManager.connectServers(activeMcpServerIds, allConfigs);
            }
```

with:

```typescript
            const { mergeConfigs, resolveEnabledServerIds } = await import('../agent/mcp-config');
            const savedJson = await TenantConfigService.getConfig('mcp-servers', tenantId);
            const allConfigs = mergeConfigs(savedJson);
            // Hard-enforce: intersect the task's selected ids with enabled configs
            // (empty ⇒ all enabled). A server disabled after the task was saved
            // is never reconnected.
            activeMcpServerIds = resolveEnabledServerIds(mcpServerIds, allConfigs);
            if (activeMcpServerIds.length > 0) {
                await mcpManager.connectServers(activeMcpServerIds, allConfigs);
            }
```

- [ ] **Step 3: Wire into `agent-executor.ts` — second site (~lines 575–583)**

Replace:

```typescript
            const { mergeConfigs } = await import('../agent/mcp-config');
            const savedJson = await TenantConfigService.getConfig('mcp-servers', tenantId);
            const allConfigs = mergeConfigs(savedJson);
            if (activeMcpServerIds.length === 0) {
                activeMcpServerIds = allConfigs.filter((c: any) => c.enabled).map((c: any) => c.id);
            }
            if (activeMcpServerIds.length > 0) {
                await mcpManager.connectServers(activeMcpServerIds, allConfigs);
            }
```

with:

```typescript
            const { mergeConfigs, resolveEnabledServerIds } = await import('../agent/mcp-config');
            const savedJson = await TenantConfigService.getConfig('mcp-servers', tenantId);
            const allConfigs = mergeConfigs(savedJson);
            activeMcpServerIds = resolveEnabledServerIds(mcpServerIds, allConfigs);
            if (activeMcpServerIds.length > 0) {
                await mcpManager.connectServers(activeMcpServerIds, allConfigs);
            }
```

- [ ] **Step 4: Typecheck + run helper tests**

Run: `cd apps/web-ui && bunx tsc --noEmit && bunx vitest run lib/agent/mcp-config.test.ts`
Expected: tsc clean for these files; helper tests PASS. (A pre-existing tsc baseline of unrelated errors may exist — confirm no NEW errors in `agent-shared.ts` / `agent-executor.ts`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/agent-shared.ts apps/web-ui/lib/agent-ops/agent-executor.ts
git commit -m "feat(agent): drop disabled MCP servers at runtime choke-points"
```

---

### Task 3: Console picker visibility (Layer A) — MCP + KB

Hide inactive items in the AIOps chat pickers and the deep-agent MCP selector. Management pages unchanged.

**Files:**
- Modify: `apps/web-ui/components/agent/chat-interface.tsx` (MCP picker ~line 2035; KB picker ~line 1923)
- Modify: `apps/web-ui/components/deep-agent/mcp-skill-selector.tsx` (McpServer interface ~line 13; render ~line 195)

**Interfaces:**
- Consumes: `/api/mcp-servers` returns `servers: Array<{ id; name; description; enabled; ... }>`; `useKnowledgeBases()` returns `KnowledgeBase[]` with `status: 'active' | 'inactive'`.

- [ ] **Step 1: Filter the chat MCP picker to enabled**

In `apps/web-ui/components/agent/chat-interface.tsx` (~line 2035), the render starts `{mcpServers.filter((server) => server.name...`. Prepend an enabled filter so it reads:

```tsx
                            {mcpServers
                              .filter((server) => server.enabled)
                              .filter(
                                (server) =>
                                  server.name
                                    .toLowerCase()
                                    .includes(mcpSearch.toLowerCase()) ||
                                  server.description
                                    ?.toLowerCase()
                                    .includes(mcpSearch.toLowerCase()),
                              )
                              .map((server) => (
```

- [ ] **Step 2: Filter the chat KB picker to active**

In the same file (~line 1923), replace `{knowledgeBases.map((kb) => (` with a filtered list, and update the empty-state guard (~line 1918) to use the filtered array. Change:

```tsx
                      {knowledgeBases.length === 0 && (
                        <p className="text-xs text-muted-foreground p-3 text-center">
                          No knowledge bases available
                        </p>
                      )}
                      {knowledgeBases.map((kb) => (
```

to:

```tsx
                      {knowledgeBases.filter((kb) => kb.status === 'active').length === 0 && (
                        <p className="text-xs text-muted-foreground p-3 text-center">
                          No knowledge bases available
                        </p>
                      )}
                      {knowledgeBases.filter((kb) => kb.status === 'active').map((kb) => (
```

- [ ] **Step 3: Filter the deep-agent MCP selector to enabled**

In `apps/web-ui/components/deep-agent/mcp-skill-selector.tsx`, extend the `McpServer` interface (~line 13) to carry the flag:

```tsx
interface McpServer {
  id: string;
  name: string;
  enabled?: boolean;
}
```

Then update the render (~line 192–195) to filter before mapping. Replace:

```tsx
              {mcpServers.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-2">No MCP servers configured</p>
              ) : (
                mcpServers.map(server => (
```

with:

```tsx
              {mcpServers.filter(s => s.enabled !== false).length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-2">No MCP servers configured</p>
              ) : (
                mcpServers.filter(s => s.enabled !== false).map(server => (
```

(`/api/mcp-servers` always returns `enabled`; `!== false` keeps legacy entries visible if the field were ever absent.)

- [ ] **Step 4: Verify build/typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no NEW errors in the two components (confirm against baseline).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/agent/chat-interface.tsx apps/web-ui/components/deep-agent/mcp-skill-selector.tsx
git commit -m "feat(agent-ops): hide inactive MCP servers and KBs in console pickers"
```

---

### Task 4: KB — repository `setKnowledgeBaseStatus`

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/knowledge-base/interface.ts`
- Modify: `apps/web-ui/lib/db/repositories/knowledge-base/postgres.ts` (type import ~line 11; new method after `updateKnowledgeBase` ~line 100)
- Modify: `apps/web-ui/lib/knowledge-base/service.ts` (type import ~line 9; new static after `updateKnowledgeBase` ~line 39)
- Test: `apps/web-ui/lib/db/repositories/knowledge-base/postgres.test.ts`

**Interfaces:**
- Produces: `IKnowledgeBaseRepository.setKnowledgeBaseStatus(kbId: string, tenantId: string, status: KnowledgeBaseStatus): Promise<void>`; `KnowledgeBaseService.setKnowledgeBaseStatus(kbId, tenantId, status)`.

- [ ] **Step 1: Write the failing repo test**

In `apps/web-ui/lib/db/repositories/knowledge-base/postgres.test.ts`, add after the `updateKnowledgeBase` describe block (~line 150):

```typescript
    describe('setKnowledgeBaseStatus', () => {
        it('calls updateMany with status and tenant-scoped where', async () => {
            mockPrisma.knowledgeBase.updateMany.mockResolvedValue({ count: 1 });

            const repo = new KnowledgeBasePostgresRepository();
            await repo.setKnowledgeBaseStatus('kb-1', 'tenant-1', 'inactive');

            expect(mockPrisma.knowledgeBase.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'kb-1', tenantId: 'tenant-1' }),
                    data: expect.objectContaining({ status: 'inactive' }),
                })
            );
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/knowledge-base/postgres.test.ts`
Expected: FAIL — `repo.setKnowledgeBaseStatus is not a function`.

- [ ] **Step 3: Implement interface + repo + service**

In `interface.ts`, update the import and add the method:

```typescript
import type { KnowledgeBase, CreateKBInput, KnowledgeBaseStatus } from '@/lib/knowledge-base/types';
```

Add inside the interface (after `updateKnowledgeBase`):

```typescript
    setKnowledgeBaseStatus(kbId: string, tenantId: string, status: KnowledgeBaseStatus): Promise<void>;
```

In `postgres.ts`, update the type import (~line 11):

```typescript
import type { KnowledgeBase, CreateKBInput, KnowledgeBaseStatus } from '@/lib/knowledge-base/types';
```

Add the method after `updateKnowledgeBase` (~line 100):

```typescript
    async setKnowledgeBaseStatus(kbId: string, tenantId: string, status: KnowledgeBaseStatus): Promise<void> {
        try {
            await getTenantClient(tenantId).knowledgeBase.updateMany({
                where: { id: kbId, tenantId },
                data: { status },
            });
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error setting knowledge base status:', error);
            throw new Error(`Failed to set knowledge base status: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
```

In `service.ts`, update the type import (~line 9–14) to include `KnowledgeBaseStatus`, and add after `updateKnowledgeBase` (~line 39):

```typescript
  static async setKnowledgeBaseStatus(
    kbId: string,
    tenantId: string,
    status: KnowledgeBaseStatus,
  ): Promise<void> {
    return getKnowledgeBaseRepository().setKnowledgeBaseStatus(kbId, tenantId, status);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/knowledge-base/postgres.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/db/repositories/knowledge-base/interface.ts apps/web-ui/lib/db/repositories/knowledge-base/postgres.ts apps/web-ui/lib/knowledge-base/service.ts apps/web-ui/lib/db/repositories/knowledge-base/postgres.test.ts
git commit -m "feat(kb): add setKnowledgeBaseStatus repository + service method"
```

---

### Task 5: KB — `PUT /api/knowledge-base/[kbId]` accepts `status`

Extend the existing PUT route (already does session guard + audit) to handle an optional `status`.

**Files:**
- Modify: `apps/web-ui/app/api/knowledge-base/[kbId]/route.ts` (PUT handler, ~lines 62–91)

**Interfaces:**
- Consumes: `KnowledgeBaseService.setKnowledgeBaseStatus` from Task 4.
- Produces: `PUT /api/knowledge-base/[kbId]` accepts JSON `{ name?, description?, status? }`; a valid `status` of `'active' | 'inactive'` toggles the KB; invalid status ⇒ 400.

- [ ] **Step 1: Update the PUT body parsing + logic**

Replace the body of the `try` block (lines ~63–91) with:

```typescript
    const { kbId } = await params;
    const tenantId = await getSessionTenantId();
    const body = await request.json();
    const { name, description, status } = body as {
      name?: string;
      description?: string;
      status?: 'active' | 'inactive';
    };

    const existing = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    if (status !== undefined) {
      if (status !== 'active' && status !== 'inactive') {
        return NextResponse.json(
          { success: false, error: "status must be 'active' or 'inactive'" },
          { status: 400 },
        );
      }
      await KnowledgeBaseService.setKnowledgeBaseStatus(kbId, tenantId, status);
    }

    if (name !== undefined || description !== undefined) {
      await KnowledgeBaseService.updateKnowledgeBase(kbId, { name, description }, tenantId);
    }

    AuditService.logUserAction({
      eventType: 'kb.knowledgebase.updated',
      severity: 'medium',
      apiRoute: 'PUT /api/knowledge-base/[kbId]',
      httpMethod: 'PUT',
      action: status !== undefined ? `${status === 'active' ? 'Activated' : 'Deactivated'} Knowledge Base` : 'Updated Knowledge Base',
      resourceType: 'kb',
      resourceId: kbId,
      resourceName: name || existing.name || kbId,
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'success',
      details: status !== undefined
        ? `Set knowledge base "${existing.name || kbId}" status to ${status}`
        : `Updated knowledge base "${name || kbId}"`,
      metadata: { tenantId },
    }).catch(() => {});

    return NextResponse.json({ success: true });
```

(The existing `catch` block below stays unchanged.)

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no NEW errors in `route.ts`.

- [ ] **Step 3: Manual smoke (optional, if dev DB available)**

Run: `cd apps/web-ui && bun run dev` then in another shell:
`curl -X PUT localhost:3001/api/knowledge-base/<id> -H 'Content-Type: application/json' -d '{"status":"inactive"}'`
Expected: `{"success":true}` (with a valid session cookie); invalid status ⇒ 400.

- [ ] **Step 4: Commit**

```bash
git add "apps/web-ui/app/api/knowledge-base/[kbId]/route.ts"
git commit -m "feat(kb): PUT route accepts active/inactive status toggle"
```

---

### Task 6: KB — Activate/Deactivate toggle in the management page

**Files:**
- Modify: `apps/web-ui/lib/queries/knowledge-base.ts` (new mutation hook after `useDeleteKnowledgeBase`, ~line 56)
- Modify: `apps/web-ui/app/app/knowledge-base/page.tsx` (import hook ~line 5; use hook ~line 32; add button in card actions ~line 141–159)

**Interfaces:**
- Consumes: `PUT /api/knowledge-base/[kbId]` with `{ status }` from Task 5.
- Produces: `useSetKnowledgeBaseStatus()` mutation taking `{ id: string; status: 'active' | 'inactive' }`, invalidating the KB list.

- [ ] **Step 1: Add the mutation hook**

In `apps/web-ui/lib/queries/knowledge-base.ts`, add after `useDeleteKnowledgeBase` (~line 56):

```typescript
export function useSetKnowledgeBaseStatus() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, status }: { id: string; status: 'active' | 'inactive' }) => {
            const res = await fetch(`/api/knowledge-base/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Failed to update status');
            }
            return res.json().catch(() => ({}));
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeBasesKey }),
    });
}
```

- [ ] **Step 2: Wire the hook + button into the page**

In `apps/web-ui/app/app/knowledge-base/page.tsx`, update the import (~line 5):

```tsx
import { useKnowledgeBases, useCreateKnowledgeBase, useDeleteKnowledgeBase, useSetKnowledgeBaseStatus } from '@/lib/queries/knowledge-base';
```

Add the hook near the other hooks (~line 32):

```tsx
  const setStatus = useSetKnowledgeBaseStatus();
```

Add an Activate/Deactivate button inside the card actions row — replace the actions `<div className="flex gap-2">` block (~lines 141–159) with:

```tsx
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => router.push(`/app/knowledge-base/${kb.id}`)}
                    >
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      disabled={setStatus.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = kb.status === 'active' ? 'inactive' : 'active';
                        setStatus.mutate(
                          { id: kb.id, status: next },
                          {
                            onSuccess: () => toast.success(`Knowledge base ${next === 'active' ? 'activated' : 'deactivated'}`),
                            onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update status'),
                          },
                        );
                      }}
                      title={kb.status === 'active' ? 'Deactivate' : 'Activate'}
                    >
                      {kb.status === 'active' ? 'Deactivate' : 'Activate'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(kb); }}
                      title="Delete knowledge base"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
```

(`toast` is already imported from `sonner` at line 25.)

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no NEW errors in `page.tsx` / `knowledge-base.ts`.

- [ ] **Step 4: Manual smoke (optional)**

Run: `cd apps/web-ui && bun run dev`; open `/app/knowledge-base`; click Deactivate on a KB → badge flips to "Inactive", toast shows; the chat KB picker (Task 3) no longer lists it.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/queries/knowledge-base.ts apps/web-ui/app/app/knowledge-base/page.tsx
git commit -m "feat(kb): add Activate/Deactivate action to knowledge base management"
```

---

### Task 7: KB — `searchKbChunks` restricts to active KBs

Runtime choke-point: retrieval only returns chunks whose parent KB is active, for both explicit-id and tenant-wide search.

**Files:**
- Modify: `apps/web-ui/lib/knowledge-base/retrieval.ts` (SQL, ~lines 36–59)
- Test: `apps/web-ui/lib/knowledge-base/retrieval.test.ts`

**Interfaces:**
- Consumes/Produces: `searchKbChunks` signature unchanged; SQL now filters `knowledge_bases.status = 'active'` via a `$2`-parameterised subquery (no new bind params).

- [ ] **Step 1: Update the failing tests**

In `apps/web-ui/lib/knowledge-base/retrieval.test.ts`, add two assertions to the existing SQL tests and one new test. In the `'tenant-only scope when no kb ids'` test, add:

```typescript
        expect(sql).toContain("status = 'active'");
```

In the `'scopes to multiple kb ids via ANY($3::text[])'` test, add:

```typescript
        expect(sql).toContain("status = 'active'");
```

Add a new test after it:

```typescript
    it('always restricts to active knowledge bases via a tenant-scoped subquery', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q' });
        const sql = q.mock.calls[0][0] as string;
        expect(sql).toContain('FROM knowledge_bases');
        expect(sql).toContain('"tenantId" = $2');
        expect(sql).toContain("status = 'active'");
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/knowledge-base/retrieval.test.ts`
Expected: FAIL — SQL does not yet contain `status = 'active'`.

- [ ] **Step 3: Implement the active-KB subquery**

In `apps/web-ui/lib/knowledge-base/retrieval.ts`, after `const cols = ...` (~line 38) add:

```typescript
    // Only chunks whose parent KB is active are searchable. Subquery reuses the
    // $2 tenantId bind (raw SQL is not tenant-intercepted — scope stays manual).
    const activeKbFilter = `"knowledgeBaseId" IN (SELECT id FROM knowledge_bases WHERE "tenantId" = $2 AND status = 'active')`;
```

Change the id-scoped query's WHERE (~line 45) to:

```typescript
             WHERE "tenantId" = $2 AND "knowledgeBaseId" = ANY($3::text[]) AND ${activeKbFilter}
```

Change the tenant-only query's WHERE (~line 54) to:

```typescript
             WHERE "tenantId" = $2 AND ${activeKbFilter}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/knowledge-base/retrieval.test.ts`
Expected: PASS (existing param/scope assertions unchanged since no new binds were added).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/knowledge-base/retrieval.ts apps/web-ui/lib/knowledge-base/retrieval.test.ts
git commit -m "feat(kb): searchKbChunks only returns chunks from active KBs"
```

---

### Task 8: KB — `autoSelectKb` excludes inactive KBs

**Files:**
- Modify: `apps/web-ui/lib/agent/auto-kb-select.ts` (~line 29)
- Test: `apps/web-ui/lib/agent/auto-kb-select.test.ts` (fixtures ~lines 20–23; new test)

**Interfaces:**
- Consumes: `KnowledgeBaseService.listKnowledgeBases` returns `KnowledgeBase[]` with `status`.

- [ ] **Step 1: Update fixtures + add a failing test**

In `apps/web-ui/lib/agent/auto-kb-select.test.ts`, the `beforeEach` mock KBs currently omit `status`. Add `status: 'active'` to both so they survive the new filter:

```typescript
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks', vectorCount: 5, status: 'active' },
            { id: 'kb-hr', name: 'HR', description: 'people policies', vectorCount: 3, status: 'active' },
        ] as any);
```

Add a new test inside `describe('autoSelectKb', ...)`:

```typescript
    it('never selects an inactive KB even if the model names it', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks', vectorCount: 5, status: 'inactive' },
        ] as any);
        mockReflector('{"kbIds":["kb-runbooks"],"reasoning":"ops"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'restart pipeline', model });
        expect(r.kbIds).toEqual([]);
    });
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/auto-kb-select.test.ts`
Expected: FAIL — the inactive KB is still selectable (returns `['kb-runbooks']`).

- [ ] **Step 3: Add the status filter**

In `apps/web-ui/lib/agent/auto-kb-select.ts`, replace line ~29:

```typescript
        const active = kbs.filter((k) => (k.vectorCount ?? 0) > 0);
```

with:

```typescript
        // Only active KBs with at least one embedded vector are auto-selectable.
        const active = kbs.filter((k) => k.status === 'active' && (k.vectorCount ?? 0) > 0);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/auto-kb-select.test.ts`
Expected: PASS (all existing tests + the new inactive-KB test).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/auto-kb-select.ts apps/web-ui/lib/agent/auto-kb-select.test.ts
git commit -m "feat(kb): auto-select excludes inactive knowledge bases"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the affected test files together**

Run:
```bash
cd apps/web-ui && bunx vitest run lib/agent/mcp-config.test.ts lib/knowledge-base/retrieval.test.ts lib/agent/auto-kb-select.test.ts lib/db/repositories/knowledge-base/postgres.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no NEW errors vs. the pre-existing baseline (record the baseline count before starting Task 1 for comparison).

- [ ] **Step 3: Lint the touched files**

Run: `cd apps/web-ui && bun run lint`
Expected: no new lint errors in touched files.

- [ ] **Step 4: Confirm skills need no change**

Manually confirm (no code): `skill-service.ts` `getSkillContent`/`loadSkills` filter `isEnabled`; `/api/skills` is enabled-only without `?all`; `auto-skill-select.ts` catalog is enabled-only. No task required — documented for reviewer completeness.

---

## Self-Review

**Spec coverage:**
- Skills already-compliant → Task 9 Step 4 (documented, no change). ✓
- MCP runtime enforcement → Tasks 1–2. ✓
- MCP visibility (chat + deep) → Task 3. ✓
- KB deactivation capability (repo/service/route/hook/UI) → Tasks 4–6. ✓
- KB runtime enforcement (`searchKbChunks`) → Task 7. ✓
- KB auto-select enforcement → Task 8. ✓
- KB visibility (chat picker) → Task 3. ✓
- Built-in tools no-op → covered in spec "out of scope"; no task needed. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `resolveEnabledServerIds(requestedIds, configs)` signature identical in Tasks 1/2. `setKnowledgeBaseStatus(kbId, tenantId, status)` identical across interface/repo/service (Task 4) and consumed by route (Task 5) via `KnowledgeBaseService`. `useSetKnowledgeBaseStatus({ id, status })` (Task 6) matches route body `{ status }` (Task 5). `KnowledgeBaseStatus` type reused from `@/lib/knowledge-base/types`. ✓
