# Dynamic RBAC Registry UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tenant admins two screens — Permissions and Modules — that make the role grid's columns and rows database-driven, so a new permission or module can be defined and bound to roles from the UI, enforced by the existing CASL engine on both the API and the UI.

**Architecture:** The dynamic RBAC/ABAC *engine* already exists on this branch: `libs/rbac/rule-compiler.ts` compiles `rbac_*` registry rows into CASL v7 rules, `/api/me/ability` ships them to the browser, and `authorize()` / row filters / `useCan()` enforce them. What is missing is any way to author the registry. This plan adds a registry-admin service, four API routes, three UI tabs, and rewrites `role-dialog.tsx` to render from the registry instead of hardcoded arrays. No schema migration is required — every table already exists.

**Tech Stack:** Next.js 15 App Router, React 19, TanStack Query 5, React Hook Form + Zod 4, Radix/shadcn UI, Prisma, CASL v7 (`@casl/ability` — `createMongoAbility`, `packRules` from `@casl/ability/extra`), Vitest.

## Global Constraints

- **No new Prisma models and no migration.** Every table used here exists in `libs/prisma/schema.prisma:1348-1590`.
- **Every registry write goes through `runRbacMutation()`** (`apps/web-ui/lib/rbac/registry-service.ts:217`). It supplies the transaction, `assertNoLockout`, the append-only ledger row, and the RBAC version bump. Writing a registry row outside it produces a database that looks correct while the app serves stale compiled abilities.
- **Registry writes use `getTenantClient()`; registry reads use the exception in `lib/rbac/registry.ts`.** `registry-isolation.test.ts` fails CI if any other module reaches for `getPrismaClient()` while touching an `rbac*` model. New admin *reads* live in `lib/rbac/registry-admin.ts`, which must be added to that test's allowlist.
- **`tenantId IS NULL` rows are the global system registry.** A tenant admin may never create, delete, or re-key one. `assertTenantScoped(actorTenantId, rowTenantId)` enforces this; call it before every write to an existing row.
- **`bun run rbac:sync` must be run after adding any API route**, and `bun run rbac:check` must exit zero. An undeclared handler is refused by Layer 1 — the new admin screens would 403 themselves.
- **Auth on every route:** `authorize('read'|'create'|'update'|'delete', 'Settings')`, matching `app/api/settings/roles/route.ts`.
- **Response shape:** `NextResponse.json({ success: true, data })` or `{ success: false, error: string }`.
- **Frontend:** TanStack Query hooks in `lib/queries/`, keys from `lib/queries/query-keys.ts` (the `rbac.*` and `ability.*` keys already exist). Every registry mutation invalidates **both** `queryKeys.rbac.all` and `queryKeys.ability.all`. Toasts import `toast` from `"sonner"`. Forms use `react-hook-form` + `zodResolver`.
- **Indentation:** 4 spaces in `lib/` and API routes, 2 spaces in `components/` — match the file you are editing.
- **Tests:** `cd apps/web-ui && bun run test` (Vitest, single run). Follow the `vi.hoisted()` + fake-transaction pattern in `lib/rbac/registry-service.test.ts:11-47` and `lib/rbac/role-rule-sync.test.ts:31-62`. Do not add component tests that need jsdom without an explicit `{ timeout: 30000 }` — jsdom setup takes ~33s in this environment.
- **Four test failures are pre-existing and red before you start** (audit-log `expiresAt`, inventory ILIKE, two scheduled-task repository assertions). Do not fix them; do not count them as your regression.

---

### Task 1: Widen the permission types and de-hardcode role levelling

`PermissionSet = Record<Module, Action[]>` where both are literal unions. A verb or module created at runtime cannot be expressed in that type, so it blocks every later task. The storage is JSON and already accepts any key — this is purely a type change, plus one real bug it exposes.

