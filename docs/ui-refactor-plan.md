# Nucleus Cloud Ops — UI / Frontend Refactor Plan

**Goal:** Adopt the chatbot project's industry-standard frontend/fullstack stack (ref: `/Users/kartik/Documents/git-repo/chatbot/techstack.md`) and deliver an "awesome" UI refactor.
**Hard constraint:** DO NOT touch AI logic (langchain / langgraph) during this UI-refactor phase.
**Branch:** `app-refactor` (worktree). Main: `master-v1`.
**Loop:** 30-min recurring session loop (cron dbc3fe83). Each iteration: read this doc + `git log`, continue next ⏭ step, commit per phase, update Progress Log below.

> This doc is the durable source of truth for the loop (cron fires run in fresh
> sessions). If editing, keep the Progress Log and phase checkboxes current.

---

## Decisions (CONFIRMED by user 2026-06-26)
- D1: **Full visual overhaul** + architecture work (aggressive redesign of layout/spacing/components, not just polish).
- D2: **Incremental commits per phase** on `app-refactor` branch (no PRs unless asked).
- D3: **BOTH in scope** — add Zustand 5 AND upgrade Zod 3→4.

## Current-state findings (iteration 1, 2026-06-26)
Project is NOT a blank slate. Strong shadcn/ui foundation already:
- 56 components in `apps/web-ui/components/ui/`; HSL CSS-var theming, 10+ themes; Inter+Manrope fonts. ~8.5/10.
- Custom sidebar `components/sidebar.tsx` (NOT shadcn sidebar primitive).
- Forms: ~10 use RHF+zod; ~7 dialogs use manual `useState` (inconsistent).
- Data fetching: ~88 raw `fetch()`, ~59 `useEffect` components, NO client caching. Client services: `client-account-service.ts`, `client-schedule-service.ts`, `client-audit-service.ts`.
- Toasts: BOTH sonner AND Radix toast mounted in `app/layout.tsx` (redundant). Radix `toast()` IS used in some dialogs → consolidation needs call-site migration.
- Zod 3.24.1 in ~17 files. 66 env vars read ad-hoc.

## Phasing
- **Phase 0** ✅ DONE — deps (@tanstack/react-query+devtools, @t3-oss/env-nextjs, zustand, framer-motion, geist) + QueryProvider + `env.ts` + `components/ui/spinner.tsx`. (commit 6629220)
- **Phase 1a** ✅ DONE — `lib/queries/` query-keys + accounts hooks (reference pattern). (commit aff426e)
- **Phase 1b** ✅ DONE — accounts page migrated to query hooks; initialData seeding for server first-paint; mutations invalidate cache. (commit 5db9611)
- **Phase 1c** ✅ DONE — schedules + audit hooks; schedules page migrated. (commit 4003fe1)
    - GOTCHA found: live audit page uses `client-audit-service-**api**` (cursor pagination, `{logs,nextPageToken}`); `client-audit-service.ts` (non-api) is DEAD code. audit.ts now wraps the live -api service.
    - Audit page component migration DEFERRED (cursor pagination → needs `useInfiniteQuery`). Hooks are ready.
