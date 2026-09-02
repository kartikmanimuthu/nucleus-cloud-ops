# Two RBAC/ABAC Implementations — Comparison

**Date:** 2026-08-01
**Purpose:** Decide whether to continue `casl-imp`, adopt the existing `feature/casl-abac`
work, or merge them. Written before Task 13 rewires `authorize()`, which is the last point at
which this plan is purely additive.

---

## 1. What exists

### A. `feature/casl-abac` — the other checkout

**Location:** `C:\Dipanshu\smc-stx-nucleus-cloud-ops`, branch `feature/casl-abac`.
**State:** substantial **uncommitted** working-tree changes. 83 files under `app/api/` modified,
plus a 24-file / **4,638-line** `apps/web-ui/lib/rbac/` with 9 test files.
**Deployed to:** the shared dev database (`postgresql://…/postgres`), where its 3 migrations
(`casl_local_host`, `dynamic_abac`, `agent_ops_creator_grant`) are applied and its tables are
**populated with real data**.

**12 Prisma models:**

| Model | Purpose |
|---|---|
| `RbacModule`, `RbacAction`, `RbacSubject` | The taxonomy, all per-tenant (`tenantId` nullable = global default) |
| `RbacSubjectModule`, `RbacModuleAction` | Which subjects belong to which modules; which actions apply to which modules |
| `RbacRoleRule` | The grants: `(role, action, module?, subject?)` + `conditions Json?` + `inverted` + `reason` |
| `RbacSubjectAttribute` | **Resource-side ABAC.** Which paths a condition may reference on a subject (`accountId`, `tags.Environment`), the legal operators per path, and enum values |
| `RbacUserAttribute` | **Principal-side ABAC.** Admin-assigned per-user values (`allowedAccountIds`, `costCenter`) |
| `RbacPrincipalAttribute` | Allowlist gate for `$var` resolution — a path absent here is rejected at write time and dropped at compile time |
| `RbacRoutePermission` | Route-level override and **per-tenant emergency kill-switch**, no deploy |
| `RbacRuleChangeLog` | Audit trail of rule edits |
| `RbacGlobalVersion` | Cache-invalidation counter |

**Live data:** 24 subjects, 10 actions, 6 modules, **72 role rules**, 21 module-action links,
24 subject-module links, 14 subject attributes, 5 principal attributes.

**Supporting code** (`apps/web-ui/lib/rbac/`): `ability-cache`, `conditions`, `denials`,
`lockout`, `parity.test`, `permissions`, `prisma-filter`, `registry`, `registry-service`,
`registry-isolation.test`, `route-authz`, `row-filter`, `session-ability`, `rbac-allowlist`.

### B. `casl-imp` — this plan

**Location:** `C:\Work\attempt2\master-v1`, branch `casl-imp`. 6 commits, all reviewed.
**Deployed to:** the isolated `nucleus_casl` database only.

| Delivered | |
|---|---|
| `libs/casl` | Framework-agnostic library, 51 tests, no React / no `apps/web-ui` / no concrete `PrismaClient` |
| Manifests | 15 subjects declared in code; `Subject`/`Action` **derived as literal union types** |
| Registry | 3 tables (`permission_subjects`, `permission_actions`, `permission_subject_actions`) + boot sync with retirement |
| Drift test | Scans 104 `authorize()` call sites; fails the build on an invalid `(action, subject)` pair |
| Actors | `UserActor` / `SystemActor` / `ChannelActor` union, transport-independent |

**Not yet built:** presentation layer (Task 4), condition presets (6), compiler (7), migration
(8/11), `authorize()` rewrite (13), row filter (14), UI (15–17), denial audit (18).

---

## 2. Where they agree

Both independently arrived at the same core decisions:

- CASL as the engine, with `@casl/prisma` for row filtering.
- A **DB-recorded taxonomy** of subjects, actions, and modules rather than hardcoded enums.
- **`authorize(action, subjectType, subjectData?) => Promise<NextResponse | null>`** preserved
  verbatim, so the ~77 existing call sites keep working. Both treat that signature as fixed.
- Tenant isolation kept as a layer beneath the ability, not folded into it.
- Conditions expressed as data, with `inverted` rules (CASL `cannot`) resolved last.
- A registry read exception for global (`tenantId = null`) rows.

That convergence is a good sign both designs are sound. It also means they are **substitutes,
not complements** — running both would be two sources of truth for the same question.

---

## 3. Where they differ

