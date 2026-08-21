# Submodule-level RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin grant or deny permissions per submodule (registry subject) from the role matrix, hide nav entries and block pages the role cannot read.

**Architecture:** The CASL rule compiler already enforces subject-level rules with precise-beats-broad precedence and `cannot` overrides — this plan builds only the authoring layer (a two-level matrix writing `rbac_role_rules` directly) and the resolution layer (a shared longest-navPath-prefix resolver used by both the sidebar and a new middleware page guard). No compiler changes.

**Tech Stack:** Next.js 15.5.15 App Router, React 19, Prisma 5/6, PostgreSQL, CASL v7, TanStack Query v5, Vitest 4, Playwright, Pulumi.

**Spec:** `docs/superpowers/specs/2026-08-12-submodule-rbac-design.md`

## Global Constraints

- **CASL v7, not v6.** `createMongoAbility()`, never `new Ability()`. `packRules`/`unpackRules` live in the `@casl/ability/extra` subpath.
- **`libs/rbac/` is framework-free by contract.** No `next/`, no `react/`, no `@prisma/client` imports anywhere under it.
- **Any migration touching `rbac_modules`, `rbac_actions`, `rbac_subjects`, `rbac_subject_modules`, `rbac_module_actions` or `rbac_role_rules` MUST bump `rbac_global_version`.** Nothing else invalidates the ability cache.
- **Prisma nullable-Json gotcha:** query `conditions` with `{ equals: Prisma.DbNull }`, never `{ equals: null }` — a bare `null` means "the JSON value null" and matches zero rows.
- **Prisma nullable-String gotcha:** use `OR: [{ tenantId }, { tenantId: null }]`, never `tenantId: { in: [tenantId, null] }` — Prisma rejects null inside `in` at runtime.
- **Tenant-local rows shadow global rows of the same key.** Resolve in JS, never with `orderBy: { tenantId: 'desc' }` — Postgres sorts DESC with NULLS FIRST and picks exactly backwards.
- Indentation: 4 spaces in `lib/` and `libs/`, 2 spaces in `components/`.
- Test commands: `cd apps/web-ui && bun run test`, `cd libs/rbac && bun run test`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Subject navPath + sortOrder columns, backfill, version bump

**Files:**
- Create: `libs/prisma/migrations/20260812100000_subject_nav_paths/migration.sql`
- Modify: `libs/prisma/schema.prisma:1698-1716` (model `RbacSubject`)
- Modify: `libs/rbac/registry-types.ts:37-44` (interface `RbacSubjectRow`)
- Modify: `apps/web-ui/lib/rbac/registry.ts:104` (subject `orderBy`)

**Interfaces:**
- Consumes: nothing.
- Produces: `RbacSubjectRow` gains `navPath: string | null` and `sortOrder: number`. Subject keys `Provider`, `AgentOps`, `ScheduledTask`, `McpServer`, `ScalingAudit` exist and link to their modules.

- [ ] **Step 1: Add the columns to the Prisma model**

In `libs/prisma/schema.prisma`, model `RbacSubject`, add after `kind`:

```prisma
  navPath   String? // '/app/agent-ops/providers' — lets page/nav gating be data-driven
  sortOrder Int      @default(100)
```

- [ ] **Step 2: Extend the framework-free row type**

In `libs/rbac/registry-types.ts`, `RbacSubjectRow`:

```typescript
export interface RbacSubjectRow {
    id: string;
    tenantId: string | null;
    key: string;
    label: string;
    kind: RbacSubjectKind;
    /** Destination this subject owns, or null when it has no page. */
    navPath: string | null;
    sortOrder: number;
    isSystem: boolean;
}
```

- [ ] **Step 3: Write the migration**

Create `libs/prisma/migrations/20260812100000_subject_nav_paths/migration.sql`:

```sql
-- Gives subjects the two columns modules already have, so a DESTINATION can be
-- gated by the subject that owns it instead of by its whole module.
--
-- Before this, lib/nav-config.ts annotated all nine Agentic Ops entries with
-- module "AIOps", so Providers could not be hidden without also hiding AI Ops,
-- Agent Ops, Memory, Skills, Knowledge Base and MCP Servers.
--
-- No `enabled` column: a subject is retired by unlinking it from its module,
-- which rule-compiler.ts:337-346 already treats as contributing nothing.

ALTER TABLE "rbac_subjects" ADD COLUMN IF NOT EXISTS "navPath" TEXT;
ALTER TABLE "rbac_subjects" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 100;

-- ── navPath for subjects that already own a page ────────────────────────────
-- WHERE "navPath" IS NULL so a tenant that has already authored one is never
-- clobbered by a redeploy.
UPDATE "rbac_subjects" SET "navPath" = '/app/dashboard',                    "sortOrder" = 10 WHERE "key" = 'Dashboard'     AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/accounts',                     "sortOrder" = 10 WHERE "key" = 'Account'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/audit',                        "sortOrder" = 20 WHERE "key" = 'AuditLog'      AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/inventory',                    "sortOrder" = 10 WHERE "key" = 'Resource'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/right-sizing',                 "sortOrder" = 30 WHERE "key" = 'RightSizing'    AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/schedules',                    "sortOrder" = 10 WHERE "key" = 'Schedule'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/cost-optimization/spot-guard', "sortOrder" = 20 WHERE "key" = 'SpotGuard'      AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/agent',                        "sortOrder" = 10 WHERE "key" = 'Agent'          AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/memory',                       "sortOrder" = 40 WHERE "key" = 'Memory'         AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/knowledge-base',               "sortOrder" = 50 WHERE "key" = 'KnowledgeBase'  AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/skills',                       "sortOrder" = 60 WHERE "key" = 'Skill'          AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/channels',                     "sortOrder" = 80 WHERE "key" = 'Channel'        AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/certificates',                 "sortOrder" = 20 WHERE "key" = 'Certificate'    AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/settings',                     "sortOrder" = 10 WHERE "key" = 'Settings'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/settings/organization',        "sortOrder" = 30 WHERE "key" = 'Tenant'         AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/iam',                          "sortOrder" = 10 WHERE "key" = 'IAM'            AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/iam/members',                  "sortOrder" = 20 WHERE "key" = 'User'           AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/iam/roles',                    "sortOrder" = 30 WHERE "key" = 'Role'           AND "navPath" IS NULL;

-- Discovery, Billing and the five Agent* capability subjects own no page and
-- keep navPath NULL: grantable in the matrix, never a nav owner.

-- ── new subjects for destinations that had none ─────────────────────────────
-- ScalingAudit is a BUG FIX, not a feature. lib/rbac/types.ts:82 maps it to
-- Inventory and the Scale Sentinel routes call authorize(..., 'ScalingAudit'),
-- but no rbac_subjects row ever existed. The compiler emits one rule per
-- SUBJECT, so `read Inventory` never produced `read ScalingAudit`. Masked today
-- because prod runs the legacy matrix; flipping DYNAMIC_ABAC_ENABLED without
-- this would 403 Scale Sentinel for every non-SuperAdmin.
INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "navPath", "sortOrder", "isSystem") VALUES
    ('sys-subj-provider',      NULL, 'Provider',      'LLM Provider',   'resource', '/app/agent-ops/providers',              70, true),
    ('sys-subj-agentops',      NULL, 'AgentOps',      'Agent Ops',      'resource', '/app/agent-ops',                        20, true),
    ('sys-subj-scheduledtask', NULL, 'ScheduledTask', 'Scheduled Task', 'resource', '/app/agent-ops/scheduled-tasks',        30, true),
    ('sys-subj-mcpserver',     NULL, 'McpServer',     'MCP Server',     'resource', '/app/agent-ops/mcp-settings',           90, true),
    ('sys-subj-scalingaudit',  NULL, 'ScalingAudit',  'Scale Sentinel', 'resource', '/app/cloud-operations/scale-sentinel',  40, true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-provider',      NULL, 'sys-subj-provider',      'sys-mod-aiops'),
    ('sys-sm-agentops',      NULL, 'sys-subj-agentops',      'sys-mod-aiops'),
    ('sys-sm-scheduledtask', NULL, 'sys-subj-scheduledtask', 'sys-mod-aiops'),
    ('sys-sm-mcpserver',     NULL, 'sys-subj-mcpserver',     'sys-mod-aiops'),
    ('sys-sm-scalingaudit',  NULL, 'sys-subj-scalingaudit',  'sys-mod-inventory')
ON CONFLICT ("id") DO NOTHING;

-- ── mandatory cache invalidation ────────────────────────────────────────────
-- ability-cache.ts keys on `${rbac_global_version.version}.${tenants.rbacVersion}`.
-- Entries are immutable: bumping does not clear the cache, it makes old keys
-- unreachable. Without this, every running process keeps serving abilities
-- compiled before these subjects existed.
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
```

- [ ] **Step 4: Order subjects by sortOrder in the snapshot loader**

In `apps/web-ui/lib/rbac/registry.ts`, change the subject query:

```typescript
            prisma.rbacSubject.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
```

- [ ] **Step 5: Apply the migration and regenerate clients**

```bash
cd apps/web-ui && bun run db:migrate && bun run db:generate
cd ../workers && bun run db:generate
```

Expected: migration applies cleanly; `bunx prisma migrate status` reports no drift.

- [ ] **Step 6: Verify the rows landed**

```bash
docker compose exec -T postgres psql -U postgres -d nucleus -c \
  "SELECT key, \"navPath\", \"sortOrder\" FROM rbac_subjects WHERE \"navPath\" IS NOT NULL ORDER BY \"navPath\";"
```

Expected: 23 rows. `ScalingAudit` present with `/app/cloud-operations/scale-sentinel`.

- [ ] **Step 7: Run the existing suites to confirm nothing regressed**

```bash
cd apps/web-ui && bun run test
cd ../../libs/rbac && bun run test
```

Expected: PASS. `registry.test.ts` and `rule-compiler.test.ts` are unaffected by additive columns.

- [ ] **Step 8: Re-run parity against the backfilled registry**

The backfill changes CASL verdicts, so the shadow-mode comparison must be re-established against the new registry — the pre-backfill result no longer describes the system.

```bash
cd apps/web-ui && bunx vitest run lib/rbac/parity.test.ts lib/rbac/parity-live.test.ts
```

Expected: PASS. `ScalingAudit` specifically moves from a mismatch (legacy allows via `SUBJECT_TO_MODULE`, CASL denies for want of a subject row) to agreement. If `parity-live.test.ts` skips for want of a database, run `docker compose up -d postgres` first — a skipped parity test is not a passing one, and this is the gate Task 15 depends on.

- [ ] **Step 9: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/20260812100000_subject_nav_paths libs/rbac/registry-types.ts apps/web-ui/lib/rbac/registry.ts
git commit -m "feat(rbac): give subjects navPath and sortOrder, backfill destinations

Adds the missing ScalingAudit subject, which SUBJECT_TO_MODULE has always
claimed but rbac_subjects never had — a silent 403 waiting for the
DYNAMIC_ABAC_ENABLED flip.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Subject-coverage assertion script

**Files:**
- Create: `apps/web-ui/scripts/assert-subject-coverage.ts`
- Modify: `apps/web-ui/package.json` (add `rbac:check-subjects` script)

**Interfaces:**
- Consumes: `SUBJECT_TO_MODULE` from `@/lib/rbac/types`; `rbac_subjects`, `rbac_subject_modules`, `rbac_modules` tables.
- Produces: a script exiting non-zero on any coverage gap. Nothing imports it.

- [ ] **Step 1: Write the script**

Create `apps/web-ui/scripts/assert-subject-coverage.ts`:

```typescript
/**
 * Fails the build when the registry and SUBJECT_TO_MODULE disagree.
 *
 * ScalingAudit was mapped in code to Inventory for months with no rbac_subjects
 * row. Under the legacy matrix that resolved fine; under CASL the compiler emits
 * one rule per SUBJECT, so the grant simply did not exist and every Scale
 * Sentinel route would have 403'd the moment DYNAMIC_ABAC_ENABLED flipped.
 *
 * That class of bug is invisible until the flag flips, which is exactly when it
 * is most expensive. This is the check that makes it visible at build time.
 */
import { getPrismaClient } from '../lib/db/pg-config';
import { SUBJECT_TO_MODULE } from '../lib/rbac/types';

async function main(): Promise<void> {
    const prisma = getPrismaClient();
    const problems: string[] = [];

    const [subjects, links, modules] = await Promise.all([
        prisma.rbacSubject.findMany({ where: { tenantId: null } }),
        prisma.rbacSubjectModule.findMany({ where: { tenantId: null } }),
        prisma.rbacModule.findMany({ where: { tenantId: null } }),
    ]);

    const subjectByKey = new Map(subjects.map((s) => [s.key, s]));
    const moduleById = new Map(modules.map((m) => [m.id, m]));
    const moduleIdBySubjectId = new Map(links.map((l) => [l.subjectId, l.moduleId]));

    // 1. Every SUBJECT_TO_MODULE key exists and links to the module it claims.
    for (const [subjectKey, moduleKey] of Object.entries(SUBJECT_TO_MODULE)) {
        if (subjectKey === 'all') continue; // wildcard fallback, not a real subject
        const subject = subjectByKey.get(subjectKey);
        if (!subject) {
            problems.push(`SUBJECT_TO_MODULE['${subjectKey}'] has no rbac_subjects row`);
            continue;
        }
        const linkedModule = moduleById.get(moduleIdBySubjectId.get(subject.id) ?? '');
        if (!linkedModule) {
            problems.push(`subject '${subjectKey}' links to no module`);
        } else if (linkedModule.key !== moduleKey) {
            problems.push(
                `subject '${subjectKey}' links to module '${linkedModule.key}' but SUBJECT_TO_MODULE says '${moduleKey}'`
            );
        }
    }

    // 2. Every subject links to exactly one ENABLED module.
    for (const subject of subjects) {
        const moduleId = moduleIdBySubjectId.get(subject.id);
        if (!moduleId) {
            problems.push(`subject '${subject.key}' links to no module`);
            continue;
        }
        const module = moduleById.get(moduleId);
        if (module && !module.enabled) {
            problems.push(`subject '${subject.key}' links to disabled module '${module.key}'`);
        }
    }

    // 3. No two subjects share a navPath — resolveNavOwner would be ambiguous.
    const byNavPath = new Map<string, string[]>();
    for (const subject of subjects) {
        if (!subject.navPath) continue;
        byNavPath.set(subject.navPath, [...(byNavPath.get(subject.navPath) ?? []), subject.key]);
    }
    for (const [navPath, keys] of byNavPath) {
        if (keys.length > 1) problems.push(`navPath '${navPath}' claimed by ${keys.join(', ')}`);
    }

    if (problems.length > 0) {
        console.error('[rbac] subject coverage FAILED:');
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exit(1);
    }
    console.log(`[rbac] subject coverage OK — ${subjects.length} subjects, ${byNavPath.size} navPaths`);
}

main()
    .catch((error) => {
        console.error('[rbac] subject coverage check errored:', error);
        process.exit(1);
    })
    .finally(() => process.exit(0));
```

- [ ] **Step 2: Add the npm script**

In `apps/web-ui/package.json`, under `"scripts"`:

```json
    "rbac:check-subjects": "tsx scripts/assert-subject-coverage.ts",
```

- [ ] **Step 3: Run it against the migrated database**

```bash
cd apps/web-ui && bun run rbac:check-subjects
```

Expected: `[rbac] subject coverage OK — 31 subjects, 23 navPaths`. If it reports a gap, that gap is a real bug — fix it in a follow-up migration before continuing.

- [ ] **Step 4: Prove it actually fails**

Temporarily add a bogus entry to `SUBJECT_TO_MODULE` in `lib/rbac/types.ts`:

