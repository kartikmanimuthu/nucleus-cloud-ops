# Adding global RBAC registry rows

**Global registry rows go in a migration. Not the seed, not a script.**

The Permissions and Modules admin screens were removed, and the
`backfill-permissions.ts` / `backfill-modules.ts` scripts that briefly replaced them are
gone too. This is where that capability lives now.

## Why a migration and not the seed

`apps/web-ui/docker-entrypoint.sh:11` runs `prisma migrate deploy` and nothing else. The
seed is never executed in production. A registry row added to `libs/prisma/seed.ts` would
exist on every developer laptop and in no production database — which is why
`seed.ts:42-56` says so explicitly and `assertRbacRegistrySeeded()` fails the seed if the
registry is missing rather than creating it.

The same argument retired the backfill scripts. These rows are global (`tenantId IS NULL`),
`isSystem = true`, and **nothing in the app can delete them** — `deleteAction` /
`deleteModule` refuse global rows unconditionally. A row you cannot delete should be
reviewed in a diff and applied identically everywhere, which is what a migration is and
what a hand-run script is not.

## Non-negotiable invariants

Every recipe below obeys these. They are not stylistic.

**1. Deterministic ids.** `sys-act-*`, `sys-mod-*`, `sys-subj-*`, `sys-sm-*`, `sys-ma-*`,
`sys-rule-*`. Random cuids would make the migration non-idempotent and leave later
migrations unable to reference the row.

**2. Untargeted `ON CONFLICT DO NOTHING`.** Not `ON CONFLICT ("id")`. There are partial
global unique indexes — `rbac_subjects_global_key`, `rbac_subject_modules_global_key`
(`20260730000000_dynamic_abac:244-245`) — and the untargeted form covers those as well as
the primary key. `20260813000000_scaling_audit_subject:41` documents why that matters: a
database where someone hand-inserted a row to work around a 403 stays valid.

**3. Bump `rbac_global_version`. Always.** `ability-cache.ts` keys both layers on
`${rbac_global_version.version}.${tenants.rbacVersion}` and those entries are **immutable** —
bumping does not clear the cache, it makes the old keys unreachable. No trigger watches
`rbac_subjects` or `rbac_modules`. Without the bump, every running task keeps serving
abilities compiled before your row existed and a correct database still 403s. The probe
refreshes every 5s, so this applies without a restart.

```sql
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
-- Defensive: the singleton is created by DEFAULT but never explicitly seeded, so where it
-- is absent the UPDATE above is a silent no-op and nothing invalidates.
INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
```

**4. A new column on a row that may already exist needs its own `UPDATE`.** An
`INSERT ... ON CONFLICT DO NOTHING` that carries a new column value applies it *only* if the
row was absent. Where the row existed, the column stays NULL and no later migration
revisits it. Use `UPDATE ... SET col = ... WHERE key = 'X' AND col IS NULL` — idempotent,
re-runnable, and it never clobbers a tenant-authored value.
`20260820000000_backfill_subject_navpaths` exists solely because
`20260812100000_subject_nav_paths` got this wrong for five subjects, and the resulting NULL
`navPath` made a sidebar entry render for every role.

**5. Never edit an applied migration.** Prisma stores a checksum; editing a folder that has
run anywhere breaks `migrate deploy` for that database. Write a new migration.

---

## Recipe: new permission (`rbac_actions`)

Replaces `backfill-permissions.ts`. Precedent: `20260730000000_dynamic_abac:444-455`.

```sql
INSERT INTO "rbac_actions" ("id", "tenantId", "key", "label", "description", "aliasOfKey", "isDangerous", "isSystem", "sortOrder") VALUES
    ('sys-act-restart', NULL, 'restart', 'Restart', 'Restarts a running resource', 'update', true, true, 110)
ON CONFLICT DO NOTHING;
```

- `key` must match `^[a-z][a-z0-9_]*$`.
- `aliasOfKey` must resolve to an action that exists — it is followed at compile time, and a
  dangling alias is a rule the compiler cannot resolve. `'update'` above means "a role
  holding `update` also gets `restart`".
