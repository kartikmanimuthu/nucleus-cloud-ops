# Submodule-level RBAC: authoring, nav visibility, page admission

**Date:** 2026-08-12
**Branch:** `integration/dynamic-rbac-abac`
**Status:** Design approved, ready for planning

---

## 1. Problem

The role editor (`components/settings/role-dialog.tsx`) offers a matrix of 7 module rows
× 4 verbs. Two things follow from that, both of which we want to change:

1. **Permissions cannot be expressed below module granularity from the UI.** A role that
   should read Inventory but not Right Sizing, or use AI Ops but not manage LLM Providers,
   is not authorable.
2. **The sidebar can only be gated per module.** `nav-config.ts` annotates all nine
   Agentic Ops destinations with `module: "AIOps"`, so Providers cannot be hidden without
   hiding AI Ops, Agent Ops, Memory, Skills, Knowledge Base and MCP Servers along with it.

Additionally, hiding a nav entry is UX only — the page remains reachable by URL, because
the middleware page guard does not exist.

## 2. What already exists

This matters because it determines the size of the work: **the enforcement engine already
supports everything asked for. Only the authoring and resolution layers are missing.**

| Level | Where | Status |
|---|---|---|
| Module | `rbac_modules`, `custom_roles.permissions` | Authored in UI, enforced |
| Subject ("submodule") | `rbac_subjects`, `rbac_subject_modules`, `libs/rbac/rule-compiler.ts` | **Fully enforced, zero UI** |
| Row / field (ABAC) | `rbac_role_rules.conditions`, `condition-schema.ts`, `prisma-filter.ts` | Enforced; no authoring UI |
| Route | `rbac_route_permissions`, `libs/rbac/generated/route-manifest.json`, `middleware.ts` | Enforced (Layer 1) |
| Page | `requireAuth` / `AuthorizePage` in 7 layouts | Sparse, ad hoc |
| Nav visibility | `nav-main.tsx` → `useNavGate()` | Enforced, module granularity only |

Specifically already implemented and tested:

- `rule-compiler.ts:399-406` — **precise beats broad**: a subject-level rule suppresses its
  module's rule for the same (terminal action, subject), regardless of row order.
- `rule-compiler.ts:461-464` — `cannot` rules are emitted last, so an inverted rule reliably
  beats an overlapping `can`.
- `rule-compiler.ts:305-346` — a rule targeting a disabled module contributes nothing.

The bottleneck is `role-rule-sync.ts`, which deliberately writes **only** module-level
positive grants, because `Record<Module, Action[]>` cannot express anything else.

## 3. Decisions

| # | Decision |
|---|---|
| D1 | A "submodule" is a **registry subject**, backfilled so every nav destination owns one. |
| D2 | The module rule stays a **real module-level grant**. Submodule cells are overrides (inherit / grant / deny). A subject added to a module later is automatically covered by every role holding that module. |
| D3 | Nav gating is **data-driven**: subjects gain `navPath`; resolution is longest-prefix across subjects ∪ modules. |
| D4 | The **middleware** page guard is extended to `/app/*`, using the same resolver as the sidebar. |
| D5 | `DYNAMIC_ABAC_ENABLED` flips to `true` in prod as part of this work. |
| D6 | Page guard **fails open on infrastructure error**, closed on denial (see §7). |
| D7 | No ABAC condition editor — explicit non-goal. |

---

## 4. Data model

### Migration A — subject columns

```prisma
model RbacSubject {
  // existing: id, tenantId, key, label, kind, isSystem
  navPath   String?                 // '/app/agent-ops/providers'
  sortOrder Int      @default(100)  // row order under its module
}
```

No `enabled` column. A subject is retired by unlinking it from its module, which the
compiler already treats as contributing nothing.

### Migration B — backfill

`navPath` for the existing subjects that own a page:

