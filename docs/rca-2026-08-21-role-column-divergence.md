# RCA — sidebar hid pages the API still served (role/roleId divergence)

**Date:** 2026-08-21
**Severity:** High — authorization gap, not a display bug
**Status:** Root cause identified; code fix written, data reconciliation pending a decision
**Environments:** Production (`nucleus-cloud-ops-postgres`, tenant `smc`)

---

## 1. Summary

Nine members of the `smc` tenant saw a sidebar that omitted Spot Guard, Cost Scheduler,
Inventory, Agentic Ops and IAM, while the corresponding pages and every one of their API
endpoints returned **200**. The reported symptom was "the Spot Guard menu item is missing on
production but present on UAT".

The sidebar was correct. The API was wrong.

`user_tenant_roles` records a member's role **twice** — once as free text (`role`) and once as
a foreign key (`roleId`). For those nine rows the two disagree: `role = 'cloud-admin'` while
`roleId` points at **`cloud-read`**. Two code paths read different columns, so the nav and the
API answered questions about two different roles.

---

## 2. Impact

`cloud-admin` grants `Schedules: create/read/update/delete` and `IAM: create/read/update/delete`.
`cloud-read` grants neither.

For the nine affected members, while presented in the UI as read-only:

- **Live compute control.** `delete` on Schedules is the grant `lib/rbac/types.ts:142-155`
  identifies as "may change running AWS compute" — restarting ECS services via Spot Guard.
- **Privilege self-escalation.** `IAM: create/read/update/delete` permits reaching
  `/app/iam/roles` directly and editing any role, including their own. The only thing
  obscuring this was a hidden nav entry, and `hooks/use-can.ts:6-9` states plainly that nav
  gating is *"UX, not security"*.
- **No SuperAdmin exists** in production (verified: 0 accounts), so there was no higher
  authority the escalation could be checked against.

No evidence of exploitation was sought or found; this analysis covers capability only.

Not affected: other tenants, and the 23 memberships whose two columns agree.

---

## 3. Root cause

### 3.1 The data

```
user_tenant_roles.role   (free text) : "cloud-admin"
user_tenant_roles.roleId (FK)        : cmq6bkk1l03zjg8i2vhps9cud  ->  cloud-read
```

Confirmed against live production: **9 memberships**, all in tenant `smc`, all the identical
`cloud-admin` / `cloud-read` pair.

**Origin identified.** `PATCH /api/settings/members/[memberId]` — the "Change Member Role"
action in the Members UI — wrote the name only:

```ts
// app/api/settings/members/[memberId]/route.ts:48-51 (before the fix)
const updated = await prisma.userTenantRole.update({
    where: { id: memberId },
    data: { role: role.trim() },     // roleId never touched
});
```

Changing a member from `cloud-read` to `cloud-admin` through that screen produces exactly the
observed row: name `cloud-admin`, FK still `cloud-read`. Nine members, one tenant, one pair —
consistent with a single admin session working through that list.

Every other writer sets both columns correctly, so this is a **single-line defect, not a
systemic one**:

| writer | behaviour |
|---|---|
| `app/api/tenants/route.ts:61` (create org) | `role` + `roleId` ✅ |
| `lib/db/repositories/rbac/postgres.ts:57` (upsert) | `role` + `roleId` ✅ |
| `lib/invitation-service.ts:69`, `:334` | `role` + `roleId` ✅ |
| `lib/rbac/custom-role-service.ts:339` (role deleted → demote to Viewer) | name only, but harmless: the FK is `onDelete: SetNull`, so `roleId` becomes NULL and the name fallback applies consistently |

`audit_logs` records `tenant.member.role_changed` at `severity: 'high'` for that endpoint, so
the actor and timestamp of the nine changes are recoverable — and may settle whether
`cloud-admin` was the intent.

### 3.3 A second defect in the same handler

The endpoint also never bumped `tenants.rbacVersion`. `principalCache`
(`session-ability.ts:131`) is keyed `tenantId:userId:version`, so after a role change the
**old principal — carrying the old roleId — kept being served** until the version moved or the
entry fell out of a 500-item LRU. Role changes were therefore not reliably taking effect at
all. Fixed alongside.

### 3.2 The code

Two paths, two columns, only one of them taught which is authoritative:

| path | reads | resolves to | outcome |
|---|---|---|---|
| `lib/rbac/authorize.ts:182` (legacy) | `session.user.role` — the **name**, set from `utr.role` at `lib/auth-options.ts:169` | `cloud-admin` | API **allows** |
| `lib/rbac/session-ability.ts:44` (CASL, sidebar, page guard) | `membership.customRole` — the **FK** | `cloud-read` | nav **hides** |

`session-ability.ts` deliberately prefers the FK and consults the name only when `roleId` is
NULL, warning when it does. `authorize.ts` never received that treatment — it was written when
the name was the only representation and was not revisited when CASL landed alongside it.

---

## 4. Why nothing caught it

**No database constraint.** `20260403_drop_role_check_constraint` removed the CHECK on `role`
so custom role names could be arbitrary, moving validation to "the application layer". Nothing
replaced it, and nothing anywhere asserts `role` agrees with `roleId`.

**`role` outlived its purpose.** `libs/prisma/schema.prisma:199` labels it *"keep for backward
compat"*, yet it remained an authorization input.

**All three request guards passed.**

