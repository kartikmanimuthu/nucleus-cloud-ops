# Backfill Permissions & Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two one-shot TypeScript scripts, `backfill-permissions.ts` and `backfill-modules.ts`, that seed new global `rbac_actions`/`rbac_modules` registry rows now that the Permissions/Modules admin UI screens have been removed.

**Architecture:** Two standalone scripts under `apps/web-ui/scripts/`, each following `backfill-rbac.ts`'s existing pattern exactly: direct `PrismaClient` import, `--dry-run` flag, a single `$transaction` for all writes, idempotent by `key`. Neither goes through `registry-admin-writes.ts` (that API refuses `tenantId: null` writes by design — it's for tenant-authored rows, not system seeding).

**Tech Stack:** TypeScript, `tsx` (already used to run `backfill-rbac.ts`), Prisma 5 (`../../../node_modules/.prisma/client`, same relative import every existing script under `apps/web-ui/scripts/` uses).

## Global Constraints

- Every inserted row is global and system: `tenantId: null`, `isSystem: true` — same shape as the 7 existing modules and the actions seeded by migration.
- Neither script touches `rbac_role_rules`. No role grants — matches how `createModule`/`createAction` never auto-granted anyone either.
- `backfill-modules.ts` creates no new subjects. `subjectKeys` must already exist in `rbac_subjects`; the script only links existing ones via `rbac_subject_modules`.
- Fail closed, validate before writing: an unknown `actionKey`/`subjectKey`/`aliasOfKey` reference, or a subject already linked to a different module, aborts the whole run with `process.exitCode = 1` before any write happens — never a silent skip.
- All writes for one script's run happen inside a single `prisma.$transaction`.
- `--dry-run` (`process.argv.includes('--dry-run')`) logs intent and writes nothing.
- No automated test suite — matches `backfill-rbac.ts`, which has none. Verification is `--dry-run`, then a real run against the dev database, then a second real run to confirm it reports everything already present and writes nothing.
- Indentation: 4 spaces, matching `apps/web-ui/scripts/backfill-rbac.ts`.

---

### Task 1: `backfill-permissions.ts`

**Files:**
- Create: `apps/web-ui/scripts/backfill-permissions.ts`

**Interfaces:**
- Produces: `interface SeedAction { key: string; label: string; description?: string; aliasOfKey?: string; isDangerous?: boolean; sortOrder?: number; }` and the `SEED_ACTIONS: SeedAction[]` array later business data goes into. Nothing else depends on this task.

- [ ] **Step 1: Create the script**

Create `apps/web-ui/scripts/backfill-permissions.ts`:

```ts
/**
 * backfill-permissions.ts — one-shot script to seed new global rbac_actions
 * ("permissions") rows now that the Permissions admin screen has been
 * removed. Fill in SEED_ACTIONS below with the real data before running for
 * real.
 *
 *   cd apps/web-ui && tsx scripts/backfill-permissions.ts --dry-run   # inspect, write nothing
 *   cd apps/web-ui && tsx scripts/backfill-permissions.ts             # apply
 */

// Same import style as backfill-rbac.ts: reach the generated client directly
// rather than through lib/db/pg-config, which is written for the Next
// runtime and its `@/` alias.
import { PrismaClient } from '../../../node_modules/.prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

interface SeedAction {
    key: string;
    label: string;
    description?: string;
    aliasOfKey?: string;
    isDangerous?: boolean;
    sortOrder?: number;
}

const SEED_ACTIONS: SeedAction[] = [
    // filled in with the real business data before this runs for real
];

async function main(): Promise<void> {
    console.log(`backfill-permissions — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLYING'}`);

    const existing = await prisma.rbacAction.findMany({
        where: { tenantId: null },
        select: { key: true },
    });
    const existingKeys = new Set(existing.map((a) => a.key));
    const seedKeys = new Set(SEED_ACTIONS.map((a) => a.key));

    // aliasOfKey must resolve to a key that already exists in the DB or
    // appears elsewhere in this same seed list — an alias to nothing is a
    // dangling reference the CASL alias resolver can't follow.
    const unknownAliases: string[] = [];
    for (const seed of SEED_ACTIONS) {
        if (seed.aliasOfKey && !existingKeys.has(seed.aliasOfKey) && !seedKeys.has(seed.aliasOfKey)) {
            unknownAliases.push(`${seed.key} -> aliasOfKey '${seed.aliasOfKey}'`);
        }
    }
    if (unknownAliases.length > 0) {
        console.error('backfill-permissions — ABORTED: unknown aliasOfKey reference(s):');
        for (const line of unknownAliases) console.error(`  ${line}`);
        process.exitCode = 1;
        return;
    }

    const toInsert = SEED_ACTIONS.filter((a) => !existingKeys.has(a.key));
    const alreadyPresent = SEED_ACTIONS.length - toInsert.length;

    if (!DRY_RUN) {
        await prisma.$transaction(async (tx) => {
            for (const seed of toInsert) {
                await tx.rbacAction.create({
                    data: {
                        tenantId: null,
                        key: seed.key,
                        label: seed.label,
                        description: seed.description ?? null,
                        aliasOfKey: seed.aliasOfKey ?? null,
                        isDangerous: seed.isDangerous ?? false,
                        isSystem: true,
                        sortOrder: seed.sortOrder ?? 100,
                        createdBy: 'backfill-permissions',
                    },
                });
            }
        });
    }

    console.log(
        `backfill-permissions — ${toInsert.length} ${DRY_RUN ? 'would be inserted' : 'inserted'}, ` +
            `${alreadyPresent} already present`
    );
    for (const seed of toInsert) {
        console.log(`  ${DRY_RUN ? '[dry-run] would insert' : 'inserted'}: ${seed.key}`);
    }
}

