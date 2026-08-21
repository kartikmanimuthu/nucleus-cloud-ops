# Dynamic RBAC / ABAC — What Was Built, and How

**Date:** 2026-08-03
**Branch:** `integration/rbac-adopt` (pushed, 11 commits ahead of `master-v1`)
**Status:** Engine complete, cut over in configuration, not yet deployed.

---

## 1. The problem we started from

Authorization was a hand-rolled lookup table: `Record<Module, Action[]>` in
`apps/web-ui/lib/rbac/permissions.ts`, with six fixed modules (Accounts, Schedules, AIOps,
Inventory, Settings, Dashboard) and four CRUD actions. Every module, action, and role shape
was a TypeScript literal.

Three things it could not do:

1. **Say *which rows*.** It answered "may you read Schedules", never "which schedules". The
   coarseness had already forced a workaround: `SpotGuard` was filed under the `Schedules`
   module rather than `Inventory`, purely so that holders of `Inventory:update` would not
   silently gain the power to restart production ECS tasks.
2. **Change without a deploy.** Adding a module, regrouping one, or relabelling an action for
   a single customer meant editing code and shipping a release.
3. **Cover the surface.** An audit found 211 endpoints, of which 101 were guarded, 88 were
   session-only, and 7 were unguarded — **52% coverage**. UI gating was 0 of 59 mutating
   files and 0 of 28 nav destinations.

The ask was to make actions and subjects dynamic, driven from the database, so an admin could
extend them without a release.

---

## 2. How the work actually unfolded

This matters for reading the rest of the document, because the implementation that shipped is
**not** the one originally planned here.

### Phase 1 — Design and plan (superseded)

Wrote a spec and an 18-task implementation plan for a new library, `libs/casl`: code-declared
permission manifests, derived literal-union types, a synced registry, and five fixed condition
presets. Executed 6 tasks under a subagent-driven loop with per-task review.

Two defects in that plan were caught by its own review gates and are worth recording:

- `@casl/ability` 7.0.1 has no `PureAbility` — it is `Ability`. A dedicated API-reconciliation
  step existed precisely to catch this, and did.
- `Subject` and `Action` had silently degraded to `string`, because `mergeManifests` annotated
  its return as a non-generic type with an index signature. Every test passed while the type
  contract was broken, because every test asserted runtime values only. The fix required a
  generic signature **and** a permanent type-level guard, proven to fail when reverted.

### Phase 2 — Discovery

Partway through, the shared development database was found to already contain a *different*
dynamic RBAC implementation: 12 populated `rbac_*` tables, 72 role rules, applied by three
migrations absent from this branch. It came from a second checkout on branch
`feature/casl-abac`, where **170 files sat uncommitted**.

`prisma migrate diff` showed that reconciling our schema against that database would emit
`DROP` for all 12 tables. Work was halted before any migration ran.

### Phase 3 — Comparison and adoption

A written comparison concluded the existing implementation was substantially further along.
**Two claimed advantages for the new plan were investigated and retracted:**

- *"Only ours has a framework-agnostic library."* False — `libs/rbac/` already existed, with
  the condition schema, rule compiler, registry types, and a generated route manifest,
  importing nothing from `apps/web-ui`.
- *"Only ours catches invalid (action, subject) pairs."* False, and theirs is stronger. Its
  `parity.test.ts` harvests pairs from a **1,306-entry build-time route manifest** and asserts
  that legacy and CASL reach the same decision for every pair × every preset role.

The one real difference — narrow literal types — was a **deliberate rejection** on their side,
documented in `libs/rbac/types.ts`: *"Subjects and actions are database-driven, so they are
`string` at the type"* level. Compile-time unions only work when the taxonomy is fixed at
build time; enforcing them would have closed the very door the feature exists to open.

**Nothing from the superseded plan was ported.** Its branch was deleted; the comparison and
adoption records were preserved.

Adoption steps: committed the 170 uncommitted files after verifying no secrets and no
`node_modules` staged; brought the branch across via a local git remote; merged mainline (it
had forked **44 commits back**, missing `fix(rbac): preset roles were missing in every
deployed environment`), with only **5 overlapping files**; linked the new `@nucleus/rbac`
workspace package.

### Phase 4 — Completion

Four gaps identified in a status audit, then closed. Detailed in §5.

---

## 3. The approach — how "dynamic CASL" actually works

The design separates **what can be enforced** from **what is granted**, and layers
enforcement into four independent gates.

### 3.1 The taxonomy is data

Subjects, actions, and modules are rows, not enums:

| Table | Holds |
|---|---|
| `rbac_subjects` | 24 subjects, per-tenant (`tenantId` nullable = global default) |
| `rbac_actions` | 10 actions with `label`, `aliasOfKey`, `isDangerous`, `isSystem`, `sortOrder` |
| `rbac_modules` | 6 modules — presentation grouping only |
| `rbac_subject_modules`, `rbac_module_actions` | Which subject sits in which module; which actions apply where |

Because `rbac_actions` is keyed `(tenantId, key)`, a tenant can carry its own action that
another tenant never sees. `aliasOfKey` lets a verb resolve onto a terminal action —
`execute → update`, `export → read` — so call sites keep their natural vocabulary.

The cost of this choice, accepted deliberately: **subjects and actions are `string` at the
type level.** A misspelled subject compiles fine and fails closed at runtime. The mitigations
are the route manifest and the parity harness (§3.4), not the type system.

### 3.2 Grants are rules with conditions

`rbac_role_rules` carries `(roleId, actionId, moduleId?, subjectId?)` plus:

- `conditions Json?` — a **validated condition AST**; null means unconditional
- `inverted Boolean` — a CASL `cannot`, always compiled last so denials win
- `reason String?` — surfaced in the 403 body and as a UI tooltip

This is the piece that makes it ABAC rather than RBAC. The safety comes from two independent
rails, checked at write time *and* again at compile time:

- **`rbac_subject_attributes`** — which paths a condition may reference on a subject
  (`accountId`, `tags.Environment`), the legal operators per path, and enum values.
- **`rbac_principal_attributes`** — the allowlist gate for `$var` resolution, backed by
  `rbac_user_attributes` for admin-assigned per-user values. A `$var` path absent from the
  allowlist is rejected on write and dropped at compile.

Free-form rule builders are normally a bad trade — arbitrary DB content reaching a query
matcher. These two rails are what make it defensible.

### 3.3 Four enforcement gates

| Gate | Where | Question |
|---|---|---|
| **1 — Route guard** | `middleware.ts` | Is this endpoint permitted at all? Default-deny from the generated manifest, with `rbac_route_permissions` as a per-tenant override and emergency kill-switch |
| **2 — `authorize()`** | 77 route files | May this actor perform this action on this subject type? → 403 |
| **3 — Row filter** | Prisma `where` | *Which* rows? Compiled ability → `where` fragment, intersected via `andWhere()` |
| **4 — Stored grants** | workers, agent | Re-check at execution time: a scheduled task whose creator lost the permission is taken out of the firing set; agent tool calls pass a capability gate |

Gate 4 is the subtle one. A scheduled task is a **stored grant** — authorized once at
creation, then fired unattended indefinitely. Revocation is treated as terminal
(`taskStatus = 'permission_revoked'`, audit row written, no throw), because throwing would
send it back through pg-boss's retry ladder to be denied again. A plain 403 with no revocation
code stays retryable, since that is almost always a misconfigured internal key.

### 3.4 Safety mechanisms

- **Generated route manifest** — `libs/rbac/generated/route-manifest.json`, a build-time
  inventory of every endpoint and its `(action, subject)` pair. Drives Gate 1 and feeds the
  parity harness.
- **Parity harness** — proves legacy and CASL agree for every manifest pair × every role. This
  is what replaces compile-time type safety.
- **Registry isolation guard** — a test that parses every source file under `apps/web-ui` and
  fails if any file outside two documented exceptions combines `getPrismaClient()` with an
  `rbac_*` model. Registry reads must bypass tenant scoping (global rows are
  `tenantId IS NULL`); this keeps that bypass in one reviewed place.
- **Lockout protection** — the last rule granting admin cannot be deleted.
- **Ability cache** with `rbac_global_version` for invalidation; **`rbac_rule_change_log`** for
  audit.

### 3.5 Rollout posture

Two flags, both defaulting safe in code:

```
DYNAMIC_ABAC_ENABLED   false → legacy decides, CASL shadow-compared,
                               disagreements logged as rbac.parity.mismatch
RBAC_ROUTE_GUARD_MODE  off | shadow | enforce
```

Shadow mode runs both engines and reports disagreement without acting on it. This is the
single most important design decision in the rollout, and it is what made adopting this
implementation over the planned one the right call — the superseded plan had explicitly chosen
*no* feature flag.

---

## 4. What was implemented, by phase

| Phase | Delivered |
|---|---|
| 1 | `libs/casl` foundation (superseded, branch deleted). Value retained: two plan defects documented; a comparison methodology |
| 2 | Discovery of the existing implementation; halted before any destructive migration |
| 3 | Preserved 170 uncommitted files; merged 44 commits of mainline; linked `@nucleus/rbac`; comparison + adoption records with two retracted claims |
| 4 | Items 1–4 below |