- Do not redefine `manage` (already seeded, expands to every grantable action on the module)
  or `all` (CASL's wildcard).
- `isDangerous = true` forces a typed confirmation in the role editor. Use it for anything
  that mutates live AWS compute.
- **A new action grants nothing until it is added to a module's grid** — see the next
  recipe's `rbac_module_actions` block. An action with no grid link has no checkbox.

## Recipe: new module (`rbac_modules`)

Replaces `backfill-modules.ts`. Precedent: `20260806120000_iam_module` — copy it; it is the
complete worked example, including the part the script could not do at all (preset grants).

```sql
-- 1. The module row.
INSERT INTO "rbac_modules" ("id", "tenantId", "key", "label", "description", "icon", "navPath", "sortOrder", "isSystem") VALUES
    ('sys-mod-costcontrol', NULL, 'CostControl', 'Cost Control', 'Budgets and anomaly alerts', 'PiggyBank', '/app/cost-control', 55, true)
ON CONFLICT DO NOTHING;

-- 2. The action grid. This is what decides which cells EXIST — it is how Dashboard stays
--    read-only, as data. `grantable = false` renders a cell disabled rather than absent.
INSERT INTO "rbac_module_actions" ("id", "tenantId", "moduleId", "actionId", "grantable")
SELECT 'sys-ma-CostControl-' || a."key", NULL, 'sys-mod-costcontrol', a."id", true
FROM "rbac_actions" a
WHERE a."tenantId" IS NULL AND a."key" IN ('create', 'read', 'update', 'delete')
ON CONFLICT DO NOTHING;

-- 3. Preset-role grants. Without these the module is invisible to every role but SuperAdmin.
--    Match permissions.ts ROLE_PERMISSIONS.*.<Module> exactly.
INSERT INTO "rbac_role_rules" ("id", "tenantId", "roleId", "actionId", "moduleId", "createdBy")
SELECT 'sys-rule-' || g.role_id || '-CostControl-' || act, NULL, g.role_id, a."id", 'sys-mod-costcontrol', 'system'
FROM (VALUES
    ('preset-owner',  ARRAY['create', 'read', 'update', 'delete']),
    ('preset-admin',  ARRAY['create', 'read', 'update']),
    ('preset-member', ARRAY['read']),
    ('preset-viewer', ARRAY['read'])
) AS g(role_id, actions)
CROSS JOIN LATERAL unnest(g.actions) AS act
JOIN "rbac_actions" a ON a."key" = act AND a."tenantId" IS NULL
JOIN "custom_roles" r ON r."id" = g.role_id
ON CONFLICT DO NOTHING;
```

- `key` must match `^[A-Za-z][A-Za-z0-9]*$`.
- A module needs at least one subject to be worth anything: the compiler expands a module
  grant onto every subject of that module (`rule-compiler.ts:324`), so a module with no
  subjects compiles to nothing.
- Adding a subject to an existing module later is automatically covered by every role that
  already holds that module — no new rules needed.

## Recipe: new subject / "submodule" (`rbac_subjects`)

A "submodule" in the role editor **is** a registry subject
(`docs/superpowers/specs/2026-08-12-submodule-rbac-design.md:53`). Precedent:
`20260813000000_scaling_audit_subject`.

```sql
INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "isSystem") VALUES
    ('sys-subj-budget', NULL, 'Budget', 'Budget', 'resource', true)
ON CONFLICT DO NOTHING;

INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-budget', NULL, 'sys-subj-budget', 'sys-mod-costcontrol')
ON CONFLICT DO NOTHING;

-- Only if the subject owns a page. Separate UPDATE per invariant 4 above.
UPDATE "rbac_subjects" SET "navPath" = '/app/cost-control/budgets', "sortOrder" = 30
 WHERE "key" = 'Budget' AND "navPath" IS NULL;
```

- **One module per subject.** `rbac_subject_modules` is globally unique on `subjectId`
  alone. To move a subject, `UPDATE ... SET "moduleId" = ...` — a second row violates the
  index. See `20260806120000_iam_module`'s repoint of `User` / `Role` off Settings.
- `kind`: `'resource'` for something with a backing row, `'capability'` for an agent tool
  permission with none.
- `navPath` NULL means the subject is grantable in the matrix but never resolves as a nav
  owner. Correct for `Discovery`, `Billing` and the `Agent*` capability subjects.
- **Two subjects must never share a `navPath`** — `resolveNavOwner` would be ambiguous, and
  `assert-subject-coverage.ts` rejects it in CI.
- A subject reachable by URL but claimed by no `navPath` renders in the sidebar for
  *everyone*: `canSeeHref` fails **open** on an unclaimed href (`use-can.ts:142-147`,
  deliberate — failing closed would blank the sidebar for any route the registry has not
  been taught). Either give it a `navPath` or annotate the nav entry with a `module`.
- Every key in `SUBJECT_TO_MODULE` (`lib/rbac/types.ts`) needs a row here. One that is
  missing is a silent 403 the moment `DYNAMIC_ABAC_ENABLED` flips — the `ScalingAudit` bug
  (B1). `scripts/assert-subject-coverage.ts` is the CI guard.

---

## Verifying

```bash
cd apps/web-ui && bun run db:migrate:deploy      # apply locally
cd apps/web-ui && bunx tsx scripts/assert-subject-coverage.ts
cd apps/web-ui && bunx tsx scripts/backfill-rbac.ts --dry-run   # role rules still round-trip
```

`assert-subject-coverage.ts` asserts every `SUBJECT_TO_MODULE` key exists and links to the
module it claims, every subject links to exactly one *enabled* module, and no two subjects
share a `navPath`. Run it after any registry migration.

## What `backfill-rbac.ts` still does

Role **grants**, not registry rows: it reads each `CustomRole`'s legacy `permissions` blob
into `rbac_role_rules`, pins `level`, and round-trip-asserts that the rules reproduce the
legacy matrix exactly. It deliberately fails closed on a module or action key it cannot
resolve — that abort means a registry migration is missing, and it is the signal you want.