main()
    .catch((error: unknown) => {
        console.error('backfill-permissions — FAILED:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run it with `--dry-run` against the dev database**

Run: `cd apps/web-ui && npx tsx scripts/backfill-permissions.ts --dry-run`
Expected: `backfill-permissions — DRY RUN (no writes)` then `backfill-permissions — 0 would be inserted, 0 already present` (since `SEED_ACTIONS` is empty), exit code 0, no errors. This confirms the Prisma connection, the query, and the empty-list path all work before any real data is added.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/scripts/backfill-permissions.ts
git commit -m "$(cat <<'EOF'
feat(rbac): add backfill-permissions.ts

The Permissions admin screen was removed from the IAM nav section; new
rbac_actions rows the business needs now go in via this one-shot script
instead. Follows backfill-rbac.ts's existing pattern: direct PrismaClient,
--dry-run, a single transaction, idempotent by key. SEED_ACTIONS ships
empty — filled in with real data separately before a real run.
EOF
)"
```

---

### Task 2: `backfill-modules.ts`

**Files:**
- Create: `apps/web-ui/scripts/backfill-modules.ts`

**Interfaces:**
- Consumes: nothing from Task 1 — the two scripts are independent.
- Produces: `interface SeedModule { key: string; label: string; description?: string; icon?: string; navPath?: string; sortOrder?: number; enabled?: boolean; actionKeys: string[]; subjectKeys: string[]; }` and the `SEED_MODULES: SeedModule[]` array later business data goes into.

- [ ] **Step 1: Create the script**

Create `apps/web-ui/scripts/backfill-modules.ts`:

```ts
/**
 * backfill-modules.ts — one-shot script to seed new global rbac_modules rows
 * (plus their action grid and subject links) now that the Modules admin
 * screen has been removed. Fill in SEED_MODULES below with the real data
 * before running for real.
 *
 * Does NOT create subjects — every subjectKey must already exist in
 * rbac_subjects; this script only links existing subjects to a new module.
 *
 *   cd apps/web-ui && tsx scripts/backfill-modules.ts --dry-run   # inspect, write nothing
 *   cd apps/web-ui && tsx scripts/backfill-modules.ts             # apply
 */

import { PrismaClient } from '../../../node_modules/.prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

interface SeedModule {
    key: string;
    label: string;
    description?: string;
    icon?: string;
    navPath?: string;
    sortOrder?: number;
    enabled?: boolean;
    actionKeys: string[];
    subjectKeys: string[];
}

const SEED_MODULES: SeedModule[] = [
    // filled in with the real business data before this runs for real
];

async function main(): Promise<void> {
    console.log(`backfill-modules — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLYING'}`);

    const [modules, actions, subjects, subjectModules] = await Promise.all([
        prisma.rbacModule.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
        prisma.rbacAction.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
        prisma.rbacSubject.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
        prisma.rbacSubjectModule.findMany({
            where: { tenantId: null },
            select: { subjectId: true, moduleId: true },
        }),
    ]);

    const moduleIdByKey = new Map(modules.map((m) => [m.key, m.id]));
    const actionIdByKey = new Map(actions.map((a) => [a.key, a.id]));
    const subjectIdByKey = new Map(subjects.map((s) => [s.key, s.id]));
    const moduleKeyById = new Map(modules.map((m) => [m.id, m.key]));
    const subjectKeyById = new Map(subjects.map((s) => [s.id, s.key]));

    // subjectKey -> the module key it's already linked to, from existing DB rows.
    const linkedModuleKeyBySubjectKey = new Map<string, string>();
    for (const link of subjectModules) {
        const subjectKey = subjectKeyById.get(link.subjectId);
        const moduleKey = moduleKeyById.get(link.moduleId);
        if (subjectKey && moduleKey) linkedModuleKeyBySubjectKey.set(subjectKey, moduleKey);
    }

    // ── Validate every seed module before writing anything ──────────────────
    const unknownActions: string[] = [];
    const unknownSubjects: string[] = [];
    const subjectConflicts = new Set<string>();

    for (const seed of SEED_MODULES) {
        for (const actionKey of seed.actionKeys) {
            if (!actionIdByKey.has(actionKey)) {
                unknownActions.push(`${seed.key} -> actionKey '${actionKey}'`);
            }
        }
        for (const subjectKey of seed.subjectKeys) {
            if (!subjectIdByKey.has(subjectKey)) {
                unknownSubjects.push(`${seed.key} -> subjectKey '${subjectKey}'`);
                continue;
            }
            const linkedTo = linkedModuleKeyBySubjectKey.get(subjectKey);
            if (linkedTo && linkedTo !== seed.key) {
                subjectConflicts.add(
                    `'${subjectKey}' is already linked to module '${linkedTo}', cannot also link it to '${seed.key}'`
                );
            }
        }
        // A subject claimed by two DIFFERENT seed modules in this same list —
        // rbac_subject_modules' global unique index on subjectId alone means
        // only one of them could ever win.
        for (const other of SEED_MODULES) {
            if (other.key === seed.key) continue;
            for (const subjectKey of seed.subjectKeys) {
                if (other.subjectKeys.includes(subjectKey)) {
                    subjectConflicts.add(`'${subjectKey}' is claimed by both seed modules '${seed.key}' and '${other.key}'`);
                }
            }
        }
    }

    if (unknownActions.length > 0 || unknownSubjects.length > 0 || subjectConflicts.size > 0) {
        console.error('backfill-modules — ABORTED:');
        for (const line of unknownActions) console.error(`  unknown action: ${line}`);
        for (const line of unknownSubjects) console.error(`  unknown subject: ${line}`);
        for (const line of subjectConflicts) console.error(`  subject conflict: ${line}`);
        process.exitCode = 1;
        return;
    }

    const toInsert = SEED_MODULES.filter((m) => !moduleIdByKey.has(m.key));
    const alreadyPresent = SEED_MODULES.length - toInsert.length;

    if (!DRY_RUN) {
        await prisma.$transaction(async (tx) => {
            for (const seed of toInsert) {
                const created = await tx.rbacModule.create({
                    data: {
                        tenantId: null,
                        key: seed.key,
                        label: seed.label,
                        description: seed.description ?? null,
                        icon: seed.icon ?? null,
                        navPath: seed.navPath ?? null,
                        sortOrder: seed.sortOrder ?? 100,
                        enabled: seed.enabled ?? true,
                        isSystem: true,
                        createdBy: 'backfill-modules',
                    },
                    select: { id: true },
                });

                for (const actionKey of seed.actionKeys) {
                    const actionId = actionIdByKey.get(actionKey)!;
                    await tx.rbacModuleAction.create({
                        data: { tenantId: null, moduleId: created.id, actionId, grantable: true },
                    });
                }

                for (const subjectKey of seed.subjectKeys) {
                    const subjectId = subjectIdByKey.get(subjectKey)!;
                    await tx.rbacSubjectModule.create({
                        data: { tenantId: null, subjectId, moduleId: created.id },
                    });
                }
            }
        });
    }

    console.log(
        `backfill-modules — ${toInsert.length} module(s) ${DRY_RUN ? 'would be inserted' : 'inserted'}, ` +
            `${alreadyPresent} already present`
    );
    for (const seed of toInsert) {
        console.log(
            `  ${DRY_RUN ? '[dry-run] would insert' : 'inserted'}: ${seed.key} ` +
                `(${seed.actionKeys.length} action link(s), ${seed.subjectKeys.length} subject link(s))`
        );
    }
}

main()
    .catch((error: unknown) => {
        console.error('backfill-modules — FAILED:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run it with `--dry-run` against the dev database**

Run: `cd apps/web-ui && npx tsx scripts/backfill-modules.ts --dry-run`
Expected: `backfill-modules — DRY RUN (no writes)` then `backfill-modules — 0 module(s) would be inserted, 0 already present` (since `SEED_MODULES` is empty), exit code 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/scripts/backfill-modules.ts
git commit -m "$(cat <<'EOF'
feat(rbac): add backfill-modules.ts

The Modules admin screen was removed from the IAM nav section; new
rbac_modules rows the business needs (plus their action grid and subject
links) now go in via this one-shot script instead. Follows
backfill-rbac.ts's existing pattern. Validates every actionKey/subjectKey
reference and checks for subjects already linked to a different module
before writing anything — rbac_subject_modules has a global unique index on
subjectId alone, so a silent double-link would violate it or silently move
someone else's subject. SEED_MODULES ships empty — filled in with real data
separately before a real run.
EOF
)"
```

---

## Self-Review

**Spec coverage:** Both scripts from the design (`backfill-permissions.ts`, `backfill-modules.ts`) have a task each. Global system rows, no role grants, no new subjects, fail-closed validation, single transaction, `--dry-run`, no automated tests — all present in both tasks and the Global Constraints. The design's subject-conflict rule (global unique index on `subjectId`) is implemented as both an existing-DB-link check and a same-seed-list conflict check.

**Placeholder scan:** No TBDs. `SEED_ACTIONS`/`SEED_MODULES` ship empty by design (per the spec's Open Item — expected content to fill in later, not a plan gap); every other line is real, runnable code.

**Type consistency:** `SeedAction`/`SeedModule` field names match the design doc's interfaces exactly. Prisma field names (`aliasOfKey`, `isDangerous`, `navPath`, `sortOrder`, `enabled`, `grantable`) match `libs/prisma/schema.prisma`'s `RbacAction`/`RbacModule`/`RbacModuleAction`/`RbacSubjectModule` models verified directly against the schema file.
