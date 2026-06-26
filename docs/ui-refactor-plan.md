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
- **Phase 5** ⏭ NEXT (data-layer rollout) — migrate remaining list/detail pages off raw fetch+useEffect to query hooks: inventory, right-sizing, channels, settings, dashboard. Add `lib/queries/<domain>.ts` per domain as needed (mirror accounts.ts). Lower urgency than visual; can interleave with Phase 6.
- **Phase 2** (toast consolidation) — migrate Radix `toast()` call sites (delete-account-dialog, etc.) to sonner; remove `<Toaster/>` (radix) from `app/layout.tsx`; delete `components/ui/toast.tsx`+`toaster.tsx`+`use-toast` hook. GREP `useToast` / `@/components/ui/use-toast` first.
- **Phase 3** (forms) — migrate ~7 manual `useState` dialogs to RHF+zod (create-account-dialog, edit-account-dialog, create-schedule-dialog, …). Reuse `components/ui/form.tsx`.
- **Phase 4** (Zod 3→4) — DEDICATED: bump zod^4 + @hookform/resolvers compat + t3-env may need ^0.13; fix ~17 zod files (API changes). Full typecheck.
- **Phase 5** (data-layer rollout) — inventory, right-sizing, channels, settings, dashboard → query hooks.
- **Phase 6** (visual overhaul, D1=full) — Geist font in layout, framer-motion route/page transitions, refine sidebar/spacing/density, dashboard cards, empty states, consistent TanStack Table styling, zustand for UI/theme-config state.

## Loop protocol (each 30-min fire)
1. Read this doc + `git log --oneline -8`. 2. Pick first ⏭/unfinished phase. 3. Do ONE coherent chunk. 4. `bunx tsc --noEmit` filtered to touched files (build ignores TS errors but keep new code clean). 5. Commit per phase. 6. Update Progress Log. AI logic (langchain/langgraph) OFF-LIMITS.

## Progress Log
- 2026-06-26 14:41–15:05 — Iteration 1: explored codebase (3 agents); user confirmed D1=full overhaul, D2=incremental commits, D3=Zustand+Zod4. Set up 30-min loop (cron dbc3fe83). Shipped Phase 0 (6629220) + Phase 1a (aff426e). New files typecheck clean. Next: Phase 1b (wire accounts page to hooks).
- 2026-06-26 15:13 — Iteration 2: Shipped Phase 1b (5db9611) — accounts page fully migrated to TanStack Query (list+stats queries, initialData seeding, cache invalidation on mutate). Removed 6 useState + 3 useEffect + manual refetch callbacks. Typecheck clean, no dangling refs. Next: Phase 1c (schedules + audit query hooks + page migrations).
- 2026-06-26 15:?? — Iteration 3 (loop now 15-min, cron 93a5b782): Shipped Phase 1c (4003fe1) — schedules + audit hooks; schedules page migrated (mirrors accounts). Found+routed around dead audit service (live = -api, cursor paginated). Deferred audit COMPONENT migration to 1d. Typecheck clean. Next: Phase 1d (audit page) then Phase 2 (toast consolidation).
- 2026-06-26 16:?? — Iteration 4: Shipped Phase 1d (cd069be) — audit page migrated to TanStack Query (cursor pagination via pageToken→query key; useAuditFilterOptions). Deleted dead client-audit-service.ts. 3 feature pages (accounts/schedules/audit) now fully on TanStack Query. Typecheck clean. Next: Phase 2 (toast consolidation) — biggest cross-cutting change so far (many call sites).
- 2026-06-26 16:?? — Iteration 5: Shipped Phase 2 (d61b4d2) — toast consolidation via SHIM strategy (use-toast.ts forwards to sonner) instead of rewriting ~17 call sites; removed Radix Toaster + deleted toast.tsx/toaster.tsx. Single toast system. Typecheck clean. Next: Phase 3 (forms standardization).
- 2026-06-26 18:?? — Iteration 7: Shipped Phase 4 (25410b6) — Zod 3→4 global upgrade. Found deepagents requires zod 4 (was mismatched). Only 7 mechanical fixes needed (z.record 2-arg ×2, .errors→.issues ×5); verified net-zero new errors. AI logic untouched. Next: Phase 5 (data rollout) / Phase 6 (visual overhaul — the big remaining piece).
- 2026-06-26 17:?? — Iteration 6: Phase 3. DISCOVERY: the large manual create/edit dialogs were all DEAD (zero importers; live flows use form pages). 3a deleted 4 dead dialogs (d15c0e0). 3b migrated the only live manual form, duplicate-schedule-dialog, to RHF+zod+useCreateSchedule (7e756bb). All live forms standardized. Typecheck clean. Next: Phase 4 (Zod 3→4 breaking upgrade).