**Files:**
- Modify: `apps/web-ui/lib/rbac/types.ts:5-18`
- Modify: `apps/web-ui/lib/rbac/permissions.ts:1-7,68,91-99`
- Test: `apps/web-ui/lib/rbac/permissions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Module = string`, `type Action = string`, `type PermissionSet = Record<string, string[]>`, `type LegacyModule` / `type LegacyAction` (the retained literal unions, used only by the legacy fallback matrix), and `getAutoLevel(permissions: PermissionSet, ownerActionCount?: number): RoleLevel`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web-ui/lib/rbac/permissions.test.ts`:

```typescript
describe('getAutoLevel with a dynamic registry', () => {
    it('accepts permission sets with keys outside the legacy module union', () => {
        const perms: PermissionSet = {
            CostControl: ['read', 'update'],
            Accounts: ['read'],
        };
        expect(getAutoLevel(perms)).toBe(1);
    });

    it('scales the Owner threshold with the registry, not the static matrix', () => {
        // 21 ticks would clear the static Owner threshold (21 actions in
        // ROLE_PERMISSIONS.Owner) and hand out level 4 — the level that may
        // assign roles. With the real cell count passed in, it must not.
        const perms: PermissionSet = {
            Accounts: ['create', 'read', 'update', 'delete'],
            Schedules: ['create', 'read', 'update', 'delete'],
            AIOps: ['create', 'read', 'update', 'delete'],
            Inventory: ['create', 'read', 'update', 'delete'],
            CostControl: ['create', 'read', 'update', 'delete'],
            Dashboard: ['read'],
        };
        expect(getAutoLevel(perms, 21)).toBe(4);
        expect(getAutoLevel(perms, 40)).toBe(3);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/permissions.test.ts`
Expected: FAIL — `getAutoLevel` takes one argument, and TypeScript rejects `CostControl` as a `PermissionSet` key.

- [ ] **Step 3: Widen the types**

In `apps/web-ui/lib/rbac/types.ts`, replace the `Module`, `Action` and `PermissionSet` declarations with:

```typescript
/**
 * A module key. Was a literal union of the 6 seeded modules; now open, because
 * `rbac_modules` is authored from the UI and a runtime key cannot be a compile-
 * time union member. The registry is the authority on which keys exist —
 * `syncRoleRules` resolves keys against it and reports unknown ones as skipped.
 */
export type Module = string;

/** A verb key. Open for the same reason as Module. */
export type Action = string;

/**
 * The 6 modules and 4 verbs the LEGACY fallback matrix is written in terms of.
 * Retained as unions so `ROLE_PERMISSIONS` below stays exhaustively checked:
 * it is the decision source whenever DYNAMIC_ABAC_ENABLED is not 'true', and it
 * must keep describing exactly the world it was written for. Deleted with the
 * matrix in Workstream J.
 */
export type LegacyModule = 'Accounts' | 'Schedules' | 'AIOps' | 'Inventory' | 'Settings' | 'Dashboard';
export type LegacyAction = 'create' | 'read' | 'update' | 'delete';

export type PermissionSet = Record<string, string[]>;
```

In `apps/web-ui/lib/rbac/permissions.ts`, type the static matrix against the legacy unions so it stays exhaustive:

```typescript
import type { Module, Action, LegacyModule, LegacyAction, PredefinedRole, RoleLevel, PermissionSet } from './types';

export const ROLE_PERMISSIONS: Record<PredefinedRole, Record<LegacyModule, LegacyAction[]>> = {
    // ... rows unchanged ...
};
```

- [ ] **Step 4: Fix getAutoLevel**

Replace `getAutoLevel` in `apps/web-ui/lib/rbac/permissions.ts`:

```typescript
/**
 * Per D-10: auto-level a custom role by its total permission count.
 *
 * `ownerActionCount` is the number of grantable (module, action) cells in the
 * REGISTRY. It must be passed by any caller that can see the registry, because
 * the static Owner set is no longer the ceiling: once modules are authored from
 * the UI, a role can accumulate 21 ticks across ordinary modules and clear the
 * static threshold — silently reaching level 4, the level that may assign roles.
 * Defaulting to the static count keeps the legacy fallback path unchanged.
 */
export function getAutoLevel(permissions: PermissionSet, ownerActionCount?: number): RoleLevel {
    const totalActions = Object.values(permissions).flat().length;
    const ceiling = ownerActionCount ?? Object.values(ROLE_PERMISSIONS.Owner).flat().length;
    if (totalActions >= ceiling) return 4;
    if (totalActions >= 15) return 3;
    if (totalActions >= 8) return 2;
    return 1;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/permissions.test.ts lib/rbac/role-rule-sync.test.ts lib/rbac/custom-role-service.test.ts`
Expected: PASS. `role-rule-sync.test.ts:137,151,162` uses `as unknown as PermissionSet` casts that become redundant but still compile — leave them.

- [ ] **Step 6: Typecheck the whole app**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors. `hasCustomPermission(permissions, action, module)` keeps working because indexing `Record<string, string[]>` by a string is legal.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/rbac/types.ts apps/web-ui/lib/rbac/permissions.ts apps/web-ui/lib/rbac/permissions.test.ts
git commit -m "refactor(rbac): open Module/Action types so the registry can define them

getAutoLevel now takes the registry's grantable-cell count as its Owner
ceiling. Counting ticks against the static Owner set would hand level 4 —
the level that may assign roles — to any role with enough modules ticked."
```

---

### Task 2: Registry-admin read service and route

Both new screens and the rewritten role grid need one payload: modules with their grantable verbs and covered subjects, verbs, subjects, and the rule counts that make deletion refusals honest.

**Files:**
- Create: `apps/web-ui/lib/rbac/registry-admin.ts`
- Create: `apps/web-ui/lib/rbac/registry-admin.test.ts`
- Create: `apps/web-ui/app/api/settings/rbac/registry/route.ts`
- Modify: `apps/web-ui/lib/rbac/registry-isolation.test.ts` (allowlist the new file)

**Interfaces:**
- Consumes: `getPrismaClient` from `@/lib/db/pg-config`.
- Produces:

```typescript
export interface AdminActionRow {
    id: string; key: string; label: string; description: string | null;
    aliasOfKey: string | null; isDangerous: boolean; sortOrder: number;
    isSystem: boolean; isGlobal: boolean; ruleCount: number;
}
export interface AdminModuleRow {
    id: string; key: string; label: string; description: string | null;
    icon: string | null; navPath: string | null; sortOrder: number;
    enabled: boolean; isSystem: boolean; isGlobal: boolean;
    actionKeys: string[]; subjectKeys: string[]; ruleCount: number;
}
export interface AdminSubjectRow {
    id: string; key: string; label: string; kind: string;
    moduleKey: string | null; isSystem: boolean;
}
export interface AdminRegistry {
    modules: AdminModuleRow[]; actions: AdminActionRow[]; subjects: AdminSubjectRow[];
    /** Total grantable (module, action) cells — the getAutoLevel ceiling. */
    grantableCellCount: number;
}
export async function loadAdminRegistry(tenantId: string): Promise<AdminRegistry>;
```

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/rbac/registry-admin.test.ts`:

```typescript
/**
 * The admin registry read is what the Modules and Permissions screens render
 * from, and what makes a delete refusal truthful. Two properties matter: a
 * tenant-local row must shadow the global row of the same key (same precedence
 * as registry.ts's mergeByKey), and a row's ruleCount must be the number of
 * grants that would be destroyed by deleting it.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    prisma: {
        rbacModule: { findMany: vi.fn() },
        rbacAction: { findMany: vi.fn() },
        rbacSubject: { findMany: vi.fn() },
        rbacSubjectModule: { findMany: vi.fn() },
        rbacModuleAction: { findMany: vi.fn() },
        rbacRoleRule: { groupBy: vi.fn() },
    },
}));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => h.prisma }));

import { loadAdminRegistry } from './registry-admin';

function seed() {
    h.prisma.rbacModule.findMany.mockResolvedValue([
        { id: 'm-acc', tenantId: null, key: 'Accounts', label: 'Accounts', description: null, icon: null, navPath: '/app/accounts', sortOrder: 10, enabled: true, isSystem: true },
        { id: 'm-acc-t', tenantId: 't1', key: 'Accounts', label: 'AWS Accounts', description: null, icon: null, navPath: '/app/accounts', sortOrder: 10, enabled: true, isSystem: false },
    ]);
    h.prisma.rbacAction.findMany.mockResolvedValue([
        { id: 'a-read', tenantId: null, key: 'read', label: 'Read', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 20, isSystem: true },
    ]);
    h.prisma.rbacSubject.findMany.mockResolvedValue([
        { id: 's-acc', tenantId: null, key: 'Account', label: 'AWS Account', kind: 'resource', isSystem: true },
    ]);
    h.prisma.rbacSubjectModule.findMany.mockResolvedValue([{ subjectId: 's-acc', moduleId: 'm-acc' }]);
    h.prisma.rbacModuleAction.findMany.mockResolvedValue([
        { moduleId: 'm-acc', actionId: 'a-read', grantable: true },
        { moduleId: 'm-acc', actionId: 'a-read', grantable: false },
    ]);
    h.prisma.rbacRoleRule.groupBy.mockResolvedValue([]);
}

describe('loadAdminRegistry', () => {
    it('lets a tenant-local row shadow the global row of the same key', async () => {
        seed();
        const registry = await loadAdminRegistry('t1');
        expect(registry.modules).toHaveLength(1);
        expect(registry.modules[0].label).toBe('AWS Accounts');
        expect(registry.modules[0].isGlobal).toBe(false);
    });

    it('counts only grantable cells toward grantableCellCount', async () => {
        seed();
        const registry = await loadAdminRegistry('t1');
        expect(registry.grantableCellCount).toBe(1);
    });

    it('reports the rules that a delete would destroy', async () => {
        seed();
        h.prisma.rbacRoleRule.groupBy.mockResolvedValue([
            { moduleId: 'm-acc-t', actionId: 'a-read', _count: { _all: 3 } },
        ]);
        const registry = await loadAdminRegistry('t1');
        expect(registry.modules[0].ruleCount).toBe(3);
        expect(registry.actions[0].ruleCount).toBe(3);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin.test.ts`
Expected: FAIL — `Cannot find module './registry-admin'`.

- [ ] **Step 3: Write the service**

Create `apps/web-ui/lib/rbac/registry-admin.ts`:

```typescript
/**
 * Registry READS for the admin screens.
 *
 * Uses getPrismaClient() with an explicit `OR: [{ tenantId }, { tenantId: null }]`
 * on every query, for the reason spelled out at the top of registry.ts: the
 * system rows have `tenantId IS NULL`, and the tenant extension's injected
 * `WHERE tenant_id = $1` excludes NULLs, so a scoped client returns none of
 * them. This file is listed alongside registry.ts in registry-isolation.test.ts.
 *
 * Kept separate from registry.ts because the shapes differ: the compiler wants
 * raw rows, the screens want rows joined to their links and annotated with the
 * rule counts that make a delete refusal truthful.
 */

import { getPrismaClient } from '@/lib/db/pg-config';

export interface AdminActionRow {
    id: string;
    key: string;
    label: string;
    description: string | null;
    aliasOfKey: string | null;
    isDangerous: boolean;
    sortOrder: number;
    isSystem: boolean;
    /** True for a system row the tenant may relabel but not re-key or delete. */
    isGlobal: boolean;
    /** Grants that would be destroyed by deleting this row. */
    ruleCount: number;
}

export interface AdminModuleRow {
    id: string;
    key: string;
    label: string;
    description: string | null;
    icon: string | null;
    navPath: string | null;
    sortOrder: number;
    enabled: boolean;
    isSystem: boolean;
    isGlobal: boolean;
    /** Verb keys with a grantable RbacModuleAction row — the grid's columns. */
    actionKeys: string[];
    /** Subject keys mapped to this module — what makes its grants enforceable. */
    subjectKeys: string[];
    ruleCount: number;
}

export interface AdminSubjectRow {
    id: string;
    key: string;
    label: string;
    kind: string;
    moduleKey: string | null;
    isSystem: boolean;
}

export interface AdminRegistry {
    modules: AdminModuleRow[];
    actions: AdminActionRow[];
    subjects: AdminSubjectRow[];
    /**
     * Total grantable cells. Passed to getAutoLevel() as the Owner ceiling so
     * adding modules does not inflate every role's level.
     */
    grantableCellCount: number;
}

function globalOrTenant(tenantId: string) {
    return { OR: [{ tenantId }, { tenantId: null }] };
}

/**
 * A tenant-local row shadows the global row of the same key. Resolved in JS,
 * not with `orderBy: { tenantId: 'desc' }` — Postgres sorts DESC with NULLS
 * FIRST, so "take the first match" picks exactly backwards.
 */
function mergeByKey<T extends { key: string; tenantId: string | null }>(rows: T[]): T[] {
    const byKey = new Map<string, T>();
    for (const row of rows) {
        const existing = byKey.get(row.key);
        if (!existing || (existing.tenantId === null && row.tenantId !== null)) {
            byKey.set(row.key, row);
        }
    }
    return [...byKey.values()];
}

export async function loadAdminRegistry(tenantId: string): Promise<AdminRegistry> {
    const prisma = getPrismaClient();
    const scope = globalOrTenant(tenantId);

    const [modules, actions, subjects, subjectModules, moduleActions, ruleCounts] = await Promise.all([
        prisma.rbacModule.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
        prisma.rbacAction.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
        prisma.rbacSubject.findMany({ where: scope, orderBy: { key: 'asc' } }),
        prisma.rbacSubjectModule.findMany({ where: scope }),
        prisma.rbacModuleAction.findMany({ where: scope }),
        // Counted across the tenant's roles AND the global presets, because a
        // preset rule is destroyed by a cascade just as a tenant rule is.
        prisma.rbacRoleRule.groupBy({
            by: ['moduleId', 'actionId'],
            where: scope,
            _count: { _all: true },
        }),
    ]);

    const visibleModules = mergeByKey(modules);
    const visibleActions = mergeByKey(actions);
    const visibleSubjects = mergeByKey(subjects);

    const actionKeyById = new Map(visibleActions.map((a) => [a.id, a.key]));
    const subjectKeyById = new Map(visibleSubjects.map((s) => [s.id, s.key]));
    const moduleKeyById = new Map(visibleModules.map((m) => [m.id, m.key]));

    // Counts are keyed by KEY, not id: a tenant override and the global row it
    // shadows are the same permission to a reader, and rules may point at either.
    // Per-CELL counts are deliberately not computed here: Task 4 needs them for a
    // confirmation prompt, and that must reflect the state the write will see, so
    // it counts inside its own transaction.
    const rulesByModuleKey = new Map<string, number>();
    const rulesByActionKey = new Map<string, number>();
    for (const row of ruleCounts) {
        const count = row._count._all;
        const moduleKey = row.moduleId ? moduleKeyById.get(row.moduleId) : undefined;
        const actionKey = actionKeyById.get(row.actionId);
        if (moduleKey) rulesByModuleKey.set(moduleKey, (rulesByModuleKey.get(moduleKey) ?? 0) + count);
        if (actionKey) rulesByActionKey.set(actionKey, (rulesByActionKey.get(actionKey) ?? 0) + count);
    }

    const grantableByModuleId = new Map<string, Set<string>>();
    for (const link of moduleActions) {
        if (!link.grantable) continue;
        const key = actionKeyById.get(link.actionId);
        if (!key) continue;
        const bucket = grantableByModuleId.get(link.moduleId) ?? new Set<string>();
        bucket.add(key);
        grantableByModuleId.set(link.moduleId, bucket);
    }

    const subjectKeysByModuleId = new Map<string, string[]>();
    const moduleIdBySubjectId = new Map<string, string>();
    for (const link of subjectModules) {
        moduleIdBySubjectId.set(link.subjectId, link.moduleId);
        const key = subjectKeyById.get(link.subjectId);
        if (!key) continue;
        subjectKeysByModuleId.set(link.moduleId, [...(subjectKeysByModuleId.get(link.moduleId) ?? []), key]);
    }

    return {
        modules: visibleModules.map((m) => ({
            id: m.id,
            key: m.key,
            label: m.label,
            description: m.description,
            icon: m.icon,
            navPath: m.navPath,
            sortOrder: m.sortOrder,
            enabled: m.enabled,
            isSystem: m.isSystem,
            isGlobal: m.tenantId === null,
            actionKeys: [...(grantableByModuleId.get(m.id) ?? [])].sort(),
            subjectKeys: (subjectKeysByModuleId.get(m.id) ?? []).sort(),
            ruleCount: rulesByModuleKey.get(m.key) ?? 0,
        })),
        actions: visibleActions.map((a) => ({
            id: a.id,
            key: a.key,
            label: a.label,
            description: a.description,
            aliasOfKey: a.aliasOfKey,
            isDangerous: a.isDangerous,
            sortOrder: a.sortOrder,
            isSystem: a.isSystem,
            isGlobal: a.tenantId === null,
            ruleCount: rulesByActionKey.get(a.key) ?? 0,
        })),
        subjects: visibleSubjects.map((s) => ({
            id: s.id,
            key: s.key,
            label: s.label,
            kind: s.kind,
            moduleKey: moduleKeyById.get(moduleIdBySubjectId.get(s.id) ?? '') ?? null,
            isSystem: s.isSystem,
        })),
        grantableCellCount: [...grantableByModuleId.values()].reduce((sum, set) => sum + set.size, 0),
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Allowlist the file in the isolation guard**

Open `apps/web-ui/lib/rbac/registry-isolation.test.ts`, find the list of files permitted to call `getPrismaClient()` while touching an `rbac*` model, and add `registry-admin.ts` beside `registry.ts` with this comment:

```typescript
// registry-admin.ts reads the same global rows as registry.ts, for the admin
// screens, with the same explicit `OR: [{ tenantId }, { tenantId: null }]` on
// every query. Same exception, same reason.
```

- [ ] **Step 6: Write the read route**

Create `apps/web-ui/app/api/settings/rbac/registry/route.ts`:

```typescript
import { NextResponse } from 'next/server';

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { loadAdminRegistry } from '@/lib/rbac/registry-admin';

export const dynamic = 'force-dynamic';

export async function GET() {
    console.log('API - GET /api/settings/rbac/registry - Loading admin registry');
    const authError = await authorize('read', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const data = await loadAdminRegistry(tenantId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - Error loading admin registry:', error);
        return NextResponse.json({ success: false, error: 'Failed to load the permission registry' }, { status: 500 });
    }
}
```

- [ ] **Step 7: Regenerate the route manifest**

Run: `cd apps/web-ui && bun run rbac:sync && bun run rbac:check`
Expected: the manifest gains one `GET /api/settings/rbac/registry` entry with `source: 'inferred'`; `rbac:check` exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/rbac/registry-admin.ts apps/web-ui/lib/rbac/registry-admin.test.ts \
        apps/web-ui/lib/rbac/registry-isolation.test.ts \
        apps/web-ui/app/api/settings/rbac/registry/route.ts apps/web-ui/lib/rbac/generated
git commit -m "feat(rbac): read the registry for the admin screens

Annotates each row with the grants a delete would destroy, so a refusal can
state a number instead of a warning."
```

---

### Task 3: Permissions (verb) write service and routes

**Files:**
- Modify: `apps/web-ui/lib/rbac/registry-admin.ts` (append the write half)
- Modify: `apps/web-ui/lib/rbac/registry-admin.test.ts`
- Create: `apps/web-ui/app/api/settings/rbac/permissions/route.ts`
- Create: `apps/web-ui/app/api/settings/rbac/permissions/[actionId]/route.ts`

**Interfaces:**
- Consumes: `runRbacMutation`, `assertTenantScoped`, `TenantScopeError`, `type RbacActor` from `./registry-service`; `loadAdminRegistry` from Task 2.
- Produces:

```typescript
export class RegistryInUseError extends Error { constructor(message: string) }
export class SystemRowError extends Error { constructor(message: string) }
export interface ActionInput {
    key: string; label: string; description?: string | null;
    aliasOfKey?: string | null; isDangerous?: boolean; sortOrder?: number;
}
export async function createAction(actor: RbacActor, input: ActionInput): Promise<{ id: string }>;
export async function updateAction(actor: RbacActor, actionId: string, input: Partial<ActionInput>, reason?: string): Promise<void>;
export async function deleteAction(actor: RbacActor, actionId: string, reason?: string): Promise<void>;
export const ACTION_KEY_PATTERN: RegExp;
export const RESERVED_ACTION_KEYS: ReadonlySet<string>;
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/web-ui/lib/rbac/registry-admin.test.ts`. Add the write-path stubs to the hoisted mock first — extend the `h` object with a `tx` and a `$transaction`, following `registry-service.test.ts:11-47` (including the healthy-tenant lockout defaults, or every mutation throws `RbacLockoutError`):

```typescript
describe('createAction', () => {
    it('rejects a key that collides with a visible verb', async () => {
        await expect(
            createAction(actor, { key: 'read', label: 'Read Again' })
        ).rejects.toThrow(/already exists/i);
    });

    it('rejects a reserved key', async () => {
        await expect(
            createAction(actor, { key: 'manage', label: 'Manage' })
        ).rejects.toThrow(/reserved/i);
    });

    it('rejects a key that is not a lowercase identifier', async () => {
        await expect(
            createAction(actor, { key: 'Restart Service', label: 'Restart' })
        ).rejects.toThrow(/lowercase/i);
    });

    it('rejects an aliasOfKey that is not itself a verb', async () => {
        await expect(
            createAction(actor, { key: 'restart', label: 'Restart', aliasOfKey: 'bounce' })
        ).rejects.toThrow(/alias/i);
    });

    it('writes the row with the actor tenant, never global', async () => {
        await createAction(actor, { key: 'restart', label: 'Restart', aliasOfKey: 'update' });
        expect(h.tx.rbacAction.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ tenantId: 't1', key: 'restart' }) })
        );
    });
});

describe('deleteAction', () => {
    it('refuses to delete a system row', async () => {
        await expect(deleteAction(actor, 'sys-act-read')).rejects.toThrow(SystemRowError);
    });

    it('refuses to delete a verb that roles still grant, and says how many', async () => {
        h.tx.rbacRoleRule.count.mockResolvedValue(4);
        await expect(deleteAction(actor, 'a-restart')).rejects.toThrow(/4 grant/i);
    });

    it('deletes a verb no role grants', async () => {
        h.tx.rbacRoleRule.count.mockResolvedValue(0);
        await deleteAction(actor, 'a-restart');
        expect(h.tx.rbacAction.delete).toHaveBeenCalledWith({ where: { id: 'a-restart' } });
    });
});

describe('updateAction', () => {
    it('allows relabelling a system row', async () => {
        await updateAction(actor, 'sys-act-read', { label: 'View' });
        expect(h.tx.rbacAction.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'sys-act-read' }, data: { label: 'View' } })
        );
    });

    it('refuses to re-key a system row', async () => {
        await expect(updateAction(actor, 'sys-act-read', { key: 'view' })).rejects.toThrow(SystemRowError);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin.test.ts`
Expected: FAIL — `createAction` is not exported.

- [ ] **Step 3: Implement the write half**

Append to `apps/web-ui/lib/rbac/registry-admin.ts`:

```typescript
import {
    assertTenantScoped,
    runRbacMutation,
    type RbacActor,
    type RbacTransaction,
} from './registry-service';

/** Thrown when a delete would destroy live grants. Maps to HTTP 409. */
export class RegistryInUseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RegistryInUseError';
    }
}

/** Thrown when a tenant tries to restructure a global system row. HTTP 403. */
export class SystemRowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SystemRowError';
    }
}