| guard | state on prod | why it let the request through |
|---|---|---|
| Page guard (`enforcePageRead`) | `shadow` | `RBAC_PAGE_GUARD_MODE` is **set by nothing, anywhere** — not infra, not prod, not sbx |
| Route guard (`enforceLayer1`) | `shadow` | evaluates and logs, then allows |
| `authorize()` | enforcing | working correctly, on the wrong column |

`lib/rbac/page-authz.ts:21-23` asserts *"infra/compute sets `enforce` explicitly"*. It does not —
`infra/compute/index.ts:797-799` sets only `DYNAMIC_ABAC_ENABLED` and `RBAC_ROUTE_GUARD_MODE`.
That false comment is why the unfinished rollout step went unnoticed.

**Existing telemetry was not watched.** `authorize.ts` already logs `rbac.parity.mismatch` on
every legacy/CASL disagreement, and it is explicitly the documented gate for flipping
`DYNAMIC_ABAC_ENABLED`. These nine users generated it on every request. Nothing alerted.

---

## 5. Diagnostic missteps (recorded so the next person is faster)

**Wrong first hypothesis, and a migration written for it.** The initial diagnosis was drift
between `custom_roles.permissions` and `rbac_role_rules`. That is a real failure mode in this
codebase, and migration `20260821000000_backfill_custom_role_rules` correctly addresses it —
but it was not this bug. For `cloud-read`, blob and rules matched exactly and the migration
created **0 rules**. Several hours were spent building and validating a fix for the wrong
problem. **The cheap check that would have collapsed the investigation immediately —
"print the affected role's blob and rules side by side" — was run late.**

**Restore artifact mistaken for a product bug.** Loading the production slice via Prisma
`createMany` with `conditions: null` wrote the JSON *value* `null` rather than SQL `NULL`.
`lib/rbac/lockout.ts:120` filters with `Prisma.DbNull`, which matches SQL NULL only, so the
lockout guard saw zero qualifying roles and blocked every role edit in the copy. This was an
artifact of the restore, not production behaviour. Ironically the codebase already documents
the mirror image of this footgun at `lockout.ts:115-119`.

---

## 6. Remediation

### Immediate

0. **Fix the source of new mismatches** (done, uncommitted). `PATCH
   /api/settings/members/[memberId]` now resolves the role row by name and writes `roleId`
   alongside `role`, inside a transaction that also bumps `tenants.rbacVersion`. Without this,
   any reconciliation is undone the next time someone uses the Members screen.
1. **Reconcile the nine memberships.** Decide per user whether they are `cloud-admin` or
   `cloud-read`, then set *both* columns and bump `rbac_global_version` (the ability cache is
   version-keyed and its entries are immutable). Ship as a migration, per
   `docs/rbac-registry-migrations.md`.
2. **Deploy the `authorize.ts` FK-first fix** (written, uncommitted). It resolves the role from
   `verdict.roleName` — the FK-resolved value — and falls back to the session name only when the
   ability cannot be built. Adds `rbac.role.column_mismatch` logging. `isAdmin()` had the same
   flaw and is fixed alongside.
   **This fix itself removes the nine users' extra access at deploy time**, so ordering with
   step 1 is a deliberate choice, not an afterthought.
3. **Alert on `rbac.parity.mismatch` and `rbac.role.column_mismatch`.** The signal already
   exists; only the alert is missing.

### Short term

4. **Restore the missing invariant.** A CHECK or trigger asserting
   `role = (SELECT name FROM custom_roles WHERE id = roleId)` whenever `roleId` is non-null.
   Must follow step 1, or it will reject the existing rows.
5. **Set `RBAC_PAGE_GUARD_MODE` explicitly in `infra/compute`** and correct the false comment at
   `page-authz.ts:21-23`. Completes step 5 of the rollout plan.
6. **Backfill `roleId` where NULL**, so the FK is universal and the name fallback becomes dead code.

### Long term

7. **Workstream J** — delete `legacyDecision()`, `ROLE_PERMISSIONS`, and the parity harness. This
   removes the second code path entirely and makes the bug class impossible.
8. **Demote `role` to display-only**, then drop it.

---

## 7. Open decisions

- **Are the nine `cloud-admin` or `cloud-read`?** A permissions question, not a technical one.
  The data cannot answer it; `assignedBy` / `assignedAt` on those rows may indicate intent.
- **Ordering of the `authorize.ts` fix versus the data reconciliation.** Either order closes the
  gap; the difference is whether nine users lose access with or without warning.
- **`c1283624`** (`dynamicAbacEnabled=true` on prod, committed and unpushed) has the same effect
  by a different route. Do not deploy it before reconciliation.
- **Verify `rbac_role_rules.conditions` on production** is SQL NULL, not JSON `null`
  (`scratchpad/prod-check-nullkind.sh`). Expected to be fine; if not, no one can edit any role
  in production.

---

## 8. Verification performed

- Production queried read-only via SSM through the prod bastion: **9** mismatched memberships,
  `cloud-admin Schedules=["create","read","delete","update"]`, `cloud-read Schedules=[]`.
- Bug reproduced locally against a production data copy: sidebar omitted Spot Guard while all
  `/api/spot-guard/*` calls returned 200.
- Fix confirmed on the copy: repointing the FK to `cloud-admin` restored the nav entry, with
  name and FK in agreement.
- `authorize.ts` change: typecheck clean, 282 RBAC tests passing.