- **Phase 1d** ✅ DONE — audit page migrated (pageToken→query key, useAuditFilterOptions). Deleted dead `client-audit-service.ts`. (commit cd069be)
    - Still-dead cluster to clean later: `app/app/audit/page-api.tsx` + `components/audit/audit-client-component-api.tsx` (page-api.tsx isn't a Next route). Defer to a cleanup phase.
- **Phase 2** ✅ DONE (toast consolidation) — `hooks/use-toast.ts` is now a sonner shim (kept legacy API so all ~17 call sites work unchanged); removed Radix `<Toaster/>` from layout; deleted `components/ui/toast.tsx`+`toaster.tsx`. Single system = sonner. (commit d61b4d2)
- **Phase 3** ✅ DONE (forms) — REALITY: the big "manual dialogs" were DEAD code (create/edit account+schedule dialogs, zero importers). 3a deleted them (d15c0e0, ~1900 lines). 3b migrated the one LIVE manual form (duplicate-schedule-dialog) to RHF+zod+useCreateSchedule (7e756bb). All live forms now RHF+zod. Live delete dialogs (delete-account/delete-schedule) are confirm-only (no fields) — they still call ClientService directly but work via onDeleted→page invalidation; OPTIONAL later: wire to useDeleteAccount/useDeleteSchedule for consistency.
- **Phase 4** ✅ DONE (Zod 3→4) — zod^4.4.3 + t3-env^0.13 + resolvers^3.10. Key insight: deepagents@1.8.1 REQUIRES zod^4.3.6 (was mismatched on z3). Mechanical fixes only: z.record(x)→z.record(z.string(),x) (model-factory, mcp-tools); ZodError.errors→.issues (4 API routes). Net-zero new TS errors vs baseline. AI behavior untouched. (commit 25410b6)
    - OPTIONAL later polish: convert deprecated `z.string().email()/.url()` → `z.email()/z.url()` (5-6 form files) and `.passthrough()`→`z.looseObject` (mcp-tools). Functional as-is; skipped to keep Phase 4 focused.
- **Phase 5** (data-layer rollout) — IN PROGRESS:
    - ✅ right-sizing page → `lib/queries/right-sizing.ts` (16188aef).
    - ✅ channels overview → `lib/queries/channels.ts` (2f3cc814).
    - ✅ settings/roles → `lib/queries/roles.ts` (07b33bfd); also consolidated roles-list types onto the hook.
    - ✅ settings/members → `lib/queries/members.ts` (c03f077f); optimistic revoke; reuses useRoles.
    - ✅ scheduler-settings → `lib/queries/scheduler-settings.ts` (3ea692e2); loader-gate + form-seeded-from-data pattern (reusable for other settings forms).
    - ✅ discovery-settings → `lib/queries/discovery-settings.ts` (b0ff6eb7); loader-gate + live display props.
    - ✅ org-switcher → `lib/queries/orgs.ts` (486a7ae8); useMyOrgs + useSwitchOrg.
    - ✅ shared channel-settings hooks + slack form → `lib/queries/channel-settings.ts` (193e855e). Hook now returns full GET payload.
    - ✅ jira form → shared hooks (4798827e).
    - ✅ discord form → shared hooks (21cfa3ed).
    - ✅ telegram form → shared hooks (3575bef2).
    - ✅ webhook form → shared hooks (5f74adb0). ALL 5 channel forms done.
    - ✅ provider-settings → `lib/queries/providers.ts` (17810a1d); CRUD + test.
    - ✅ knowledge-base page → `lib/queries/knowledge-base.ts` (00c778f2); list + create + delete.
    - ⏭ NEXT — inventory data layer (high-traffic, complex: resources+sync+filters+refs), dashboard sections (refreshKey, multi-file). SKIP/DEFER: mcp-settings (Monaco), org-settings-form (logo S3 flow + overlaps TenantContext — low value/moderate risk), KB detail/sources sub-pages.
- **Phase 2** (toast consolidation) — migrate Radix `toast()` call sites (delete-account-dialog, etc.) to sonner; remove `<Toaster/>` (radix) from `app/layout.tsx`; delete `components/ui/toast.tsx`+`toaster.tsx`+`use-toast` hook. GREP `useToast` / `@/components/ui/use-toast` first.
- **Phase 3** (forms) — migrate ~7 manual `useState` dialogs to RHF+zod (create-account-dialog, edit-account-dialog, create-schedule-dialog, …). Reuse `components/ui/form.tsx`.
- **Phase 4** (Zod 3→4) — DEDICATED: bump zod^4 + @hookform/resolvers compat + t3-env may need ^0.13; fix ~17 zod files (API changes). Full typecheck.
- **Phase 5** (data-layer rollout) — inventory, right-sizing, channels, settings, dashboard → query hooks.
- **Phase 6** (visual overhaul, D1=full) — IN PROGRESS:
    - **6a** ✅ DONE — Geist font properly wired (fixed broken --font-sans), switcher updated. (commit 4049cff)
    - **6b** ✅ DONE — `<PageTransition>` (framer-motion, keyed by pathname, fade+rise, reduced-motion aware) wraps app content in layout-wrapper. (commit 010514d)
    - **6c** ✅ DONE — `components/shared/empty-state.tsx` primitive; wired accounts-grid + schedules-grid. (commit 5b969e5b) Remaining wirings (optional): accounts-table (line ~377 "No accounts found" in a table cell), inventory/audit/right-sizing zero-states, schedules-table/list.
    - **6c-ext** ✅ DONE — `components/shared/page-header.tsx`; wired accounts + schedules page headers. (commit e1fecf0d)
    - **6c-ext2** ✅ DONE — wired audit (0898facc) + inventory (7aabee0b) to PageHeader. 4 pages now consistent.
    - **6c-ext3** ✅ DONE — EmptyState wired into accounts-table + schedules-table (06771931). Grid+table views consistent.
        - LEFTOVER (low priority, do opportunistically): remaining page headers (`components/dashboard/dashboard-header.tsx`, `app/app/settings/*`, `schedules/settings`, `inventory/settings`, right-sizing, knowledge-base) — varied markup, inspect per file.
    - **6d** ✅ DONE — zustand persist store (`lib/stores/theme-config-store.ts`) replaces localStorage-in-Context; provider thinned to DOM side-effects; useThemeConfig() shim keeps consumers working. (commit b422d1c6) ⇒ ALL explicitly-requested stack items adopted (TanStack Query, t3-env, Zod 4, sonner, RHF, zustand).
    - ⚠️ CAUTION: the loop can't see the rendered UI. Favor objective/safe changes (font, motion, spacing tokens, empty-state components). Avoid sweeping layout rewrites that need visual QA — flag those for the user to review. Each 6x sub-phase = its own commit.

## Loop protocol (each 30-min fire)
1. Read this doc + `git log --oneline -8`. 2. Pick first ⏭/unfinished phase. 3. Do ONE coherent chunk. 4. `bunx tsc --noEmit` filtered to touched files (build ignores TS errors but keep new code clean). 5. Commit per phase. 6. Update Progress Log. AI logic (langchain/langgraph) OFF-LIMITS.

## Progress Log
- 2026-06-26 14:41–15:05 — Iteration 1: explored codebase (3 agents); user confirmed D1=full overhaul, D2=incremental commits, D3=Zustand+Zod4. Set up 30-min loop (cron dbc3fe83). Shipped Phase 0 (6629220) + Phase 1a (aff426e). New files typecheck clean. Next: Phase 1b (wire accounts page to hooks).
- 2026-06-26 15:13 — Iteration 2: Shipped Phase 1b (5db9611) — accounts page fully migrated to TanStack Query (list+stats queries, initialData seeding, cache invalidation on mutate). Removed 6 useState + 3 useEffect + manual refetch callbacks. Typecheck clean, no dangling refs. Next: Phase 1c (schedules + audit query hooks + page migrations).
- 2026-06-26 15:?? — Iteration 3 (loop now 15-min, cron 93a5b782): Shipped Phase 1c (4003fe1) — schedules + audit hooks; schedules page migrated (mirrors accounts). Found+routed around dead audit service (live = -api, cursor paginated). Deferred audit COMPONENT migration to 1d. Typecheck clean. Next: Phase 1d (audit page) then Phase 2 (toast consolidation).
- 2026-06-26 16:?? — Iteration 4: Shipped Phase 1d (cd069be) — audit page migrated to TanStack Query (cursor pagination via pageToken→query key; useAuditFilterOptions). Deleted dead client-audit-service.ts. 3 feature pages (accounts/schedules/audit) now fully on TanStack Query. Typecheck clean. Next: Phase 2 (toast consolidation) — biggest cross-cutting change so far (many call sites).
- 2026-06-26 16:?? — Iteration 5: Shipped Phase 2 (d61b4d2) — toast consolidation via SHIM strategy (use-toast.ts forwards to sonner) instead of rewriting ~17 call sites; removed Radix Toaster + deleted toast.tsx/toaster.tsx. Single toast system. Typecheck clean. Next: Phase 3 (forms standardization).
- 2026-06-27 03:?? — Iteration 28: Shipped knowledge-base migration (00c778f2) — list+create+delete hooks. Typecheck clean. 17 surfaces on TanStack Query. Remaining clean targets nearly exhausted; next are complex (inventory/dashboard) or deferred.
- 2026-06-27 02:?? — Iteration 27: Shipped provider-settings migration (17810a1d) — CRUD + test hooks. Typecheck clean. 16 surfaces on TanStack Query. Next: org-settings-form / knowledge-base / heavier pages.
- 2026-06-27 02:?? — Iteration 26: Shipped webhook form migration (5f74adb0) — all 5 channel forms now on shared hooks. Typecheck clean. 15 surfaces on TanStack Query. Next: provider-settings / org-settings-form / heavier pages.
- 2026-06-27 01:?? — Iteration 25: Shipped telegram form migration (3575bef2). Typecheck clean. 14 surfaces on TanStack Query. Next: webhook form (last channel form).
- 2026-06-27 01:?? — Iteration 24: Shipped discord form migration (21cfa3ed). Typecheck clean. 13 surfaces on TanStack Query. Next: telegram + webhook forms.
- 2026-06-27 00:?? — Iteration 23: Shipped jira form migration (4798827e) — extended shared hook to return full payload. Typecheck clean. 12 surfaces on TanStack Query. Next: discord/telegram/webhook forms (same template).
- 2026-06-27 00:?? — Iteration 22: Shipped shared channel-settings hooks + slack form (193e855e). Skipped mcp-settings (low value/high risk — Monaco editor). Typecheck clean. 11 surfaces on TanStack Query. Next: wire remaining 4 channel forms to the shared hooks.
- 2026-06-26 23:?? — Iteration 21: Shipped org-switcher migration (486a7ae8) — useMyOrgs + useSwitchOrg. Typecheck clean. 10 surfaces on TanStack Query. Next: remaining settings forms / inventory / dashboard.
- 2026-06-26 23:?? — Iteration 20: Shipped discovery-settings migration (b0ff6eb7) — loader-gate pattern with live display props. Typecheck clean. 9 pages/components on TanStack Query. Next: remaining settings forms / inventory / dashboard.
- 2026-06-26 22:?? — Iteration 19: Shipped scheduler-settings migration (3ea692e2) — established loader-gate + form-seeded-from-data pattern for settings edit forms. Typecheck clean. 8 pages/components on TanStack Query. Next: remaining settings forms / inventory / dashboard.
- 2026-06-26 22:?? — Iteration 18: Shipped settings/members migration (c03f077f) — useMembers/useInvitations + 4 mutations (optimistic revoke); reuses useRoles. Typecheck clean. 7 pages now on TanStack Query. Next: remaining Phase 5 pages (inventory data layer, dashboard, settings forms).
- 2026-06-26 21:?? — Iteration 17: Shipped settings/roles migration (07b33bfd) — useRoles/useSaveRole/useDeleteRole; consolidated roles-list types onto the hook. Typecheck clean. Next: settings/members, then remaining Phase 5 pages.
- 2026-06-26 21:?? — Iteration 16: Shipped channels migration (2f3cc814) — useChannelStatus parallel-load hook. Typecheck clean. Next: continue Phase 5 (inventory data layer / dashboard / settings).
- 2026-06-26 20:?? — Iteration 15: Shipped Phase 5 start (16188aef) — right-sizing page migrated to TanStack Query (new lib/queries/right-sizing.ts, inline fetches, scan mutation). Typecheck clean. Next: continue Phase 5 rollout (inventory data layer, channels, dashboard, etc.).
- 2026-06-26 20:?? — Iteration 14: Shipped 6d (b422d1c6) — zustand persist store for theme config. ALL requested stack items now adopted. Typecheck clean. Remaining: Phase 5 (data rollout to more pages), leftover header wirings (low pri), subjective visual redesign (needs user's eyes). Next ⏭: Phase 5 — start with a primary page still on raw fetch (e.g. right-sizing or inventory data layer) → query hooks.
- 2026-06-26 20:?? — Iteration 13: Shipped 6c-ext3 (06771931) — EmptyState in accounts/schedules tables. Typecheck clean. Next: 6d (zustand for theme-config state) — higher value than remaining header wiring.
- 2026-06-26 19:?? — Iteration 12: Shipped 6c-ext2 — wired audit (0898facc) + inventory (7aabee0b) headers to PageHeader. 4 pages consistent. Typecheck clean. Next: 6c-ext3 (remaining page headers + table empty-states).
- 2026-06-26 19:?? — Iteration 11: Shipped Phase 6c-ext (e1fecf0d) — shared PageHeader primitive; wired accounts + schedules headers. Typecheck clean. Next: 6c-ext2 (audit + other pages' headers, remaining EmptyState wirings).
- 2026-06-26 19:?? — Iteration 10 (loop now 3-min, cron 5825be95): Shipped Phase 6c (5b969e5b) — EmptyState primitive + wired accounts/schedules grids. Typecheck clean. Next: 6c-ext (more zero-states + PageHeader extraction).
- 2026-06-26 19:?? — Iteration 9: Shipped Phase 6b (010514d) — framer-motion PageTransition wrapper (route-keyed fade+rise, reduced-motion aware). Typecheck clean. Next: 6c (EmptyState primitive + wiring).
- 2026-06-26 18:?? — Iteration 8: Started Phase 6 (visual overhaul). Shipped 6a (4049cff) — Geist font (Sans+Mono) replacing Inter/Manrope; fixed the previously-broken --font-sans wiring; updated font switcher + default. Typecheck clean. Next: 6b (framer-motion page transitions). NOTE: loop can't see UI — favor safe/objective visual changes, flag big layout work for user review.
- 2026-06-26 18:?? — Iteration 7: Shipped Phase 4 (25410b6) — Zod 3→4 global upgrade. Found deepagents requires zod 4 (was mismatched). Only 7 mechanical fixes needed (z.record 2-arg ×2, .errors→.issues ×5); verified net-zero new errors. AI logic untouched. Next: Phase 5 (data rollout) / Phase 6 (visual overhaul — the big remaining piece).
- 2026-06-26 17:?? — Iteration 6: Phase 3. DISCOVERY: the large manual create/edit dialogs were all DEAD (zero importers; live flows use form pages). 3a deleted 4 dead dialogs (d15c0e0). 3b migrated the only live manual form, duplicate-schedule-dialog, to RHF+zod+useCreateSchedule (7e756bb). All live forms standardized. Typecheck clean. Next: Phase 4 (Zod 3→4 breaking upgrade).