### Phase 4 detail

**Parity against real roles** (`80353d5`) — Surveyed the live database read-only: 5 roles
(4 presets + one custom), 72 rules, and the finding that shaped everything: **zero rules carry
conditions**, zero user attributes assigned. With no conditional rules, legacy-vs-CASL is an
exact set comparison with no narrow/widen ambiguity. All 5 roles agree exactly.

A trap surfaced while writing it: preset rows store `permissions = '{}'` — presets resolve from
`ROLE_PERMISSIONS` in code, and only custom roles read the DB JSON. The first version compared
presets against their empty JSON and reported every preset as a CASL over-grant. The test was
wrong, not the engine. It now pins the conditional-rule count at zero as a tripwire, so the
first conditional rule fails the build and forces the harness to be extended.

**Row filtering** (`7f9be03`) — Gate 3 extended from 5 to **all 11 list endpoints**. The
registry's spellings differ from the obvious ones: `Agent` not `AgentOpsRun`, `Memory` not
`AgentMemory`, `Resource` not `InventoryResource`. Every string was verified against
`rbac_subjects`, because an unregistered subject compiles to nothing and fails closed — a
silent revocation.

**UI gating** (`724b1c6`) — 5 → **16 files**. Gated the controls that *trigger* mutations
rather than the dialogs they open; skipped self-service forms and dialogs already gated
upstream. 8 gated, 13 reasoned skips. Default is disable-with-tooltip, not hide, so a user with
row-level access sees why a control is unavailable rather than watching it vanish.

**Timeout fix** (`66468bd`) — The registry-isolation guard was exceeding the 5s default while
taking 18s under contention: a test that passes alone and fails in CI. It is the only thing
stopping unscoped `rbac_*` reads from spreading, so it got an explicit timeout rather than
being deleted for flaking.

**Cutover** (`d1f2f19`) — `DYNAMIC_ABAC_ENABLED=true`, `RBAC_ROUTE_GUARD_MODE=enforce` in
configuration. Verified by running the identical suite with the flags **on and off**:
identical results, 4 failed / 381 passed, the same four pre-existing tests — proving no
flag-induced regression.

The **code** defaults were deliberately left at `false`/`shadow`. Both files state the intent
— *"flip only once the mismatch counter has stayed at zero across a soak"*, *"turning Layer 1
on must never be the thing that breaks prod"*. The cutover belongs in configuration; the
fallback belongs safe, so a misconfigured environment degrades to the legacy matrix rather
than silently enforcing an unverified engine.

---

## 5. Where it stands

| | |
|---|---|
| Endpoint coverage | **216 of 216** — 200 with an (action, subject) pair, 16 explicitly allowlisted (was 52%) |
| Row filtering | **11 of 11** list endpoints |
| UI gating | 16 files |
| Tests | **211 passing** — 136 web-ui `lib/rbac`, 44 `libs/rbac`, 23 workers, 8 gating |
| Branch | `integration/rbac-adopt`, pushed |

### Not done, deliberately

1. **Not deployed.** The flags are not wired into `infra/compute/index.ts`, so nothing changes
   in a deployed environment until that happens. Explicitly out of scope.
2. **The designed cutover gate was not met.** The code asks for zero `rbac.parity.mismatch`
   across a real shadow soak. Static parity across every role in the database was substituted
   — strong evidence about *the data*, but not evidence *from running traffic*. No soak was
   run, and running one now is harder because the flags are on.
3. **Four pre-existing test failures remain red** — audit-log `expiresAt`, inventory ILIKE, and
   two scheduled-task repository assertions. Outside this work, but one is a tenant-isolation
   assertion and should not sit red indefinitely.
4. **jsdom is very slow in this environment** — ~33s of environment setup, which puts any
   component test at risk of flaking against the 5s default. Not masked with a global timeout
   bump, because one sample does not justify a broad config change and it would hide real
   hangs.
5. **Legacy matrix still present.** Removing it and `parity.test.ts` together is the one
   irreversible step, and is gated on a clean production soak.

---

## 6. If you pick this up next

In order:

1. Wire the two flags into `infra/compute/index.ts` so a deploy carries them.
2. Consider reverting to `shadow` and running a real soak before enforcing in production —
   that is what the code's own gate asks for.
3. Fix the four pre-existing failures, starting with the tenant-isolation one.
4. Only then consider removing the legacy matrix.

**Reference documents:** `2026-08-01-rbac-implementation-comparison.md` (with corrections
recorded in the adoption record), `2026-08-01-rbac-adoption-record.md`.
