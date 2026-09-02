# NOTES — Dipanshu's world

Raw notes on tools, channels and terminology. Seeded from facts verified in-repo on 2026-07-30; decisions still open are marked **[OPEN]**.

## Terminology — canonical forms

| User says | Canonical | Note |
|---|---|---|
| "KSL", "CLS", "CASL" | **CASL** | `@casl/ability`. Currently **not installed** — see below. |
| "ABAC" | **ABAC** | Attribute-based: per-rule `conditions`. Zero exist today. |
| "module" | **subject** (CASL) / **module** (this repo's RBAC) | Repo has 6: Accounts, Schedules, AIOps, Inventory, Settings, Dashboard. |
| "action" | **action** | Repo has 4 CRUD: create, read, update, delete. Aliases (`execute`, `manage`, `validate`, `export`, `use`, `approve`) map onto these. |
| "endpoint" | **HTTP handler** | One `route.ts` exporting GET+POST = 2 endpoints. 211 total. |
| "the matrix" | the module × action permission grid | Rendered in `components/settings/role-dialog.tsx`. |

## The system

- **Repo:** `smc-stx-nucleus-cloud-ops`, Nx 21 + Bun monorepo. Branch `feature/casl-abac`, main is `master-v1`.
- **Stack:** Next.js 15.5.15 App Router · React 19 · Prisma + PostgreSQL · NextAuth (JWT, 24h) · TanStack Query · Pulumi → ECS Fargate.
- **Two apps:** `apps/web-ui` (UI + API in one container), `apps/workers` (pg-boss jobs). No Lambda.
- **UI lives at** `app/app/**`; **backend at** `app/api/**`. Both inside `apps/web-ui`.

## Authorization as it stands (verified)

- Engine is **not CASL** — it is a hand-rolled `Record<Module, Action[]>` lookup in `lib/rbac/`. CASL was removed in commit `5c34675`, which deleted `abilities.ts`, `server-ability.ts`, `AbilityContext.tsx`.
- **Backend:** 211 endpoints · 101 guarded by `authorize()` · 88 session-only · 7 unguarded · **52% coverage**.
- **UI, three layers:**
  - page admission — `requireAuth()` in folder layouts — **5 of 17 modules**
  - control gating — **0 of 59 mutating files**
  - nav gating — **0 of 28 destinations**
- **Already dynamic:** `CustomRole` table (`permissions Json`, `type: preset|custom`), preset roles seeded, `UserTenantRole.roleId` FK exists but is unused (roles resolve by *name string*).

## Known defects (from the audit)

F-1 Viewer can PUT/DELETE an AWS account · F-2 agent-run approval unguarded · F-3 `accounts/validate` has no guard · F-4 `knowledge-base` 18 endpoints ungated · F-5 `deep-agent`/`threads` ungated · F-6 template discloses `SPOT_GUARD_BUS_ARN` · F-8 the one UI gate is `role === 'Owner'|'Admin'`, broken for custom roles · F-9 Settings section gated on the `Account` subject. (F-7 retracted.)

## Delegation history in this session — why loops matter here

I audited authorization coverage **twice** and got it wrong **twice**, same root cause both times: grepping for a call in the file where it is used, when the call lives one import away.
- Missed `requireAuth()` in folder layouts → reported UI as 0% gated.
- Missed `handleMcpTest` delegation → reported 2 endpoints unguarded, filed a false SSRF finding (F-7, retracted).

This is the strongest available argument that **"audit authorization coverage" is a loop worth delegating to a machine**, not a task to redo by hand each time.

## Existing artifacts (scratchpad, Notion-importable)

- `dynamic-abac-plan.md` — the 4-phase migration plan, 13 sections, incl. full DB design (§5.1–5.10) and backend/UI splits (§6A/§6B).
- `backend-api-security-report.md` — the coverage audit, both halves.
- `audit-endpoints.mjs`, `audit-ui.mjs`, `check-delegated.mjs` — the scripts that produced the numbers.

## CI — verified, and broken

- `.github/workflows/ci.yml` triggers on `master-v1` push/PR — but `origin` is **Bitbucket** (`bitbucket.org/rohitahuja1/smc-stx-nucleus-cloud-ops`). **GitHub Actions never fires.** Dead file.
- No `bitbucket-pipelines.yml`. **Nothing inspects a PR.**
- `infra/cicd/` CodePipeline sources a CodeStar **GitHub** connection to `kartikmanimuthu/nucleus-cloud-ops` — a different repo *and owner* from the remote actually pushed to. Post-merge on `master-v1`, manual-approval gated. A deploy pipeline, not a PR check.
- Even the dead CI had `lint` and `test` as `continue-on-error: true`.
- No Husky, no lint-staged. **`prepare` is already taken by `prisma generate`** — Husky must be appended, not overwrite it.

## GSD — convention without tooling

- `/gsd:*` commands are **not installed** (neither `.claude/commands/gsd` nor the user-level equivalent). CLAUDE.md mandates the workflow anyway.
- `.planning/` has 20+ phases of precedent. Artifact convention per phase: `NN-CONTEXT.md`, `NN-RESEARCH.md`, `NN-NN-PLAN.md`, `NN-NN-SUMMARY.md`, `NN-VERIFICATION.md`, `NN-DISCUSSION-LOG.md`.
- `STATE.md` is the ledger — YAML frontmatter with `milestone`, `status`, `stopped_at`, `progress`.
- Current: milestone v5.0, phase 24, last activity **2026-04-09** (~4 months stale).
- ABAC work claims **milestone v6.0, phases 25–29**.

## Decisions locked this session

| # | Decision |
|---|---|
| 1 | Two specs: `ship-a-phase` (the loop) + `authz-coverage-audit` (its gate). The permission-change loop is deferred — it cannot be specced honestly until the registry exists. |
| 2 | Audit trigger: **event, `git pre-push`** via Husky. Committed script, pipeline-ready. No new infra. |
| 3 | Failure rule: **baseline allowlist that only shrinks** (`.authz-baseline.json`). Accounted = guard \| `// authZ:` annotation \| baseline entry. Count-ratchet rejected as gameable. |
| 4 | Audit scope: **hard-gate** endpoints + UI page admission (both exactly detectable). **Report-only** control gating + nav until Phase 3 makes their detection exact. |
| 5 | **5 phases, 0–4** (→ 25–29). Discovery is done and drops out of the numbering. The shadow→flip and cutover→UI seams are load-bearing and must not merge. |
| 6 | Artifacts conform to the **`.planning/` GSD convention**, milestone v6.0. One ledger, not two. |
| 7 | **Six checkpoints**: one at each phase exit, plus a **pre-flip gate in Phase 27**. Push-right everywhere it's safe; one exception where deferring would put the decision after the consequence. |

## Their world — **[OPEN]**, to grill

- Team size / who else ships to this repo? Solo or reviewers?
- CI: is there a pipeline that could host a recurring check? (`infra/cicd/` has CodeBuild specs — unverified whether PRs run anything.)
- Where do they want to be interrupted — Bitbucket PR, Slack, Telegram, terminal? (Repo integrates Slack, Telegram, Discord, Jira as *product* channels; unknown which they personally use for work.)
- Cadence: is this ABAC migration a this-week push or a background track?
- GSD workflow (`/gsd:*`) is mandated by CLAUDE.md for repo edits — how strictly?