/**
 * Verb keys are lowercase identifiers because that is what call sites pass to
 * authorize() — `authorize('restart', 'SpotGuard')`. A key that does not match
 * this shape can never be reached by code, only by an alias.
 */
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `manage` expands to a module's grantable verbs at compile time and `all` is
 * CASL's subject wildcard. Neither may be redefined as an ordinary row: doing so
 * would either shadow the expansion or emit a rule matching every subject.
 */
export const RESERVED_ACTION_KEYS: ReadonlySet<string> = new Set(['manage', 'all']);

/** Fields a tenant may edit on a GLOBAL system row. Everything else is structural. */
const RELABEL_ONLY: ReadonlySet<string> = new Set(['label', 'description', 'sortOrder']);

function assertRelabelOnly(patch: Record<string, unknown>, what: string): void {
    const structural = Object.keys(patch).filter((k) => !RELABEL_ONLY.has(k));
    if (structural.length > 0) {
        throw new SystemRowError(
            `'${what}' is a system row. It may be relabelled and reordered, but ${structural.join(', ')} ` +
                `cannot change — the compiler, the route manifest and the seeded rules all reference its key.`
        );
    }
}

export interface ActionInput {
    key: string;
    label: string;
    description?: string | null;
    aliasOfKey?: string | null;
    isDangerous?: boolean;
    sortOrder?: number;
}

export async function createAction(actor: RbacActor, input: ActionInput): Promise<{ id: string }> {
    if (actor.tenantId === null) throw new SystemRowError('Global registry authoring is not available here.');

    const key = input.key.trim();
    if (!ACTION_KEY_PATTERN.test(key)) {
        throw new Error(`'${key}' is not a valid permission key — use a lowercase identifier such as 'restart'.`);
    }
    if (RESERVED_ACTION_KEYS.has(key)) {
        throw new Error(`'${key}' is reserved by the permission engine and cannot be redefined.`);
    }

    const registry = await loadAdminRegistry(actor.tenantId);
    if (registry.actions.some((a) => a.key === key)) {
        throw new Error(`A permission named '${key}' already exists.`);
    }
    if (input.aliasOfKey && !registry.actions.some((a) => a.key === input.aliasOfKey)) {
        throw new Error(`Cannot alias '${key}' to '${input.aliasOfKey}' — no such permission.`);
    }
    if (input.aliasOfKey === key) {
        throw new Error(`A permission cannot be an alias of itself.`);
    }

    return runRbacMutation(
        { actor, entityType: 'action', entityId: key, operation: 'create', after: input },
        async (tx) =>
            tx.rbacAction.create({
                data: {
                    tenantId: actor.tenantId,
                    key,
                    label: input.label.trim(),
                    description: input.description ?? null,
                    aliasOfKey: input.aliasOfKey ?? null,
                    isDangerous: input.isDangerous ?? false,
                    sortOrder: input.sortOrder ?? 100,
                    isSystem: false,
                    createdBy: actor.email,
                },
                select: { id: true },
            })
    );
}

export async function updateAction(
    actor: RbacActor,
    actionId: string,
    input: Partial<ActionInput>,
    reason?: string
): Promise<void> {
    const prisma = getPrismaClient();
    const before = await prisma.rbacAction.findUnique({ where: { id: actionId } });
    if (!before) throw new Error('Permission not found');

    const patch: Record<string, unknown> = {};
    if (input.label !== undefined) patch.label = input.label.trim();
    if (input.description !== undefined) patch.description = input.description;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.key !== undefined && input.key !== before.key) patch.key = input.key.trim();
    if (input.aliasOfKey !== undefined) patch.aliasOfKey = input.aliasOfKey;
    if (input.isDangerous !== undefined) patch.isDangerous = input.isDangerous;

    if (before.tenantId === null) {
        assertRelabelOnly(patch, before.key);
    } else {
        assertTenantScoped(actor.tenantId, before.tenantId);
    }
    if (Object.keys(patch).length === 0) return;

    await runRbacMutation(
        { actor, entityType: 'action', entityId: actionId, operation: 'update', before, after: patch, reason },
        async (tx) => {
            await tx.rbacAction.update({ where: { id: actionId }, data: patch });
        }
    );
}

