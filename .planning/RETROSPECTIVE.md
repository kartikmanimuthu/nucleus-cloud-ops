# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v5.0 — Horizontal Worker Architecture

**Shipped:** 2026-04-09
**Phases:** 3 | **Plans:** 6 | **Sessions:** 1

### What Was Built
- JobExecutor interface + VerticalExecutor (in-process, Map-based dispatch) + HorizontalExecutor (ECS RunTask with exponential backoff polling)
- All 3 pg-boss jobs (scheduler, discovery, kb-sync) wired through the abstraction — zero behavior change in vertical mode
- Standalone job-runner.ts entrypoint: receives `--job` and `--data` CLI args, runs handler, exits with correct code
- Pulumi infra: ephemeral worker task definition (256 CPU/512 MiB, ARM64), CloudWatch log group (7-day retention), IAM dispatch policy (RunTask + DescribeTasks + PassRole), HORIZONTAL_* env vars wired into workers service

### What Worked
- Parallel wave execution (24-01 and 24-02 spawned simultaneously) saved significant time
- Plan specs were precise enough that the executor agent produced correct code on first attempt for 24-01 (13/13 tests passing)
- Cherry-picking individual commits from worktree branches is cleaner than merging full branches when only the implementation commit is needed
- TypeScript compile check (`npx tsc --noEmit`) as the primary verification gate for Pulumi infra changes is fast and reliable

### What Was Inefficient
- 24-02 agent failed silently — it couldn't find plan files in its worktree and produced no commits; required inline execution as fallback
- Worktree agents sometimes work on stale branches that diverge from the main branch, causing cherry-pick conflicts on planning files (STATE.md, REQUIREMENTS.md)
- `pulumi.all()` with mixed `Output<string>` and `Output<string[]>` types requires pre-joining arrays before passing — not obvious from Pulumi docs

### Patterns Established
- `privateSubnetIds.apply(ids => ids.join(","))` pattern for passing subnet lists as env vars in Pulumi task definitions
- Move security group definition before task definition when the SG ID is needed as an env var in the task def
- Executor agents in worktrees: cherry-pick only the implementation commit (not the docs/summary commit) to avoid planning file merge conflicts

### Key Lessons
1. When a parallel agent fails silently (no SUMMARY.md, no commits), fall back to inline execution immediately rather than retrying the agent
2. Pulumi `pulumi.all()` only accepts `Input<string>` elements — pre-resolve `Output<string[]>` to `Output<string>` before including in the array
3. Resource ordering matters in Pulumi: define resources before they're referenced, even within the same file

### Cost Observations
- Model mix: ~100% sonnet (executor + verifier)
- Sessions: 1 (all 3 phases executed in a single session)
- Notable: Entire v5.0 milestone (3 phases, 6 plans) completed in a single day

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 5 | ~10 | Initial DynamoDB → PostgreSQL migration |
| v2.0 | 6 | 17 | Pulumi IaC migration |
| v3.0 | 6 | 18 | Multi-tenancy foundation |
| v4.0 | 4 | 9 | Tenant isolation hardening |
| v5.0 | 3 | 6 | Horizontal worker architecture |

### Top Lessons (Verified Across Milestones)

1. Parallel agent execution with worktrees is fast but requires fallback handling for silent failures
2. TypeScript strict mode + `npx tsc --noEmit` as a gate catches Pulumi type issues before deploy
3. Explicit physical names on every Pulumi resource prevents delete+create on rename