| Subject | Module | navPath |
|---|---|---|
| `Dashboard` | Dashboard | `/app/dashboard` |
| `AuditLog` | Accounts | `/app/audit` |
| `Account` | Accounts | `/app/accounts` |
| `Resource` | Inventory | `/app/inventory` |
| `RightSizing` | Inventory | `/app/right-sizing` |
| `Schedule` | Schedules | `/app/schedules` |
| `SpotGuard` | Schedules | `/app/cost-optimization/spot-guard` |
| `Agent` | AIOps | `/app/agent` |
| `Skill` | AIOps | `/app/skills` |
| `Memory` | AIOps | `/app/memory` |
| `KnowledgeBase` | AIOps | `/app/knowledge-base` |
| `Channel` | AIOps | `/app/channels` |
| `Certificate` | Settings | `/app/certificates` |
| `Tenant` | Settings | `/app/settings/organization` |
| `Settings` | Settings | `/app/settings` |
| `User` | IAM | `/app/iam/members` |
| `Role` | IAM | `/app/iam/roles` |
| `IAM` | IAM | `/app/iam` |

`Discovery`, `Billing` and the five `Agent*` capability subjects (`AgentShell`, `AgentFile`,
`AgentMcp`, `AgentWeb`, `AgentStorage`) own no page and keep `navPath` NULL — they are
grantable in the matrix but never resolve as a nav owner.

Plus new rows for destinations that have no subject at all:

| New subject | Module | navPath |
|---|---|---|
| `Provider` | AIOps | `/app/agent-ops/providers` |
| `AgentOps` | AIOps | `/app/agent-ops` |
| `ScheduledTask` | AIOps | `/app/agent-ops/scheduled-tasks` |
| `McpServer` | AIOps | `/app/agent-ops/mcp-settings` |
| `ScalingAudit` | Inventory | `/app/cloud-operations/scale-sentinel` |

Slack does not need a subject: the duplicate `/app/agent-ops/slack-settings` page is
deleted and the nav points at `/app/channels/slack-settings`, which the existing `Channel`
subject claims by prefix.

**Idempotency:** `ON CONFLICT DO NOTHING` on `(tenantId, key)` for subjects and
`(tenantId, subjectId)` for module links, matching existing migration style. `navPath` is
set `WHERE navPath IS NULL` so a tenant-authored value is never clobbered. Global rows
change, so `rbac_global_version` is bumped in a companion statement (precedent:
`20260811130000_bump_rbac_version_channel_subject`).

### Pre-existing bugs folded in

**B1 — `ScalingAudit` has no subject row.** `SUBJECT_TO_MODULE` maps it to `Inventory`
(`lib/rbac/types.ts:82`) and Scale Sentinel's routes call `authorize(…, 'ScalingAudit')`,
but no such key exists in `rbac_subjects`. The compiler emits one rule per *subject*, so
`read Inventory` never produces `read ScalingAudit`. Masked today because prod runs the
legacy matrix, which resolves through `SUBJECT_TO_MODULE` and allows it. **Flipping
`DYNAMIC_ABAC_ENABLED` would 403 Scale Sentinel for every non-SuperAdmin.** Migration B
fixes it.

**B2 — `requireAuth` redirects to a 404.** `AuthorizePage.tsx:32,53` redirect to
`/unauthorized`; the page lives at `/app/unauthorized`. Every page-level denial today
lands on a 404 instead of the denial screen.

**B3 — Spot Guard nav link is a 404.** `nav-config.ts:70` points at `/app/spot-guard`; the
route is `/app/cost-optimization/spot-guard`.

**B4 — duplicate Slack and Jira pages.** `app/app/agent-ops/slack-settings/page.tsx` and
`app/app/agent-ops/jira-settings/page.tsx` render the identical components as their
`/app/channels/*` twins. Deleted and replaced with `redirect()` stubs (precedent:
`app/app/settings/members/page.tsx`). `components/spot-guard/settings-form.tsx:172` is
updated to the surviving href.

`/app/agent-ops/mcp-settings` is **not** a duplicate — it passes
`apiPath="/api/agent-ops/mcp-settings"`, distinct from the Channels one. Both stay;
`McpServer` claims the former, `Channel`'s `/app/channels` prefix claims the latter.

### Not changing

`rbac_role_rules`, the compiler, `condition-schema.ts`, `prisma-filter.ts`. Subject-level
grants, inverted denies and precise-beats-broad precedence are already implemented.

---

## 5. Authoring

### Storage

Overrides go into `rbac_role_rules`, not a second blob. `custom_roles.permissions` keeps
its shape and its module-only content — it is still read by the legacy fallback path and
by the parity shadow comparison. A second blob would recreate exactly the desync that
`role-rule-sync.ts` was written to fix.

