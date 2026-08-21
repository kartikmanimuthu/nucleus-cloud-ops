# IAM Nav Section — Design

**Date:** 2026-08-06
**Status:** Approved, pending implementation plan

## Summary

Introduce a new top-level sidebar section, **IAM**, containing four standalone
pages: Members, Roles, Permissions, Modules. These currently live under
Settings — Members as its own page, and Roles/Permissions/Modules as three
tabs on one shared "Access Control" page. This is a pure information-
architecture change: no new permissions model, no RBAC engine changes, no new
API routes. The underlying components already exist, are already tested, and
move to new routes unchanged in behavior.

## Goals

- A new top-level nav entry, **IAM**, with four child pages: Members, Roles,
  Permissions, Modules — each its own route, its own sidebar link, no shared
  tab bar between them.
- Settings keeps only Overview and Organization once Members and
  Roles/Permissions/Modules move out.
- Old URLs (`/app/settings/members`, `/app/settings/roles`,
  `/app/settings/access-control` and its `?tab=` variants) keep working via
  redirect, matching the pattern already established in this codebase
  (`app/app/settings/roles/page.tsx` already redirects today).

## Non-goals

- No change to *nav-level* visibility — every new page still gates on
  `module: "Settings"`, identical to the permission that already governs
  these screens today.
- No new API routes. `PermissionsTab`, `ModulesTab`, `RolesTab`, and the
  Members page's hooks (`useMembers`, `useInvitations`, etc.) call the same
  endpoints they call today.
- No change to the RBAC/ABAC engine itself — see the RBAC cutover-safety work
  landed on `integration/dynamic-rbac-abac` earlier this session, which this
  design does not touch. (Client-side *gating* of individual controls,
  addressed below, is UX only — `authorize()` on each route remains the real
  boundary either way.)

Everything else about each screen's visuals and behavior is unchanged; the
only content difference from today is the client-side gating fixes below.

## UI gating audit

Moving these files is the natural point to close pre-existing gating gaps in
them — not a new requirement invented for this feature, but real, currently-
shipped gaps this move touches anyway. Audited by reading every mutating
control in all four screens against `components/rbac/gated.tsx`'s
`GatedButton`/`GatedDropdownItem`/`Gate` and cross-checking each one's actual
server-side `authorize()` call so the client-side check can't drift from it.

**Already correctly gated — preserved as-is, no change needed:**

- `PermissionsTab` — "New permission" (`GatedButton action="update" subject="Settings"`), Edit/Delete on custom rows (`GatedDropdownItem`, same subject).
- `ModulesTab` — "New module", Edit/Delete on custom rows — same pattern.
- `RolesList` (used by `RolesTab`) — Edit/Delete on custom role cards (`GatedButton action="update"/"delete" subject="Settings"`).

Built-in/system rows in `PermissionsTab`/`ModulesTab` deliberately keep a
plain, always-visible `Button` for their view-only Edit affordance (opens a
read-only dialog) and, for modules, a permanently-disabled Delete — these are
not mutating controls and correctly have no gate.

**Real gaps found — fixed as part of this move**, each using the exact
`action`/`subject` its own API route already authorizes with (verified by
reading the route, not assumed):

