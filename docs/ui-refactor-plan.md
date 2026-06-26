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
- **Phase 1b** ⏭ NEXT — migrate accounts page to the hooks (proof of pattern):
    - `components/accounts/accounts-client-component.tsx`: loadAccountsWithFilters/useEffect → `useAccounts`; stats → query; dialog `onUpdated/onCreated/onDeleted` callbacks → rely on mutation invalidation.
    - Keep behavior identical (filters, pagination, URL sync). Verify via playwright MCP if dev server runnable.
- **Phase 1c** — add schedules + audit query hooks (mirror `accounts.ts`), migrate those pages.
- **Phase 2** (toast consolidation) — migrate Radix `toast()` call sites (delete-account-dialog, etc.) to sonner; remove `<Toaster/>` (radix) from `app/layout.tsx`; delete `components/ui/toast.tsx`+`toaster.tsx`+`use-toast` hook. GREP `useToast` / `@/components/ui/use-toast` first.
- **Phase 3** (forms) — migrate ~7 manual `useState` dialogs to RHF+zod (create-account-dialog, edit-account-dialog, create-schedule-dialog, …). Reuse `components/ui/form.tsx`.
- **Phase 4** (Zod 3→4) — DEDICATED: bump zod^4 + @hookform/resolvers compat + t3-env may need ^0.13; fix ~17 zod files (API changes). Full typecheck.
- **Phase 5** (data-layer rollout) — inventory, right-sizing, channels, settings, dashboard → query hooks.
- **Phase 6** (visual overhaul, D1=full) — Geist font in layout, framer-motion route/page transitions, refine sidebar/spacing/density, dashboard cards, empty states, consistent TanStack Table styling, zustand for UI/theme-config state.

## Loop protocol (each 30-min fire)
1. Read this doc + `git log --oneline -8`. 2. Pick first ⏭/unfinished phase. 3. Do ONE coherent chunk. 4. `bunx tsc --noEmit` filtered to touched files (build ignores TS errors but keep new code clean). 5. Commit per phase. 6. Update Progress Log. AI logic (langchain/langgraph) OFF-LIMITS.

## Progress Log
- 2026-06-26 14:41–15:05 — Iteration 1: explored codebase (3 agents); user confirmed D1=full overhaul, D2=incremental commits, D3=Zustand+Zod4. Set up 30-min loop (cron dbc3fe83). Shipped Phase 0 (6629220) + Phase 1a (aff426e). New files typecheck clean. Next: Phase 1b (wire accounts page to hooks).
