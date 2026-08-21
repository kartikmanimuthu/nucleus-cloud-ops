# RBAC Adoption Record

**Date:** 2026-08-01
**Outcome:** `feature/casl-abac` adopted as the authorization implementation. The parallel
`casl-imp` plan is superseded and **nothing from it was ported.**

---

## What happened

A plan was written and partially executed on branch `casl-imp` to build a dynamic RBAC/ABAC
layer (`libs/casl`, code-declared manifests, a permission registry, condition presets). Seven
commits landed, all reviewed.

Partway through, the shared dev database was found to already contain a *different*, populated
dynamic RBAC implementation — 12 `rbac_*` tables with 72 role rules — applied by three
migrations absent from `casl-imp`. It came from a second checkout on branch
`feature/casl-abac`, where 170 files sat uncommitted.

A comparison was written
(`2026-08-01-rbac-implementation-comparison.md`), the decision was to adopt
`feature/casl-abac`, and this record captures what that actually took — including two places
where the comparison's own conclusions were wrong.

## Corrections to the comparison document

The comparison claimed `casl-imp` had two advantages worth porting. **Closer reading of the
adopted code shows neither survives.** Both claims are retracted here.

### Retracted claim 1 — "only `casl-imp` has a framework-agnostic library"

False. `feature/casl-abac` ships **`libs/rbac/`**, a proper Nx library containing
`condition-schema.ts`, `rule-compiler.ts`, `registry-types.ts`, `types.ts`, and
`generated/route-manifest.json`, with its own `package.json`, `project.json`, `tsconfig.json`,
and `vitest.config.ts`. It imports nothing from `apps/web-ui`.

The claim was made from an incomplete file listing that missed the untracked `libs/rbac/`
directory. `apps/workers` can import it exactly as it would have imported `libs/casl`.

### Retracted claim 2 — "only `casl-imp` catches invalid (action, subject) pairs"

False, and the adopted version is **stronger**. `apps/web-ui/lib/rbac/parity.test.ts` harvests
pairs from `libs/rbac/generated/route-manifest.json` — a build-time inventory of **1,306
entries covering every route**, not a regex scrape — and asserts:

- every subject used by a route is registered;
- every verb used by a route resolves through the alias map;
- **for every pair × every preset role, the legacy matrix and CASL reach the same decision.**

That third assertion is a guarantee `casl-imp`'s drift test never made. The test's own comment
records that it already caught real bugs: *"This is how AIOps and Settings were caught."*

By contrast, `casl-imp`'s drift test scanned source text with two regexes and checked only that
pairs were registered — and a review had already found it blind to indirect
`authorize(variable, variable)` call sites, which had to be fixed with a second regex.

### The one difference that is real, and why it is not a defect

`casl-imp` derived `Subject`/`Action` as narrow literal union types, so `authorize('delete',
'Shcedule')` failed the build. The adopted implementation types both as `string`, documented in
`libs/rbac/types.ts`: *"Subjects and actions are database-driven, so they are `string` at the
type"* level.

**That is a deliberate trade, not an oversight, and it is the correct one for this design.**
Narrow literal unions are only sound when the taxonomy is fixed at compile time. The adopted
implementation lets a tenant admin add an action row at runtime — the original requirement that
started this work. Porting derived types would re-close exactly the door the feature exists to
open. The `route-manifest` + parity harness recovers the safety by a different route:
build-time inventory validated against the live registry.

**Conclusion: nothing from `casl-imp` should be ported.**

## What was done

1. **Preserved the work.** Committed 170 files on `feature/casl-abac` in the second checkout as
   `0b1b3cc` — 51 added, 127 modified, 1 deleted. Verified beforehand: no secrets, no
   `node_modules` staged, 124 RBAC tests passing.
2. **Brought it into this checkout.** Added the second checkout as a local git remote and
   fetched. No network round-trip and no push required.
3. **Merged mainline.** `feature/casl-abac` had forked at `4df7ab1` and was **44 commits behind
   `master-v1`**, missing the spot-guard and chatbot-persona work — including
   `daa194d fix(rbac): preset roles were missing in every deployed environment`. Only **5 files
   overlapped**, so the merge was clean: `01857b7` on `integration/rbac-adopt`.
4. **Linked the new workspace package.** Three RBAC test files failed with
   `Cannot find package '@nucleus/rbac'` until `bun install` linked `libs/rbac`. Not a merge
   defect — a new workspace member this checkout had never installed.
5. **Verified.** 9 files, **128 RBAC tests passing** on the merged tree (up from 124, the extra
   four arriving with the mainline RBAC fix).

## Current state

| | |
|---|---|
| Working branch | `integration/rbac-adopt` — 43 commits ahead of `master-v1`, unpushed |
| RBAC tests | 128 passing across 9 files |
| Rollout posture | `DYNAMIC_ABAC_ENABLED=false`, `RBAC_ROUTE_GUARD_MODE=shadow` — legacy matrix still authoritative, CASL shadow-compared, disagreements reported as `rbac.parity.mismatch` |
| `casl-imp` | Intact, 8 commits, superseded. Retained only as a record |
| `libs/casl` | Not on this branch (zero tracked files); exists only on `casl-imp` |
| Shared database | Never modified by `casl-imp` — still 12 `rbac_*` tables, 72 role rules |
| `nucleus_casl` database | Disposable; created only to isolate `casl-imp`'s migrations |

## Open items

1. **Push `integration/rbac-adopt`** — 43 commits exist only locally, in two working copies.
2. **Decide `casl-imp`'s fate** — delete, or keep as a record of the superseded approach.
3. **Drop the `nucleus_casl` database** once `casl-imp` is retired.
4. **The rollout flags are still shadow-mode.** Flipping `DYNAMIC_ABAC_ENABLED` to `true` is the
   real cutover and has not been attempted or scheduled. The parity harness is the evidence
   base for that decision.
5. **The second checkout still holds `0b1b3cc`** and will diverge from this one unless the
   branch is pushed and that copy is reset to track it.