| Component (new location) | Control | Server route it calls | Fix |
|---|---|---|---|
| `roles-tab.tsx` → `app/app/iam/roles/page.tsx`'s tree | "Create Role" button | `POST /api/settings/roles` → `authorize('create', 'Settings')` | Wrap in `GatedButton action="create" subject="Settings"` |
| `members-table.tsx` | Per-row role-change `Select` | `PATCH /api/settings/members/[memberId]` → `authorize("update", "User")` | Not a `Button` — use the `Gate` render-prop (`components/rbac/gated.tsx`'s exact documented use case: "controls that are not the Button primitive") to disable the `Select` when denied, passing `data={member}` |
| `members-table.tsx` | "Edit attributes" icon button (opens `MemberAttributesDialog` — the ABAC principal-attribute assignment surface) | `PUT /api/settings/members/[memberId]/attributes` → `authorize('update', 'Settings')` | Wrap in `GatedButton action="update" subject="Settings"` |
| `invitations-table.tsx` | "Resend" button | `POST /api/invitations/[id]/resend` → `authorize("update", "User")` | Wrap in `GatedButton action="update" subject="User" data={invitation}` |
| `invitations-table.tsx` | "Revoke" button | `POST /api/invitations/[id]/revoke` → `authorize("delete", "User")` | Wrap in `GatedButton action="delete" subject="User" data={invitation}` |

`data={member}`/`data={invitation}` is passed on the row-scoped fixes even
though no live conditional rule exists on `User` or `Settings` today (per
earlier findings this session: 0 of 102 live rules carry conditions) —
matching the established convention already used by `RolesList` (which
passes `data={role}` under the identical circumstance) rather than
introducing a new, inconsistent pattern. If a conditional rule is ever
authored against these subjects, these controls are already correct instead
of silently over-permissive.

These five fixes touch files this design already modifies for other reasons
(`roles-tab.tsx` gets a new consumer; `members-table.tsx`/
`invitations-table.tsx` are consumed by the Members page, which moves). No
additional files beyond what "Files touched" below already lists.

## Current state (for reference)

```
apps/web-ui/lib/nav-config.ts          — static two-level sidebar tree (source of truth)
apps/web-ui/app/app/settings/
  members/page.tsx                     — "use client" page, ~130 lines, real logic
                                          (useMembers/useInvitations/useRoles hooks,
                                          MembersTable, InvitationsTable, InviteMemberDialog)
  roles/page.tsx                       — 7-line redirect to access-control?tab=roles
  access-control/page.tsx              — "use client", 3 Radix Tabs (permissions|modules|roles)
                                          rendering:
apps/web-ui/components/settings/access-control/
  permissions-tab.tsx
  modules-tab.tsx
  roles-tab.tsx
  permission-dialog.tsx                — dialogs used by the tabs above; untouched
  module-dialog.tsx
```

Sidebar today (`navMenus` in `nav-config.ts`), relevant slice:

```ts
{
  title: "Settings",
  icon: Settings,
  items: [
    { title: "Overview", href: "/app/settings", module: "Settings" },
    { title: "Members", href: "/app/settings/members", module: "Settings" },
    { title: "Roles & Permissions", href: "/app/settings/roles", module: "Settings" },
    { title: "Organization", href: "/app/settings/organization", module: "Settings" },
  ],
},
```

## Design

### 1. Sidebar

New top-level entry in `navMenus`, positioned directly above Settings (both
are admin-facing; this keeps Settings — now just Overview + Organization —
last, after every operational section):

```ts
{
  title: "IAM",
  icon: ShieldCheck,   // already used on today's Access Control page header
  items: [
    { title: "Members", href: "/app/iam/members", module: "Settings" },
    { title: "Roles", href: "/app/iam/roles", module: "Settings" },
    { title: "Permissions", href: "/app/iam/permissions", module: "Settings" },
    { title: "Modules", href: "/app/iam/modules", module: "Settings" },
  ],
},
{
  title: "Settings",
  icon: Settings,
  items: [
    { title: "Overview", href: "/app/settings", module: "Settings" },
    { title: "Organization", href: "/app/settings/organization", module: "Settings" },
  ],
},
```

`module: "Settings"` on all four — unchanged gating, per the Non-goals section.

### 2. New pages

- **`app/app/iam/members/page.tsx`** — the entire current contents of
  `app/app/settings/members/page.tsx`, moved verbatim (same imports, same
  hooks, same JSX). `PageHeader` title/icon unchanged ("Members", `Users`
  icon).
- **`app/app/iam/roles/page.tsx`** — new thin page:
  `PageHeader` (title "Roles", suitable icon — see Open Questions) +
  `<RolesTab />`, no `Tabs` wrapper.
- **`app/app/iam/permissions/page.tsx`** — new thin page:
  `PageHeader` (title "Permissions") + `<PermissionsTab />`.
- **`app/app/iam/modules/page.tsx`** — new thin page:
  `PageHeader` (title "Modules") + `<ModulesTab />`.

`RolesTab`, `PermissionsTab`, `ModulesTab` are consumed exactly as
`access-control/page.tsx` consumes them today (no prop changes) — confirmed
by reading each: none of the three components import or depend on being
inside a `Tabs`/`TabsContent` ancestor.

### 3. Old routes → redirects

Matches the existing pattern (`settings/roles/page.tsx` already does this):

- `app/app/settings/members/page.tsx` → replace contents with
  `redirect("/app/iam/members")`.
- `app/app/settings/roles/page.tsx` → change its existing redirect target
  from `/app/settings/access-control?tab=roles` to `/app/iam/roles`.
- `app/app/settings/access-control/page.tsx` → replaced with a redirect page
  (its `Tabs`/`TabsList`/`TabsContent` JSX is removed; `permissions-tab.tsx`,
  `modules-tab.tsx`, `roles-tab.tsx` are NOT deleted or moved — they simply
  gain a new consumer, the four pages above, instead of this one). Query-param
  deep links (`?tab=permissions`, `?tab=modules`) need to keep resolving, so
  the redirect reads `searchParams.get("tab")` and sends `permissions` →
  `/app/iam/permissions`, `modules` → `/app/iam/modules`, anything else
  (including `roles` or no param) → `/app/iam/roles`.

### 4. What does not change

- `permission-dialog.tsx` and `module-dialog.tsx` (used by `ModulesTab`/
  `PermissionsTab`) — untouched; their consumers' physical location isn't
  changing, only which page renders them.
- `components/settings/roles-list.tsx`, `role-dialog.tsx`,
  `delete-role-dialog.tsx` — used by `RolesTab`, untouched for the same
  reason.
- `getPageTitle()` in `nav-config.ts` — works unchanged; it matches against
  `navMenus` by longest-href-prefix, so it picks up the new IAM entries
  automatically once they're added to the array. No separate edit needed.
- The RBAC engine, `authorize()`, the ability payload API
  (`/api/me/ability`), and every RBAC test file from earlier in this
  session — none of this touches or is touched by the nav/page move.

## Testing

- No existing Playwright E2E spec references `settings/members`,
  `settings/roles`, `settings/access-control`, "Access Control", or
  "Roles & Permissions" (checked — zero matches in `apps/web-ui-e2e`), so no
  E2E test needs updating as a result of this change.
- Manual verification is sufficient given the scope (page moves + redirects,
  no logic changes): visit all four new IAM pages, visit all three old URLs
  (plus the two `?tab=` variants) and confirm they land on the right new
  page, confirm Settings now shows only Overview + Organization.

## Page headers, decided

Each new page's `PageHeader` reuses the icon already assigned to that concept
on today's Access Control page (`icon={KeySquare}` on the Permissions tab
trigger, `icon={Boxes}` on Modules, `icon={Users}` on Roles — confirmed by
reading `access-control/page.tsx`), with the removed page's single
description split one clause per page:

| Page | Icon | Description |
|---|---|---|
| Members | `Users` (unchanged) | "Manage your organization's team members and pending invitations." (unchanged) |
| Roles | `Users` | "Bind permissions to roles." |
| Permissions | `KeySquare` | "Define the permissions your roles can grant." |
| Modules | `Boxes` | "Group permissions into modules." |

## Files touched

**Created:**
- `apps/web-ui/app/app/iam/members/page.tsx`
- `apps/web-ui/app/app/iam/roles/page.tsx`
- `apps/web-ui/app/app/iam/permissions/page.tsx`
- `apps/web-ui/app/app/iam/modules/page.tsx`

**Modified:**
- `apps/web-ui/lib/nav-config.ts` — add IAM section, remove two items from Settings.
- `apps/web-ui/app/app/settings/members/page.tsx` — replaced with a redirect.
- `apps/web-ui/app/app/settings/roles/page.tsx` — redirect target changed.
- `apps/web-ui/app/app/settings/access-control/page.tsx` — replaced with a
  `?tab=`-aware redirect.
- `apps/web-ui/components/settings/access-control/roles-tab.tsx` — gating
  fix (Create Role button); otherwise unchanged. **Physical location does
  not change** — no reason to move it, since Next.js component directories
  don't need to mirror route directories. Only its consumer changes, from
  `access-control/page.tsx`'s tab panel to `iam/roles/page.tsx`.
- `apps/web-ui/components/settings/access-control/permissions-tab.tsx` and
  `modules-tab.tsx` — no content change (already correctly gated per the
  audit above); consumer changes the same way as `roles-tab.tsx`.
- `apps/web-ui/components/settings/members-table.tsx` — gating fixes (role
  Select, Edit attributes button); physical location unchanged.
- `apps/web-ui/components/settings/invitations-table.tsx` — gating fixes
  (Resend, Revoke buttons); physical location unchanged.

**Deleted:**
- Nothing outright — `access-control/page.tsx` becomes a redirect rather
  than being removed, per the query-param deep-link requirement above.