```typescript
    NotARealSubject: 'Inventory',
```

Run: `cd apps/web-ui && bun run rbac:check-subjects`
Expected: exit 1, `SUBJECT_TO_MODULE['NotARealSubject'] has no rbac_subjects row`. **Remove the bogus entry.**

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/scripts/assert-subject-coverage.ts apps/web-ui/package.json
git commit -m "chore(rbac): assert SUBJECT_TO_MODULE has registry coverage

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fix the four pre-existing routing bugs

**Files:**
- Modify: `apps/web-ui/components/auth/AuthorizePage.tsx:32,53`
- Modify: `apps/web-ui/lib/nav-config.ts:70,79`
- Modify: `apps/web-ui/components/spot-guard/settings-form.tsx:172`
- Replace: `apps/web-ui/app/app/agent-ops/slack-settings/page.tsx`
- Replace: `apps/web-ui/app/app/agent-ops/jira-settings/page.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `/app/spot-guard` and `/app/agent-ops/{slack,jira}-settings` no longer appear in nav; denials land on `/app/unauthorized`.

- [ ] **Step 1: Fix the denial redirect target**

`AuthorizePage.tsx` redirects to `/unauthorized`, but the page is at `app/app/unauthorized/page.tsx` → `/app/unauthorized`. Every page-level denial currently 404s. Both occurrences:

```typescript
    redirect('/app/unauthorized');
```

- [ ] **Step 2: Fix the Spot Guard 404 and point Slack at the surviving page**

In `apps/web-ui/lib/nav-config.ts`, line 70:

```typescript
      { title: "Spot Guard", href: "/app/cost-optimization/spot-guard", module: "Schedules" },
```

and line 79:

```typescript
      { title: "Slack", href: "/app/channels/slack-settings", module: "AIOps" },
```

- [ ] **Step 3: Fix the stale in-page link**

In `apps/web-ui/components/spot-guard/settings-form.tsx`, line 172:

```tsx
                                href="/app/channels/slack-settings"
```

- [ ] **Step 4: Replace the duplicate pages with redirects**

`app/app/agent-ops/slack-settings/page.tsx` rendered the identical `SlackSettingsForm` as `/app/channels/slack-settings`. Replace its whole contents (precedent: `app/app/settings/members/page.tsx`):

```tsx
import { redirect } from "next/navigation";

// Slack settings live under Channels, beside Telegram/Discord/Jira/Webhook.
// The duplicate under agent-ops meant one feature had two URLs and only one
// could be gated by the Channel subject. Old URL kept working via redirect.
export default function AgentOpsSlackSettingsRedirect() {
  redirect("/app/channels/slack-settings");
}
```

And `app/app/agent-ops/jira-settings/page.tsx`:

```tsx
import { redirect } from "next/navigation";

// Same duplication as slack-settings. Canonical page is under Channels.
export default function AgentOpsJiraSettingsRedirect() {
  redirect("/app/channels/jira-settings");
}
```

- [ ] **Step 5: Verify the routes resolve**

```bash
cd apps/web-ui && bun run dev
```

Visit `/app/agent-ops/slack-settings` → lands on `/app/channels/slack-settings`. Visit `/app/cost-optimization/spot-guard` from the sidebar's Spot Guard link → renders, no 404.

- [ ] **Step 6: Typecheck and lint**

```bash
cd apps/web-ui && bun run lint
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/components/auth/AuthorizePage.tsx apps/web-ui/lib/nav-config.ts apps/web-ui/components/spot-guard/settings-form.tsx apps/web-ui/app/app/agent-ops/slack-settings/page.tsx apps/web-ui/app/app/agent-ops/jira-settings/page.tsx
git commit -m "fix(nav): dead Spot Guard link, 404 denial redirect, duplicate channel pages

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The shared nav resolver

**Files:**
- Create: `libs/rbac/nav-resolver.ts`
- Create: `libs/rbac/nav-resolver.test.ts`
- Modify: `libs/rbac/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveNavOwner(pathname, subjects, modules): NavOwner | null`, plus types `NavOwner` and `NavPathRow`, exported from `@nucleus/rbac`.

- [ ] **Step 1: Write the failing test**

Create `libs/rbac/nav-resolver.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { resolveNavOwner } from './nav-resolver';

const SUBJECTS = [
    { key: 'Agent', navPath: '/app/agent' },
    { key: 'AgentOps', navPath: '/app/agent-ops' },
    { key: 'Provider', navPath: '/app/agent-ops/providers' },
    { key: 'Channel', navPath: '/app/channels' },
    { key: 'Discovery', navPath: null },
];

const MODULES = [
    { key: 'AIOps', navPath: '/app/agent' },
    { key: 'Settings', navPath: '/app/settings' },
];

describe('resolveNavOwner', () => {
    it('picks the longest matching navPath', () => {
        expect(resolveNavOwner('/app/agent-ops/providers', SUBJECTS, MODULES)).toEqual({
            kind: 'subject',
            key: 'Provider',
            navPath: '/app/agent-ops/providers',
        });
    });

    it('matches a child route through its parent prefix', () => {
        expect(resolveNavOwner('/app/channels/telegram-settings', SUBJECTS, MODULES)?.key).toBe('Channel');
    });

    // The trap: '/app/agent-ops' must NOT be treated as a child of '/app/agent'.
    // The `+ '/'` in the prefix test is the only thing preventing it, and getting
    // this wrong silently gates all of Agent Ops behind the Agent subject.
    it('does not treat a longer sibling segment as a child', () => {
        expect(resolveNavOwner('/app/agent-ops', SUBJECTS, MODULES)?.key).toBe('AgentOps');
    });

    // Subject and module both sit on '/app/agent'. Without the tie-break the
    // module wins and the Agent subject can never gate the AI Ops page.
    it('prefers a subject over a module at equal navPath length', () => {
        expect(resolveNavOwner('/app/agent', SUBJECTS, MODULES)).toEqual({
            kind: 'subject',
            key: 'Agent',
            navPath: '/app/agent',
        });
    });

    it('falls back to a module when no subject claims the path', () => {
        expect(resolveNavOwner('/app/settings/organization', SUBJECTS, MODULES)).toEqual({
            kind: 'module',
            key: 'Settings',
            navPath: '/app/settings',
        });
    });

    it('returns null when nothing claims the path', () => {
        expect(resolveNavOwner('/app/nowhere', SUBJECTS, MODULES)).toBeNull();
    });

    it('ignores rows with a null navPath', () => {
        expect(resolveNavOwner('/app/discovery', SUBJECTS, MODULES)).toBeNull();
    });

    it('is deterministic when two rows of the same kind tie', () => {
        const dupes = [
            { key: 'Bbb', navPath: '/app/dupe' },
            { key: 'Aaa', navPath: '/app/dupe' },
        ];
        expect(resolveNavOwner('/app/dupe', dupes, [])?.key).toBe('Aaa');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd libs/rbac && bunx vitest run nav-resolver.test.ts`
Expected: FAIL — `Failed to resolve import "./nav-resolver"`.

- [ ] **Step 3: Write the implementation**

Create `libs/rbac/nav-resolver.ts`:

```typescript
/**
 * Resolves a destination to the registry row that gates it.
 *
 * ── WHY THIS LIVES IN libs/rbac AND NOT IN THE HOOK ─────────────────────────
 * Two callers must agree exactly: the sidebar (which decides whether to render
 * a link) and the middleware page guard (which decides whether to serve the
 * page). If they disagree, the user gets either a visible link that redirects
 * or an invisible page that works. Both are bugs that only show up in
 * production, so the logic is written once and imported twice rather than
 * implemented twice.
 */

/** A registry row that may own a destination. */
export interface NavPathRow {
    key: string;
    navPath: string | null;
}

export interface NavOwner {
    kind: 'subject' | 'module';
    key: string;
    navPath: string;
}

/**
 * `/app/agent-ops` must NOT match navPath `/app/agent`. Requiring the separator
 * is the whole defence — without it every sibling route whose name merely starts
 * with another's is silently swallowed by it.
 */
function claims(pathname: string, navPath: string): boolean {
    return pathname === navPath || pathname.startsWith(`${navPath}/`);
}

/**
 * The owner of `pathname`: longest matching navPath across subjects ∪ modules.
 *
 * A SUBJECT beats a MODULE at equal length, because a subject is the strictly
 * more specific claim. This tie-break is load-bearing: module AIOps and subject
 * Agent both sit on '/app/agent'.
 *
 * Returns null when nothing claims the path. Callers treat that as visible —
 * nav is UX and the API underneath is guarded independently, so failing closed
 * here would turn a missing metadata row into an apparent outage.
 */
export function resolveNavOwner(
    pathname: string,
    subjects: NavPathRow[],
    modules: NavPathRow[]
): NavOwner | null {
    const candidates: NavOwner[] = [];

    for (const subject of subjects) {
        if (subject.navPath && claims(pathname, subject.navPath)) {
            candidates.push({ kind: 'subject', key: subject.key, navPath: subject.navPath });
        }
    }
    for (const module of modules) {
        if (module.navPath && claims(pathname, module.navPath)) {
            candidates.push({ kind: 'module', key: module.key, navPath: module.navPath });
        }
    }

    if (candidates.length === 0) return null;

    // Longest navPath, then subject-over-module, then key order. The last clause
    // exists only so a misconfigured registry (two rows on one navPath) resolves
    // the SAME way on every process rather than following row order — Postgres
    // makes no ordering promise. assert-subject-coverage.ts rejects that state
    // outright; this keeps it deterministic until someone runs the check.
    candidates.sort((a, b) => {
        if (a.navPath.length !== b.navPath.length) return b.navPath.length - a.navPath.length;
        if (a.kind !== b.kind) return a.kind === 'subject' ? -1 : 1;
        return a.key.localeCompare(b.key);
    });

    return candidates[0];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd libs/rbac && bunx vitest run nav-resolver.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Export from the package surface**

In `libs/rbac/index.ts`, append:

```typescript
export { resolveNavOwner } from './nav-resolver';
export type { NavOwner, NavPathRow } from './nav-resolver';
```

- [ ] **Step 6: Pin the compiler behaviour the whole plan assumes**

Everything downstream rests on one claim: a module grant plus a subject deny already compiles to the right rules. That is asserted piecemeal in `rule-compiler.test.ts` (precise-beats-broad, `cannot`-last ordering) but never end to end in the exact shape the matrix will now emit. Append to `libs/rbac/rule-compiler.test.ts`:

```typescript
describe('module grant with a subject deny', () => {
    it('emits the module expansion plus a trailing inverted rule', () => {
        const registry: RegistrySnapshot = {
            tenantId: 't1',
            modules: [
                { id: 'm-aiops', tenantId: null, key: 'AIOps', label: 'AI Ops', description: null, icon: null, navPath: '/app/agent', sortOrder: 40, isSystem: true, enabled: true },
            ],
            actions: [
                { id: 'a-read', tenantId: null, key: 'read', label: 'Read', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 20, isSystem: true },
            ],
            subjects: [
                { id: 's-agent', tenantId: null, key: 'Agent', label: 'Agent', kind: 'resource', navPath: '/app/agent', sortOrder: 10, isSystem: true },
                { id: 's-provider', tenantId: null, key: 'Provider', label: 'Provider', kind: 'resource', navPath: '/app/agent-ops/providers', sortOrder: 70, isSystem: true },
            ],
            subjectModules: [
                { tenantId: null, subjectId: 's-agent', moduleId: 'm-aiops' },
                { tenantId: null, subjectId: 's-provider', moduleId: 'm-aiops' },
            ],
            moduleActions: [{ tenantId: null, moduleId: 'm-aiops', actionId: 'a-read', grantable: true }],
            subjectAttributes: [],
            principalAttributes: [],
        };

        const { rules, dropped } = compileRules(
            registry,
            [
                { id: 'r1', tenantId: 't1', roleId: 'role-1', actionId: 'a-read', moduleId: 'm-aiops', subjectId: null, conditions: null, fields: [], inverted: false, reason: null },
                { id: 'r2', tenantId: 't1', roleId: 'role-1', actionId: 'a-read', moduleId: null, subjectId: 's-provider', conditions: null, fields: [], inverted: true, reason: null },
            ],
            { userId: 'u1', email: 'u@example.com', tenantId: 't1', roleName: 'Custom', isSuperAdmin: false, attributes: {} }
        );

        expect(dropped).toEqual([]);
        // Two rules, not three. `preciseKeys` (rule-compiler.ts:403) does NOT
        // check `inverted`, so ANY subject-level rule SUPPRESSES the module's
        // expanded rule for that (action, subject) — the module's `read
        // Provider` is dropped outright rather than being outvoted later.
        //
        // So suppression is the mechanism, and the `cannot`-last ordering
        // (step 6) is a second line of defence, not the thing doing the work.
        // Both are load-bearing for DIFFERENT cases: ordering still matters
        // when a deny must beat a grant it did not suppress.
        expect(rules).toEqual([
            { action: 'read', subject: 'Agent' },
            { action: 'read', subject: 'Provider', inverted: true },
        ]);
    });
});
```

Add `import type { RegistrySnapshot } from './registry-types';` at the top of the file if it is not already imported.

- [ ] **Step 7: Run the whole libs/rbac suite**

Run: `cd libs/rbac && bun run test`
Expected: PASS, including the new compiler case. **If the compiler case fails, stop** — the premise this entire plan rests on is wrong and the design needs revisiting, not the test.

- [ ] **Step 8: Commit**

```bash
git add libs/rbac/nav-resolver.ts libs/rbac/nav-resolver.test.ts libs/rbac/rule-compiler.test.ts libs/rbac/index.ts
git commit -m "feat(rbac): shared longest-navPath destination resolver

Also pins the module-grant + subject-deny compilation this plan assumes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Ship navPath and sortOrder to the client

**Files:**
- Modify: `apps/web-ui/app/api/me/ability/route.ts:95-104`
- Modify: `apps/web-ui/providers/ability-provider.tsx:50-62`

**Interfaces:**
- Consumes: `RbacSubjectRow.navPath` / `.sortOrder` (Task 1).
- Produces: `AbilitySubjectDef` gains `navPath: string | null` and `sortOrder: number`; both available via `useAbilityMeta().subjects`.

- [ ] **Step 1: Extend the client-side subject type**

In `apps/web-ui/providers/ability-provider.tsx`, `AbilitySubjectDef`:

```typescript
export interface AbilitySubjectDef {
    key: string;
    label: string;
    kind: string;
    moduleKey: string | null;
    /** Destination this subject owns, or null. Drives nav gating and the page guard. */
    navPath: string | null;
    /** Row order under its module in the permission matrix. */
    sortOrder: number;
}
```

- [ ] **Step 2: Ship the two fields from the API**

In `apps/web-ui/app/api/me/ability/route.ts`, in the `subjects` projection:

```typescript
                    subjects: registry.subjects.map((s) => ({
                        key: s.key,
                        label: s.label,
                        kind: s.kind,
                        navPath: s.navPath,
                        sortOrder: s.sortOrder,
                        moduleKey:
                            moduleKeyById.get(
                                registry.subjectModules.find((link) => link.subjectId === s.id)?.moduleId ?? ''
                            ) ?? null,
                    })),
```

- [ ] **Step 3: Verify the payload**

```bash
cd apps/web-ui && bun run dev
```

Sign in, then in the browser console:

```js
await (await fetch('/api/me/ability')).json()
```

Expected: `data.subjects` entries carry `navPath` and `sortOrder`; the `Provider` entry shows `navPath: "/app/agent-ops/providers"`.