### Ownership boundary

New `syncRoleSubjectOverrides(tx, { roleId, tenantId, overrides, createdBy })`, beside the
existing `syncRoleRules`. It owns exactly the rows matching:

```sql
subjectId IS NOT NULL  AND  conditions IS NULL  AND  fields = '{}'
```

Rules carrying conditions or a field list belong to the ABAC layer and are left untouched —
the same discipline `syncRoleRules` applies today when it refuses to touch subject rules
at all.

This narrows but preserves the original safety property: *never delete a grant the editor
cannot display.* Because the dialog renders every subject of every module, every
editor-owned row is displayed, so a save can only revoke what the operator actually saw.

### API

```ts
PUT /api/settings/roles/:roleId
{
  name: string,
  permissions: Record<ModuleKey, ActionKey[]>,          // unchanged
  overrides:   Record<SubjectKey, {
    grant: ActionKey[],   // subjectId rule, inverted = false
    deny:  ActionKey[],   // subjectId rule, inverted = true
  }>
}
```

`GET` returns `overrides` derived from the same query, so the dialog round-trips its own
output.

Transaction order inside the existing handler: `syncRoleRules` → `syncRoleSubjectOverrides`
→ `assertNoLockout` → ledger append → `rbacVersion` bump.

### Lockout extension

`assertNoLockout` (`lockout.ts`) today counts only **module-level** `update Settings`
rules. `isAdmin()` evaluates `can('update', 'Settings')` against the `Settings` *subject*,
so a `cannot update Settings` override would kill admin access while lockout still saw a
qualifying rule — the escape hatch closes silently.

Extension: a role stops qualifying if it carries an unconditional inverted rule on the
`Settings` subject for `update`, and starts qualifying if it carries an unconditional
positive one. Same post-write, in-transaction placement.

### Matrix UI

Two-level table. The module row is today's checkbox, unchanged. A chevron expands its
subjects, ordered by `sortOrder` then `key`.

| Cell state | Renders as | Stored |
|---|---|---|
| **inherit** (default) | the module's value, muted + dashed | nothing |
| **override grant** | checked + override dot | `subjectId` rule, `inverted = false` |
| **override deny** | unchecked + override dot | `subjectId` rule, `inverted = true` |

**One click flips to the opposite of what is inherited; a second click returns to
inherit.** No three-way cycle. Plus a per-row *Reset to inherited* and a legend.

Non-grantable cells render disabled at both levels — `grantable` is a module↔action link,
so it applies uniformly across that module's subjects.

Implication rules, mirroring the module ones in `role-dialog.tsx:188-217`:

- granting a non-`read` verb also grants `read` on that subject, when `read` is not already
  effective there;
- **denying `read` denies every other verb on that subject** — you cannot act on what you
  cannot see.

Dangerous verbs (`isDangerous`) reuse the existing type-CONFIRM `AlertDialog`, for explicit
grants only. Denies never prompt.

The `carried` mechanism (`role-dialog.tsx:75-113`) gains a subject-level twin: an override
on a subject the registry no longer exposes round-trips verbatim rather than being dropped.

### File split

`role-dialog.tsx` is 392 lines and would roughly double. Split before growing it:

```
components/settings/role-dialog.tsx          # shell: name, save, validation
components/settings/permission-matrix/
    matrix.tsx                               # table, header, legend, filter
    module-row.tsx
    subject-row.tsx
    use-matrix-state.ts                      # all state transitions, no JSX
```

`use-matrix-state.ts` holds `toMatrixState` / `toPayload` / `applyToggle` / the implication
rules — the parts worth unit-testing without rendering a dialog.

---

## 6. Resolution

### One resolver, two callers

Path→owner logic lives once in `libs/rbac/` (framework-free, consumed by both the client
bundle and the server), so the sidebar and the middleware agree by construction:

```ts
// libs/rbac/nav-resolver.ts
export interface NavOwner { kind: 'subject' | 'module'; key: string; navPath: string }

export function resolveNavOwner(
  pathname: string,
  subjects: { key: string; navPath: string | null; moduleKey: string | null }[],
  modules:  { key: string; navPath: string | null }[],
): NavOwner | null
```

