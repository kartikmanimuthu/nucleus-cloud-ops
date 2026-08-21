# Backfill Permissions & Modules — Design

**Date:** 2026-08-07
**Status:** Approved, pending implementation plan

## Summary

The Permissions and Modules admin UI screens were removed from the IAM nav
section (`feat(nav): remove Permissions and Modules screens from the IAM
section`, 157ae2e). The business still needs specific permission (`rbac_actions`)
and module (`rbac_modules`) rows to exist in the database. With no UI left to
create them, two one-shot TypeScript backfill scripts take over that job —
the same role `backfill-rbac.ts` already plays for role rules, and the same
role the `20260806120000_iam_module` migration played by hand for the IAM
module itself.

## Goals

- `apps/web-ui/scripts/backfill-permissions.ts` — ingests a hardcoded list of
  new `rbac_actions` rows into the database.
- `apps/web-ui/scripts/backfill-modules.ts` — ingests a hardcoded list of new
  `rbac_modules` rows, plus the `rbac_module_actions` grid entries and
  `rbac_subject_modules` links each module needs.
- Both scripts are safe to re-run: anything already present (matched by
  `key`) is left alone, nothing is duplicated.
- Both scripts create only **global, system** rows (`tenantId: null`,
  `isSystem: true`) — the same shape as the 7 modules and the actions already
  seeded by migration.
- Both scripts fail closed: a seed module referencing an action or subject
  that doesn't exist in the registry aborts the whole run before writing
  anything, rather than silently skipping or guessing.

## Non-goals

- No role grants. Neither script touches `rbac_role_rules`. This matches how
  the removed UI worked — `createModule`/`createAction` never auto-granted
  anyone either; an admin ticks boxes in the Roles screen afterward.
- No new subjects. `backfill-modules.ts` only *links* existing `rbac_subjects`
  rows to a new module via `rbac_subject_modules`; it does not create subject
  rows. If a seed module needs a subject that doesn't exist yet, that's a
  registry gap to close separately, not something this script guesses at.
- No changes to the (now-removed) Permissions/Modules UI, `registry-admin-writes.ts`,
  or any API route. This is a database-seeding concern only.
- No automated test suite. `backfill-rbac.ts` has none either — this is a
  one-shot ops script, verified by `--dry-run` plus a real run against the
  dev database.

## Design

### Shared shape

Both scripts follow `backfill-rbac.ts`'s established pattern:

- Import `PrismaClient` directly from `../../../node_modules/.prisma/client`
  (same relative path `backfill-rbac.ts` uses) — **not** through
  `registry-admin-writes.ts`, which explicitly throws on `tenantId === null`
  (`SystemRowError('Global registry authoring is not available here.')`).
  That API is for tenant-authored rows; these are global system rows, written
  the same way the migration seed and `backfill-rbac.ts` already write them.
- `const DRY_RUN = process.argv.includes('--dry-run');` — inspect and log,
  write nothing.
- All writes for one script's run happen inside a single `prisma.$transaction`
  — a failure partway through leaves nothing partially written.
- `createdBy: 'backfill-permissions'` / `'backfill-modules'` on inserted rows,
  matching `backfill-rbac.ts`'s `createdBy: 'backfill-rbac'`.
- Exit code 1 on any failure/abort, 0 on success.
- Final console summary: counts inserted vs. already-present (or, on
  `--dry-run`, counts that *would* be inserted).

### `backfill-permissions.ts`

```ts
interface SeedAction {
    key: string;
    label: string;
    description?: string;
    aliasOfKey?: string;
    isDangerous?: boolean;
    sortOrder?: number;
}

const SEED_ACTIONS: SeedAction[] = [
    // filled in with the actual business data before this runs
];
```

Fields mirror `rbac_actions` columns / `ActionInput` in
`registry-admin-writes.ts` — the same fields the removed "New permission"
dialog collected.

Flow:

1. Load existing global actions (`tenantId: null`) into a `Set<key>`.
2. For each `SEED_ACTIONS` entry whose `key` isn't already present, insert.
3. If `aliasOfKey` is set, it must resolve to an existing action key (either
   already in the DB or earlier in the same seed list) — abort listing any
   that don't, same fail-closed rule as unknown module/subject references
   below.

### `backfill-modules.ts`

```ts
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
    // filled in with the actual business data before this runs
];
```

Fields mirror `rbac_modules` columns / `ModuleInput` in
`registry-admin-writes.ts`. `actionKeys`/`subjectKeys` name existing registry
rows this module should cover — the same two arrays `createModule()` takes.

Flow:

1. Load existing global modules, actions, and subjects (each `tenantId: null`)
   into key-indexed maps.
2. Load existing `rbac_subject_modules` links (global only) into a
   `subjectKey → moduleKey` map — this is what makes the next check possible.
3. For each `SEED_MODULES` entry:
   - Resolve every `actionKey` against the actions map. Any that don't
     resolve: **abort the whole run**, listing every unknown key across every
     seed module (not just the first one hit) — a module that references a
     nonexistent action is a data bug, not something to skip past.
   - Resolve every `subjectKey` against the subjects map the same way, abort
     on any unknown key.
   - For every `subjectKey` already linked to a **different** module (per the
     map from step 2, or a different seed module earlier in this same list):
     **abort**, naming the subject and both modules. `rbac_subject_modules`
     carries a global unique index on `subjectId` alone — a subject can only
     belong to one global module at a time. Repointing an existing link (what
     the IAM migration did for `User`/`Role`) is a deliberate, one-off
     decision, not something this script does silently by default.
4. Only after every seed module in the list passes validation does the
   transaction proceed to write: insert the module row (skip if `key` already
   exists), insert its `rbac_module_actions` grid rows, insert its
   `rbac_subject_modules` link rows.

## Testing

- No new automated tests — matches `backfill-rbac.ts` (a one-shot ops script
  with zero test coverage today).
- Verification: run with `--dry-run` first, review the summary output, then
  run for real against the dev database (the one this session has already
  been using), and re-run once more to confirm the second run reports
  everything already present and makes zero writes.

## Files touched

**Created:**
- `apps/web-ui/scripts/backfill-permissions.ts`
- `apps/web-ui/scripts/backfill-modules.ts`

**Modified:** none.

## Open item

`SEED_ACTIONS` and `SEED_MODULES` ship empty in the implementation — the
actual permission/module data is supplied separately before either script is
run for real. This is expected content to fill in, not an unresolved design
question: the shape, validation rules, and write path above are fully
specified regardless of what the lists eventually contain.