- [ ] **Step 4: Run the ability payload tests**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/ability-payload.test.ts`
Expected: PASS — `toAbilityModuleActions` is untouched by this change.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/me/ability/route.ts apps/web-ui/providers/ability-provider.tsx
git commit -m "feat(rbac): ship subject navPath and sortOrder in the ability payload

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: syncRoleSubjectOverrides

**Files:**
- Create: `apps/web-ui/lib/rbac/role-subject-overrides.ts`
- Create: `apps/web-ui/lib/rbac/role-subject-overrides.test.ts`

**Interfaces:**
- Consumes: `RbacTransaction` from `./registry-service`; `ACTION_MAP` from `./types`.
- Produces:
  - `interface SubjectOverride { grant: string[]; deny: string[] }`
  - `type SubjectOverrides = Record<string, SubjectOverride>`
  - `interface SubjectSyncResult { created: number; deleted: number; skipped: string[] }`
  - `async function syncRoleSubjectOverrides(tx, { roleId, tenantId, overrides, createdBy }): Promise<SubjectSyncResult>`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/rbac/role-subject-overrides.test.ts`:

```typescript
/**
 * The property that matters most is the same NEGATIVE one role-rule-sync.test.ts
 * protects, narrowed by one level: this editor owns subject rules that carry
 * NEITHER conditions NOR a field list. A subject rule with conditions is the
 * ABAC layer and must survive a save from a UI that cannot display it.
 */

import { describe, expect, it, vi } from 'vitest';

import { syncRoleSubjectOverrides } from './role-subject-overrides';

const SUBJECTS = [
    { id: 's-provider', key: 'Provider', tenantId: null },
    { id: 's-skill', key: 'Skill', tenantId: null },
];

const ACTIONS = [
    { id: 'a-create', key: 'create', tenantId: null },
    { id: 'a-read', key: 'read', tenantId: null },
    { id: 'a-update', key: 'update', tenantId: null },
    { id: 'a-delete', key: 'delete', tenantId: null },
];

interface ExistingRule {
    id: string;
    subjectId: string | null;
    actionId: string;
    inverted: boolean;
}

function fakeTx(existing: ExistingRule[] = []) {
    interface CreateManyArgs {
        data: { roleId: string; tenantId: string | null; actionId: string; subjectId: string; inverted: boolean }[];
    }
    interface DeleteManyArgs { where: { id: { in: string[] } } }
    const createMany = vi.fn(async (_args: CreateManyArgs) => ({ count: 0 }));
    const deleteMany = vi.fn(async (_args: DeleteManyArgs) => ({ count: 0 }));
    // The real query filters conditions/fields in SQL; the fake returns whatever
    // the test declared as already-owned rows.
    const findMany = vi.fn(async () => existing);

    return {
        tx: {
            rbacSubject: { findMany: async () => SUBJECTS },
            rbacAction: { findMany: async () => ACTIONS },
            rbacRoleRule: { findMany, createMany, deleteMany },
        },
        createMany,
        deleteMany,
        findMany,
    };
}

const base = { roleId: 'role-1', tenantId: 't1', createdBy: 'tester@example.com' };

describe('syncRoleSubjectOverrides', () => {
    it('creates a positive rule for a grant', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['read'], deny: [] } },
        });

        expect(result.created).toBe(1);
        expect(createMany.mock.calls[0][0].data).toEqual([
            { roleId: 'role-1', tenantId: 't1', subjectId: 's-provider', actionId: 'a-read', inverted: false, createdBy: 'tester@example.com' },
        ]);
    });

    it('creates an inverted rule for a deny', async () => {
        const { tx, createMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: [], deny: ['update'] } },
        });

        expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ subjectId: 's-provider', actionId: 'a-update', inverted: true });
    });

    it('deletes an override the payload no longer contains', async () => {
        const { tx, deleteMany } = fakeTx([
            { id: 'rule-old', subjectId: 's-skill', actionId: 'a-delete', inverted: true },
        ]);

        const result = await syncRoleSubjectOverrides(tx as never, { ...base, overrides: {} });

        expect(result.deleted).toBe(1);
        expect(deleteMany.mock.calls[0][0].where.id.in).toEqual(['rule-old']);
    });

    it('leaves an unchanged override alone', async () => {
        const { tx, createMany, deleteMany } = fakeTx([
            { id: 'rule-keep', subjectId: 's-provider', actionId: 'a-read', inverted: false },
        ]);

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['read'], deny: [] } },
        });

        expect(result).toMatchObject({ created: 0, deleted: 0 });
        expect(createMany).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('scopes its read to rules with no conditions and no fields', async () => {
        const { tx, findMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, { ...base, overrides: {} });

        const where = findMany.mock.calls[0][0].where;
        expect(where.subjectId).toEqual({ not: null });
        expect(where.fields).toEqual({ equals: [] });
        // Prisma.DbNull, never a bare null — a bare null means "the JSON value
        // null" on a nullable Json column and matches zero rows.
        expect(where.conditions).toBeDefined();
    });

    it('resolves aliased verbs to terminal actions', async () => {
        const { tx, createMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: [], deny: ['execute'] } },
        });

        // execute -> update, matching how authorize() resolves at read time.
        expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ actionId: 'a-update', inverted: true });
    });

    it('reports an unknown subject rather than guessing', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { GhostSubject: { grant: ['read'], deny: [] } },
        });

        expect(result.skipped).toEqual([`subject 'GhostSubject'`]);
        expect(createMany).not.toHaveBeenCalled();
    });

    it('lets deny win when a verb appears in both lists', async () => {
        const { tx, createMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['read'], deny: ['read'] } },
        });

        const data = createMany.mock.calls[0][0].data;
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({ actionId: 'a-read', inverted: true });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/role-subject-overrides.test.ts`
Expected: FAIL — cannot resolve `./role-subject-overrides`.

- [ ] **Step 3: Write the implementation**

Create `apps/web-ui/lib/rbac/role-subject-overrides.ts`:

```typescript
/**
 * Projects the matrix's SUBJECT-level overrides onto `rbac_role_rules`.
 *
 * ── HOW THIS DIFFERS FROM role-rule-sync.ts ─────────────────────────────────
 * syncRoleRules owns MODULE-level positive grants, because that is all
 * `Record<Module, Action[]>` can express. It explicitly refuses to touch subject
 * rules so that finer-grained authorisation is not destroyed by someone ticking
 * an unrelated checkbox.
 *
 * This function owns the next level down, and inherits the same discipline with
 * a narrower boundary:
 *
 *     subjectId IS NOT NULL  AND  conditions IS NULL  AND  fields = '{}'
 *
 * A subject rule carrying conditions or a field list belongs to the ABAC layer,
 * which has no authoring UI. It survives a save untouched.
 *
 * The original safety property still holds — never delete a grant the editor
 * cannot display — because the matrix renders every subject of every module, so
 * every editor-owned row is on screen when the operator presses Save.
 */

import { Prisma } from '@prisma/client';

import { ACTION_MAP, type Action } from './types';
import type { RbacTransaction } from './registry-service';

/** One subject's overrides. A verb in `deny` wins over the same verb in `grant`. */
export interface SubjectOverride {
    grant: string[];
    deny: string[];
}

export type SubjectOverrides = Record<string, SubjectOverride>;

export interface SubjectSyncResult {
    created: number;
    deleted: number;
    /** Keys with no matching registry row — reported, never guessed. */
    skipped: string[];
}

/** Expand a verb into the terminal action key(s) the registry stores. */
function terminalActions(verb: string): string[] {
    const mapped = ACTION_MAP[verb as Action];
    if (!mapped) return [verb];
    return Array.isArray(mapped) ? [...mapped] : [mapped];
}

/**
 * A tenant override of a key must beat the global row of the same key. Resolved
 * in JS, not with `orderBy: { tenantId: 'desc' }` — Postgres sorts DESC with
 * NULLS FIRST, so the global row arrives first and "take the first" picks
 * exactly backwards. Same idiom as role-rule-sync.ts and registry.ts.
 */
function indexByKey(rows: { id: string; key: string; tenantId: string | null }[]): Map<string, string> {
    const byKey = new Map<string, { id: string; tenantId: string | null }>();
    for (const row of rows) {
        const existing = byKey.get(row.key);
        if (!existing || (existing.tenantId === null && row.tenantId !== null)) {
            byKey.set(row.key, row);
        }
    }
    return new Map([...byKey].map(([key, row]) => [key, row.id]));
}

export async function syncRoleSubjectOverrides(
    tx: RbacTransaction,
    opts: {
        roleId: string;
        /** Owning tenant; null for a global preset. */
        tenantId: string | null;
        overrides: SubjectOverrides;
        createdBy: string;
    }
): Promise<SubjectSyncResult> {
    const { roleId, tenantId, overrides, createdBy } = opts;
    const skipped: string[] = [];

    // See the Prisma nullable-String note in role-rule-sync.ts: a null inside
    // `in` is rejected at runtime on a String field.
    const scope = tenantId === null ? { tenantId: null } : { OR: [{ tenantId }, { tenantId: null }] };

    const [subjects, actions] = await Promise.all([
        tx.rbacSubject.findMany({ where: scope, select: { id: true, key: true, tenantId: true } }),
        tx.rbacAction.findMany({ where: scope, select: { id: true, key: true, tenantId: true } }),
    ]);

    const subjectIdByKey = indexByKey(subjects);
    const actionIdByKey = indexByKey(actions);

    // ── desired state ────────────────────────────────────────────────────────
    const desired = new Map<string, boolean>(); // `${subjectId}::${actionId}` -> inverted

    for (const [subjectKey, override] of Object.entries(overrides ?? {})) {
        const subjectId = subjectIdByKey.get(subjectKey);
        if (!subjectId) {
            skipped.push(`subject '${subjectKey}'`);
            continue;
        }
        // Grants first so a verb listed in BOTH resolves to deny. A cell cannot
        // produce that from the UI, but a hand-built payload can, and "the more
        // restrictive wins" is the only safe way to break the tie.
        for (const [verbs, inverted] of [
            [override.grant ?? [], false],
            [override.deny ?? [], true],
        ] as const) {
            for (const verb of verbs) {
                for (const actionKey of terminalActions(verb)) {
                    const actionId = actionIdByKey.get(actionKey);
                    if (!actionId) {
                        skipped.push(`action '${actionKey}'`);
                        continue;
                    }
                    desired.set(`${subjectId}::${actionId}`, inverted);
                }
            }
        }
    }

    // ── current state, editor-owned rows only ────────────────────────────────
    const existing = await tx.rbacRoleRule.findMany({
        where: {
            // Same tenant scope as the reader, and for the same reason — except
            // this query decides what gets DELETED. A preset role's id is shared
            // across tenants, so an unscoped read here lets one tenant's save
            // reconcile away another tenant's override rows.
            ...scope,
            roleId,
            subjectId: { not: null },
            // Prisma.DbNull, NOT null. On a nullable Json column a bare null is
            // read as "the JSON value null" and matches zero rows — the exact
            // bug lockout.ts documents at its `conditions` filter.
            conditions: { equals: Prisma.DbNull },
            fields: { equals: [] },
        },
        select: { id: true, subjectId: true, actionId: true, inverted: true },
    });

    const existingByKey = new Map<string, { id: string; inverted: boolean }>();
    for (const rule of existing) {
        if (!rule.subjectId) continue; // defensive; the WHERE already excludes these
        existingByKey.set(`${rule.subjectId}::${rule.actionId}`, { id: rule.id, inverted: rule.inverted });
    }

    // ── diff ─────────────────────────────────────────────────────────────────
    // A flip between grant and deny is a delete plus a create, not an update:
    // `inverted` is part of the row's identity for the unique constraint, and
    // recreating keeps this function a pure set-reconciler.
    const toCreate: { subjectId: string; actionId: string; inverted: boolean }[] = [];
    for (const [key, inverted] of desired) {
        const current = existingByKey.get(key);
        if (current && current.inverted === inverted) continue;
        const [subjectId, actionId] = key.split('::');
        toCreate.push({ subjectId, actionId, inverted });
    }

    const toDelete = [...existingByKey.entries()]
        .filter(([key, current]) => !desired.has(key) || desired.get(key) !== current.inverted)
        .map(([, current]) => current.id);

    // Delete first: a grant→deny flip on the same (subject, action) would
    // otherwise collide with the @@unique([roleId, actionId, moduleId, subjectId]).
    if (toDelete.length > 0) {
        await tx.rbacRoleRule.deleteMany({ where: { id: { in: toDelete } } });
    }

    if (toCreate.length > 0) {
        await tx.rbacRoleRule.createMany({
            data: toCreate.map((row) => ({
                roleId,
                tenantId,
                subjectId: row.subjectId,
                actionId: row.actionId,
                inverted: row.inverted,
                createdBy,
            })),
        });
    }

    return { created: toCreate.length, deleted: toDelete.length, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/role-subject-overrides.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Confirm the module-level sync still behaves**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/role-rule-sync.test.ts`
Expected: PASS — `syncRoleRules` is untouched and still filters `subjectId: null`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/rbac/role-subject-overrides.ts apps/web-ui/lib/rbac/role-subject-overrides.test.ts
git commit -m "feat(rbac): sync subject-level overrides into rbac_role_rules

Owns only subject rules with no conditions and no field list, so the ABAC
layer survives a save from a UI that cannot display it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Read overrides back for the editor

**Files:**
- Modify: `apps/web-ui/lib/rbac/registry-admin.ts` (append `loadRoleSubjectOverrides`)
- Create: `apps/web-ui/lib/rbac/registry-admin-overrides.test.ts`

**Interfaces:**
- Consumes: `SubjectOverrides` from `./role-subject-overrides` (Task 6).
- Produces: `async function loadRoleSubjectOverrides(roleIds: string[], tenantId: string | null): Promise<Map<string, SubjectOverrides>>`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/rbac/registry-admin-overrides.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findManyRule = vi.fn();
const findManySubject = vi.fn();
const findManyAction = vi.fn();

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        rbacRoleRule: { findMany: findManyRule },
        rbacSubject: { findMany: findManySubject },
        rbacAction: { findMany: findManyAction },
    }),
}));

import { loadRoleSubjectOverrides } from './registry-admin';

beforeEach(() => {
    findManySubject.mockResolvedValue([
        { id: 's-provider', key: 'Provider' },
        { id: 's-skill', key: 'Skill' },
    ]);
    findManyAction.mockResolvedValue([
        { id: 'a-read', key: 'read' },
        { id: 'a-update', key: 'update' },
    ]);
});

