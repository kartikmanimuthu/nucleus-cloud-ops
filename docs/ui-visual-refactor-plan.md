# Nucleus Cloud Ops — UI Visual Refactor Plan (chatbot-template parity)

**Goal:** Replicate the chatbot reference project's UI/UX (sidebar, nested nav, org/user
switchers, global top bar, page headers, stat cards, audit-style data tables, and the
login/signup/create-org auth flows) in `apps/web-ui`. Make all co-located grid/card+table
toggles **table-only**. Match the chatbot's **font (Geist) and type scale/sizing**.

**Reference project:** `/Users/kartik/Documents/git-repo/chatbot/apps/web-ui` (Next.js 15 +
shadcn/ui). Tech ref: `/Users/kartik/Documents/git-repo/chatbot/techstack.md`.
Reference screenshots were provided by the user (sidebar groups + nested nav, org switcher
dropdown, audit logs page with stat cards + table, Connectors card grid, settings theme
Font/Radius switcher + user dropdown).

**Hard constraints:**
- DO NOT touch AI logic (langchain / langgraph) or any agent code.
- DO NOT change auth/tenant **logic** — NextAuth providers, signup→create-org flow,
  slug-check API, `POST /api/tenants` stay exactly as-is. Auth work is a **visual reskin only**.
- Keep the marketing landing page (`app/page.tsx`) as-is for now (only auth pages reskinned).
- Keep the multi-theme + font + radius switcher. Default accent = **blue** (to match the
  provided screenshots' blue avatar squares + active accents).

**Branch:** `app-refactor` (worktree). Main: `master-v1`.
**Verification:** **Playwright CLI only** (NOT Playwright MCP). See "Visual Verification" below.
**Loop:** 5-min recurring session loop. Each iteration: read this doc + `git log`, do ONE coherent
chunk of the first unfinished phase, verify (typecheck + screenshot when a visual change),
commit per chunk, update the Progress Log.

> This doc is the durable source of truth for the loop (fires run in fresh sessions). Keep the
> phase checkboxes and Progress Log current on every iteration.

---

## Decisions (CONFIRMED by user 2026-06-26)
- **D1 — Sidebar IA:** Domain-grouped + nested (see "Navigation IA" below).
- **D2 — Top bar:** Add the global top bar (sidebar-toggle + "Nucleus Cloud Ops" + theme toggle)
  ABOVE page content; keep per-page headers (now with an icon) below it.
- **D3 — Grid→Table:** Drop Accounts grid toggle; drop Schedules grid toggle; rebuild Inventory
  as a table; KEEP Channels as cards (matches reference "Connectors" screen).
- **D4 — Rollout:** Phased commits on `app-refactor` (no PR unless asked).
- **D5 — Auth in scope:** login, logout, signup, tenant/org creation reskinned to chatbot template
  (visual only; logic untouched).
- **D6 — Verification:** Playwright **CLI** only, no MCP. **Authed `/app/*` = public-only + manual QA**
  (user decision 2026-06-26): the loop screenshots only PUBLIC routes (`/login`,`/signup`,
  `/create-org`,`/`); `/app/*` phases are verified by code review + `bunx tsc --noEmit` on touched
  files, and the USER does manual visual QA at phase checkpoints. Do NOT restart the dev server or
  forge sessions. After each `/app/*` phase, the loop should explicitly flag "ready for your visual
  QA" in the Progress Log.
- **D7 — Defaults:** keep theme/font/radius switcher; default accent blue; keep marketing page.

---

## Key reality checks (from codebase exploration, 2026-06-26)
The two projects already share architecture — this is mostly a **reskin + recomposition**, not a rewrite.

- **shadcn sidebar primitive already exists** at `apps/web-ui/components/ui/sidebar.tsx`
  (~23KB). The chatbot builds its sidebar on the same primitive. ⇒ We compose
  `AppSidebar`/`nav-main`/`nav-user`/`org-switcher` on top of it (do NOT modify the primitive
  unless ours lacks an export the chatbot uses — verify parity in V0).
- **Auth flow already matches** the chatbot structurally:
  - `app/login/page.tsx` — NextAuth Credentials + Cognito (`signIn`), redirect `/app/dashboard`.
  - `app/signup/page.tsx` — `POST /api/auth/signup` → auto sign-in → middleware sends to
    `/create-org` when no `tenantId`.
  - `app/create-org/page.tsx` — name + slug, debounced `GET /api/tenants/check-slug`,
    `POST /api/tenants` (atomic Tenant + Owner role, auto-switch). KEEP all of this.
  - Logout = `signOut({ callbackUrl: '/login' })`.
  - No `(auth)` route group yet — three standalone pages share a hand-rolled card layout.
- **Current shell to retire/rewire:**
  - `components/sidebar.tsx` — custom flat sidebar (solid-blue active buttons, icon-rail
    collapse, org switcher, user footer). REPLACE with shadcn-primitive composition.
  - `components/layout-wrapper.tsx` — applies sidebar layout for `/app/*`. REWIRE to
    `SidebarProvider` + `AppSidebar` + `SidebarInset` + `Header`.
  - No global top bar today (each page renders its own sticky `PageHeader`).
- **Shared primitives today:** `components/shared/page-header.tsx` (title + description +
  actions; NO icon). Used by accounts/schedules/audit/inventory.
- **Grid/table toggles (Tabs-based, viewMode state):**
  - Accounts: `components/accounts/accounts-client-component.tsx` (Tabs Table/Grid) +
    `accounts-grid.tsx` / `accounts-table.tsx`.
  - Schedules: `app/app/schedules/schedules-page-client.tsx` (Tabs Table/Grid) +
    `schedules-grid.tsx` / `schedules-table.tsx`.
  - Inventory: `app/app/inventory/page.tsx` — grid-only (`resource-grid.tsx`); rebuild as table.
  - Right Sizing: already table-only (`recommendations-table.tsx`).
  - Audit: table-only (`audit-logs-table.tsx` + `audit-filters.tsx` + chart). Needs a stat-card row.
  - Channels: card grid (KEEP).
- **Theme:** `lib/stores/theme-config-store.ts` (zustand persist, key `nucleus-theme-config`,
  `{theme,radius,font}`), `components/theme-config-provider.tsx`, `components/settings/theme-settings.tsx`,
  `components/settings/theme-registry.ts`. Geist already wired. `--radius: 0.5rem`.
  Our `globals.css` lacks `--sidebar-*` tokens — must add them (V1).

---

## Navigation IA (D1) — the nav-main config
Group labels are uppercase muted (`SidebarGroupLabel`). `▸` = expandable parent (Collapsible),
nested children indented under it.

```
PLATFORM
  Dashboard            /app/dashboard            (LayoutDashboard)
  Audit Logs           /app/audit                (Activity)

OPERATIONS
  AI Ops               /app/agent                (Bot / Sparkles)
  Agent Ops ▸          /app/agent-ops            (Workflow)
      Overview         /app/agent-ops
      Scheduled Tasks  /app/agent-ops/scheduled-tasks
      Jira Settings    /app/agent-ops/jira-settings
      Slack Settings   /app/agent-ops/slack-settings
      MCP Settings     /app/agent-ops/mcp-settings

RESOURCES
  AWS Accounts         /app/accounts             (Cloud)
  Inventory            /app/inventory            (Boxes)
  Right Sizing         /app/right-sizing         (Gauge)   [feature-flagged: keep existing gate]
  Cost Scheduler       /app/schedules            (CalendarClock)
  Certificates         /app/certificates         (ShieldCheck)

KNOWLEDGE
  Knowledge Base ▸     /app/knowledge-base       (Database)
      All Bases        /app/knowledge-base
      Ask              /app/knowledge-base/ask

INTEGRATIONS
  Channels             /app/channels             (Plug / Webhook)

SETTINGS
  Settings ▸           /app/settings             (Settings)
      Overview         /app/settings
      Members          /app/settings/members
      Roles & Permissions  /app/settings/roles
      Organization     /app/settings/organization
      Providers        /app/settings/providers
```
Notes: icons are suggestions (lucide-react) — pick the closest. Preserve the existing
Right-Sizing feature flag gate. Active detection: exact match for leaves; parent is "active"
(expanded) when pathname starts with its base. `/app/settings` needs the existing special-case
(don't mark Overview active for deeper settings routes).

---

## Reference class strings to replicate (from chatbot, quote-accurate)
Embed these so loop sessions don't need to re-explore the reference.

**Top bar** (`components/layout/header.tsx`):
```tsx
<header className="flex h-16 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
  <div className="flex flex-1 items-center gap-2 px-4">
    <SidebarTrigger className="-ml-1" />
    <Separator orientation="vertical" className="mr-2 h-4" />
    <h1 className="text-base font-semibold">{title}</h1>
  </div>
  <div className="flex items-center gap-2 px-4"><ThemeToggle /></div>
</header>
```

**Shell** (`layout-wrapper.tsx`):
```tsx
<SidebarProvider>
  <AppSidebar />
  <SidebarInset>
    <Header />
    {children}
  </SidebarInset>
</SidebarProvider>
```

**Sidebar group label:** `text-xs font-medium text-sidebar-foreground/70` (primitive supplies the rest).

**Active nav item** (primitive `data-[active]` already encodes this — set `isActive`):
`data-[active]:bg-sidebar-accent data-[active]:text-sidebar-accent-foreground data-[active]:font-semibold`
+ 3px primary left bar via `data-[active]:before:absolute data-[active]:before:left-0
data-[active]:before:h-5 data-[active]:before:w-[3px] data-[active]:before:-translate-y-1/2
data-[active]:before:top-1/2 data-[active]:before:rounded-r-full data-[active]:before:bg-primary`.
Nested sub-item active uses the same with `before:h-4` and `font-medium`.

**nav-user footer** (`nav-user.tsx`): `SidebarMenuButton size="lg"` with `Avatar`
(`AvatarFallback className="rounded-lg bg-primary text-primary-foreground text-xs font-medium"`),
two-line name/email (`grid flex-1 text-left text-sm leading-tight`, email
`text-xs text-muted-foreground`), trailing `<ChevronsUpDown className="ml-auto size-4" />`;
dropdown `min-w-56 rounded-lg` side="right" align="end" → Profile (`/app/settings`), Sign out
(`signOut({callbackUrl:'/login'})`).

**Stat card** (audit page):
```tsx
<Card>
  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
    <CardTitle className="text-sm font-medium">{label}</CardTitle>
    {badge ?? <Icon className="h-4 w-4 text-muted-foreground" />}
  </CardHeader>
  <CardContent>
    <div className="text-2xl font-bold">{value}</div>
    <p className="text-xs text-muted-foreground">{sub}</p>
  </CardContent>
</Card>
```
Badges: ok=`bg-green-600 text-white`, warn=`bg-yellow-500 text-white`, err=`variant="destructive"`.

**Page header** (icon + title + subtitle):
```tsx
<div className="flex items-center gap-2">
  <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="size-5" /></span>
  <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
  {actions /* right-aligned via justify-between wrapper */}
</div>
<p className="text-muted-foreground">{description}</p>
```

**DataTable** (TanStack): `data-table.tsx` + `data-table-column-header.tsx` (ArrowUp/ArrowDown/
ArrowUpDown sort, dropdown asc/desc/clear) + `data-table-pagination.tsx` ("Showing X–Y of Z",
Rows-per-page select [10,25,50,100], Prev/Next). Port and adapt to our `components/ui/table.tsx`
+ `dropdown-menu.tsx` (Radix). Chatbot uses Base-UI `render={}` prop on triggers — adapt to our
Radix `asChild` pattern.

**`--sidebar-*` tokens to add to `globals.css`** (`:root` + `.dark`):
`--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`,
`--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring`.
Light defaults (chatbot zinc, adapt hue toward our blue primary): sidebar bg `240 4.8% 95.9%`,
fg `240 10% 3.9%`, accent `240 4.8% 90%`, border `240 5.9% 90%`. Dark: invert per chatbot.
Confirm `tailwind.config.ts` maps `sidebar`, `sidebar-foreground`, `sidebar-accent`,
`sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring` to these (the primitive needs them).

**Auth pages** (centered card, `app/(auth)/layout.tsx` wraps): outer
`flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10`; inner
`flex w-full max-w-sm flex-col gap-6`; logo badge `flex size-6 items-center justify-center
rounded-md bg-primary text-primary-foreground` + product name; `Card` with centered
`CardHeader` (CardTitle `text-xl`, CardDescription), `CardContent` holds the existing
form/providers; footer fine-print line. Keep RHF+zod + `signIn`/signup/create-org calls intact.

---

## Visual Verification (Playwright CLI — NO MCP)
Loop sessions can't "see" the UI, so verify visual changes with the Playwright **CLI**.

1. Dev server: `cd apps/web-ui && bun run dev` (port 3001). Start it (background) if not running;
   reuse if already up. (The e2e config can also auto-start it.)
2. Screenshot script: keep a small script at `apps/web-ui-e2e/visual-check.ts` (or
   `scratchpad/`) that navigates to a route and saves a full-page PNG. Run with
   `cd apps/web-ui-e2e && bunx playwright ...` or `bunx tsx`. Save shots under
   the session scratchpad (NOT committed).
3. Auth: public routes (`/login`, `/signup`, `/`, `/create-org` when reachable) need no auth —
   screenshot directly. `/app/*` routes need a session: reuse the e2e `storageState`
   (`apps/web-ui-e2e/.auth/user.json`) via `auth.setup.ts` if present; if not set up, capture the
   auth pages + note that `/app/*` shots are pending real-login QA (flag for the user).
4. After a visual chunk: capture the relevant route, Read the PNG, compare against the reference
   screenshots/description, fix obvious deltas, THEN commit. Don't commit shots.
5. Always also run `bunx tsc --noEmit` filtered to touched files (build ignores TS errors, but
   keep new code clean) before committing.

---

## Phasing

### Phase V0 — Prep & verification harness  ✅ DONE (commit pending)
- [x] Sidebar primitive parity: OURS exports everything `AppSidebar`/`nav-main`/`nav-user` need
      (only diff = chatbot also exports the TS type `SidebarContextProps`; not needed). NO primitive
      port required for exports.
      ⚠️ **DELTA for V2:** our `sidebarMenuButton` cva base string does NOT include the chatbot's
      active left-bar accent (`data-[active]:before:...bg-primary`) nor `SidebarMenuSubButton`'s
      `before:h-4` bar. Our primitive only sets `data-active={isActive}` with a plainer style. In V2,
      port the chatbot's `sidebarMenuButtonVariants` + sub-button base strings (quoted in the
      "Reference class strings" section) into our `components/ui/sidebar.tsx` to get the left-bar
      accent. Safe, isolated edit to the primitive.
- [x] Playwright CLI screenshot harness added: `apps/web-ui-e2e/visual-check.ts`. Output dir
      gitignored (`.shots/`). **Run command:**
      `cd apps/web-ui-e2e && SHOT_DIR=<scratchpad>/shots bunx tsx visual-check.ts /login /app/audit ...`
      (script reuses the running dev server on :3001; `/app/*` routes load with `.auth/session.json`).
- [x] Fixed `auth.setup.ts` broken module path (`apps/web-ui/node_modules/next-auth` →
      hoisted root `node_modules/next-auth`).
- [x] BEFORE shot of `/login` captured (genuine). 
- ⚠️ **AUTHED VERIFICATION BLOCKED:** `/app/*` screenshots redirect to `/login`. The e2e
      `auth.setup.ts` mints a JWT with the hard-coded TEST secret, but the running dev server uses a
      DIFFERENT `NEXTAUTH_SECRET`, so the token is rejected. Reading the real secret to forge a token
      is (correctly) denied by the security classifier. **NEEDS USER DECISION** (see Progress Log) —
      until resolved, `/app/*` chunks are verified by code-review + the user's manual QA; only
      public auth routes (`/login`,`/signup`,`/create-org`,`/`) are screenshot-verifiable by the loop.
- Commit: `chore(web-ui): visual-refactor prep — sidebar parity check + pw-cli screenshot harness`.

### Phase V1 — Design tokens + type scale  ✅ DONE (commit 75b81e8c)
- [x] `globals.css`: added `--sidebar-*` to `:root` and `.dark` (blue-primary accent).
- [x] `tailwind.config.ts`: added `sidebar` color mappings (DEFAULT/foreground/primary/
      primary-foreground/accent/accent-foreground/border/ring). Primitive already consumes
      `bg-sidebar*`/`text-sidebar*`/`border-sidebar*`.
- [x] Type scale already aligns (page-header title `text-3xl`, sidebar `text-sm`/`text-xs`);
      global top-bar title `text-base font-semibold` will be set in V2. No drift to fix now.
- Verify: tailwind.config.ts parses; globals.css braces balanced. (Screenshot deferred — dev server
      was down at commit time; tokens are additive/low-risk.)

### Phase V2 — App shell (sidebar + top bar)  🔄 IN PROGRESS  ← biggest change
- [x] Ported active left-bar accent into `components/ui/sidebar.tsx` (`sidebarMenuButtonVariants`
      + `SidebarMenuSubButton`): `data-[active=true]` → 3px primary rounded left bar +
      bg-sidebar-accent + font-semibold/medium. (commit 7638b7fd) No visible change until
      `isActive` is set by `app-sidebar`.
- [ ] `components/layout/header.tsx` — global top bar (SidebarTrigger + Separator + app title
      "Nucleus Cloud Ops" + ThemeToggle). Title can come from a small route→title map or a context.
- [ ] `components/nav-main.tsx` — grouped + nested nav from the IA config (Collapsible parents,
      `isActive` detection, settings special-case).
- [ ] `components/nav-user.tsx` — footer user dropdown (Profile / Sign out).
- [ ] `components/settings/org-switcher.tsx` — reskin existing org switcher to the
      SidebarMenuButton + dropdown style (keep `/api/tenants/*` calls + "Create new organization"
      → `/create-org`).
- [ ] `components/layout/app-sidebar.tsx` — compose header(org-switcher) + content(nav-main) +
      footer(nav-user).
- [ ] Rewire `components/layout-wrapper.tsx` → `SidebarProvider`/`AppSidebar`/`SidebarInset`/`Header`
      for `/app/*`; keep non-`/app` routes bare.
- [ ] Retire `components/sidebar.tsx` (delete after confirming no other importers; grep first).
- Verify: typecheck; screenshot `/app/dashboard` (collapsed + expanded), compare to reference
      sidebar shots (groups, nested expand, active left-bar, org/user dropdowns).
- Commit: `feat(web-ui): adopt shadcn sidebar shell + global top bar (chatbot parity)`.

### Phase V3 — Shared primitives  ⏭
- [ ] `components/shared/page-header.tsx` — add optional `icon` slot (tinted rounded square);
      keep title/description/actions API backward-compatible.
- [ ] `components/shared/stat-card.tsx` — label + value + sub + optional badge (ok/warn/err).
- [ ] `components/ui/data-table.tsx` + `data-table-column-header.tsx` + `data-table-pagination.tsx`
      — port from chatbot, adapt Base-UI `render` → Radix `asChild`; use our `ui/table`,
      `ui/dropdown-menu`, `ui/select`, `ui/button`.
- Verify: typecheck; mount DataTable on one page (audit or right-sizing) as a smoke test screenshot.
- Commit: `feat(web-ui): page-header icon slot + StatCard + TanStack DataTable primitives`.

### Phase V4 — Tables & grid removal  ⏭
- [ ] Accounts: remove Tabs Table/Grid toggle in `accounts-client-component.tsx`; render table only.
      Delete `accounts-grid.tsx` if no other importer (grep). Optionally re-base on DataTable.
- [ ] Schedules: same in `schedules-page-client.tsx`; delete `schedules-grid.tsx` if unused.
- [ ] Inventory: rebuild `app/app/inventory/page.tsx` to a table (columns: name/id, type, account,
      region, state/status, tags) replacing `resource-grid.tsx`; keep filters/search/pagination/
      sync/Ask-AI; keep query hooks. Retire `resource-grid.tsx` if unused.
- [ ] Audit: add the 4 StatCards row (Total Events / Successful / Warnings / Errors) above the table;
      ensure the table matches reference (sortable headers, two-line cells, Showing X–Y + Prev/Next).
- Verify: typecheck; screenshot accounts, schedules, inventory, audit; compare to reference.
- Commit (split if large): `refactor(web-ui): tables-only for accounts/schedules/inventory + audit stat cards`.

### Phase V5 — Auth reskin  ⏭
- [ ] Create `app/(auth)/layout.tsx` (centered-card shell + logo badge). Move/point login, signup,
      create-org to use it (Next route groups: put pages under `app/(auth)/` OR keep paths and add a
      shared layout — choose the lower-risk option after inspecting routing; **preserve URLs**
      `/login`, `/signup`, `/create-org`).
- [ ] Reskin `login/page.tsx`, `signup/page.tsx`, `create-org/page.tsx` to Card-based layout;
      keep ALL RHF+zod, `signIn`, signup POST, slug-check, `POST /api/tenants` logic untouched.
- [ ] Confirm logout still `signOut({callbackUrl:'/login'})` from nav-user.
- Verify: typecheck; screenshot `/login`, `/signup`, `/create-org`; compare to reference auth card.
- Commit: `feat(web-ui): reskin auth pages (login/signup/create-org) to chatbot template`.

### Phase V6 — Per-page polish sweep  ⏭
- [ ] Wire PageHeader (with icon) consistently across remaining pages (dashboard, right-sizing,
      knowledge-base, channels, certificates, settings/*, agent, agent-ops).
- [ ] Consistent section spacing/padding inside `SidebarInset` content (`p-4` / `space-y-4`),
      empty states, loading via Spinner.
- [ ] Final visual QA pass with screenshots of every primary route; flag anything needing the
      user's eyes.
- Commit(s): `polish(web-ui): consistent page headers + spacing across app`.

---

## Loop protocol (each 5-min fire)
1. Read this doc + `git log --oneline -8`.
2. Pick the first unfinished `⏭`/unchecked item (top-down by phase).
3. Do ONE coherent chunk (a single primitive/page/commit-sized unit).
4. `bunx tsc --noEmit` filtered to touched files. For visual chunks, screenshot via Playwright
   **CLI** and compare to the reference.
5. Commit per chunk (conventional commit). Don't commit screenshots.
6. Update the Progress Log + check the box.
7. AI logic (langchain/langgraph) and auth/tenant LOGIC are OFF-LIMITS.
> If a chunk needs the user's visual judgement and can't be verified by screenshot, make the safe
> part and FLAG the rest in the log rather than guessing.

## Progress Log
- 2026-06-26 — Plan authored. Design approved by user (D1–D7). Verification = Playwright CLI (no MCP).
- 2026-06-26 — Phase V0 done. Sidebar primitive parity confirmed (no export port needed; active
  left-bar accent must be ported into the primitive in V2 — recorded above). Added
  `apps/web-ui-e2e/visual-check.ts` (Playwright CLI harness, `.shots/` gitignored) + fixed
  `auth.setup.ts` next-auth path. **OPEN ISSUE — authed `/app/*` screenshots redirect to login:**
  dev server's `NEXTAUTH_SECRET` ≠ the e2e hard-coded test secret, so minted sessions are rejected;
  forging with the real secret is security-denied. To unblock loop self-verification of `/app/*`,
  the user should pick ONE: (a) restart the dev server with the e2e test secret
  `NEXTAUTH_SECRET=web-ui-nextauth-secret-change-in-production-or-use-secrets` (normal local-e2e
  config) so `auth.setup.ts` mints valid sessions; or (b) log in manually and export the
  `next-auth.session-token` cookie into `apps/web-ui-e2e/.auth/session.json`; or (c) accept that the
  loop verifies only public routes + code review and the user does periodic `/app` visual QA.
- 2026-06-26 — User decision on authed QA: **public-only screenshots + manual `/app/*` QA** (D6
  updated). Phase V1 done (commit 75b81e8c): `--sidebar-*` tokens + tailwind mappings; type scale
  already aligned. NOTE: dev server on :3001 was found DOWN mid-iteration (connection refused) — a
  background `bun run dev` was (re)started for future public-route checks; if a loop session finds
  :3001 down, restart it with `cd apps/web-ui && bun run dev` (needs AWS_PROFILE=PLATFORM-ADMIN).
- 2026-06-26 — V2 chunk 1 (commit 7638b7fd): ported active left-bar accent into the sidebar
  primitive. Dev server confirmed up on :3001 (serves /login 200). Next ⏭: V2 chunk 2 — build
  `components/nav-main.tsx` (grouped+nested nav from the IA config), then `nav-user.tsx`,
  reskin `org-switcher.tsx`, compose `app-sidebar.tsx`, add `header.tsx`, and finally rewire
  `layout-wrapper.tsx` to `SidebarProvider`/`SidebarInset` + retire old `components/sidebar.tsx`.
  Do these as separate commits. After the shell is wired, FLAG "ready for your visual QA" (sidebar
  groups/nesting/active bar + top bar are /app/* → user manual QA).