export async function deleteAction(actor: RbacActor, actionId: string, reason?: string): Promise<void> {
    const prisma = getPrismaClient();
    const before = await prisma.rbacAction.findUnique({ where: { id: actionId } });
    if (!before) throw new Error('Permission not found');
    if (before.tenantId === null) {
        throw new SystemRowError(
            `'${before.key}' is a system permission and cannot be deleted. Remove it from every module instead — ` +
                `it then disappears from the role grid without destroying any grant.`
        );
    }
    assertTenantScoped(actor.tenantId, before.tenantId);

    await runRbacMutation(
        { actor, entityType: 'action', entityId: actionId, operation: 'delete', before, reason },
        async (tx) => {
            // The FK cascades. Counting first turns a silent mass revocation
            // into a refusal that names the number.
            const grants = await tx.rbacRoleRule.count({ where: { actionId } });
            if (grants > 0) {
                throw new RegistryInUseError(
                    `'${before.key}' is granted by ${grants} rule(s). Deleting it would revoke them. ` +
                        `Remove it from every module first, or untick it in each role.`
                );
            }
            await tx.rbacAction.delete({ where: { id: actionId } });
        }
    );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the collection route**

Create `apps/web-ui/app/api/settings/rbac/permissions/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';

import { authorize } from '@/lib/rbac/authorize';
import { getAuthSession, getSessionTenantId } from '@/lib/auth-session';
import { createAction, loadAdminRegistry, RegistryInUseError, SystemRowError } from '@/lib/rbac/registry-admin';

export const dynamic = 'force-dynamic';

export async function GET() {
    console.log('API - GET /api/settings/rbac/permissions - Listing permissions');
    const authError = await authorize('read', 'Settings');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const { actions } = await loadAdminRegistry(tenantId);
        return NextResponse.json({ success: true, data: actions });
    } catch (error) {
        console.error('API - Error listing permissions:', error);
        return NextResponse.json({ success: false, error: 'Failed to list permissions' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    console.log('API - POST /api/settings/rbac/permissions - Creating permission');
    const authError = await authorize('create', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const actor = {
            userId: session?.user?.id ?? 'unknown',
            email: session?.user?.email ?? 'unknown',
            tenantId,
        };
        const body = await request.json();
        if (!body?.key || !body?.label) {
            return NextResponse.json({ success: false, error: 'Key and label are required' }, { status: 400 });
        }
        const created = await createAction(actor, {
            key: String(body.key),
            label: String(body.label),
            description: body.description ?? null,
            aliasOfKey: body.aliasOfKey || null,
            isDangerous: Boolean(body.isDangerous),
            sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : 100,
        });
        return NextResponse.json({ success: true, data: created }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating permission:', error);
        const status = error instanceof SystemRowError ? 403 : error instanceof RegistryInUseError ? 409 : 400;
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create permission' },
            { status }
        );
    }
}
```

- [ ] **Step 6: Write the item route**

Create `apps/web-ui/app/api/settings/rbac/permissions/[actionId]/route.ts` with `PUT` calling `updateAction` and `DELETE` calling `deleteAction`. Both resolve the actor exactly as `POST` above, read `reason` from the JSON body (`DELETE` may have no body — wrap `request.json()` in a try and default to `undefined`), authorize `'update'` and `'delete'` on `'Settings'` respectively, and map errors with the same three-way status mapping. Params arrive as `{ params }: { params: Promise<{ actionId: string }> }` and must be awaited — this is Next 15.

- [ ] **Step 7: Regenerate the manifest and run the suite**

Run: `cd apps/web-ui && bun run rbac:sync && bun run rbac:check && bun run test`
Expected: manifest gains 4 entries (GET/POST on the collection, PUT/DELETE on the item); the suite shows the 4 known pre-existing failures and no others.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/rbac/registry-admin.ts apps/web-ui/lib/rbac/registry-admin.test.ts \
        apps/web-ui/app/api/settings/rbac/permissions apps/web-ui/lib/rbac/generated
git commit -m "feat(rbac): author permissions (verbs) from the API

System rows accept a relabel and refuse a re-key. Deleting a verb that any
rule still grants is refused with the count, because the FK cascades."
```

---

### Task 4: Module write service and routes

The module form carries three writes that must commit together: the module row, its grantable verbs (`rbac_module_actions`), and its covered subjects (`rbac_subject_modules`). Two of them can silently revoke access, which is what most of this task is about.

**Files:**
- Modify: `apps/web-ui/lib/rbac/registry-admin.ts`
- Modify: `apps/web-ui/lib/rbac/registry-admin.test.ts`
- Create: `apps/web-ui/app/api/settings/rbac/modules/route.ts`
- Create: `apps/web-ui/app/api/settings/rbac/modules/[moduleId]/route.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces:

```typescript
export interface ModuleInput {
    key: string; label: string; description?: string | null;
    icon?: string | null; navPath?: string | null; sortOrder?: number;
    enabled?: boolean;
    /** Verb keys that become grantable cells on this module. */
    actionKeys: string[];
    /** Subject keys this module covers. Moving one materializes grants first. */
    subjectKeys: string[];
}
export interface ModuleWriteResult {
    id: string;
    /** Subject-level rules created to preserve access across a remap. */
    materializedRules: number;
    /** Module-level rules deleted because their cell stopped being grantable. */
    revokedRules: number;
}
export async function createModule(actor: RbacActor, input: ModuleInput): Promise<ModuleWriteResult>;
export async function updateModule(actor: RbacActor, moduleId: string, input: ModuleInput, opts?: { force?: boolean; reason?: string }): Promise<ModuleWriteResult>;
export async function deleteModule(actor: RbacActor, moduleId: string, reason?: string): Promise<void>;
export const MODULE_KEY_PATTERN: RegExp;
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/web-ui/lib/rbac/registry-admin.test.ts`. These need four stubs beyond Task 3's, added to the hoisted `h.tx`, with these defaults (individual tests override them):

```typescript
        rbacSubjectModule: {
            // 'SpotGuard' currently lives in Schedules — the remap source.
            findFirst: vi.fn().mockResolvedValue({ id: 'sm-spotguard', moduleId: 'm-sched' }),
            update: vi.fn(),
            create: vi.fn(),
            // Non-zero so deleteModule's "still covers" refusal fires by default.
            count: vi.fn().mockResolvedValue(2),
        },
        rbacModuleAction: {
            findMany: vi.fn().mockResolvedValue([{ id: 'ma-1', actionId: 'a-read' }]),
            createMany: vi.fn(),
            deleteMany: vi.fn(),
        },
```

and `h.tx.rbacRoleRule` extended with `createMany`, `deleteMany`, `count` (default `0`) and `findMany` (default `[]`). `h.prisma.rbacModule.findUnique` must resolve a tenant-owned row (`{ id: 'm-cost', tenantId: 't1', key: 'CostControl', enabled: true, sortOrder: 100, isSystem: false }`) for the tenant cases and a `tenantId: null` row for the system-row refusals, and `h.prisma.rbacSubject.findMany` must include `{ id: 's-spotguard', tenantId: null, key: 'SpotGuard', label: 'Fargate Spot Guard', kind: 'resource', isSystem: true }` so the key resolves.

```typescript
describe('updateModule — subject remap', () => {
    /**
     * The trap documented on RbacSubjectModule. A role holding only
     * (Schedules, update) reaches SpotGuard because the compiler expands the
     * module rule over the module's subjects. Move SpotGuard to Cost Control and
     * that role loses it — with no rule edited and nothing in the UI to show it.
     */
    it('materializes a subject-level rule for every role that would lose access', async () => {
        h.tx.rbacRoleRule.findMany.mockResolvedValue([
            { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-sched', conditions: null, inverted: false, reason: null },
        ]);
        const result = await updateModule(actor, 'm-cost', {
            key: 'CostControl', label: 'Cost Control',
            actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
        });
        expect(result.materializedRules).toBe(1);
        expect(h.tx.rbacRoleRule.createMany).toHaveBeenCalledWith({
            data: [expect.objectContaining({ roleId: 'role-ops', actionId: 'a-update', subjectId: 's-spotguard', moduleId: null })],
            skipDuplicates: true,
        });
    });

    it('materializes nothing for a role that already holds the destination grant', async () => {
        h.tx.rbacRoleRule.findMany.mockResolvedValue([
            { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-sched', conditions: null, inverted: false, reason: null },
            { id: 'r2', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-cost', conditions: null, inverted: false, reason: null },
        ]);
        const result = await updateModule(actor, 'm-cost', {
            key: 'CostControl', label: 'Cost Control',
            actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
        });
        expect(result.materializedRules).toBe(0);
    });
});

describe('updateModule — removing a grantable cell', () => {
    /**
     * grantable=false only affects `manage` expansion in the compiler
     * (rule-compiler.ts:244-251) — it does NOT stop an existing rule compiling.
     * Untick a cell with live grants and the permission stays in force while its
     * checkbox is gone from the grid: a grant nobody can see or revoke.
     */
    it('refuses without force when the cell still has grants', async () => {
        h.tx.rbacRoleRule.count.mockResolvedValue(2);
        await expect(
            updateModule(actor, 'm-acc', { key: 'Accounts', label: 'Accounts', actionKeys: ['read'], subjectKeys: ['Account'] })
        ).rejects.toThrow(/2 role\(s\)/i);
    });

    it('deletes the orphaned grants when forced', async () => {
        h.tx.rbacRoleRule.count.mockResolvedValue(2);
        const result = await updateModule(
            actor,
            'm-acc',
            { key: 'Accounts', label: 'Accounts', actionKeys: ['read'], subjectKeys: ['Account'] },
            { force: true }
        );
        expect(result.revokedRules).toBe(2);
        expect(h.tx.rbacRoleRule.deleteMany).toHaveBeenCalled();
    });
});

describe('deleteModule', () => {
    it('refuses a system row', async () => {
        await expect(deleteModule(actor, 'sys-mod-accounts')).rejects.toThrow(SystemRowError);
    });

    it('refuses a module that still covers subjects', async () => {
        await expect(deleteModule(actor, 'm-cost')).rejects.toThrow(/still covers/i);
    });
});

describe('createModule', () => {
    it('rejects a key that is not PascalCase', async () => {
        await expect(
            createModule(actor, { key: 'cost control', label: 'Cost', actionKeys: ['read'], subjectKeys: [] })
        ).rejects.toThrow(/letters and digits/i);
    });

    it('requires at least one grantable permission', async () => {
        await expect(
            createModule(actor, { key: 'CostControl', label: 'Cost', actionKeys: [], subjectKeys: [] })
        ).rejects.toThrow(/at least one permission/i);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin.test.ts`
Expected: FAIL — `createModule` is not exported.

- [ ] **Step 3: Implement the module writes**

Append to `apps/web-ui/lib/rbac/registry-admin.ts`:

```typescript
/** Module keys are PascalCase identifiers, matching every seeded key. */
export const MODULE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export interface ModuleInput {
    key: string;
    label: string;
    description?: string | null;
    icon?: string | null;
    navPath?: string | null;
    sortOrder?: number;
    enabled?: boolean;
    actionKeys: string[];
    subjectKeys: string[];
}

export interface ModuleWriteResult {
    id: string;
    materializedRules: number;
    revokedRules: number;
}

/**
 * Preserves access across a subject remap.
 *
 * When subject S moves from module A to module B, every role holding
 * (A, verb) but not (B, verb) silently loses S — the compiler expands a module
 * rule over the module's CURRENT subjects, so the grant evaporates with no rule
 * edited. This writes the explicit subject-level rule that keeps it, which the
 * schema comment on RbacSubjectModule calls for. Conditions and `inverted` are
 * copied verbatim: a conditional grant must stay exactly as conditional.
 */
async function materializeSubjectGrants(
    tx: RbacTransaction,
    opts: { tenantId: string; subjectId: string; fromModuleId: string; toModuleId: string; createdBy: string }
): Promise<number> {
    const { tenantId, subjectId, fromModuleId, toModuleId, createdBy } = opts;

    const rules = await tx.rbacRoleRule.findMany({
        where: { moduleId: { in: [fromModuleId, toModuleId] } },
        select: { roleId: true, actionId: true, moduleId: true, conditions: true, inverted: true, reason: true },
    });

    const destination = new Set(
        rules.filter((r) => r.moduleId === toModuleId).map((r) => `${r.roleId}::${r.actionId}`)
    );

    const toCreate = rules
        .filter((r) => r.moduleId === fromModuleId && !destination.has(`${r.roleId}::${r.actionId}`))
        .map((r) => ({
            tenantId,
            roleId: r.roleId,
            actionId: r.actionId,
            moduleId: null,
            subjectId,
            conditions: r.conditions ?? undefined,
            inverted: r.inverted,
            reason: r.reason ?? 'Preserved when this area moved to another module',
            createdBy,
        }));

    if (toCreate.length === 0) return 0;
    // skipDuplicates: the (roleId, actionId, moduleId, subjectId) unique index
    // makes a re-run of the same remap a no-op rather than a crash.
    await tx.rbacRoleRule.createMany({ data: toCreate, skipDuplicates: true });
    return toCreate.length;
}

/**
 * Applies the grantable-cell set, and deals with the cells being REMOVED.
 *
 * `grantable: false` does not stop an existing rule compiling — it only trims
 * `manage` expansion. So a removed cell whose rules stay behind is a permission
 * in force with no checkbox: invisible and unrevokable from the grid. Removing
 * such a cell therefore requires `force`, and then deletes the rules.
 */
async function applyModuleActions(
    tx: RbacTransaction,
    opts: {
        tenantId: string;
        moduleId: string;
        moduleKey: string;
        actionIdByKey: Map<string, string>;
        actionKeys: string[];
        force: boolean;
    }
): Promise<number> {
    const { tenantId, moduleId, moduleKey, actionIdByKey, actionKeys, force } = opts;

    const desired = new Set(
        actionKeys.map((key) => {
            const id = actionIdByKey.get(key);
            if (!id) throw new Error(`Unknown permission '${key}'.`);
            return id;
        })
    );

    const existing = await tx.rbacModuleAction.findMany({ where: { moduleId }, select: { id: true, actionId: true } });
    const existingIds = new Set(existing.map((row) => row.actionId));

    const removed = existing.filter((row) => !desired.has(row.actionId));
    let revoked = 0;
    if (removed.length > 0) {
        const grants = await tx.rbacRoleRule.count({
            where: { moduleId, actionId: { in: removed.map((r) => r.actionId) } },
        });
        if (grants > 0 && !force) {
            throw new RegistryInUseError(
                `Removing those permissions from '${moduleKey}' would leave ${grants} role(s) holding a grant ` +
                    `with no checkbox to revoke it. Confirm to revoke them as part of this change.`
            );
        }
        if (grants > 0) {
            await tx.rbacRoleRule.deleteMany({
                where: { moduleId, actionId: { in: removed.map((r) => r.actionId) } },
            });
            revoked = grants;
        }
        await tx.rbacModuleAction.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
    }

    const added = [...desired].filter((actionId) => !existingIds.has(actionId));
    if (added.length > 0) {
        await tx.rbacModuleAction.createMany({
            data: added.map((actionId) => ({ tenantId, moduleId, actionId, grantable: true })),
            skipDuplicates: true,
        });
    }

    return revoked;
}

async function applyModuleSubjects(
    tx: RbacTransaction,
    opts: {
        tenantId: string;
        moduleId: string;
        subjectIdByKey: Map<string, string>;
        subjectKeys: string[];
        createdBy: string;
    }
): Promise<number> {
    const { tenantId, moduleId, subjectIdByKey, subjectKeys, createdBy } = opts;
    let materialized = 0;

    const desired = subjectKeys.map((key) => {
        const id = subjectIdByKey.get(key);
        if (!id) throw new Error(`Unknown area '${key}'.`);
        return id;
    });

    for (const subjectId of desired) {
        // @@unique([tenantId, subjectId]) — a subject belongs to exactly one
        // module, so this is an upsert-shaped move, not an add.
        const current = await tx.rbacSubjectModule.findFirst({ where: { subjectId }, select: { id: true, moduleId: true } });
        if (current?.moduleId === moduleId) continue;

        if (current) {
            materialized += await materializeSubjectGrants(tx, {
                tenantId,
                subjectId,
                fromModuleId: current.moduleId,
                toModuleId: moduleId,
                createdBy,
            });
            await tx.rbacSubjectModule.update({ where: { id: current.id }, data: { moduleId } });
        } else {
            await tx.rbacSubjectModule.create({ data: { tenantId, subjectId, moduleId } });
        }
    }

    // Subjects dropped from this module are NOT unmapped: a subject with no
    // module compiles to nothing, which fails closed and revokes access
    // silently. They stay put until another module claims them.
    return materialized;
}

function validateModuleInput(input: ModuleInput): string {
    const key = input.key.trim();
    if (!MODULE_KEY_PATTERN.test(key)) {
        throw new Error(`'${key}' is not a valid module key — use letters and digits only, e.g. 'CostControl'.`);
    }
    if (input.actionKeys.length === 0) {
        throw new Error('Select at least one permission for this module, or its column has nothing to grant.');
    }
    return key;
}

export async function createModule(actor: RbacActor, input: ModuleInput): Promise<ModuleWriteResult> {
    if (actor.tenantId === null) throw new SystemRowError('Global registry authoring is not available here.');
    const key = validateModuleInput(input);
    const tenantId = actor.tenantId;

    const registry = await loadAdminRegistry(tenantId);
    if (registry.modules.some((m) => m.key === key)) {
        throw new Error(`A module named '${key}' already exists.`);
    }
    const actionIdByKey = new Map(registry.actions.map((a) => [a.key, a.id]));
    const subjectIdByKey = new Map(registry.subjects.map((s) => [s.key, s.id]));

    return runRbacMutation(
        { actor, entityType: 'module', entityId: key, operation: 'create', after: input },
        async (tx) => {
            const module = await tx.rbacModule.create({
                data: {
                    tenantId,
                    key,
                    label: input.label.trim(),
                    description: input.description ?? null,
                    icon: input.icon ?? null,
                    navPath: input.navPath ?? null,
                    sortOrder: input.sortOrder ?? 100,
                    enabled: input.enabled ?? true,
                    isSystem: false,
                    createdBy: actor.email,
                },
                select: { id: true },
            });

            const revokedRules = await applyModuleActions(tx, {
                tenantId,
                moduleId: module.id,
                moduleKey: key,
                actionIdByKey,
                actionKeys: input.actionKeys,
                force: true, // a new module has no cells to remove
            });
            const materializedRules = await applyModuleSubjects(tx, {
                tenantId,
                moduleId: module.id,
                subjectIdByKey,
                subjectKeys: input.subjectKeys,
                createdBy: actor.email,
            });

            return { id: module.id, materializedRules, revokedRules };
        }
    );
}

export async function updateModule(
    actor: RbacActor,
    moduleId: string,
    input: ModuleInput,
    opts: { force?: boolean; reason?: string } = {}
): Promise<ModuleWriteResult> {
    const key = validateModuleInput(input);
    const prisma = getPrismaClient();
    const before = await prisma.rbacModule.findUnique({ where: { id: moduleId } });
    if (!before) throw new Error('Module not found');

    const tenantId = actor.tenantId;
    if (tenantId === null) throw new SystemRowError('Global registry authoring is not available here.');

    const patch: Record<string, unknown> = {
        label: input.label.trim(),
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? before.sortOrder,
    };
    if (before.tenantId === null) {
        // A system module may be relabelled and reordered. Its key, icon target,
        // nav path and enabled flag are structural: the route manifest, the
        // sidebar and the compiler are all written against them.
        assertRelabelOnly(
            {
                ...patch,
                ...(key !== before.key ? { key } : {}),
                ...(input.enabled !== undefined && input.enabled !== before.enabled ? { enabled: input.enabled } : {}),
            },
            before.key
        );
    } else {
        assertTenantScoped(tenantId, before.tenantId);
        patch.key = key;
        patch.icon = input.icon ?? null;
        patch.navPath = input.navPath ?? null;
        patch.enabled = input.enabled ?? before.enabled;
    }

    const registry = await loadAdminRegistry(tenantId);
    const actionIdByKey = new Map(registry.actions.map((a) => [a.key, a.id]));
    const subjectIdByKey = new Map(registry.subjects.map((s) => [s.key, s.id]));

    return runRbacMutation(
        {
            actor,
            entityType: 'module',
            entityId: moduleId,
            operation: 'update',
            before,
            after: input,
            reason: opts.reason,
            // A remap is a permission-preserving migration, not an ordinary
            // edit, and deserves its own name in the ledger.
            eventType: input.subjectKeys.length > 0 ? 'rbac.subject.remapped' : undefined,
        },
        async (tx) => {
            await tx.rbacModule.update({ where: { id: moduleId }, data: patch });
            const revokedRules = await applyModuleActions(tx, {
                tenantId,
                moduleId,
                moduleKey: key,
                actionIdByKey,
                actionKeys: input.actionKeys,
                force: opts.force ?? false,
            });
            const materializedRules = await applyModuleSubjects(tx, {
                tenantId,
                moduleId,
                subjectIdByKey,
                subjectKeys: input.subjectKeys,
                createdBy: actor.email,
            });
            return { id: moduleId, materializedRules, revokedRules };
        }
    );
}

export async function deleteModule(actor: RbacActor, moduleId: string, reason?: string): Promise<void> {
    const prisma = getPrismaClient();
    const before = await prisma.rbacModule.findUnique({ where: { id: moduleId } });
    if (!before) throw new Error('Module not found');
    if (before.tenantId === null) {
        throw new SystemRowError(
            `'${before.key}' is a system module and cannot be deleted. Disable it instead — the compiler ` +
                `contributes nothing for a disabled module, so its grants stop applying without being destroyed.`
        );
    }
    assertTenantScoped(actor.tenantId, before.tenantId);

    await runRbacMutation(
        { actor, entityType: 'module', entityId: moduleId, operation: 'delete', before, reason },
        async (tx) => {
            // A subject with no module compiles to nothing, so deleting a module
            // that still covers areas revokes them silently. Refuse; make the
            // operator move them somewhere explicit first.
            const covered = await tx.rbacSubjectModule.count({ where: { moduleId } });
            if (covered > 0) {
                throw new RegistryInUseError(
                    `'${before.key}' still covers ${covered} area(s). Move them to another module first, or they ` +
                        `would stop being reachable by any role.`
                );
            }
            const grants = await tx.rbacRoleRule.count({ where: { moduleId } });
            if (grants > 0) {
                throw new RegistryInUseError(
                    `'${before.key}' is granted by ${grants} rule(s). Untick it in those roles first, or disable ` +
                        `the module to suspend it without destroying the grants.`
                );
            }
            await tx.rbacModule.delete({ where: { id: moduleId } });
        }
    );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Write the routes**

Create `apps/web-ui/app/api/settings/rbac/modules/route.ts` (`GET` returning `loadAdminRegistry().modules`, `POST` calling `createModule`) and `apps/web-ui/app/api/settings/rbac/modules/[moduleId]/route.ts` (`PUT` calling `updateModule` with `force` and `reason` from the body, `DELETE` calling `deleteModule`). Copy the actor resolution, validation, and three-way error mapping from `apps/web-ui/app/api/settings/rbac/permissions/route.ts` verbatim. `PUT` returns `{ success: true, data: { id, materializedRules, revokedRules } }` so the UI can report "3 grants preserved" in its toast.

- [ ] **Step 6: Regenerate the manifest and run the suite**

Run: `cd apps/web-ui && bun run rbac:sync && bun run rbac:check && bun run test`
Expected: manifest gains 4 entries; only the 4 known failures.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/rbac/registry-admin.ts apps/web-ui/lib/rbac/registry-admin.test.ts \
        apps/web-ui/app/api/settings/rbac/modules apps/web-ui/lib/rbac/generated
git commit -m "feat(rbac): author modules, their permissions and their coverage

Two silent revocations are now refusals: moving an area between modules
materializes the subject-level grants that would have evaporated, and
un-ticking a cell with live grants requires confirmation because
grantable=false does not stop an existing rule compiling."
```

---

### Task 5: Ship the grantable cells to the client

The role grid must know which cells exist. `/api/me/ability` already loads the full snapshot and ships modules, actions and subjects — adding `moduleActions` keeps the grid reading from the same source the rules compiled from, which is the whole point of that route.

**Files:**
- Modify: `apps/web-ui/app/api/me/ability/route.ts:70-95`
- Modify: `apps/web-ui/providers/ability-provider.tsx:32-150`
- Modify: `apps/web-ui/hooks/use-can.ts`
- Test: `apps/web-ui/lib/rbac/ability-payload.test.ts` (new)

**Interfaces:**
- Consumes: `loadRegistrySnapshot` from `@/lib/rbac/registry`.
- Produces: `AbilityPayload.moduleActions: AbilityModuleAction[]` where `interface AbilityModuleAction { moduleKey: string; actionKey: string }`; `AbilityMeta.moduleActions`; and `useGrantableCells(): { moduleKey: string; actionKey: string }[]` from `hooks/use-can.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/rbac/ability-payload.test.ts`:

```typescript
/**
 * The role grid renders its columns from this payload. If it shipped every
 * (module, action) pair rather than the grantable ones, the grid would offer
 * ticks that `manage` never expands to — a checkbox promising more than the
 * engine grants.
 */
import { describe, expect, it } from 'vitest';

import { toAbilityModuleActions } from './ability-payload';

describe('toAbilityModuleActions', () => {
    const snapshot = {
        modules: [{ id: 'm-acc', key: 'Accounts' }, { id: 'm-dash', key: 'Dashboard' }],
        actions: [{ id: 'a-read', key: 'read' }, { id: 'a-delete', key: 'delete' }],
        moduleActions: [
            { moduleId: 'm-acc', actionId: 'a-read', grantable: true },
            { moduleId: 'm-acc', actionId: 'a-delete', grantable: false },
            { moduleId: 'm-dash', actionId: 'a-read', grantable: true },
        ],
    };

    it('emits one entry per grantable cell', () => {
        expect(toAbilityModuleActions(snapshot as never)).toEqual([
            { moduleKey: 'Accounts', actionKey: 'read' },
            { moduleKey: 'Dashboard', actionKey: 'read' },
        ]);
    });

    it('drops a cell whose module or action is not in the snapshot', () => {
        const orphaned = { ...snapshot, moduleActions: [{ moduleId: 'gone', actionId: 'a-read', grantable: true }] };
        expect(toAbilityModuleActions(orphaned as never)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/ability-payload.test.ts`
Expected: FAIL — `Cannot find module './ability-payload'`.

- [ ] **Step 3: Write the projection**

Create `apps/web-ui/lib/rbac/ability-payload.ts`:

```typescript
/**
 * Projections shipped by /api/me/ability. Extracted so they are unit-testable
 * without standing up a session.
 */
import type { RegistrySnapshot } from '@nucleus/rbac';

export interface AbilityModuleAction {
    moduleKey: string;
    actionKey: string;
}

/**
 * The grid cells that exist, as (moduleKey, actionKey) pairs.
 *
 * Only `grantable` links are emitted. A non-grantable link is a cell the role
 * editor must render disabled, and `manage` never expands to it — offering it as
 * a tick would promise a grant the compiler does not produce.
 */
export function toAbilityModuleActions(registry: RegistrySnapshot): AbilityModuleAction[] {
    const moduleKeyById = new Map(registry.modules.map((m) => [m.id, m.key]));
    const actionKeyById = new Map(registry.actions.map((a) => [a.id, a.key]));

    const out: AbilityModuleAction[] = [];
    for (const link of registry.moduleActions) {
        if (!link.grantable) continue;
        const moduleKey = moduleKeyById.get(link.moduleId);
        const actionKey = actionKeyById.get(link.actionId);
        if (!moduleKey || !actionKey) continue;
        out.push({ moduleKey, actionKey });
    }
    return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/ability-payload.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it through the route and the provider**

In `apps/web-ui/app/api/me/ability/route.ts`, import `toAbilityModuleActions` and add to the `data` object, after `actions`:

```typescript
                    /**
                     * Which grid cells exist. Rides along for the same reason
                     * `modules` does: the role editor must render from the rows
                     * the rules compiled FROM, or a tick and a grant can differ.
                     */
                    moduleActions: toAbilityModuleActions(registry),
```

In `apps/web-ui/providers/ability-provider.tsx`: add `moduleActions: AbilityModuleAction[]` to `AbilityPayload` and to `AbilityMeta`, re-export the type, default it to `[]` in the `AbilityMetaContext` default and in the `useMemo`.

In `apps/web-ui/hooks/use-can.ts`, add:

```typescript
/**
 * The (module, action) cells the role editor may offer. Sourced from the ability
 * payload so the grid and the compiler cannot disagree about which cells exist.
 */
export function useGrantableCells(): AbilityModuleAction[] {
    return useAbilityMeta().moduleActions;
}
```

- [ ] **Step 6: Verify the payload end-to-end**

Run `bun run dev` from the repo root, sign in, then:

Run: `curl -s -b "<session cookie>" http://localhost:3001/api/me/ability | jq '.data.moduleActions | length'`
Expected: `21` — the 20 CRUD cells the migration seeds across 5 modules plus `Dashboard:read` (`migration.sql:536-553`).

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/rbac/ability-payload.ts apps/web-ui/lib/rbac/ability-payload.test.ts \
        apps/web-ui/app/api/me/ability/route.ts apps/web-ui/providers/ability-provider.tsx \
        apps/web-ui/hooks/use-can.ts
git commit -m "feat(rbac): ship the grantable grid cells with the ability payload"
```

---

### Task 6: Registry query hooks

**Files:**
- Create: `apps/web-ui/lib/queries/rbac-registry.ts`

**Interfaces:**
- Consumes: `queryKeys.rbac.*` and `queryKeys.ability.*` from `lib/queries/query-keys.ts` (already defined at lines 114-132); the `AdminRegistry` types from Task 2.
- Produces: `useAdminRegistry()`, `useCreatePermission()`, `useUpdatePermission()`, `useDeletePermission()`, `useCreateModule()`, `useUpdateModule()`, `useDeleteModule()`. Every mutation's `onSuccess` invalidates `queryKeys.rbac.all` **and** `queryKeys.ability.all`.

- [ ] **Step 1: Write the hooks**

Create `apps/web-ui/lib/queries/rbac-registry.ts`:

```typescript
'use client';

/**
 * TanStack Query hooks for the permission registry (Settings → Access Control).
 *
 * Every mutation invalidates BOTH `queryKeys.rbac.all` and
 * `queryKeys.ability.all`, matching lib/queries/permissions.ts: a registry
 * change alters the taxonomy AND the caller's own compiled ability, and
 * refreshing one without the other leaves the screen disagreeing with the API.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from './query-keys';
import type { AdminRegistry } from '@/lib/rbac/registry-admin';

export type { AdminActionRow, AdminModuleRow, AdminSubjectRow } from '@/lib/rbac/registry-admin';

export interface PermissionInput {
    key: string;
    label: string;
    description?: string | null;
    aliasOfKey?: string | null;
    isDangerous?: boolean;
    sortOrder?: number;
}

export interface ModuleFormInput {
    key: string;
    label: string;
    description?: string | null;
    icon?: string | null;
    navPath?: string | null;
    sortOrder?: number;
    enabled?: boolean;
    actionKeys: string[];
    subjectKeys: string[];
    /** Confirms revoking grants whose cell is being removed. */
    force?: boolean;
    reason?: string;
}