Longest `navPath` prefix wins across the union, using today's match test
(`pathname === navPath || pathname.startsWith(navPath + '/')`). **On an equal-length tie a
subject beats a module**, because a subject is the strictly more specific claim.

That tie-break is load-bearing: module `AIOps` and subject `Agent` both sit on `/app/agent`.
Without it the AI Ops page resolves to the module and the `Agent` subject can never gate it.

Read predicate by owner kind: `can('read', key)` for a subject; the existing
`canReadModule()` ("can read *any* subject of this module", `use-can.ts:111-119`) for a
module.

### Nav precedence

`useVisibleItems` currently short-circuits on a declared `module`, which would shadow every
subject navPath. New order:

1. subject navPath match → `can('read', subject.key)`
2. declared `module` annotation → `canReadModule(module)`
3. module navPath match → `canReadModule(owner.key)`
4. no match → **visible** (fail-open, unchanged)

Existing `module:` annotations survive as the fallback, so nothing regresses; they simply
stop outranking a more specific subject. `useNavGate` grows `canSeeSubject` and an
owner-aware `canSeeHref`. `useAccessibleModules` is unaffected.

`/api/me/ability` ships `navPath` and `sortOrder` on subjects — `ability-payload.ts` plus
the `AbilityMetaContext` type. The global version bump invalidates cached abilities.

### Middleware page guard

```ts
// after the NextAuth gate, beside enforceLayer1
if (pathname.startsWith('/api/'))  return enforceLayer1(req);
if (pathname.startsWith('/app/'))  return enforcePageRead(req);
```

The matcher already covers `/app/*` and the middleware already runs `runtime: "nodejs"`
with Prisma access for Layer 1, so this adds no new infrastructure — only the `/api/`
early-return has to go.

Exempt: `/app/unauthorized` (redirect loop) and `/app` itself. Denial redirects to
`/app/unauthorized`, the corrected path from B2.

**Mode:** `RBAC_PAGE_GUARD_MODE = off | shadow | enforce`, mirroring
`RBAC_ROUTE_GUARD_MODE`. Code default is `shadow` (repo convention, `middleware.ts:19`:
*"turning Layer 1 on must never be the thing that breaks prod"*), with `infra/compute`
setting `enforce` explicitly.

### nav-config.ts corrections

| Fix | Detail |
|---|---|
| B3 | `/app/spot-guard` → `/app/cost-optimization/spot-guard` |
| B4 | Slack href → `/app/channels/slack-settings`; delete the `agent-ops` duplicate |
| B4 | Same for `agent-ops/jira-settings` |
| B4 | `components/spot-guard/settings-form.tsx:172` |
| B2 | `AuthorizePage.tsx:32,53` → `/app/unauthorized` |

---

## 7. Error handling

**Deliberate divergence from Layer 1's fail-closed contract.** A *denial* fails closed. An
*infrastructure* failure — registry unreadable, compiler throws — fails **open**, logged at
error.

Layer 1 guards the data and must never serve a row it could not authorize. The page guard
guards the chrome over API routes that are already guarded twice. A compiler outage should
degrade to empty-looking pages, not lock every user out of the entire application. This is
the opposite of `enforceLayer1` and must be stated in the code, or someone will "fix" it.

| Situation | Behaviour |
|---|---|
| Override names a subject no longer in the registry | Compiler records it in `dropped` and logs; dialog carries it through verbatim |
| Subject's owning module is disabled | Compiler drops (existing, `rule-compiler.ts:339`) |
| Page matches no owner | Visible and reachable — fail-open, consistent between nav and guard |
| Registry unreadable inside middleware | Fail open, log at error |
| Save would lock the tenant out | Transaction rolls back, 409 with the lockout reason |
| Save would revoke something not rendered | Structurally impossible — `carried` plus full subject rendering |
| Two subjects claim one navPath | Deterministic (longest, then key sort); CI script rejects it outright |

---

## 8. Rollout

Five independently revertable steps. The binding constraint: **the subject backfill must be
live before the prod flag flips**, or Scale Sentinel 403s on day one.

