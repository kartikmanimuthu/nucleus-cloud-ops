# Validating the RBAC/ABAC Implementation from the UI

**Date:** 2026-08-03
**Branch:** `integration/dynamic-rbac-abac` @ `2ccdf0b`
**Environment:** `DYNAMIC_ABAC_ENABLED=true`, `RBAC_ROUTE_GUARD_MODE=enforce` — the CASL
engine is deciding, not shadow-comparing.

---

## Read this first — what you cannot test yet

Three gaps limit what the UI can prove. None are blockers for the tests below, but knowing
them stops you chasing "bugs" that are unbuilt features.

### 1. Editing a role has no effect on access

The roles page writes `custom_roles.permissions` (legacy JSON). CASL reads `rbac_role_rules`.
**Nothing in the request path syncs one to the other.** The only writer of `rbac_role_rules`
is `apps/web-ui/scripts/backfill-rbac.ts`, a one-off script.

So if you tick a box in Settings → Roles and save, the JSON changes and **the user's actual
access does not**. Under the old engine it would have. This is the single biggest gap.

### 2. Conditions cannot be authored

`role-dialog.tsx` is still the legacy 6-module × 4-action grid. There is no condition builder,
so the ABAC half of the system — the part that answers "which rows" — has no UI. The engine,
schema, validator, and compiler all exist; the authoring surface does not. Consistent with
this, **zero of the 72 live rules carry conditions.**

### 3. You have one user, and inviting a second needs AWS

The database holds exactly one user — yours, role **Owner** — authenticating via SSO. Inviting
a second calls Cognito `AdminCreateUser`, which fails with *"Could not load credentials from
any providers"* until `AWS_PROFILE=PLATFORM-ADMIN` is configured.

Owner can do everything, so **you cannot observe a denial as yourself.** Section D works
around this.

---

## Before you start

```bash
# 1. Postgres must be running (native, no Docker)
#    connection: postgresql://postgres:matrix@localhost:5432/postgres

# 2. Start the app
cd apps/web-ui && bun run dev        # http://localhost:3001

# 3. Keep the server log visible — it is where the RBAC signal appears
```

**Do not change your own Owner role.** Lockout protection should stop you removing the last
admin grant, but testing that by locking yourself out of the only account is not worth it.

---

## Section A — Prove nothing broke (highest value, do this first)

The cutover's entire promise is *"nothing about anyone's access changes."* Parity was proven
statically for all 5 roles; this checks it against the running app.

As Owner, visit each page and confirm it loads with data and no error toast:

| # | Page | Expect |
|---|---|---|
| A1 | `/app/dashboard` | Loads, widgets populate |
| A2 | `/app/accounts` | Account list renders *(this one 500'd before `2ccdf0b` — the regression fix)* |
| A3 | `/app/schedules` | Schedule list renders |
| A4 | `/app/inventory` | Resource list renders |
| A5 | `/app/right-sizing` | Recommendations render |
| A6 | `/app/spot-guard` | Services render |
| A7 | `/app/certificates` | Certificate list renders |
| A8 | `/app/skills` | Skills render |
| A9 | `/app/knowledge-base` | Knowledge bases render |
| A10 | `/app/audit` | Audit log renders |
| A11 | `/app/agent-ops` | Runs render |
| A12 | `/app/memory` | Memories render |
| A13 | `/app/settings/roles` | 5 roles: Owner, Admin, Member, Viewer, Test |
| A14 | `/app/settings/members` | 1 member — you, as Owner |

**A2–A12 are exactly the endpoints row filtering was wired into.** They all run the code path
that produced the `Account` crash, so this list is the regression suite for that fix.

**What a failure looks like:** an empty list where data exists, or a 500. In the server log:

```
[rbac] cannot push down a '<Subject>' read rule into SQL: ...
```

That means the subject has a rule referencing an attribute with no column mapping. Report the
subject name — the fix is in `lib/rbac/prisma-filter.ts`'s `SUBJECT_FIELDS`.

---

## Section B — Prove the route guard is enforcing

`RBAC_ROUTE_GUARD_MODE=enforce` means Layer 1 denies any route not accounted for in the
generated manifest.

| # | Do | Expect |
|---|---|---|
| B1 | While logged in, browse to `http://localhost:3001/api/definitely-not-a-route` | 404 or 403 — **not** a stack trace |
| B2 | Log out, then hit `http://localhost:3001/api/accounts` directly | Redirect to sign-in |
| B3 | Log out, then hit `http://localhost:3001/api/health` | **200** — it is allowlisted |

B3 matters: it proves the allowlist works and the guard is not simply denying everything.

---

## Section C — Prove UI gating renders

Gating is UX, not security — the API is the boundary. But it should be visibly present.

| # | Do | Expect |
|---|---|---|
| C1 | Open `/app/settings/roles` | Preset roles are read-only; only custom roles offer Edit/Delete |
| C2 | Open `/app/certificates`, look at row actions | Controls present and enabled (you are Owner) |
| C3 | Open `/app/skills` | Create/Edit controls enabled |
| C4 | `/app/settings/members` → a member's row | "Attributes" opens the principal-attributes dialog |

As Owner everything is enabled, so C2–C4 prove the gates **render and permit**, not that they
deny. Denial is Section D.

**Note:** the default is *disable with a tooltip*, not hide. A greyed control with a reason on
hover is correct behaviour, not a bug.

---

## Section D — Prove enforcement actually denies (the real test)

Everything above shows the system permitting. To see it deny you need a second, restricted
user. Two routes:

### D-1 (preferred): configure AWS, invite a real user

```bash
export AWS_PROFILE=PLATFORM-ADMIN     # then restart the dev server
```

Then Settings → Members → Invite, role **Viewer**. Accept the invite in a private window.

### D-2 (no AWS): create a credentials user directly in the database

This writes to the shared database. It adds one row to `auth_users` and one to
`user_tenant_roles` — it does not touch any `rbac_*` table. Ask before running it if you are
unsure.

You need a bcrypt hash of a password, then insert a user with that `passwordHash`, plus a
`user_tenant_roles` row giving them role `Viewer` in your tenant. They can then sign in via the
**Email & Password** tab.

### What to check once you have a Viewer

| # | As Viewer | Expect |
|---|---|---|
| D3 | Visit `/app/schedules` | List loads (Viewer has read) |
| D4 | Look for Create / Delete controls | **Disabled or absent** |
| D5 | Call `DELETE /api/schedules/<id>` directly (curl/devtools) | **403** with `{"error":"Forbidden"}` |
| D6 | Visit `/app/settings/roles` | Denied or read-only |

**D5 is the most important single check in this document.** It proves the API is the real
boundary and the hidden button was only UX. If D4 hides the control but D5 returns 200, the
enforcement is broken and that is a security finding.

---

## Section E — Watch the parity signal

Even with the flag on, disagreements are logged. Keep the server log open through Sections
A–D and search it afterwards:

```bash
grep "rbac.parity.mismatch" <your dev server log>
```

**Expect zero.** Each line names the action, subject, role, and both engines' decisions. Any
line is a genuine finding: static parity said the engines agree for every role, so a runtime
mismatch means a case the static comparison did not model.

This is also the closest you can now get to the soak the code asks for
(`authorize.ts` — *"the gate for flipping DYNAMIC_ABAC_ENABLED is this counter staying at
zero"*), which was never run before the flip.

---

## Section F — Rolling back

If anything in A–D misbehaves, revert to shadow mode in `.env` and restart:

```
DYNAMIC_ABAC_ENABLED=false
RBAC_ROUTE_GUARD_MODE=shadow
```

The legacy matrix decides again, CASL goes back to comparing silently, and the app behaves
exactly as it did before this work. **This is the safety property that makes the cutover
reversible** — use it rather than debugging live.

---

## What a clean pass proves, and what it does not

**Proves:** the cutover did not regress existing access for a real Owner across every page;
the route guard enforces without over-denying; gating renders; and — if you complete Section
D — the API denies a restricted user and the UI reflects it.

**Does not prove:**
- That role edits work — they do not reach the engine (gap 1).
- Anything about ABAC conditions — none exist and none can be authored (gap 2).
- Row filtering actually narrowing — with zero conditional rules, every filter is currently
  "no narrowing". Sections A2–A12 prove the path does not *crash*, not that it *filters*.
- Behaviour under concurrency, multiple tenants, or load.

---

## Suggested next work, in priority order

1. **Wire role edits to `rbac_role_rules`.** Until this exists, the roles UI is misleading —
   it accepts changes that do nothing. This is the most user-visible gap.
2. **Build the condition builder**, so the ABAC half becomes reachable.
3. **Fix the Account registry rows** — `alias` and `tags.Environment` are declared but have no
   columns, so a condition on either throws at query time.
4. **Configure AWS credentials**, which unblocks invitations and Section D-1.