export interface ModuleWriteResult {
    id: string;
    materializedRules: number;
    revokedRules: number;
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error ?? fallback);
    return json.data as T;
}

export function useAdminRegistry() {
    return useQuery({
        queryKey: queryKeys.rbac.registry(),
        queryFn: async (): Promise<AdminRegistry> => {
            const res = await fetch('/api/settings/rbac/registry');
            return readJson<AdminRegistry>(res, 'Failed to load the permission registry.');
        },
    });
}

function useRegistryMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: fn,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.rbac.all });
            qc.invalidateQueries({ queryKey: queryKeys.ability.all });
            // The roles screen renders the grid from the registry, and its own
            // cache key predates queryKeys.rbac — invalidate it explicitly.
            qc.invalidateQueries({ queryKey: ['settings', 'roles'] });
        },
    });
}

export function useCreatePermission() {
    return useRegistryMutation(async (input: PermissionInput) => {
        const res = await fetch('/api/settings/rbac/permissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        return readJson<{ id: string }>(res, 'Failed to create the permission.');
    });
}

export function useUpdatePermission() {
    return useRegistryMutation(async ({ id, ...input }: PermissionInput & { id: string; reason?: string }) => {
        const res = await fetch(`/api/settings/rbac/permissions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        return readJson<unknown>(res, 'Failed to update the permission.');
    });
}

export function useDeletePermission() {
    return useRegistryMutation(async ({ id, reason }: { id: string; reason?: string }) => {
        const res = await fetch(`/api/settings/rbac/permissions/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        return readJson<unknown>(res, 'Failed to delete the permission.');
    });
}

export function useCreateModule() {
    return useRegistryMutation(async (input: ModuleFormInput) => {
        const res = await fetch('/api/settings/rbac/modules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        return readJson<ModuleWriteResult>(res, 'Failed to create the module.');
    });
}

export function useUpdateModule() {
    return useRegistryMutation(async ({ id, ...input }: ModuleFormInput & { id: string }) => {
        const res = await fetch(`/api/settings/rbac/modules/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        return readJson<ModuleWriteResult>(res, 'Failed to update the module.');
    });
}

export function useDeleteModule() {
    return useRegistryMutation(async ({ id, reason }: { id: string; reason?: string }) => {
        const res = await fetch(`/api/settings/rbac/modules/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        return readJson<unknown>(res, 'Failed to delete the module.');
    });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no errors. Importing types from `lib/rbac/registry-admin` into a client file is type-only and erased — do not import its functions.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/queries/rbac-registry.ts
git commit -m "feat(rbac): query hooks for the permission registry"
```

---

### Task 7: Permissions tab

**Files:**
- Create: `apps/web-ui/components/settings/access-control/permissions-tab.tsx`
- Create: `apps/web-ui/components/settings/access-control/permission-dialog.tsx`

**Interfaces:**
- Consumes: `useAdminRegistry`, `useCreatePermission`, `useUpdatePermission`, `useDeletePermission`, `type AdminActionRow` from `@/lib/queries/rbac-registry`; `GatedButton` from `@/components/rbac/gated`.
- Produces: `<PermissionsTab />`, `<PermissionDialog open onOpenChange permission actions onSaved />`.

- [ ] **Step 1: Build the dialog**

Create `apps/web-ui/components/settings/access-control/permission-dialog.tsx`. React Hook Form + `zodResolver`, 2-space indentation, `toast` from `"sonner"`.

```tsx
"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  useCreatePermission,
  useUpdatePermission,
  type AdminActionRow,
} from "@/lib/queries/rbac-registry";

/**
 * `key` mirrors ACTION_KEY_PATTERN in lib/rbac/registry-admin.ts. Validated in
 * both places on purpose: the client message is immediate, the server one is
 * the boundary.
 */
const schema = z.object({
  key: z
    .string()
    .min(1, "A key is required.")
    .regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase identifier, e.g. 'restart'."),
  label: z.string().min(1, "A label is required."),
  description: z.string().optional(),
  aliasOfKey: z.string().optional(),
  isDangerous: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(9999),
});

type FormValues = z.infer<typeof schema>;

const NO_ALIAS = "__none__";

export function PermissionDialog({
  open,
  onOpenChange,
  permission,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permission: AdminActionRow | null;
  actions: AdminActionRow[];
}) {
  const create = useCreatePermission();
  const update = useUpdatePermission();
  const isEdit = Boolean(permission);
  // A system row may be relabelled and reordered; its key and alias are
  // structural, and the API refuses to change them.
  const structuralLocked = Boolean(permission?.isGlobal);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { key: "", label: "", description: "", aliasOfKey: NO_ALIAS, isDangerous: false, sortOrder: 100 },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      key: permission?.key ?? "",
      label: permission?.label ?? "",
      description: permission?.description ?? "",
      aliasOfKey: permission?.aliasOfKey ?? NO_ALIAS,
      isDangerous: permission?.isDangerous ?? false,
      sortOrder: permission?.sortOrder ?? 100,
    });
  }, [open, permission, form]);

  async function onSubmit(values: FormValues) {
    const payload = {
      ...values,
      description: values.description || null,
      aliasOfKey: values.aliasOfKey === NO_ALIAS ? null : values.aliasOfKey,
    };
    try {
      if (permission) {
        await update.mutateAsync({ id: permission.id, ...payload });
        toast.success(`Updated '${values.label}'.`);
      } else {
        await create.mutateAsync(payload);
        toast.success(`Created '${values.label}'. Tick it on a module to make it grantable.`);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save the permission.");
    }
  }

  const saving = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${permission?.label}` : "New permission"}</DialogTitle>
          <DialogDescription>
            A permission is a verb a role can be granted. It only appears in the role grid once a module
            makes it grantable.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="perm-key">Key</Label>
            <Input id="perm-key" {...form.register("key")} disabled={structuralLocked} placeholder="restart" />
            {structuralLocked && (
              <p className="text-xs text-muted-foreground">
                Built-in permission — the key is referenced by application code and cannot change.
              </p>
            )}
            {form.formState.errors.key && (
              <p className="text-xs text-destructive">{form.formState.errors.key.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-label">Label</Label>
            <Input id="perm-label" {...form.register("label")} placeholder="Restart" />
            {form.formState.errors.label && (
              <p className="text-xs text-destructive">{form.formState.errors.label.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-desc">Description</Label>
            <Input id="perm-desc" {...form.register("description")} placeholder="Shown in the role editor" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-alias">Behaves as</Label>
            <Select
              value={form.watch("aliasOfKey")}
              onValueChange={(value) => form.setValue("aliasOfKey", value)}
              disabled={structuralLocked}
            >
              <SelectTrigger id="perm-alias">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ALIAS}>Itself (needs code that checks it)</SelectItem>
                {actions
                  .filter((a) => !a.aliasOfKey && a.key !== permission?.key)
                  .map((a) => (
                    <SelectItem key={a.key} value={a.key}>
                      {a.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              An alias is enforced immediately, by the checks that already exist for the permission it
              behaves as. A permission that behaves as itself enforces nothing until application code
              checks for it.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="perm-danger"
              checked={form.watch("isDangerous")}
              onCheckedChange={(checked) => form.setValue("isDangerous", checked === true)}
            />
            <Label htmlFor="perm-danger" className="font-normal">
              Dangerous — require a typed confirmation when granting it
            </Label>
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-order">Column order</Label>
            <Input id="perm-order" type="number" {...form.register("sortOrder")} className="w-28" />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner className="mr-2 h-4 w-4" />}
              {isEdit ? "Save" : "Create permission"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Build the tab**

Create `apps/web-ui/components/settings/access-control/permissions-tab.tsx`: a `Card` wrapping a `Table` with columns Permission (label + `<code>{key}</code>`), Behaves as (the alias, or `—`), Dangerous (a `Badge variant="destructive"` when set), In use (`{ruleCount} grants`), Source (`Built-in` / `Custom` badge from `isGlobal`), and a row action menu. Empty and loading states use `Spinner`.

Requirements:
- The "New permission" button and every row action wrap in `GatedButton action="update" subject="Settings"` (from `@/components/rbac/gated`) so a member without Settings rights sees a disabled control with the reason, per the hide-vs-disable note in `components/rbac/gated.tsx`.
- Delete is hidden for `isGlobal` rows and disabled with the tooltip `"{n} roles grant this permission"` when `ruleCount > 0` — the API refuses either way; this saves the round trip.
- Deleting shows a confirmation `AlertDialog` naming the permission, then calls `useDeletePermission`, surfacing the server error via `toast.error`.
- Add a one-line hint above the table: *"A permission becomes grantable when a module lists it. Verbs already defined but unused by any module show 0 grants."*

- [ ] **Step 3: Verify the data the tab will render**

The page that hosts this tab lands in Task 10, so verify the payload rather than temporarily wiring the component into another page — a scaffold added to be removed later shows up in the diff as stray code.

Run `bun run dev`, sign in as an Owner, then:

Run: `curl -s -b "<session cookie>" http://localhost:3001/api/settings/rbac/permissions | jq -r '.data[] | "\(.key) alias=\(.aliasOfKey) danger=\(.isDangerous) grants=\(.ruleCount)"'`
Expected: 10 rows; `execute`/`approve`/`export`/`validate`/`use` carry aliases; `delete` and `execute` are dangerous; `grants` is non-zero only for `create`/`read`/`update`/`delete`.

The tab's own rendering is verified in Task 10's end-to-end pass, step 2.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/settings/access-control
git commit -m "feat(rbac): permissions tab for authoring verbs"
```

---

### Task 8: Modules tab

**Files:**
- Create: `apps/web-ui/components/settings/access-control/modules-tab.tsx`
- Create: `apps/web-ui/components/settings/access-control/module-dialog.tsx`

**Interfaces:**
- Consumes: `useAdminRegistry`, `useCreateModule`, `useUpdateModule`, `useDeleteModule`, `type AdminModuleRow`, `type AdminSubjectRow` from `@/lib/queries/rbac-registry`.
- Produces: `<ModulesTab />`, `<ModuleDialog open onOpenChange module registry />`.

- [ ] **Step 1: Build the dialog**

Create `apps/web-ui/components/settings/access-control/module-dialog.tsx`. Same stack as Task 7. Zod schema:

```tsx
const schema = z.object({
  key: z.string().min(1, "A key is required.").regex(/^[A-Za-z][A-Za-z0-9]*$/, "Letters and digits only, e.g. 'CostControl'."),
  label: z.string().min(1, "A label is required."),
  description: z.string().optional(),
  icon: z.string().optional(),
  navPath: z.string().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999),
  enabled: z.boolean(),
  actionKeys: z.array(z.string()).min(1, "Select at least one permission."),
  subjectKeys: z.array(z.string()),
});
```

Sections, in order:

1. **Identity** — key (disabled when `module.isGlobal`), label, description, lucide icon name, nav path, order, enabled switch (disabled when `isGlobal`).
2. **Permissions that apply** — a checkbox per verb from `registry.actions`, filtering out verbs with an `aliasOfKey` (an alias resolves to its target at compile time, so a column for it would be a duplicate of that target's column). These write `RbacModuleAction`.
3. **Areas this module covers** — a checkbox per `registry.subjects`, each labelled `{label}` with a muted `currently in {moduleKey}` suffix when it belongs to another module, and `capability` subjects grouped under a "Agent capabilities" subheading. These write `RbacSubjectModule`.

Two inline warnings, computed from the form state:

```tsx
  // A module with no areas compiles to zero CASL rules: its checkboxes would
  // tick, save, and grant nothing. Warn rather than block — a module may be
  // created ahead of the areas that will move into it.
  const inert = watchedSubjectKeys.length === 0;

  // Moving an area out of its current module revokes it from every role holding
  // only that module's grant. The API materializes explicit subject-level rules
  // so nobody loses access, and reports how many it wrote.
  const moving = watchedSubjectKeys
    .map((key) => registry.subjects.find((s) => s.key === key))
    .filter((s) => s && s.moduleKey && s.moduleKey !== module?.key);
```

Render `inert` as an amber `Alert`: *"No areas selected. Roles can be granted this module, but nothing is enforced until an area is moved into it."* Render `moving` as an amber `Alert` listing the areas and their current modules, ending: *"Existing grants are preserved automatically — an explicit rule is written for each role that would otherwise lose access."*

On submit, call the mutation and report what happened:

```tsx
    try {
      const result = module
        ? await updateModule.mutateAsync({ id: module.id, ...payload })
        : await createModule.mutateAsync(payload);
      const notes = [
        result.materializedRules > 0 && `${result.materializedRules} grant(s) preserved`,
        result.revokedRules > 0 && `${result.revokedRules} grant(s) revoked`,
      ].filter(Boolean);
      toast.success(`Saved '${values.label}'.${notes.length ? ` ${notes.join(", ")}.` : ""}`);
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save the module.";
      // The API refuses a cell removal that would orphan live grants. Re-offer
      // the same save with force, so the operator confirms the revocation
      // instead of being told to guess what to change.
      if (/no checkbox to revoke/.test(message)) {
        setPendingForce(payload);
        return;
      }
      toast.error(message);
    }
```

`pendingForce` drives an `AlertDialog` whose body is the server's message and whose confirm button re-submits with `force: true`.

- [ ] **Step 2: Build the tab**

Create `apps/web-ui/components/settings/access-control/modules-tab.tsx`: a `Card` + `Table` with columns Module (label + `<code>{key}</code>` + the lucide icon), Permissions (`{actionKeys.length} of {registry.actions.length}`), Areas (`{subjectKeys.length}`, rendered as an amber `⚠ none` when zero), Nav path, Status (`Enabled` / `Disabled` badge), In use (`{ruleCount} grants`), Source badge, and a row action menu. Gate every control with `GatedButton action="update" subject="Settings"`. Delete is hidden for `isGlobal` rows and disabled when `subjectKeys.length > 0 || ruleCount > 0`, with the reason in the tooltip. Rows sort by `sortOrder` then `key`, matching the registry's own ordering.

- [ ] **Step 3: Verify against the running app**

With `bun run dev`, as an Owner: create a module `CostControl` (icon `dollar-sign`, no nav path, permissions Read + Update) and move `RightSizing` and `SpotGuard` into it. Confirm the moving warning lists both with their current modules, the toast reports the preserved-grant count, and the ledger row exists:

Run: `psql "$DATABASE_URL" -c "select entity_type, operation, reason from rbac_rule_change_log order by \"createdAt\" desc limit 3;"`
Expected: a `module` / `update` row. Then confirm no role lost access:

Run: `psql "$DATABASE_URL" -c "select count(*) from rbac_role_rules where \"subjectId\" is not null;"`
Expected: greater than zero — these are the materialized rules; it was zero before this task.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/settings/access-control
git commit -m "feat(rbac): modules tab, with the two silent revocations surfaced

Moving an area between modules and un-ticking a granted cell are both
access-removing operations that look like edits. Each now shows what it will
do before it does it."
```

---

### Task 9: Dynamic role grid

**Files:**
- Modify: `apps/web-ui/components/settings/role-dialog.tsx` (replace lines 25-38 and the state helpers)
- Modify: `apps/web-ui/components/settings/roles-list.tsx:24` (`permissionSummary` iterates the legacy `Module` list)
- Test: `apps/web-ui/components/settings/__tests__/role-dialog.test.tsx` (new)

**Interfaces:**
- Consumes: `useAbilityMeta` and `useGrantableCells` from `@/hooks/use-can`; `type PermissionSet` from `@/lib/rbac/types`.
- Produces: an unchanged `RoleDialogProps` contract — `onSave(name: string, permissions: PermissionSet)`. The page, the API route and `syncRoleRules` are untouched.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/components/settings/__tests__/role-dialog.test.tsx`, following the mocking style of `components/rbac/__tests__/gated.test.tsx`:

```tsx
/**
 * The grid must be the registry's shape, not a copy of it. These tests pin the
 * three ways the old hardcoded arrays could drift from the database: a module
 * that exists only in the registry, a verb column that only some modules
 * grant, and a cell the registry says is not grantable.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const meta = {
  modules: [
    { key: 'Accounts', label: 'Accounts', icon: null, navPath: null, sortOrder: 10 },
    { key: 'CostControl', label: 'Cost Control', icon: null, navPath: null, sortOrder: 70 },
  ],
  actions: [
    { key: 'read', label: 'Read', aliasOfKey: null, isDangerous: false },
    { key: 'delete', label: 'Delete', aliasOfKey: null, isDangerous: true },
    { key: 'execute', label: 'Execute', aliasOfKey: 'update', isDangerous: true },
  ],
  moduleActions: [
    { moduleKey: 'Accounts', actionKey: 'read' },
    { moduleKey: 'Accounts', actionKey: 'delete' },
    { moduleKey: 'CostControl', actionKey: 'read' },
  ],
  subjects: [],
  actionAliases: { execute: 'update' },
  version: '1.0',
  isLoaded: true,
};

vi.mock('@/hooks/use-can', () => ({
  useAbilityMeta: () => meta,
  useGrantableCells: () => meta.moduleActions,
}));

import { RoleDialog } from '../role-dialog';

const noop = async () => {};

describe('RoleDialog', () => {
  it('renders a row for every registry module, including new ones', () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    expect(screen.getByText('Cost Control')).toBeInTheDocument();
  });

  it('renders a column for every verb that some module grants', () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('omits alias verbs, which resolve to their target at compile time', () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    expect(screen.queryByText('Execute')).not.toBeInTheDocument();
  });

  it('disables a cell the registry does not make grantable', () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    expect(screen.getByRole('checkbox', { name: 'Delete Cost Control' })).toBeDisabled();
  });

  it('keeps a grant whose module has left the registry, so saving does not silently revoke it', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <RoleDialog
        open
        onOpenChange={noop}
        role={{ id: 'r1', name: 'Ops', permissions: { Accounts: ['read'], Retired: ['read'] } }}
        onSave={onSave}
      />
    );
    screen.getByRole('button', { name: 'Save Role' }).click();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toMatchObject({ Accounts: ['read'], Retired: ['read'] });
  });
}, 30000);
```

The 30s suite timeout is deliberate — jsdom setup takes ~33s in this environment and the 5s default would flake.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/settings/__tests__/role-dialog.test.tsx`
Expected: FAIL — `Cost Control` is not rendered; the component reads its own `MODULES` constant.

- [ ] **Step 3: Rewrite the dialog's data source**

In `apps/web-ui/components/settings/role-dialog.tsx`, delete the `MODULES` and `ACTIONS` constants (lines 25-38) and derive everything from the registry:

```tsx
import { useAbilityMeta, useGrantableCells } from "@/hooks/use-can";

type PermissionsState = Record<string, Set<string>>;

/**
 * Verbs that get a column: those some module makes grantable, minus aliases.
 *
 * An alias resolves to its target at compile time (rule-compiler.ts's
 * resolveAlias), so a column for `execute` would write a rule indistinguishable
 * from the `update` column's — two checkboxes for one grant.
 */
function useGridShape() {
  const { modules, actions } = useAbilityMeta();
  const cells = useGrantableCells();

  const grantable = new Set(cells.map((c) => `${c.moduleKey}::${c.actionKey}`));
  const grantedVerbs = new Set(cells.map((c) => c.actionKey));

  return {
    rows: [...modules].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)),
    columns: actions.filter((a) => !a.aliasOfKey && grantedVerbs.has(a.key)),
    isGrantable: (moduleKey: string, actionKey: string) => grantable.has(`${moduleKey}::${actionKey}`),
  };
}
```

Replace `toPermissionsState` / `toPermissionSet` so they round-trip unknown keys:

```tsx
/**
 * Grants whose module has left the registry are carried through untouched.
 *
 * Filtering them out would make opening and saving a role a silent revocation
 * of a permission the editor never showed — the failure mode this whole screen
 * exists to avoid. They are invisible here and preserved on save; the Modules
 * tab is where such a module gets re-enabled or its areas moved.
 */