describe('loadRoleSubjectOverrides', () => {
    it('returns an empty map for no roles', async () => {
        expect(await loadRoleSubjectOverrides([], 't1')).toEqual(new Map());
    });

    it('splits rules into grant and deny by subject key', async () => {
        findManyRule.mockResolvedValue([
            { roleId: 'r1', subjectId: 's-provider', actionId: 'a-read', inverted: false },
            { roleId: 'r1', subjectId: 's-skill', actionId: 'a-update', inverted: true },
        ]);

        const result = await loadRoleSubjectOverrides(['r1'], 't1');

        expect(result.get('r1')).toEqual({
            Provider: { grant: ['read'], deny: [] },
            Skill: { grant: [], deny: ['update'] },
        });
    });

    it('skips a rule pointing at a registry row it cannot see', async () => {
        findManyRule.mockResolvedValue([
            { roleId: 'r1', subjectId: 's-ghost', actionId: 'a-read', inverted: false },
        ]);

        expect(await loadRoleSubjectOverrides(['r1'], 't1')).toEqual(new Map());
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin-overrides.test.ts`
Expected: FAIL — `loadRoleSubjectOverrides is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `apps/web-ui/lib/rbac/registry-admin.ts`:

```typescript
/**
 * The subject-level overrides for a set of roles, keyed by role id.
 *
 * The exact inverse of syncRoleSubjectOverrides, and scoped identically —
 * `conditions IS NULL AND fields = '{}'` — so the editor round-trips its own
 * output and never displays an ABAC rule it has no way to edit.
 */
export async function loadRoleSubjectOverrides(
    roleIds: string[],
    tenantId: string | null
): Promise<Map<string, SubjectOverrides>> {
    if (roleIds.length === 0) return new Map();

    const prisma = getPrismaClient();
    const scope = tenantId === null ? { tenantId: null } : globalOrTenant(tenantId);

    const [rules, subjects, actions] = await Promise.all([
        prisma.rbacRoleRule.findMany({
            where: {
                // `...scope` is NOT optional here, and its absence is a
                // cross-tenant leak, not an inefficiency. A PRESET role is a
                // single global row whose id is shared by every tenant, while
                // rbac_role_rules carries its own tenantId — so an unscoped
                // read returns tenant A's overrides to tenant B's editor, and
                // B's next save reconciles them away. loadRoleModuleGrants
                // scopes its rule query for exactly this reason.
                ...scope,
                roleId: { in: roleIds },
                subjectId: { not: null },
                conditions: { equals: Prisma.DbNull },
                fields: { equals: [] },
            },
        }),
        prisma.rbacSubject.findMany({ where: scope }),
        prisma.rbacAction.findMany({ where: scope }),
    ]);

    // Keyed off the RAW rows for the shadowed-id reason loadRoleModuleGrants
    // spells out: a preset rule points at the GLOBAL row id and is never
    // rewritten when a tenant authors an override.
    const subjectKeyById = new Map(subjects.map((s) => [s.id, s.key]));
    const actionKeyById = new Map(actions.map((a) => [a.id, a.key]));

    const out = new Map<string, SubjectOverrides>();
    for (const rule of rules) {
        if (!rule.subjectId) continue;
        const subjectKey = subjectKeyById.get(rule.subjectId);
        const actionKey = actionKeyById.get(rule.actionId);
        // A rule naming a row this reader cannot see is skipped, not guessed at —
        // same posture as syncRoleRules()'s `skipped`.
        if (!subjectKey || !actionKey) continue;

        const forRole = out.get(rule.roleId) ?? {};
        const entry = forRole[subjectKey] ?? { grant: [], deny: [] };
        (rule.inverted ? entry.deny : entry.grant).push(actionKey);
        forRole[subjectKey] = entry;
        out.set(rule.roleId, forRole);
    }

    return out;
}
```

Add the imports at the top of the file if not already present:

```typescript
import { Prisma } from '@prisma/client';
import type { SubjectOverrides } from './role-subject-overrides';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin-overrides.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the neighbouring admin suites**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/registry-admin.test.ts lib/rbac/registry-admin-writes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/rbac/registry-admin.ts apps/web-ui/lib/rbac/registry-admin-overrides.test.ts
git commit -m "feat(rbac): read subject overrides back for the role editor

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Teach lockout about subject overrides

**Files:**
- Modify: `apps/web-ui/lib/rbac/lockout.ts`
- Modify: `apps/web-ui/lib/rbac/lockout.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `assertNoLockout` unchanged in signature; a role holding `cannot update Settings` on the `Settings` subject no longer counts as an admin role.

- [ ] **Step 1: Write the failing test**

Append to `apps/web-ui/lib/rbac/lockout.test.ts`, inside the existing top-level `describe`:

```typescript
    // isAdmin() evaluates can('update', 'Settings') against the Settings
    // SUBJECT, so a subject-level deny kills admin access while the module-level
    // rule this guard counts is still sitting there looking healthy. Without
    // this, the permission system can still delete its own escape hatch — just
    // one level lower than before.
    it('does not count a role whose Settings subject is denied update', async () => {
        const tx = fakeTx({
            modules: [{ id: 'm-settings', tenantId: null }],
            actions: [{ id: 'a-update', tenantId: null }],
            subjects: [{ id: 's-settings', key: 'Settings', tenantId: null }],
            moduleRules: [{ roleId: 'role-admin' }],
            subjectRules: [
                { roleId: 'role-admin', subjectId: 's-settings', actionId: 'a-update', inverted: true },
            ],
            roles: [{ id: 'role-admin', name: 'Admin' }],
            memberCount: 1,
        });

        await expect(assertNoLockout(tx as never, 't1')).rejects.toThrow(RbacLockoutError);
    });

    it('counts a role granted update on the Settings subject directly', async () => {
        const tx = fakeTx({
            modules: [{ id: 'm-settings', tenantId: null }],
            actions: [{ id: 'a-update', tenantId: null }],
            subjects: [{ id: 's-settings', key: 'Settings', tenantId: null }],
            moduleRules: [],
            subjectRules: [
                { roleId: 'role-admin', subjectId: 's-settings', actionId: 'a-update', inverted: false },
            ],
            roles: [{ id: 'role-admin', name: 'Admin' }],
            memberCount: 1,
        });

        await expect(assertNoLockout(tx as never, 't1')).resolves.toBeUndefined();
    });
```

Extend the file's existing `fakeTx` helper to serve `rbacSubject.findMany` and to let `rbacRoleRule.findMany` answer both the module-rule query and the subject-rule query, keyed on whether `where.subjectId` is present:

```typescript
        rbacSubject: { findMany: async () => opts.subjects ?? [] },
        rbacRoleRule: {
            findMany: async (args: { where: Record<string, unknown> }) =>
                'subjectId' in args.where && args.where.subjectId !== null
                    ? (opts.subjectRules ?? [])
                    : (opts.moduleRules ?? []),
        },
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/lockout.test.ts`
Expected: FAIL — the deny case resolves instead of throwing, because only module rules are counted.

- [ ] **Step 3: Write the implementation**

In `apps/web-ui/lib/rbac/lockout.ts`, add a constant beside the existing two:

```typescript
/**
 * isAdmin() asks CASL about the 'Settings' SUBJECT, not the module — the
 * compiler expands a module grant into one rule per subject and never emits a
 * rule named after the module. So the subject is where a deny actually bites.
 */
const ADMIN_SUBJECT_KEY = 'Settings';
```

Then, after `survivingAdminRoles` is computed and before `survivingRoleIds`, subtract the denied roles and add the directly-granted ones:

```typescript
    const settingsSubject = preferTenantLocal(
        await tx.rbacSubject.findMany({
            where: { ...scope, key: ADMIN_SUBJECT_KEY },
            select: { id: true, tenantId: true },
        })
    );

    // Subject-level rules on 'Settings' for the admin action. Unconditional
    // only, for the same reason the module query is: a conditional grant may
    // evaluate false for every real row, so counting it would let an admin
    // satisfy the invariant with a rule that grants nobody anything.
    const subjectRules = settingsSubject
        ? await tx.rbacRoleRule.findMany({
              where: {
                  OR: [{ tenantId }, { tenantId: null }],
                  subjectId: settingsSubject.id,
                  actionId: action.id,
                  conditions: { equals: Prisma.DbNull },
              },
              select: { roleId: true, inverted: true },
          })
        : [];

    const deniedRoleIds = new Set(subjectRules.filter((r) => r.inverted).map((r) => r.roleId));
    const directlyGrantedRoleIds = subjectRules.filter((r) => !r.inverted).map((r) => r.roleId);

    // A deny beats the module grant it shadows (rule-compiler.ts step 6 emits
    // every `cannot` last, so CASL gives it precedence). A direct subject grant
    // qualifies a role that holds no module rule at all.
    const qualifyingRoleIds = [
        ...new Set(
            [...survivingAdminRoles.map((r) => r.roleId), ...directlyGrantedRoleIds].filter(
                (roleId) => !deniedRoleIds.has(roleId)
            )
        ),
    ];

    if (qualifyingRoleIds.length === 0) {
        throw new RbacLockoutError(
            `This change would leave no role able to administer permissions. ` +
                `At least one role must keep '${ADMIN_ACTION_KEY} ${ADMIN_MODULE_KEY}' without conditions ` +
                `and without a '${ADMIN_SUBJECT_KEY}' deny.`
        );
    }
```

Then replace the old `survivingRoleIds` line with:

```typescript
    const survivingRoleIds = qualifyingRoleIds;
```

and delete the now-superseded `if (survivingAdminRoles.length === 0)` block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/lockout.test.ts`
Expected: PASS, including the two new cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/rbac/lockout.ts apps/web-ui/lib/rbac/lockout.test.ts
git commit -m "fix(rbac): count Settings subject denies in the lockout invariant

A subject-level deny kills isAdmin() while the module rule the guard
counted still looked healthy — the escape hatch could close silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wire overrides through the service and API

**Files:**
- Modify: `apps/web-ui/lib/rbac/custom-role-service.ts:29-43,88-122,214-258`
- Modify: `apps/web-ui/app/api/settings/roles/route.ts:53-90`
- Modify: `apps/web-ui/app/api/settings/roles/[roleId]/route.ts:52-90`

**Interfaces:**
- Consumes: `syncRoleSubjectOverrides` (Task 6), `loadRoleSubjectOverrides` (Task 7).
- Produces: `CustomRoleInput` and `CustomRoleOutput` both gain `overrides: SubjectOverrides`. `GET /api/settings/roles` returns `overrides` per role; `POST`/`PUT` accept it.

- [ ] **Step 1: Extend the service types**

In `apps/web-ui/lib/rbac/custom-role-service.ts`:

```typescript
import type { SubjectOverrides } from './role-subject-overrides';
import { syncRoleSubjectOverrides } from './role-subject-overrides';
import { loadAdminRegistry, loadRoleModuleGrants, loadRoleSubjectOverrides } from './registry-admin';

export interface CustomRoleInput {
    name: string;
    permissions: PermissionSet;
    /**
     * Subject-level exceptions to `permissions`. Absent means "no overrides",
     * NOT "leave existing overrides alone" — the sync is a set-reconciler, so an
     * older client that omits the field clears them. That is the safe direction:
     * the alternative is overrides nobody can see and nobody can remove.
     */
    overrides?: SubjectOverrides;
}

export interface CustomRoleOutput {
    id: string;
    tenantId: string;
    name: string;
    permissions: PermissionSet;
    overrides: SubjectOverrides;
    level: number;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
}
```

Update `castRole` to take overrides:

```typescript
function castRole(
    raw: {
        id: string;
        tenantId: string | null;
        name: string;
        permissions: unknown;
        level: number;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
    },
    overrides: SubjectOverrides = {}
): CustomRoleOutput {
    return {
        ...raw,
        tenantId: raw.tenantId ?? '',
        permissions: raw.permissions as PermissionSet,
        overrides,
    };
}
```

- [ ] **Step 2: Sync overrides inside both mutations**

In `createCustomRole`, immediately after the existing `syncRoleRules` call:

```typescript
                // Module grants first, then the exceptions to them. Same
                // transaction: a partial sync would leave the engine disagreeing
                // with the screen that produced it.
                await syncRoleSubjectOverrides(tx, {
                    roleId: role.id,
                    tenantId,
                    overrides: input.overrides ?? {},
                    createdBy: actor.email,
                });

                return castRole(role, input.overrides ?? {});
```

In `updateCustomRole`, after its `syncRoleRules` call:

```typescript
                await syncRoleSubjectOverrides(tx, {
                    roleId,
                    tenantId,
                    overrides: input.overrides ?? {},
                    createdBy: actor.email,
                });

                return castRole(role, input.overrides ?? {});
```

> **Note on `level`:** `getAutoLevel` still counts only module grants. A role whose overrides deny half its module is scored as if it did not. Level gates who may assign roles, so scoring a role *higher* than its effective reach is the conservative direction — it never widens anyone's ability to assign. Left as-is deliberately; revisit only if levels start driving anything else.

- [ ] **Step 3: Return overrides from the list readers**

In `getCustomRoles`:

```typescript
export async function getCustomRoles(tenantId: string): Promise<CustomRoleOutput[]> {
    const prisma = getPrismaClient();
    const roles = await prisma.customRole.findMany({
        where: { tenantId, type: 'custom' },
        orderBy: { name: 'asc' },
    });
    const overridesByRoleId = await loadRoleSubjectOverrides(roles.map((r) => r.id), tenantId);
    return roles.map((r) => castRole(r, overridesByRoleId.get(r.id) ?? {}));
}
```

In `getCustomRole`:

```typescript
export async function getCustomRole(tenantId: string, roleId: string): Promise<CustomRoleOutput | null> {
    const prisma = getPrismaClient();
    const role = await prisma.customRole.findFirst({ where: { id: roleId, tenantId } });
    if (!role) return null;
    const overridesByRoleId = await loadRoleSubjectOverrides([role.id], tenantId);
    return castRole(role, overridesByRoleId.get(role.id) ?? {});
}
```

In `getPresetRoles`, load them alongside the module grants and thread them into the map:

```typescript
    const [grantsByRoleId, overridesByRoleId] = await Promise.all([
        loadRoleModuleGrants(roles.map((r) => r.id), tenantId ?? null),
        loadRoleSubjectOverrides(roles.map((r) => r.id), tenantId ?? null),
    ]);
```

and inside the `byName` map builder, replace `const role = castRole(r);` with:

```typescript
            const role = castRole(r, overridesByRoleId.get(r.id) ?? {});
```

The synthesized-preset fallback object gains `overrides: {}`.

- [ ] **Step 4: Accept overrides in the API routes**

In `apps/web-ui/app/api/settings/roles/route.ts`, in `POST`:

```typescript
        const { name, permissions, overrides } = body as {
            name: string;
            permissions: PermissionSet;
            overrides?: SubjectOverrides;
        };
```

and pass it through to the service:

```typescript
            { name: name.trim(), permissions, overrides: overrides ?? {} },
```

Make the same two edits in `apps/web-ui/app/api/settings/roles/[roleId]/route.ts`'s `PUT`. Add the import to both:

```typescript
import type { SubjectOverrides } from '@/lib/rbac/role-subject-overrides';
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no errors. If `castRole` call sites complain, they need the second argument.

- [ ] **Step 6: Manual round-trip against a live database**

```bash
cd apps/web-ui && bun run dev
```

```bash
curl -s -X PUT localhost:3001/api/settings/roles/<roleId> \
  -H 'Content-Type: application/json' -b '<session cookie>' \
  -d '{"name":"ROLE1","permissions":{"AIOps":["read"]},"overrides":{"Provider":{"grant":[],"deny":["read"]}}}'
curl -s localhost:3001/api/settings/roles -b '<session cookie>' | jq '.data[] | select(.name=="ROLE1") | .overrides'
```

Expected: `{"Provider":{"grant":[],"deny":["read"]}}` — the payload round-trips.

- [ ] **Step 7: Run the full web-ui suite**

Run: `cd apps/web-ui && bun run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/rbac/custom-role-service.ts apps/web-ui/app/api/settings/roles
git commit -m "feat(rbac): accept and return subject overrides on the roles API

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Matrix state machine

**Files:**
- Create: `apps/web-ui/components/settings/permission-matrix/use-matrix-state.ts`
- Create: `apps/web-ui/components/settings/permission-matrix/__tests__/use-matrix-state.test.ts`

**Interfaces:**
- Consumes: `PermissionSet` from `@/lib/rbac/types`; `SubjectOverrides` from `@/lib/rbac/role-subject-overrides`.
- Produces:
  - `type CellState = 'inherit' | 'grant' | 'deny'`
  - `interface MatrixState { modules: Record<string, string[]>; overrides: Record<string, Record<string, CellState>> }`
  - `interface CarriedState { modules: PermissionSet; overrides: SubjectOverrides }`
  - `function toMatrixState(permissions, overrides, moduleKeys, subjectKeys, columnKeys): { state, carried }`
  - `function toPayload(state, carried): { permissions: PermissionSet; overrides: SubjectOverrides }`
  - `function cellState(state, subjectKey, actionKey): CellState`
  - `function effectiveChecked(state, moduleKey, subjectKey, actionKey): boolean`
  - `function toggleModule(state, moduleKey, actionKey, isGrantable): MatrixState`
  - `function toggleSubject(state, moduleKey, subjectKey, actionKey, isGrantable): MatrixState`
  - `function resetSubject(state, subjectKey): MatrixState`
  - `function hasAnyPermission(state, carried): boolean`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/components/settings/permission-matrix/__tests__/use-matrix-state.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  cellState,
  effectiveChecked,
  hasAnyPermission,
  resetSubject,
  toggleModule,
  toggleSubject,
  toMatrixState,
  toPayload,
  type MatrixState,
} from '../use-matrix-state';

const MODULE_KEYS = ['AIOps', 'Inventory'];
const SUBJECT_KEYS = ['Agent', 'Provider', 'Resource'];
const COLUMN_KEYS = new Set(['create', 'read', 'update', 'delete']);
const grantableAlways = () => true;

function state(partial: Partial<MatrixState> = {}): MatrixState {
  return { modules: {}, overrides: {}, ...partial };
}

describe('toMatrixState', () => {
  it('loads module grants and overrides into editable state', () => {
    const { state: s } = toMatrixState(
      { AIOps: ['read', 'update'] },
      { Provider: { grant: [], deny: ['update'] } },
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    expect(s.modules.AIOps).toEqual(['read', 'update']);
    expect(s.overrides.Provider).toEqual({ update: 'deny' });
  });

  // Same property role-dialog.tsx's `carried` protects: opening and saving a
  // role must never silently revoke a grant the grid could not render.
  it('carries grants for modules and subjects the grid cannot show', () => {
    const { state: s, carried } = toMatrixState(
      { AIOps: ['read'], GhostModule: ['delete'] },
      { GhostSubject: { grant: ['read'], deny: [] } },
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    expect(s.modules.GhostModule).toBeUndefined();
    expect(carried.modules).toEqual({ GhostModule: ['delete'] });
    expect(carried.overrides).toEqual({ GhostSubject: { grant: ['read'], deny: [] } });
  });

  it('carries a verb with no column inside a module that has a row', () => {
    const { state: s, carried } = toMatrixState(
      { AIOps: ['read', 'exotic'] },
      {},
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    expect(s.modules.AIOps).toEqual(['read']);
    expect(carried.modules).toEqual({ AIOps: ['exotic'] });
  });
});

describe('effectiveChecked', () => {
  it('inherits the module value when there is no override', () => {
    const s = state({ modules: { AIOps: ['read'] } });
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(true);
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'update')).toBe(false);
  });

  it('lets a deny override a granted module', () => {
    const s = state({ modules: { AIOps: ['read'] }, overrides: { Provider: { read: 'deny' } } });
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(false);
  });

  it('lets a grant override an ungranted module', () => {
    const s = state({ modules: {}, overrides: { Provider: { read: 'grant' } } });
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(true);
  });
});

describe('toggleSubject', () => {
  it('flips an inherited grant to an explicit deny', () => {
    const s = toggleSubject(state({ modules: { AIOps: ['read'] } }), 'AIOps', 'Provider', 'read', grantableAlways);
    expect(cellState(s, 'Provider', 'read')).toBe('deny');
  });

  it('flips an inherited denial to an explicit grant', () => {
    const s = toggleSubject(state({ modules: {} }), 'AIOps', 'Provider', 'read', grantableAlways);
    expect(cellState(s, 'Provider', 'read')).toBe('grant');
  });

  it('returns to inherit on a second click', () => {
    let s = toggleSubject(state({ modules: { AIOps: ['read'] } }), 'AIOps', 'Provider', 'read', grantableAlways);
    s = toggleSubject(s, 'AIOps', 'Provider', 'read', grantableAlways);
    expect(cellState(s, 'Provider', 'read')).toBe('inherit');
  });

  // You cannot act on what you cannot see — the subject-level twin of the
  // "unchecking Read clears the row" rule the module grid already has.
  it('denying read denies every other verb on that subject', () => {
    const s = toggleSubject(
      state({ modules: { AIOps: ['read', 'update', 'delete'] } }),
      'AIOps',
      'Provider',
      'read',
      grantableAlways
    );
    expect(s.overrides.Provider).toEqual({ read: 'deny', update: 'deny', delete: 'deny' });
  });

  it('granting a non-read verb also grants read when read is not effective', () => {
    const s = toggleSubject(state({ modules: {} }), 'AIOps', 'Provider', 'update', grantableAlways);
    expect(s.overrides.Provider).toEqual({ update: 'grant', read: 'grant' });
  });

  it('does not add a read grant when the module already grants read', () => {
    const s = toggleSubject(state({ modules: { AIOps: ['read'] } }), 'AIOps', 'Provider', 'update', grantableAlways);
    expect(s.overrides.Provider).toEqual({ update: 'grant' });
  });

  it('never writes a cell the registry says is not grantable', () => {
    const s = toggleSubject(state({ modules: {} }), 'AIOps', 'Provider', 'delete', () => false);
    expect(s.overrides.Provider).toBeUndefined();
  });
});

describe('toggleModule', () => {
  it('checking a non-read verb auto-checks read', () => {
    const s = toggleModule(state(), 'AIOps', 'update', grantableAlways);
    expect(new Set(s.modules.AIOps)).toEqual(new Set(['update', 'read']));
  });

  it('unchecking read clears the module row', () => {
    let s = toggleModule(state(), 'AIOps', 'update', grantableAlways);
    s = toggleModule(s, 'AIOps', 'read', grantableAlways);
    expect(s.modules.AIOps).toEqual([]);
  });
});

describe('resetSubject', () => {
  it('drops every override for one subject', () => {
    const s = resetSubject(
      state({ overrides: { Provider: { read: 'deny' }, Agent: { read: 'grant' } } }),
      'Provider'
    );
    expect(s.overrides.Provider).toBeUndefined();
    expect(s.overrides.Agent).toEqual({ read: 'grant' });
  });
});

describe('toPayload', () => {
  it('round-trips through toMatrixState unchanged', () => {
    const permissions = { AIOps: ['read', 'update'] };
    const overrides = { Provider: { grant: [], deny: ['update'] } };
    const { state: s, carried } = toMatrixState(permissions, overrides, MODULE_KEYS, SUBJECT_KEYS, COLUMN_KEYS);

    const payload = toPayload(s, carried);

    expect(payload.permissions.AIOps.sort()).toEqual(['read', 'update']);
    expect(payload.overrides).toEqual({ Provider: { grant: [], deny: ['update'] } });
  });

  it('merges carried grants back in verbatim', () => {
    const { state: s, carried } = toMatrixState(
      { AIOps: ['read'], GhostModule: ['delete'] },
      { GhostSubject: { grant: ['read'], deny: [] } },
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    const payload = toPayload(s, carried);

    expect(payload.permissions.GhostModule).toEqual(['delete']);
    expect(payload.overrides.GhostSubject).toEqual({ grant: ['read'], deny: [] });
  });
});

describe('hasAnyPermission', () => {
  it('is false for an empty role', () => {
    expect(hasAnyPermission(state(), { modules: {}, overrides: {} })).toBe(false);
  });

  it('is true when only a carried grant exists', () => {
    expect(hasAnyPermission(state(), { modules: { Ghost: ['read'] }, overrides: {} })).toBe(true);
  });

  // A role made only of denials grants nothing and must not save.
  it('is false when the only overrides are denials', () => {
    expect(hasAnyPermission(state({ overrides: { Provider: { read: 'deny' } } }), { modules: {}, overrides: {} })).toBe(false);
  });

  it('is true when a subject grant exists with no module grant', () => {
    expect(hasAnyPermission(state({ overrides: { Provider: { read: 'grant' } } }), { modules: {}, overrides: {} })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/settings/permission-matrix`
Expected: FAIL — cannot resolve `../use-matrix-state`.

- [ ] **Step 3: Write the implementation**

Create `apps/web-ui/components/settings/permission-matrix/use-matrix-state.ts`:

```typescript
/**
 * Every state transition the permission matrix can make, with no JSX.
 *
 * Extracted from role-dialog.tsx so the rules that actually matter — what a
 * click means, what inherits, what is carried through untouched — are testable
 * without rendering a dialog. The component files below are then only markup.
 */

import type { PermissionSet } from "@/lib/rbac/types";
import type { SubjectOverrides } from "@/lib/rbac/role-subject-overrides";

export type CellState = "inherit" | "grant" | "deny";

export interface MatrixState {
  /** moduleKey -> granted verbs. Mirrors the legacy permissions blob. */
  modules: Record<string, string[]>;
  /** subjectKey -> verb -> explicit override. Absent verb means inherit. */
  overrides: Record<string, Record<string, CellState>>;
}

/**
 * Grants the grid cannot render, kept verbatim so opening and saving a role is
 * never a silent revocation. Three ways a grant becomes unrenderable: its module
 * left the registry, its verb lost its column, or its subject left the registry.
 */
export interface CarriedState {
  modules: PermissionSet;
  overrides: SubjectOverrides;
}

/** Whether a (module, verb) cell may be written at all. */
export type IsGrantable = (moduleKey: string, actionKey: string) => boolean;

const READ = "read";

export function toMatrixState(
  permissions: PermissionSet | null | undefined,
  overrides: SubjectOverrides | null | undefined,
  moduleKeys: string[],
  subjectKeys: string[],
  columnKeys: Set<string>
): { state: MatrixState; carried: CarriedState } {
  const knownModules = new Set(moduleKeys);
  const knownSubjects = new Set(subjectKeys);

  const state: MatrixState = { modules: {}, overrides: {} };
  const carried: CarriedState = { modules: {}, overrides: {} };

  for (const key of moduleKeys) state.modules[key] = [];

  for (const [moduleKey, verbs] of Object.entries(permissions ?? {})) {
    const list = verbs ?? [];
    if (!knownModules.has(moduleKey)) {
      carried.modules[moduleKey] = [...list];
      continue;
    }
    state.modules[moduleKey] = list.filter((v) => columnKeys.has(v));
    const hidden = list.filter((v) => !columnKeys.has(v));
    if (hidden.length > 0) carried.modules[moduleKey] = hidden;
  }

  for (const [subjectKey, override] of Object.entries(overrides ?? {})) {
    const grant = override?.grant ?? [];
    const deny = override?.deny ?? [];
    if (!knownSubjects.has(subjectKey)) {
      carried.overrides[subjectKey] = { grant: [...grant], deny: [...deny] };
      continue;
    }
    const cells: Record<string, CellState> = {};
    const hiddenGrant = grant.filter((v) => !columnKeys.has(v));
    const hiddenDeny = deny.filter((v) => !columnKeys.has(v));
    for (const verb of grant) if (columnKeys.has(verb)) cells[verb] = "grant";
    // Deny applied second so it wins a contradictory stored payload, matching
    // syncRoleSubjectOverrides' tie-break.
    for (const verb of deny) if (columnKeys.has(verb)) cells[verb] = "deny";
    if (Object.keys(cells).length > 0) state.overrides[subjectKey] = cells;
    if (hiddenGrant.length > 0 || hiddenDeny.length > 0) {
      carried.overrides[subjectKey] = { grant: hiddenGrant, deny: hiddenDeny };
    }
  }

  return { state, carried };
}

export function cellState(state: MatrixState, subjectKey: string, actionKey: string): CellState {
  return state.overrides[subjectKey]?.[actionKey] ?? "inherit";
}

/** What the checkbox shows: the override if there is one, else the module's value. */
export function effectiveChecked(
  state: MatrixState,
  moduleKey: string,
  subjectKey: string,
  actionKey: string
): boolean {
  const override = cellState(state, subjectKey, actionKey);
  if (override === "grant") return true;
  if (override === "deny") return false;
  return (state.modules[moduleKey] ?? []).includes(actionKey);
}

function withOverrides(
  state: MatrixState,
  subjectKey: string,
  cells: Record<string, CellState>
): MatrixState {
  const next = { ...state, overrides: { ...state.overrides } };
  if (Object.keys(cells).length === 0) delete next.overrides[subjectKey];
  else next.overrides[subjectKey] = cells;
  return next;
}

export function toggleModule(
  state: MatrixState,
  moduleKey: string,
  actionKey: string,
  isGrantable: IsGrantable
): MatrixState {
  if (!isGrantable(moduleKey, actionKey)) return state;

  const current = new Set(state.modules[moduleKey] ?? []);
  if (current.has(actionKey)) {
    current.delete(actionKey);
    // Unchecking Read clears the row — you cannot act on what you cannot see.
    if (actionKey === READ) current.clear();
  } else {
    current.add(actionKey);
    // Checking any non-read verb implies Read. Guarded by isGrantable because
    // nothing guarantees a module that grants SOME verb also grants read.
    if (actionKey !== READ && isGrantable(moduleKey, READ)) current.add(READ);
  }
  return { ...state, modules: { ...state.modules, [moduleKey]: [...current] } };
}

/**
 * One click flips the cell to the opposite of what it inherits; a second click
 * returns it to inherit. There is no three-way cycle to hunt through, and the
 * meaning of a click is always "make this disagree with its module" or "stop
 * disagreeing".
 */
export function toggleSubject(
  state: MatrixState,
  moduleKey: string,
  subjectKey: string,
  actionKey: string,
  isGrantable: IsGrantable
): MatrixState {
  if (!isGrantable(moduleKey, actionKey)) return state;

  const cells = { ...(state.overrides[subjectKey] ?? {}) };

  // Already overridden -> back to inherit.
  if (cells[actionKey]) {
    delete cells[actionKey];
    return withOverrides(state, subjectKey, cells);
  }

  const inheritedOn = (state.modules[moduleKey] ?? []).includes(actionKey);

  if (inheritedOn) {
    cells[actionKey] = "deny";
    // Denying Read denies everything else EFFECTIVE on this subject.
    //
    // The candidate set is the union of module-granted verbs AND verbs the
    // subject already overrides. Iterating `state.modules[moduleKey]` alone
    // misses a verb granted purely by an override — e.g. module grants only
    // `read` while `overrides.Provider = { create: 'grant' }`. Denying read
    // would then leave `create` live on a subject nobody can read.
    if (actionKey === READ) {
      const candidates = new Set([...(state.modules[moduleKey] ?? []), ...Object.keys(cells)]);
      for (const verb of candidates) {
        if (verb === READ) continue;
        if (!isGrantable(moduleKey, verb)) continue;
        // effectiveChecked reads the PRE-toggle state — what WAS effective.
        if (effectiveChecked(state, moduleKey, subjectKey, verb)) cells[verb] = "deny";
      }
    }
  } else {
    cells[actionKey] = "grant";
    // Granting a non-read verb implies Read, unless read is already effective.
    if (actionKey !== READ && isGrantable(moduleKey, READ)) {
      // Override-aware: an explicit read DENY means read is NOT effective even
      // though the module grants it. Testing `cells[READ] === 'grant' || module
      // .includes(READ)` masks the deny and ships update-without-read.
      const readEffective = cells[READ]
        ? cells[READ] === "grant"
        : (state.modules[moduleKey] ?? []).includes(READ);
      // Deliberate: this OVERWRITES an explicit read deny. It reverses a user
      // choice, which is the lesser evil — the alternative is a granted verb on
      // an unreadable subject. Re-denying read afterwards cascades correctly.
      if (!readEffective) cells[READ] = "grant";
    }
  }

  return withOverrides(state, subjectKey, cells);
}

export function resetSubject(state: MatrixState, subjectKey: string): MatrixState {
  return withOverrides(state, subjectKey, {});
}

export function toPayload(
  state: MatrixState,
  carried: CarriedState
): { permissions: PermissionSet; overrides: SubjectOverrides } {
  const permissions: PermissionSet = {};
  for (const [moduleKey, verbs] of Object.entries(carried.modules)) {
    if (!(moduleKey in state.modules)) permissions[moduleKey] = [...verbs];
  }
  for (const [moduleKey, verbs] of Object.entries(state.modules)) {
    const hidden = carried.modules[moduleKey] ?? [];
    permissions[moduleKey] = [...new Set([...hidden, ...verbs])];
  }

  const overrides: SubjectOverrides = {};
  for (const [subjectKey, entry] of Object.entries(carried.overrides)) {
    overrides[subjectKey] = { grant: [...entry.grant], deny: [...entry.deny] };
  }
  for (const [subjectKey, cells] of Object.entries(state.overrides)) {
    const hidden = carried.overrides[subjectKey] ?? { grant: [], deny: [] };
    const grant = [...hidden.grant];
    const deny = [...hidden.deny];
    for (const [verb, cell] of Object.entries(cells)) {
      if (cell === "grant") grant.push(verb);
      else deny.push(verb);
    }
    overrides[subjectKey] = { grant: [...new Set(grant)], deny: [...new Set(deny)] };
  }

  return { permissions, overrides };
}

/**
 * A role must grant SOMETHING. Denials do not count: a role built only of
 * `cannot` rules authorizes nobody to do anything, and saving it would create a
 * role that looks configured and is inert.
 */
export function hasAnyPermission(state: MatrixState, carried: CarriedState): boolean {
  if (Object.values(state.modules).some((verbs) => verbs.length > 0)) return true;
  if (Object.values(carried.modules).some((verbs) => verbs.length > 0)) return true;
  if (Object.values(state.overrides).some((cells) => Object.values(cells).includes("grant"))) return true;
  return Object.values(carried.overrides).some((entry) => entry.grant.length > 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run components/settings/permission-matrix`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/settings/permission-matrix
git commit -m "feat(rbac): matrix state machine for module + subject cells

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Two-level matrix UI

**Files:**
- Create: `apps/web-ui/components/settings/permission-matrix/matrix.tsx`
- Create: `apps/web-ui/components/settings/permission-matrix/module-row.tsx`
- Create: `apps/web-ui/components/settings/permission-matrix/subject-row.tsx`
- Modify: `apps/web-ui/components/settings/role-dialog.tsx` (replace the grid; keep the shell)
- Modify: `apps/web-ui/lib/queries/roles.ts` (`CustomRole.overrides`, `useSaveRole` variables)
- Modify: `apps/web-ui/components/settings/access-control/roles-tab.tsx` (`handleSave` third argument)
- Test: `apps/web-ui/components/settings/__tests__/role-dialog.test.tsx` (existing — update assertions)

**Interfaces:**
- Consumes: everything from `use-matrix-state.ts` (Task 10); `useAbilityMeta`/`useGrantableCells` from `@/hooks/use-can`; `AbilitySubjectDef` (Task 5); `SubjectOverrides` (Task 6).
- Produces:
  - `<PermissionMatrix rows columns subjectsByModule state isGrantable onToggleModule onToggleSubject onResetSubject />`
  - `RoleDialogProps.onSave: (name: string, permissions: PermissionSet, overrides: SubjectOverrides) => Promise<void>`
  - `RoleDialogProps.role?: { id: string; name: string; permissions: PermissionSet; overrides?: SubjectOverrides } | null`
  - `CustomRole.overrides: SubjectOverrides` and `PredefinedRole.overrides: SubjectOverrides` in `lib/queries/roles.ts`

- [ ] **Step 1: Write the subject row**

Create `apps/web-ui/components/settings/permission-matrix/subject-row.tsx`:

```tsx
"use client";

import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { AbilityActionDef } from "@/providers/ability-provider";

import { cellState, effectiveChecked, type MatrixState } from "./use-matrix-state";

export interface SubjectRowProps {
  moduleKey: string;
  subjectKey: string;
  subjectLabel: string;
  columns: AbilityActionDef[];
  state: MatrixState;
  isGrantable: (moduleKey: string, actionKey: string) => boolean;
  onToggle: (actionKey: string) => void;
  onReset: () => void;
}

export function SubjectRow({
  moduleKey,
  subjectKey,
  subjectLabel,
  columns,
  state,
  isGrantable,
  onToggle,
  onReset,
}: SubjectRowProps) {
  const cells = state.overrides[subjectKey] ?? {};
  const hasOverride = Object.keys(cells).length > 0;

  return (
    <TableRow className="bg-muted/20">
      <TableCell className="py-2 pl-10 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          {subjectLabel}
          {hasOverride && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 text-xs"
              onClick={onReset}
              aria-label={`Reset ${subjectLabel} to inherited`}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          )}
        </span>
      </TableCell>
      {columns.map((col) => {
        const grantable = isGrantable(moduleKey, col.key);
        const cell = cellState(state, subjectKey, col.key);
        const checked = effectiveChecked(state, moduleKey, subjectKey, col.key);
        return (
          <TableCell key={col.key} className="py-2 text-center">
            <span className="relative inline-flex items-center justify-center">
              <Checkbox
                checked={checked}
                onCheckedChange={() => onToggle(col.key)}
                disabled={!grantable}
                // An inherited cell is muted and dashed so "this is the module's
                // value, not a decision made here" is visible at a glance.
                className={cn(
                  cell === "inherit" && "border-dashed opacity-60",
                  cell === "deny" && "border-destructive"
                )}
                aria-label={`${col.label} ${subjectLabel} (${cell})`}
              />
              {cell !== "inherit" && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute -right-2 -top-1 h-1.5 w-1.5 rounded-full",
                    cell === "grant" ? "bg-primary" : "bg-destructive"
                  )}
                />
              )}
            </span>
          </TableCell>
        );
      })}
    </TableRow>
  );
}
```

- [ ] **Step 2: Write the module row**

Create `apps/web-ui/components/settings/permission-matrix/module-row.tsx`:

```tsx
"use client";