| Dimension | `feature/casl-abac` | `casl-imp` |
|---|---|---|
| **Taxonomy source of truth** | DB rows, per-tenant | Code manifests, synced to DB |
| **Add a subject/action without deploy** | **Yes** — insert a row | No — edit a manifest, redeploy |
| **Compile-time safety** | None; subjects/actions are `string` | **`Subject`/`Action` are literal unions**; a typo fails the build |
| **Invalid (action, subject) pair caught** | At write time, by the validator | **At build time**, by the drift test |
| **Condition expressiveness** | **Arbitrary AST** over allowlisted paths, per-attribute operator whitelist, enum values | 5 fixed presets (`own-records`, `by-account`, `status-locked`, `never-delete`, `all-in-tenant`) |
| **Principal attributes (`$var`)** | **Yes** — `RbacUserAttribute` + allowlist gate | No |
| **Route-level permissions** | **Yes**, with per-tenant kill-switch | No |
| **Rule-change audit** | **Yes** (`RbacRuleChangeLog`) | Denials only (Task 18) |
| **Ability caching** | **Yes** (`ability-cache` + `RbacGlobalVersion`) | Deliberately none (D-7) |
| **Lockout protection** | **Yes** (`lockout.ts`) | No |
| **Denial reasons in 403** | **Yes** (`RbacRoleRule.reason`) | No |
| **Parity testing vs old system** | **Yes** (`parity.test.ts`) | Migration-preserves-access property test (planned, Task 8) |
| **Consumable by workers/gateway/agent** | Lives in `apps/web-ui`; not importable by `apps/workers` | **`libs/casl` is framework-agnostic** — Specs 3–5 depend on this |
| **Property-based tenant-isolation invariants** | Not observed | Planned (Tasks 7–8), 4 invariants |
| **Completion** | ~4,638 LOC, 83 routes wired, populated DB | ~1,000 LOC, 0 routes wired |

---

## 4. Assessment

**`feature/casl-abac` is substantially further along and more capable on the axis that
matters most — ABAC expressiveness.** It has a validated condition AST with two independent
safety rails (an attribute-path allowlist and a per-attribute operator whitelist, checked at
write time *and* compile time). That is the "full rule builder" option this plan explicitly
rejected as too risky — but they built the rails that make it safe, which changes the
calculus. It also has four capabilities this plan never scoped: principal attributes, route
permissions with a kill-switch, rule-change auditing, and lockout protection.

**`casl-imp` has two things the other lacks, and they are not small:**

1. **Compile-time type safety.** `authorize('delete', 'Shcedule')` fails the build here and
   compiles there. The drift test extends that to `(action, subject)` *pairs*, which types
   alone cannot check — it caught a real indirect-call blind spot during review.
2. **A framework-agnostic `libs/casl`.** The whole reason this library exists is that
   `apps/workers` cannot import from `apps/web-ui` under Nx boundaries. Specs 3–5 (worker
   identities, gateway channel identities, agent tool authorization) all depend on sharing the
   ability factory outside the web app. The other implementation lives inside `apps/web-ui`
   and would need extraction to serve those.

**Neither is a strict superset.** But the gap is asymmetric: porting compile-time types and a
drift test onto a working 4,638-line implementation is a bounded, additive task. Rebuilding
condition ASTs, principal attributes, route permissions, lockout, and 83 wired routes is not.

---

## 5. Options

### Option 1 — Adopt `feature/casl-abac`; port the two additive pieces (recommended)

Stop this plan. Land the other branch, then add on top of it:
- Derive literal-union types for subjects/actions from a code-side manifest that is *validated
  against* the DB registry rather than being its source of truth (keeps their dynamism, adds
  our safety).
- Port the drift test, extended to their route-authz call shapes.
- Extract their `lib/rbac` into `libs/casl` when Spec 3 (workers) needs it — not before.

**Cost:** discards 6 commits of scaffolding. `libs/casl`'s manifest and registry work is
largely superseded; the actor union and drift test survive.
**Gain:** keeps 4,638 lines and a populated database of real rules.

### Option 2 — Continue `casl-imp` to completion, then reconcile

Finish all 18 tasks in isolation, then decide. **Not recommended:** Task 13 rewires
`authorize()` and Tasks 15–17 build a competing roles UI, so the two diverge much further
before anyone chooses. The reconciliation only gets more expensive.

### Option 3 — Merge deliberately

Take their schema and condition engine as the base, this plan's `libs/casl` boundary and
derived types as the shape, and re-plan the combination. **Cost:** a new spec and plan;
probably a week of work before anything ships.

---

## 6. What I need from you

Three questions I cannot answer from the code:

1. **Is `feature/casl-abac` intended to land?** It is uncommitted WIP across 83 route files.
   If it is abandoned or exploratory, this comparison flips entirely.
2. **Was this plan commissioned knowing that branch existed?** If the intent was a
   from-scratch replacement, say so and Option 2 becomes defensible.
3. **Does anything depend on the 72 role rules already in the shared database?** If they are
   throwaway test data, migration cost drops sharply.

---

## 7. Status of work in flight

- 6 commits on `casl-imp`, all reviewed clean. Nothing touches the shared database.
- Task 3 had a fix round in flight (wrapping the registry link rebuild in a transaction) when
  this comparison was requested.
- The isolated `nucleus_casl` database is disposable; dropping it reverses all DB-side work.