| # | Contents | Behaviour change |
|---|---|---|
| 1 | Migrations A + B, global version bump, bug fixes B1–B4, duplicate-route deletion | None under shadow mode; under CASL, fixes `ScalingAudit` |
| 2 | `syncRoleSubjectOverrides`, roles API, matrix UI, lockout extension | Overrides authorable and enforced |
| 3 | `nav-resolver`, nav precedence, middleware page guard (`shadow`) | Sidebar gates per subject; guard logs only |
| 4 | `infra/compute`: `DYNAMIC_ABAC_ENABLED=true` | Prod switches to CASL |
| 5 | `infra/compute`: `RBAC_PAGE_GUARD_MODE=enforce` | Pages enforce |

**The two flags ship in separate deploys.** They fail in ways that look alike from a
support ticket — "I can't get to a page I could get to yesterday" — and bundling them would
make a regression ambiguous between the decision source changing and page admission turning
on. Split, each deploy has exactly one suspect.

Step 4's gate is the one `authorize.ts:32` already specifies: `rbac.parity.mismatch` at
zero across a soak that exercised every role in active use.

Step 5's gate is a quiet `rbac.page_guard.shadow_denial` log from step 3, observed **after**
step 4 has settled — the shadow log is only meaningful once the decision source it shadows
is the one that will be live.

### Pre-existing-bug sweep as a script

`ScalingAudit` will not be the only one. Every key in `SUBJECT_TO_MODULE`
(`lib/rbac/types.ts:39-100`) with no matching `rbac_subjects` row is the same
silent-403-on-flip bug. `scripts/assert-subject-coverage.ts`, run in CI, asserts:

- every `SUBJECT_TO_MODULE` key exists in `rbac_subjects` and links to the module it claims;
- every subject links to exactly one enabled module;
- no two subjects share a `navPath`.

---

## 9. Testing

**`libs/rbac/nav-resolver.test.ts`** — longest-prefix; subject-beats-module on a tie
(`/app/agent`); no-match returns null; and the prefix-collision cases that look like bugs
but are not: `/app/agent-ops` must **not** match `/app/agent` (the `+ '/'` in the test is
what prevents it), `/app/agent-ops/providers` must beat `/app/agent-ops`.

**`use-matrix-state.test.ts`** — the three cell transitions; read-implication in both
directions; `carried` round-trip; non-grantable cells inert.

**`role-rule-sync.test.ts`** (additions) — overrides created and deleted; a subject rule
carrying `conditions` survives a save untouched; ditto one carrying `fields`.

**`lockout.test.ts`** (additions) — `cannot update Settings` on the last admin role is
refused; a positive subject-level grant satisfies the invariant.

**`rule-compiler.test.ts`** (addition) — module grant + subject deny compiles to exactly
the expected rule set, asserting the `cannot`-last ordering end to end.

**Middleware integration** — shadow logs and allows; enforce redirects; `/app/unauthorized`
and `/app` exempt; thrown registry error allows.

**E2E `apps/web-ui-e2e/rbac-submodule.spec.ts`** — role with `AIOps: read` +
`Provider: deny read` → sidebar shows Agentic Ops without Providers → direct navigation to
`/app/agent-ops/providers` lands on `/app/unauthorized`.

**Parity** — `parity-live.test.ts` re-run after the backfill. `ScalingAudit` moves from a
current unlogged mismatch to agreement.

---

## 10. Non-goals

- No ABAC **condition** editor. Conditions stay authorable only via direct registry writes;
  the engine, validator and row-filter already support them.
- No per-field (`fields[]`) UI.
- `custom_roles.permissions` keeps its shape; the legacy matrix and its eventual
  Workstream J deletion are untouched.
- No new modules — the set stays at 7.
- No UI for tenant-local subjects, though the schema's `tenantId` allows them.

---

## 11. Risks

**Prod flip (D5).** Mitigated by the parity soak gate and the coverage script. `ScalingAudit`
is a known pre-existing mismatch the backfill resolves; the script finds any others.

**Matrix density.** After the backfill it is 7 modules × ~31 subjects × 4–6 verbs. Fully
expanded that is an unusable wall. Subject rows default **collapsed**, with a filter box
over subject label/key and an expand-all escape hatch. A module row shows a badge when any
of its subjects is overridden, so a collapsed override is never invisible.

**Weakened page guard (D6/§7).** Accepted explicitly: the page guard is defence in depth
over API routes guarded by Layer 1 and `authorize()`. An infrastructure failure there
degrades presentation, not data access.