import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import type { AbilityActionDef } from "@/providers/ability-provider";

import type { MatrixState } from "./use-matrix-state";

export interface ModuleRowProps {
  moduleKey: string;
  moduleLabel: string;
  columns: AbilityActionDef[];
  state: MatrixState;
  subjectKeys: string[];
  expanded: boolean;
  isGrantable: (moduleKey: string, actionKey: string) => boolean;
  onToggleExpanded: () => void;
  onToggle: (action: AbilityActionDef) => void;
}

export function ModuleRow({
  moduleKey,
  moduleLabel,
  columns,
  state,
  subjectKeys,
  expanded,
  isGrantable,
  onToggleExpanded,
  onToggle,
}: ModuleRowProps) {
  const granted = state.modules[moduleKey] ?? [];
  // A collapsed override must never be invisible, or an admin edits a role
  // without knowing an exception is buried inside it.
  const overriddenCount = subjectKeys.filter(
    (key) => Object.keys(state.overrides[key] ?? {}).length > 0
  ).length;

  return (
    <TableRow className="min-h-[44px]">
      <TableCell className="py-3 font-medium">
        <span className="flex items-center gap-1">
          {subjectKeys.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onToggleExpanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${moduleLabel} submodules`}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          ) : (
            <span className="inline-block w-6" />
          )}
          {moduleLabel}
          {overriddenCount > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
              {overriddenCount} override{overriddenCount === 1 ? "" : "s"}
            </Badge>
          )}
        </span>
      </TableCell>
      {columns.map((col) => (
        <TableCell key={col.key} className="py-3 text-center">
          <Checkbox
            checked={granted.includes(col.key)}
            onCheckedChange={() => onToggle(col)}
            disabled={!isGrantable(moduleKey, col.key)}
            aria-label={`${col.label} ${moduleLabel}`}
          />
        </TableCell>
      ))}
    </TableRow>
  );
}
```

- [ ] **Step 3: Write the matrix shell**

Create `apps/web-ui/components/settings/permission-matrix/matrix.tsx`:

```tsx
"use client";

import { Fragment, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AbilityActionDef, AbilityModule, AbilitySubjectDef } from "@/providers/ability-provider";

import { ModuleRow } from "./module-row";
import { SubjectRow } from "./subject-row";
import type { MatrixState } from "./use-matrix-state";

export interface PermissionMatrixProps {
  rows: AbilityModule[];
  columns: AbilityActionDef[];
  subjectsByModule: Record<string, AbilitySubjectDef[]>;
  state: MatrixState;
  isGrantable: (moduleKey: string, actionKey: string) => boolean;
  onToggleModule: (moduleKey: string, moduleLabel: string, action: AbilityActionDef) => void;
  onToggleSubject: (moduleKey: string, subjectKey: string, subjectLabel: string, action: AbilityActionDef) => void;
  onResetSubject: (subjectKey: string) => void;
}

export function PermissionMatrix({
  rows,
  columns,
  subjectsByModule,
  state,
  isGrantable,
  onToggleModule,
  onToggleSubject,
  onResetSubject,
}: PermissionMatrixProps) {
  // Collapsed by default: 7 modules x ~31 subjects x 4-6 verbs fully expanded is
  // an unusable wall.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();

  const visibleSubjects = useMemo(() => {
    const out: Record<string, AbilitySubjectDef[]> = {};
    for (const [moduleKey, subjects] of Object.entries(subjectsByModule)) {
      out[moduleKey] = needle
        ? subjects.filter(
            (s) => s.label.toLowerCase().includes(needle) || s.key.toLowerCase().includes(needle)
          )
        : subjects;
    }
    return out;
  }, [subjectsByModule, needle]);

  function toggleExpanded(moduleKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(moduleKey)) next.delete(moduleKey);
      else next.add(moduleKey);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <Input
        placeholder="Filter submodules…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Filter submodules"
      />
      <div className="max-h-[420px] overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-56">Module</TableHead>
              {columns.map((col) => (
                <TableHead key={col.key} className="w-20 text-center">
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const subjects = visibleSubjects[row.key] ?? [];
              // A filter match forces its module open, or the matches are hidden
              // behind a collapsed chevron and the box looks broken.
              const isOpen = expanded.has(row.key) || (needle.length > 0 && subjects.length > 0);
              return (
                // Fragment, not <>: this is the array element, so the key
                // belongs here. On the shorthand React warns and reconciles
                // rows by index — expanding one module then collapsing another
                // reuses the wrong checkbox state.
                <Fragment key={row.key}>
                  <ModuleRow
                    moduleKey={row.key}
                    moduleLabel={row.label}
                    columns={columns}
                    state={state}
                    subjectKeys={(subjectsByModule[row.key] ?? []).map((s) => s.key)}
                    expanded={isOpen}
                    isGrantable={isGrantable}
                    onToggleExpanded={() => toggleExpanded(row.key)}
                    onToggle={(action) => onToggleModule(row.key, row.label, action)}
                  />
                  {isOpen &&
                    subjects.map((subject) => (
                      <SubjectRow
                        key={`${row.key}:${subject.key}`}
                        moduleKey={row.key}
                        subjectKey={subject.key}
                        subjectLabel={subject.label}
                        columns={columns}
                        state={state}
                        isGrantable={isGrantable}
                        onToggle={(actionKey) => {
                          const action = columns.find((c) => c.key === actionKey);
                          if (action) onToggleSubject(row.key, subject.key, subject.label, action);
                        }}
                        onReset={() => onResetSubject(subject.key)}
                      />
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Submodule cells inherit their module unless overridden. A dashed box is inherited; a dot marks an
        explicit grant or deny.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Rewire the dialog**

In `apps/web-ui/components/settings/role-dialog.tsx`, delete `toPermissionsState`, `toPermissionSet`, `hasAnyPermission` and `applyToggle` (now in `use-matrix-state.ts`), and replace the grid markup with `<PermissionMatrix />`. Key changes:

```tsx
import { PermissionMatrix } from "./permission-matrix/matrix";
import {
    hasAnyPermission,
    resetSubject,
    toggleModule,
    toggleSubject,
    toMatrixState,
    toPayload,
    type CarriedState,
    type MatrixState,
} from "./permission-matrix/use-matrix-state";
import type { SubjectOverrides } from "@/lib/rbac/role-subject-overrides";

interface RoleDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    role?: { id: string; name: string; permissions: PermissionSet; overrides?: SubjectOverrides } | null;
    onSave: (name: string, permissions: PermissionSet, overrides: SubjectOverrides) => Promise<void>;
}
```

State:

```tsx
    const [matrix, setMatrix] = useState<MatrixState>({ modules: {}, overrides: {} });
    const [carried, setCarried] = useState<CarriedState>({ modules: {}, overrides: {} });
```

Subjects grouped by module, from the ability payload:

```tsx
    const { subjects } = useAbilityMeta();
    const subjectsByModule = useMemo(() => {
        const out: Record<string, typeof subjects> = {};
        for (const subject of subjects) {
            if (!subject.moduleKey) continue;
            out[subject.moduleKey] = [...(out[subject.moduleKey] ?? []), subject];
        }
        for (const key of Object.keys(out)) {
            out[key].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
        }
        return out;
    }, [subjects]);
    const subjectKeys = useMemo(() => subjects.map((s) => s.key), [subjects]);
```

Reset effect body:

```tsx
            const { state, carried: carriedIn } = toMatrixState(
                role?.permissions ?? null,
                role?.overrides ?? null,
                rows.map((r) => r.key),
                subjectKeys,
                columnKeys
            );
            setName(role?.name ?? "");
            setMatrix(state);
            setCarried(carriedIn);
```

The dangerous-verb confirmation now covers both levels. Widen `pendingToggle` and apply on confirm:

```tsx
    const [pendingToggle, setPendingToggle] = useState<{
        moduleKey: string;
        moduleLabel: string;
        subjectKey?: string;
        action: AbilityActionDef;
    } | null>(null);

    function applyPending(pending: NonNullable<typeof pendingToggle>) {
        setMatrix((prev) =>
            pending.subjectKey
                ? toggleSubject(prev, pending.moduleKey, pending.subjectKey, pending.action.key, isGrantable)
                : toggleModule(prev, pending.moduleKey, pending.action.key, isGrantable)
        );
        setPermError(null);
    }

    function requestModuleToggle(moduleKey: string, moduleLabel: string, action: AbilityActionDef) {
        const isChecked = (matrix.modules[moduleKey] ?? []).includes(action.key);
        if (!isChecked && action.isDangerous && !confirmedDangerous.has(action.key)) {
            setConfirmText("");
            setPendingToggle({ moduleKey, moduleLabel, action });
            return;
        }
        applyPending({ moduleKey, moduleLabel, action });
    }

    function requestSubjectToggle(
        moduleKey: string,
        subjectKey: string,
        subjectLabel: string,
        action: AbilityActionDef
    ) {
        // Only an explicit GRANT prompts. A deny removes power and never needs a
        // confirmation gate.
        const willGrant =
            matrix.overrides[subjectKey]?.[action.key] === undefined &&
            !(matrix.modules[moduleKey] ?? []).includes(action.key);
        if (willGrant && action.isDangerous && !confirmedDangerous.has(action.key)) {
            setConfirmText("");
            setPendingToggle({ moduleKey, moduleLabel: subjectLabel, subjectKey, action });
            return;
        }
        applyPending({ moduleKey, moduleLabel: subjectLabel, subjectKey, action });
    }

    function confirmDangerousToggle() {
        if (!pendingToggle) return;
        setConfirmedDangerous((prev) => new Set(prev).add(pendingToggle.action.key));
        applyPending(pendingToggle);
        setPendingToggle(null);
    }
```

Save:

```tsx
        const payload = toPayload(matrix, carried);
        await onSave(name.trim(), payload.permissions, payload.overrides);
```

Validity: `hasAnyPermission(matrix, carried)` everywhere the old helper was used.

Body, replacing the old `<Table>` block:

```tsx
                            <PermissionMatrix
                                rows={rows}
                                columns={columns}
                                subjectsByModule={subjectsByModule}
                                state={matrix}
                                isGrantable={isGrantable}
                                onToggleModule={requestModuleToggle}
                                onToggleSubject={requestSubjectToggle}
                                onResetSubject={(subjectKey) =>
                                    setMatrix((prev) => resetSubject(prev, subjectKey))
                                }
                            />
```

Also widen the dialog: `<DialogContent className="max-w-3xl">`.

- [ ] **Step 5: Widen the mutation hook**

In `apps/web-ui/lib/queries/roles.ts`, add `overrides` to the `CustomRole` type and to `useSaveRole`'s variables and body:

```typescript
import type { SubjectOverrides } from '@/lib/rbac/role-subject-overrides';

export interface CustomRole {
    id: string;
    tenantId: string;
    name: string;
    permissions: PermissionSet;
    /** Subject-level exceptions to `permissions`. Empty object when there are none. */
    overrides: SubjectOverrides;
    level: number;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
}
```

```typescript
        mutationFn: async ({
            id,
            name,
            permissions,
            overrides,
        }: {
            id?: string;
            name: string;
            permissions: PermissionSet;
            overrides: SubjectOverrides;
        }) => {
            const res = await fetch(
                id ? `/api/settings/roles/${id}` : '/api/settings/roles',
                {
                    method: id ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, permissions, overrides }),
                },
            );
```

Also add `overrides: SubjectOverrides;` to the `PredefinedRole` interface — `getPresetRoles` now returns it (Task 9) and the dialog reads `role.overrides` for both kinds.

- [ ] **Step 6: Update the dialog's caller**

The call site is `apps/web-ui/components/settings/access-control/roles-tab.tsx` (not `roles-list.tsx`, which only renders cards). Widen `handleSave`:

```tsx
    const handleSave = async (name: string, permissions: PermissionSet, overrides: SubjectOverrides) => {
        // mutateAsync throws on failure so the dialog can surface the error.
        await saveRole.mutateAsync({ id: editingRole?.id, name, permissions, overrides });
        setDialogOpen(false);
    };
```

Add the import:

```tsx
import type { SubjectOverrides } from "@/lib/rbac/role-subject-overrides";
```

`editingRole` is a `CustomRole` and now carries `overrides`, so the existing `role={editingRole}` prop already satisfies the widened `RoleDialogProps` — no change needed there.

- [ ] **Step 7: Update the existing dialog test**

`apps/web-ui/components/settings/__tests__/role-dialog.test.tsx` renders `RoleDialog` and asserts against the old flat grid. It will fail on the new markup. Update it:

- `onSave={noop}` still typechecks (three args, all ignored) — no change needed to those four smoke cases.
- Any assertion matching a module checkbox by `aria-label` still works: `ModuleRow` keeps the `${col.label} ${moduleLabel}` label format.
- Any assertion counting table rows must now account for the filter input above the table and for collapsed subject rows (which render nothing until expanded).

Run it and fix what actually breaks rather than pre-emptively rewriting:

```bash
cd apps/web-ui && bunx vitest run components/settings/__tests__/role-dialog.test.tsx
```

- [ ] **Step 8: Typecheck and lint**

```bash
cd apps/web-ui && bunx tsc --noEmit && bun run lint
```

Expected: no errors.

- [ ] **Step 9: Manual verification**

```bash
cd apps/web-ui && bun run dev
```

Open **IAM → Roles → Edit** on a custom role:
- Every module row has a chevron; expanding AI Ops lists Agent, AgentOps, Channel, KnowledgeBase, McpServer, Memory, Provider, ScheduledTask, Skill.
- With AI Ops **Read** ticked, every subject's Read box shows checked-and-dashed.
- Click Provider's Read → it unchecks, gains a red dot, and the AI Ops row shows a "1 override" badge.
- Click it again → back to dashed-inherited, badge gone.
- Collapse AI Ops with an override active → the badge is still visible.
- Type "prov" in the filter → only Provider shows, and its module auto-expands.
- Save, reopen → the override is still there.

- [ ] **Step 10: Run the full suite**

Run: `cd apps/web-ui && bun run test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web-ui/components/settings apps/web-ui/lib/queries/roles.ts
git commit -m "feat(rbac): two-level permission matrix with subject overrides

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Nav gating by subject

**Files:**
- Modify: `apps/web-ui/hooks/use-can.ts:153-191`
- Modify: `apps/web-ui/components/nav-main.tsx:78-104`
- Create: `apps/web-ui/hooks/__tests__/use-nav-gate.test.tsx`

**Interfaces:**
- Consumes: `resolveNavOwner` from `@nucleus/rbac` (Task 4); `AbilitySubjectDef.navPath` (Task 5).
- Produces: `useNavGate()` returns `{ isLoaded, canSeeHref, canSeeModule, canSeeSubject }`, with `canSeeHref` now subject-aware.

- [ ] **Step 1: Write the failing test**

`apps/web-ui/hooks/__tests__/use-can.test.tsx` already exists and wraps hooks in the CASL + meta providers. Read it first and match its wrapper idiom rather than inventing a second one — two divergent harnesses for the same context is how these tests start disagreeing with each other.

Create `apps/web-ui/hooks/__tests__/use-nav-gate.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createMongoAbility } from '@casl/ability';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import type { ReactNode } from 'react';

import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { useNavGate } from '@/hooks/use-can';

const META: AbilityMeta = {
    modules: [
        { key: 'AIOps', label: 'AI Ops', icon: null, navPath: '/app/agent', sortOrder: 40 },
        { key: 'Settings', label: 'Settings', icon: null, navPath: '/app/settings', sortOrder: 50 },
    ],
    actions: [],
    subjects: [
        { key: 'Agent', label: 'Agent', kind: 'resource', moduleKey: 'AIOps', navPath: '/app/agent', sortOrder: 10 },
        { key: 'Provider', label: 'Provider', kind: 'resource', moduleKey: 'AIOps', navPath: '/app/agent-ops/providers', sortOrder: 70 },
        { key: 'Skill', label: 'Skill', kind: 'resource', moduleKey: 'AIOps', navPath: '/app/skills', sortOrder: 60 },
        { key: 'Tenant', label: 'Tenant', kind: 'resource', moduleKey: 'Settings', navPath: '/app/settings/organization', sortOrder: 30 },
    ],
    moduleActions: [],
    actionAliases: {},
    version: '1.0',
    isLoaded: true,
};

function wrapperFor(rules: { action: string; subject: string; inverted?: boolean }[]) {
    const ability = createMongoAbility(rules as never);
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <CaslAbilityProvider value={ability as never}>
                <AbilityMetaContext.Provider value={META}>{children}</AbilityMetaContext.Provider>
            </CaslAbilityProvider>
        );
    };
}

describe('useNavGate', () => {
    it('hides a destination whose owning subject is denied', () => {
        // AIOps read everywhere EXCEPT Provider — exactly what the matrix writes
        // for "AI Ops: read, Provider: deny read".
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([
                { action: 'read', subject: 'Agent' },
                { action: 'read', subject: 'Skill' },
            ]),
        });

        expect(result.current.canSeeHref('/app/skills')).toBe(true);
        expect(result.current.canSeeHref('/app/agent-ops/providers')).toBe(false);
    });

    it('keeps a module-owned destination visible when any subject is readable', () => {
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([{ action: 'read', subject: 'Tenant' }]),
        });

        expect(result.current.canSeeHref('/app/settings/organization')).toBe(true);
    });

    it('leaves a destination no row claims visible', () => {
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor([]) });
        expect(result.current.canSeeHref('/app/nowhere')).toBe(true);
    });

    it('canSeeSubject answers directly', () => {
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([{ action: 'read', subject: 'Provider' }]),
        });

        expect(result.current.canSeeSubject('Provider')).toBe(true);
        expect(result.current.canSeeSubject('Skill')).toBe(false);
    });

    it('canSeeSubject fails closed for an unknown subject', () => {
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([{ action: 'manage', subject: 'all' }]),
        });

        expect(result.current.canSeeSubject('NotInRegistry')).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run hooks/__tests__/use-nav-gate.test.tsx`
Expected: FAIL — `canSeeSubject is not a function`, and `/app/agent-ops/providers` resolves to no owner so it returns `true`.

- [ ] **Step 3: Rewrite useNavGate**

In `apps/web-ui/hooks/use-can.ts`, replace the whole `useNavGate` function:

```typescript
/**
 * Nav gating, driven by `navPath` + read grants.
 *
 * Resolution is the SHARED resolver from @nucleus/rbac, the same one the
 * middleware page guard uses — a sidebar that hides a link the page still serves
 * (or the reverse) is a bug that only surfaces in production, so the logic is
 * imported rather than reimplemented.
 *
 * ── A DESTINATION NO ROW CLAIMS STAYS VISIBLE ───────────────────────────────
 * Deliberate. Nav is UX; page admission and `authorize()` are the boundary.
 * Failing closed here would blank the sidebar for any route the registry has not
 * been taught about yet — a missing metadata row would look like an outage —
 * while failing open costs at most one avoidable 403 on a route that is still
 * guarded server-side.
 *
 * `isLoaded` is false until the rules arrive. Callers render nothing gated until
 * then: the default ability is empty, so "not yet loaded" behaves as denied, and
 * showing the full nav first would flash entries the user is about to lose.
 */
export function useNavGate(): {
    isLoaded: boolean;
    canSeeHref: (href: string) => boolean;
    canSeeModule: (moduleKey: string) => boolean;
    canSeeSubject: (subjectKey: string) => boolean;
} {
    const ability = useAppAbility();
    const { modules, subjects, isLoaded } = useAbilityMeta();

    /**
     * A module absent from the registry is NOT visible — the opposite of
     * canSeeHref's fallback, and deliberately so: an unmatched HREF usually means
     * "this route belongs to no module", whereas an unmatched MODULE KEY means
     * the annotation is wrong or the module was retired.
     */
    const canSeeModule = (moduleKey: string): boolean => {
        const known = modules.some((m) => m.key === moduleKey);
        if (!known) return false;
        return canReadModule(ability, subjects, moduleKey);
    };

    /** Same fail-closed reasoning as canSeeModule: an unknown key is a bad annotation. */
    const canSeeSubject = (subjectKey: string): boolean => {
        const known = subjects.some((s) => s.key === subjectKey);
        if (!known) return false;
        return ability.can('read', subjectKey as never);
    };

    const canSeeHref = (href: string): boolean => {
        const owner = resolveNavOwner(href, subjects, modules);
        if (!owner) return true;
        return owner.kind === 'subject'
            ? ability.can('read', owner.key as never)
            : canReadModule(ability, subjects, owner.key);
    };

    return { isLoaded, canSeeHref, canSeeModule, canSeeSubject };
}
```

Add the import at the top of the file:

```typescript
import { resolveNavOwner, type AppAbility } from '@nucleus/rbac';
```

(replacing the existing `import type { AppAbility } from '@nucleus/rbac';`)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run hooks/__tests__/use-nav-gate.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Fix the nav precedence**

In `apps/web-ui/components/nav-main.tsx`, `useVisibleItems`, replace the `canSee` closure:

```tsx
  // Resolution order: a subject that claims this href wins, THEN the declared
  // module annotation, THEN module-navPath inference, THEN visible.
  //
  // The declared `module` used to short-circuit first, which would shadow every
  // subject navPath — all nine Agentic Ops entries declare module "AIOps", so
  // Providers could never be gated on its own subject. The annotations survive
  // as the fallback for destinations no subject claims (nothing regresses); they
  // just stop outranking a more specific claim.
  const canSee = (entry: { href?: string; module?: string }): boolean => {
    if (entry.href && subjectOwns(entry.href)) return canSeeHref(entry.href)
    if (entry.module) return canSeeModule(entry.module)
    return !entry.href || canSeeHref(entry.href)
  }
```

and pull `subjectOwns` out of the hook's meta:

```tsx
function useVisibleItems(items: NavItem[]): NavItem[] {
  const { isLoaded, canSeeHref, canSeeModule } = useNavGate()
  const { subjects } = useAbilityMeta()

  const subjectOwns = React.useCallback(
    (href: string) => resolveNavOwner(href, subjects, [])?.kind === "subject",
    [subjects]
  )
```

Add the imports:

```tsx
import { resolveNavOwner } from "@nucleus/rbac"
import { useAbilityMeta, useNavGate } from "@/hooks/use-can"
```

and add `subjectOwns` to the `useMemo` dependency array.

- [ ] **Step 6: Manual verification**

Create a role with `AIOps: read` and `Provider: deny read`, assign it to a test user, sign in as them.

Expected: the Agentic Ops section shows AI Ops, Agent Ops, Memory, Scheduled Tasks, Knowledge Base, Ask, Skills and MCP Servers — **but not Providers**.

- [ ] **Step 7: Run the full suite and lint**

```bash
cd apps/web-ui && bun run test && bun run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/hooks apps/web-ui/components/nav-main.tsx
git commit -m "feat(nav): gate sidebar entries on the subject that owns them

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Middleware page guard

**Files:**
- Modify: `apps/web-ui/middleware.ts`
- Create: `apps/web-ui/lib/rbac/page-authz.ts`
- Create: `apps/web-ui/lib/rbac/page-authz.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `resolveNavOwner` (Task 4); `loadRegistrySnapshot` from `./registry`; `getAbilityForPrincipal` / `getRbacVersion` from `./ability-cache`; `buildPrincipalFor` from `./session-ability`.
- Produces, all from `lib/rbac/page-authz.ts`:
  - `type PageGuardMode = 'off' | 'shadow' | 'enforce'`
  - `function pageGuardMode(): PageGuardMode`
  - `const UNAUTHORIZED_PATH = '/app/unauthorized'`
  - `function isExemptPath(pathname: string): boolean`
  - `interface PageAuthzRegistry { subjects: { id: string; key: string; moduleKey: string | null }[] }`
  - `function canReadOwner(ability: AppAbility, owner: NavOwner, registry: PageAuthzRegistry): boolean`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/rbac/page-authz.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createMongoAbility } from '@casl/ability';