function toPermissionsState(permissions: PermissionSet | null | undefined, rowKeys: string[]): {
  state: PermissionsState;
  carried: PermissionSet;
} {
  const known = new Set(rowKeys);
  const state: PermissionsState = {};
  const carried: PermissionSet = {};
  for (const key of rowKeys) state[key] = new Set<string>();
  for (const [moduleKey, verbs] of Object.entries(permissions ?? {})) {
    if (known.has(moduleKey)) state[moduleKey] = new Set(verbs ?? []);
    else carried[moduleKey] = [...(verbs ?? [])];
  }
  return { state, carried };
}

function toPermissionSet(state: PermissionsState, carried: PermissionSet): PermissionSet {
  const result: PermissionSet = { ...carried };
  for (const [moduleKey, verbs] of Object.entries(state)) result[moduleKey] = [...verbs];
  return result;
}
```

Keep the two existing tick rules, now keyed off the registry instead of the literal `"read"`:

```tsx
  // Rule 1: any non-read grant implies read — you cannot act on what you
  // cannot see. Rule 2: clearing read clears the module. Both preserved from
  // the original dialog; 'read' is the registry key, not a hardcoded verb.
```

Render the table body from `rows` × `columns`, with each `Checkbox` given `disabled={!isGrantable(row.key, col.key)}` and `aria-label={`${col.label} ${row.label}`}` (the test depends on that label). For a `col.isDangerous` verb, require a typed confirmation before the first tick in that column: an `AlertDialog` asking the operator to type the role name, matching the pattern in `components/settings/delete-role-dialog.tsx`.

Add a skeleton branch: when `useAbilityMeta().isLoaded` is false, render `<Spinner />` in place of the table rather than an empty grid that looks like "no permissions exist".

- [ ] **Step 4: Fix the roles list summary**

`apps/web-ui/components/settings/roles-list.tsx:24`'s `permissionSummary` iterates the imported legacy module list, so a custom module's grants would not be counted. Change it to iterate `Object.entries(permissions)` and drop the `Module` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run components/settings/__tests__/role-dialog.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/components/settings/role-dialog.tsx apps/web-ui/components/settings/roles-list.tsx \
        apps/web-ui/components/settings/__tests__/role-dialog.test.tsx
git commit -m "feat(rbac): render the role grid from the registry

Rows, columns and which cells exist all come from the ability payload. Grants
on a module that has left the registry are carried through a save untouched —
dropping them would make opening a role revoke a permission it never showed."
```