import { canReadOwner, isExemptPath, pageGuardMode } from './page-authz';

const REGISTRY = {
    subjects: [
        { id: 's1', key: 'Agent', moduleKey: 'AIOps' },
        { id: 's2', key: 'Provider', moduleKey: 'AIOps' },
    ],
};

describe('pageGuardMode', () => {
    it('defaults to shadow', () => {
        delete process.env.RBAC_PAGE_GUARD_MODE;
        expect(pageGuardMode()).toBe('shadow');
    });

    it('accepts enforce and off', () => {
        process.env.RBAC_PAGE_GUARD_MODE = 'enforce';
        expect(pageGuardMode()).toBe('enforce');
        process.env.RBAC_PAGE_GUARD_MODE = 'off';
        expect(pageGuardMode()).toBe('off');
        delete process.env.RBAC_PAGE_GUARD_MODE;
    });

    it('treats an unrecognised value as shadow', () => {
        process.env.RBAC_PAGE_GUARD_MODE = 'yes-please';
        expect(pageGuardMode()).toBe('shadow');
        delete process.env.RBAC_PAGE_GUARD_MODE;
    });
});

describe('isExemptPath', () => {
    // Guarding the denial page itself is an infinite redirect.
    it('exempts the unauthorized page', () => {
        expect(isExemptPath('/app/unauthorized')).toBe(true);
    });

    it('exempts the /app root', () => {
        expect(isExemptPath('/app')).toBe(true);
    });

    it('does not exempt a normal page', () => {
        expect(isExemptPath('/app/agent-ops/providers')).toBe(false);
    });
});

describe('canReadOwner', () => {
    it('asks about the subject key for a subject owner', () => {
        const ability = createMongoAbility([{ action: 'read', subject: 'Agent' }] as never);
        expect(canReadOwner(ability as never, { kind: 'subject', key: 'Agent', navPath: '/app/agent' }, REGISTRY)).toBe(true);
        expect(canReadOwner(ability as never, { kind: 'subject', key: 'Provider', navPath: '/app/x' }, REGISTRY)).toBe(false);
    });

    // A module grant compiles to one rule per SUBJECT and never a rule named
    // after the module, so "can read anything in here" is the only answerable form.
    it('asks about any subject of the module for a module owner', () => {
        const ability = createMongoAbility([{ action: 'read', subject: 'Agent' }] as never);
        expect(canReadOwner(ability as never, { kind: 'module', key: 'AIOps', navPath: '/app/agent' }, REGISTRY)).toBe(true);
    });

    it('denies a module whose subjects are all unreadable', () => {
        const ability = createMongoAbility([] as never);
        expect(canReadOwner(ability as never, { kind: 'module', key: 'AIOps', navPath: '/app/agent' }, REGISTRY)).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/page-authz.test.ts`
Expected: FAIL — cannot resolve `./page-authz`.

- [ ] **Step 3: Write the helper**

Create `apps/web-ui/lib/rbac/page-authz.ts`:

```typescript
/**
 * Page admission — the chrome-level twin of route-authz.ts.
 *
 * ── DELIBERATE DIVERGENCE FROM LAYER 1's FAIL-CLOSED CONTRACT ───────────────
 * A DENIAL fails closed. An INFRASTRUCTURE failure (registry unreadable, the
 * compiler throwing) fails OPEN, logged at error.
 *
 * Layer 1 guards the DATA and must never serve a row it could not authorize.
 * This guard covers pages whose every API call is already gated twice, by Layer
 * 1 and by authorize(). A compiler outage should therefore degrade to
 * empty-looking pages, not lock every user out of the entire application.
 *
 * This is the OPPOSITE of enforceLayer1. Do not "fix" it to match.
 */

import type { AppAbility, NavOwner } from '@nucleus/rbac';

export type PageGuardMode = 'off' | 'shadow' | 'enforce';

/**
 * Default `shadow`, matching RBAC_ROUTE_GUARD_MODE. Turning a new guard on must
 * never be the thing that breaks prod; infra/compute sets `enforce` explicitly.
 */
export function pageGuardMode(): PageGuardMode {
    const raw = process.env.RBAC_PAGE_GUARD_MODE;
    return raw === 'enforce' || raw === 'off' ? raw : 'shadow';
}

/** Where a denial sends the user. Must itself be exempt, or it redirects forever. */
export const UNAUTHORIZED_PATH = '/app/unauthorized';

const EXEMPT = new Set(['/app', UNAUTHORIZED_PATH]);

export function isExemptPath(pathname: string): boolean {
    return EXEMPT.has(pathname);
}

/** The subset of a registry snapshot this module needs. */
export interface PageAuthzRegistry {
    subjects: { id: string; key: string; moduleKey: string | null }[];
}

/**
 * Whether the caller may READ the row that owns this page.
 *
 * A module owner is asked as "can you read ANY subject of this module", because
 * the compiler expands a module grant into one rule per subject and never emits
 * a rule whose subject is the module key — `can('read', 'Inventory')` is false
 * even for a role granted Inventory outright.
 */
export function canReadOwner(
    ability: AppAbility,
    owner: NavOwner,
    registry: PageAuthzRegistry
): boolean {
    if (owner.kind === 'subject') return ability.can('read', owner.key as never);

    const owned = registry.subjects.filter((s) => s.moduleKey === owner.key);
    if (owned.length === 0) return ability.can('read', owner.key as never);
    return owned.some((s) => ability.can('read', s.key as never));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/rbac/page-authz.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire it into the middleware**

In `apps/web-ui/middleware.ts`, add the imports:

```typescript
import { resolveNavOwner } from "@nucleus/rbac";
import { loadRegistrySnapshot } from "@/lib/rbac/registry";
import { canReadOwner, isExemptPath, pageGuardMode, UNAUTHORIZED_PATH } from "@/lib/rbac/page-authz";
```

Add the guard function beside `enforceLayer1`:

```typescript
/**
 * Page admission. Hiding a nav entry is UX only — without this, the URL still
 * works and a bookmark still resolves.
 *
 * Returns a redirect to short-circuit, or null to continue. See page-authz.ts
 * for why an infrastructure failure here allows rather than denies.
 */
async function enforcePageRead(req: NextRequestWithAuth): Promise<NextResponse | null> {
    const mode = pageGuardMode();
    if (mode === "off") return null;

    const { pathname } = req.nextUrl;
    if (!pathname.startsWith("/app/") && pathname !== "/app") return null;
    if (isExemptPath(pathname)) return null;

    try {
        const token = req.nextauth.token;
        const principal = await buildPrincipalFor(token);
        if (!principal) return null; // NextAuth already gates authentication

        const registry = await loadRegistrySnapshot(principal.tenantId);
        const moduleKeyById = new Map(registry.modules.map((m) => [m.id, m.key]));
        const subjects = registry.subjects.map((s) => ({
            id: s.id,
            key: s.key,
            navPath: s.navPath,
            moduleKey:
                moduleKeyById.get(
                    registry.subjectModules.find((link) => link.subjectId === s.id)?.moduleId ?? ""
                ) ?? null,
        }));

        const owner = resolveNavOwner(pathname, subjects, registry.modules);
        // No row claims this path. Allow — same fail-open the sidebar uses, so
        // the two never disagree about an unmapped route.
        if (!owner) return null;

        const { ability } = await getAbilityForPrincipal(principal, await getRbacVersion(principal.tenantId));
        if (canReadOwner(ability, owner, { subjects })) return null;

        if (mode === "shadow") {
            console.warn(
                "[rbac] rbac.page_guard.shadow_denial",
                JSON.stringify({
                    pathname,
                    owner: `${owner.kind}:${owner.key}`,
                    role: principal.roleName,
                    tenantId: principal.tenantId,
                })
            );
            return null;
        }

        return NextResponse.redirect(new URL(UNAUTHORIZED_PATH, req.url));
    } catch (error) {
        // Fail OPEN. See the contract note in page-authz.ts.
        console.error("[rbac] page guard failed, allowing:", error);
        return null;
    }
}
```

Then in the request handler, immediately after the existing Layer 1 dispatch:

```typescript
        const layer1 = await enforceLayer1(req);
        if (layer1) return layer1;

        const pageGuard = await enforcePageRead(req);
        if (pageGuard) return pageGuard;
```

> **Check the actual call site.** `enforceLayer1` already returns early for non-`/api/` paths, so the two guards are mutually exclusive by construction — but confirm you are inserting after the existing `if (…) return …`, not replacing it.

- [ ] **Step 6: Document the flag**

In `.env.example`, beside `RBAC_ROUTE_GUARD_MODE`:

```bash
# Page admission guard: off | shadow | enforce.
# shadow logs rbac.page_guard.shadow_denial without redirecting. Prod sets
# `enforce` via infra/compute; flip only after the shadow log is quiet AND
# DYNAMIC_ABAC_ENABLED has settled.
RBAC_PAGE_GUARD_MODE=enforce
```

- [ ] **Step 7: Manual verification in enforce mode**

```bash
cd apps/web-ui && RBAC_PAGE_GUARD_MODE=enforce bun run dev
```

Signed in as the role with `Provider: deny read`:
- `/app/agent-ops/providers` → redirects to `/app/unauthorized`.
- `/app/skills` → renders.
- `/app/unauthorized` → renders (no redirect loop).
- `/app/nowhere-at-all` → normal Next 404, not a redirect.

Then with `RBAC_PAGE_GUARD_MODE=shadow`: `/app/agent-ops/providers` renders, and the server log shows `rbac.page_guard.shadow_denial`.

- [ ] **Step 8: Run the suite**

Run: `cd apps/web-ui && bun run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web-ui/middleware.ts apps/web-ui/lib/rbac/page-authz.ts apps/web-ui/lib/rbac/page-authz.test.ts .env.example
git commit -m "feat(rbac): middleware page guard resolved by subject navPath

Fails closed on a denial, open on an infrastructure error — the opposite
of Layer 1, because this guards chrome over already-guarded APIs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: E2E round-trip

**Files:**
- Create: `apps/web-ui-e2e/rbac-submodule.spec.ts`

**Interfaces:**
- Consumes: the matrix UI (Task 11) and the roles API (Task 9).
- Produces: nothing imported.

- [ ] **Step 1: Write the spec**

Create `apps/web-ui-e2e/rbac-submodule.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';

/**
 * Round-trips a submodule override through the real editor.
 *
 * Deliberately does NOT sign in as the restricted role: creating a user,
 * assigning a role and re-authenticating inside a Playwright run is slow and the
 * flakiest part of any suite here. Nav hiding and page admission are covered by
 * use-nav-gate.test.tsx and page-authz.test.ts, which test the same resolver
 * this UI feeds. What only an E2E can prove is that the two-level grid persists
 * what it displays.
 */

const ROLE_NAME = `E2E Submodule ${Date.now()}`;

test.describe('Submodule permissions', () => {
    test('creates a role with a subject override and reloads it', async ({ page }) => {
        await page.goto('/app/iam/roles');
        await page.waitForLoadState('networkidle');

        await page.getByRole('button', { name: 'Create Role' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();

        await page.getByLabel('Role Name').fill(ROLE_NAME);

        // Grant the whole module first.
        await page.getByRole('checkbox', { name: 'Read AI Ops' }).click();

        // Expand AI Ops and deny one submodule.
        await page.getByRole('button', { name: 'Expand AI Ops submodules' }).click();
        const providerRead = page.getByRole('checkbox', { name: /^Read LLM Provider/ });
        await expect(providerRead).toBeChecked(); // inherited from the module
        await providerRead.click();
        await expect(providerRead).not.toBeChecked();

        // The override is announced on the module row even before saving.
        await expect(page.getByText('1 override')).toBeVisible();

        await page.getByRole('button', { name: 'Save Role' }).click();
        await expect(page.getByRole('dialog')).toBeHidden();

        // Reopen and confirm the override survived the round-trip.
        await page.getByRole('row', { name: new RegExp(ROLE_NAME) }).getByRole('button', { name: 'Edit' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('button', { name: 'Expand AI Ops submodules' }).click();
        await expect(page.getByRole('checkbox', { name: /^Read LLM Provider/ })).not.toBeChecked();
        await expect(page.getByRole('checkbox', { name: 'Read AI Ops' })).toBeChecked();
    });
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/web-ui-e2e && bunx playwright test rbac-submodule.spec.ts`
Expected: PASS. If a locator misses, open the page with Playwright MCP or `--headed` and read the real accessible names off the DOM rather than guessing — the `aria-label`s are set in Tasks 11's components.

- [ ] **Step 3: Clean up the test role**

The spec leaves a role behind. Either delete it manually via IAM → Roles, or add an `afterAll` that calls `DELETE /api/settings/roles/:id`. Leaving it will eventually trip the `MAX_CUSTOM_ROLES = 10` ceiling and fail the suite for an unrelated reason.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui-e2e/rbac-submodule.spec.ts
git commit -m "test(e2e): submodule override round-trips through the role editor

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Production flags — two separate deploys

**Files:**
- Modify: `infra/compute/index.ts:787`

**Interfaces:**
- Consumes: everything above, deployed and soaked.
- Produces: no code interface.

> **These are two deploys, not one.** They fail in ways that look identical from a support ticket — "I can't get to a page I could get to yesterday" — so bundling them makes a regression ambiguous. Do Step 1–4 completely, then Step 5–8.

- [ ] **Step 1: Verify the parity gate before touching anything**

`authorize.ts:32` states the contract: flip only once `rbac.parity.mismatch` has stayed at zero across a soak long enough to have exercised every role in active use.

```bash
aws logs filter-pattern "rbac.parity.mismatch" \
  --log-group-name /ecs/nucleus-web-ui --start-time $(( ($(date +%s) - 604800) * 1000 )) \
  --profile PLATFORM-ADMIN | head -50
```

Expected: no matches over 7 days. **If there are matches, stop and fix them — do not proceed.**

- [ ] **Step 2: Verify subject coverage against production data**

```bash
cd apps/web-ui && DATABASE_URL="<prod url>" bun run rbac:check-subjects
```

Expected: OK. This is the check that catches another `ScalingAudit`.

- [ ] **Step 3: Flip the decision source**

In `infra/compute/index.ts`, line 787:

```typescript
            { name: "DYNAMIC_ABAC_ENABLED", value: "true" },
```

Add `RBAC_PAGE_GUARD_MODE` in **shadow** for now, in the same env block:

```typescript
            { name: "RBAC_PAGE_GUARD_MODE", value: "shadow" },
```

- [ ] **Step 4: Deploy and watch**

```bash
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

Then verify per `CLAUDE.md`'s post-deploy checklist: CloudFront returns 200, both ECS services reach desired count, and CloudWatch is clean for 5 minutes. Specifically watch for `[rbac] rules dropped` and 403 spikes.

Commit:

```bash
git add infra/compute/index.ts
git commit -m "chore(rbac): make CASL the production decision source

Parity counter held at zero across a 7-day soak. Page guard ships in
shadow; it enforces in a separate deploy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Let the page guard shadow-log settle**

Wait at least 48 hours with `DYNAMIC_ABAC_ENABLED=true` live, then:

```bash
aws logs filter-pattern "rbac.page_guard.shadow_denial" \
  --log-group-name /ecs/nucleus-web-ui --start-time $(( ($(date +%s) - 172800) * 1000 )) \
  --profile PLATFORM-ADMIN | head -50
```

Expected: no matches, or only matches you can explain as genuine denials. **A shadow denial for a page someone legitimately needs is a missing grant or a wrong navPath — fix it before enforcing.**

The 48-hour wait is not ceremony: a shadow log recorded while the legacy matrix was still deciding tells you nothing about what CASL will deny.

- [ ] **Step 6: Flip the page guard**

In `infra/compute/index.ts`:

```typescript
            { name: "RBAC_PAGE_GUARD_MODE", value: "enforce" },
```

- [ ] **Step 7: Deploy and verify**

```bash
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

Post-deploy: sign in as a restricted role and confirm a hidden page redirects to `/app/unauthorized` rather than rendering. Confirm `/app/unauthorized` itself renders (no loop).

- [ ] **Step 8: Commit**

```bash
git add infra/compute/index.ts
git commit -m "chore(rbac): enforce the page guard in production

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Rollback

Each task is one commit and independently revertable. Fastest kill-switches, in order of preference:

| Symptom | Action |
|---|---|
| Pages redirecting that should not | Set `RBAC_PAGE_GUARD_MODE=off`, redeploy compute |
| Widespread 403s after the flag flip | Set `DYNAMIC_ABAC_ENABLED=false`, redeploy — the legacy matrix takes over |
| A single tenant's route broken | Insert an `rbac_route_permissions` row with `mode='public'` — no deploy needed |
| Bad override on one role | Edit the role in the matrix; the sync reconciles on save |

The migration is additive (two nullable/defaulted columns, five new rows) and needs no `git revert` — a rolled-back application ignores the columns.