---

### Task 10: Access Control page and level ceiling

Ties the three tabs together and closes the `getAutoLevel` loop opened in Task 1 — the ceiling argument is still unused, so a role's level is still counted against the static Owner set.

**Files:**
- Create: `apps/web-ui/app/app/settings/access-control/page.tsx`
- Modify: `apps/web-ui/app/app/settings/roles/page.tsx` (redirect)
- Modify: `apps/web-ui/lib/rbac/custom-role-service.ts:83,190` (pass the ceiling)
- Modify: `apps/web-ui/lib/rbac/custom-role-service.test.ts`

**Interfaces:**
- Consumes: `<PermissionsTab />`, `<ModulesTab />`, `RolesList` + `RoleDialog` + `DeleteRoleDialog`, `loadAdminRegistry`.
- Produces: the route `/app/settings/access-control`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web-ui/lib/rbac/custom-role-service.test.ts`:

```typescript
it('levels a role against the registry cell count, not the static Owner set', async () => {
    // 21 ticks clears the static ceiling. With 40 grantable cells in the
    // registry it must not reach level 4 — the level that may assign roles.
    h.prisma.rbacModuleAction.findMany.mockResolvedValue(
        Array.from({ length: 40 }, (_, i) => ({ moduleId: `m${i}`, actionId: `a${i}`, grantable: true }))
    );
    await createCustomRole('t1', { name: 'Wide', permissions: FULL_PERMISSIONS }, actor);
    expect(h.tx.customRole.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ level: 3 }) })
    );
});
```

`FULL_PERMISSIONS` at line 38 already has 21 actions. Extend the hoisted mock with the `rbacModuleAction`, `rbacModule`, `rbacAction`, `rbacSubject`, `rbacSubjectModule` and `rbacRoleRule.groupBy` stubs `loadAdminRegistry` needs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/custom-role-service.test.ts`
Expected: FAIL — level is 4.

- [ ] **Step 3: Pass the ceiling**

In `apps/web-ui/lib/rbac/custom-role-service.ts`, in both `createCustomRole` (line ~83) and `updateCustomRole` (line ~190), replace `const level = getAutoLevel(input.permissions);` with:

```typescript
    // The ceiling is the number of grantable cells in the REGISTRY, not in the
    // static Owner set. Without it, adding modules inflates every role's level,
    // and level 3 is what grants the right to assign roles.
    const { grantableCellCount } = await loadAdminRegistry(tenantId);
    const level = getAutoLevel(input.permissions, grantableCellCount);
```

Import `loadAdminRegistry` from `./registry-admin`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/custom-role-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the page**

Create `apps/web-ui/app/app/settings/access-control/page.tsx`: a client component with `PageHeader icon={ShieldCheck} title="Access Control"`, description *"Define permissions, group them into modules, and bind them to roles."*, and a `Tabs` with three `TabsTrigger`s — `permissions`, `modules`, `roles` — defaulting to `roles`, matching the `Tabs` usage in `app/app/settings/page.tsx:22-47`. The Roles tab hosts the existing `RolesList` / `RoleDialog` / `DeleteRoleDialog` wiring: move the body of `app/app/settings/roles/page.tsx` into a `components/settings/access-control/roles-tab.tsx` unchanged, including the 10-custom-role limit tooltip.

Replace `apps/web-ui/app/app/settings/roles/page.tsx` with a redirect so existing links and bookmarks keep working:

```tsx
import { redirect } from "next/navigation";

// Roles moved into Settings → Access Control, alongside the permissions and
// modules that define the grid. The old path is kept so existing links work.
export default function RolesPage() {
  redirect("/app/settings/access-control?tab=roles");
}
```

- [ ] **Step 6: Full verification**

Run: `cd apps/web-ui && bun run rbac:sync && bun run rbac:check && bun run lint && bun run test`
Expected: `rbac:check` exits 0; lint clean; the suite shows only the 4 known pre-existing failures.

Then the end-to-end pass with `bun run dev`, signed in as an Owner:

1. `/app/settings/access-control` → three tabs render; Roles shows 4 presets and any custom roles.
2. Permissions tab → create `restart`, behaves as `Update`, dangerous. It appears with 0 grants.
3. Modules tab → edit `Schedules`, tick `Restart` and `Execute` as applying permissions. Save.
4. Roles tab → the grid now has Restart and Execute columns; `Dashboard` still shows only Read enabled; every other cell is unchanged.
5. Create a role `RestartOnly` with `Schedules: read, restart`. Save.
6. Assign it to a second test user (Settings → Members), sign in as them.
7. Confirm the UI gate: the Spot Guard and schedule controls that call `authorize('update', …)` are enabled (restart aliases to update), and Accounts controls are disabled with a reason in the tooltip.
8. Confirm the API gate: `curl -X DELETE /api/accounts/<id>` returns 403 with a body naming the action and subject.
9. Confirm the ledger: `psql "$DATABASE_URL" -c "select entity_type, operation, actor_email from rbac_rule_change_log order by \"createdAt\" desc limit 10;"` shows an append-only row per step above.
10. Confirm cache invalidation: with the second user's session open, revoke `Schedules:read` from `RestartOnly` as the Owner, then reload the second user's page within ~10s and confirm the nav entry disappears (the version bump plus the 5s probe TTL).

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/app/app/settings/access-control apps/web-ui/app/app/settings/roles/page.tsx \
        apps/web-ui/components/settings/access-control apps/web-ui/lib/rbac/custom-role-service.ts \
        apps/web-ui/lib/rbac/custom-role-service.test.ts apps/web-ui/lib/rbac/generated
git commit -m "feat(rbac): Access Control page joining permissions, modules and roles

Role levelling now counts against the registry's grantable cells, so adding
a module no longer inflates every role toward level 4."
```

---

## Out of scope, deliberately

These are reachable from the same screens and are **not** in this plan. Each would be its own spec.

1. **Registering new subjects from the UI.** A subject is only enforceable if application code calls `authorize(verb, 'ThatKey')`, so creating one from a screen produces a row that grants nothing. The Modules tab reassigns the 24 seeded subjects; adding a new one stays a code change plus `bun run rbac:sync`.
2. **The ABAC condition builder.** `RbacRoleRule.conditions` and `RbacSubjectAttribute` are fully supported by the compiler and validator, and `parity-live.test.ts` pins the conditional-rule count at **zero** as a tripwire. The first conditional rule authored anywhere fails that test on purpose, forcing the parity harness to be extended first. Authoring conditions before that happens would take the tripwire out with it.
3. **Route override editing** (`RbacRoutePermission`) — the per-tenant endpoint kill-switch. Read by `loadRoutePermissions()` already; no screen.
4. **Deploying the flags.** `DYNAMIC_ABAC_ENABLED` / `RBAC_ROUTE_GUARD_MODE` are set in configuration but not wired into `infra/compute/index.ts`, and the designed shadow soak was never run. See §6 of `docs/superpowers/specs/2026-08-03-dynamic-rbac-abac-implementation.md`. Everything in this plan works under either flag setting, because `syncRoleRules` keeps the legacy JSON and the rules in agreement.
5. **Removing the legacy matrix** (`ROLE_PERMISSIONS`, `SUBJECT_TO_MODULE`, `ACTION_MAP`, `parity.test.ts`). The one irreversible step, gated on that soak. Task 1 keeps `LegacyModule` / `LegacyAction` precisely so the matrix stays exhaustively typed until then.
