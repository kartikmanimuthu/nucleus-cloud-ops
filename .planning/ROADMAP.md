# Roadmap: Nucleus Cloud Ops

## Milestones

- ✅ **v1.0** DynamoDB → PostgreSQL Migration — Shipped 2026-03-28 → [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0** Pulumi IaC Migration — Shipped 2026-03-30 → [archive](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0** Multi-Tenancy — Shipped 2026-04-01 → [archive](milestones/v3.0-ROADMAP.md)
- ✅ **v4.0** Tenant Isolation Hardening — Shipped 2026-04-03 → [archive](milestones/v4.0-ROADMAP.md)
- 🔄 **v5.0** Horizontal Worker Architecture — In Progress

## Phases

<details>
<summary>✅ v1.0 DynamoDB → PostgreSQL Migration (Phases 1–5) — SHIPPED 2026-03-28</summary>

See [archive](milestones/v1.0-ROADMAP.md) for full phase details.

</details>

<details>
<summary>✅ v2.0 Pulumi IaC Migration (Phases 6–11) — SHIPPED 2026-03-30</summary>

See [archive](milestones/v2.0-ROADMAP.md) for full phase details.

</details>

<details>
<summary>✅ v3.0 Multi-Tenancy (Phases 12–17) — SHIPPED 2026-04-01</summary>

See [archive](milestones/v3.0-ROADMAP.md) for full phase details.

</details>

<details>
<summary>✅ v4.0 Tenant Isolation Hardening (Phases 18–21) — SHIPPED 2026-04-03</summary>

See [archive](milestones/v4.0-ROADMAP.md) for full phase details.

</details>

### v5.0 Horizontal Worker Architecture

- [x] **Phase 22: Executor Abstraction Foundation** - JobExecutor interface + VerticalExecutor with WORKER_ARCH env switching (completed 2026-04-09)
- [x] **Phase 23: Job Wiring + Runner Entrypoint** - All 3 jobs delegate through abstraction; standalone job-runner.ts entrypoint (completed 2026-04-09)
- [ ] **Phase 24: Horizontal Executor + Infra** - HorizontalExecutor ECS RunTask dispatch + Pulumi task definition and IAM

## Phase Details

### Phase 22: Executor Abstraction Foundation
**Goal**: The worker process has a pluggable execution strategy selected at startup via WORKER_ARCH, with VerticalExecutor preserving current in-process behavior exactly
**Depends on**: Nothing (first v5.0 phase)
**Requirements**: EXEC-01, EXEC-02, EXEC-03
**Success Criteria** (what must be TRUE):
  1. Worker starts with WORKER_ARCH=vertical and selects VerticalExecutor without error
  2. Worker starts with WORKER_ARCH=horizontal and selects a strategy without crashing (stub acceptable at this phase)
  3. VerticalExecutor.execute(jobName, jobData) invokes the registered handler in-process and returns
  4. All existing job behavior is unchanged when WORKER_ARCH=vertical — zero regression on scheduler, discovery, kb-sync
**Plans:** 2/2 plans complete
Plans:
- [ ] 22-01-PLAN.md — Executor module: JobExecutor interface, VerticalExecutor, HorizontalExecutor stub, factory, tests
- [ ] 22-02-PLAN.md — Wire executor into entrypoint and all 4 job register() functions

### Phase 23: Job Wiring + Runner Entrypoint
**Goal**: All 3 pg-boss jobs delegate execution through the JobExecutor abstraction, and a standalone job-runner entrypoint can execute any job by name and exit cleanly
**Depends on**: Phase 22
**Requirements**: WIRE-01, WIRE-02, WIRE-03, WIRE-04
**Success Criteria** (what must be TRUE):
  1. Scheduler job triggers via pg-boss and executes through the executor abstraction in vertical mode with no behavior change
  2. Discovery job (fan-out + per-tenant scan) triggers via pg-boss and executes through the executor abstraction in vertical mode
  3. KB sync job (all 4 sub-types: file-upload, s3-sync, confluence-sync, bitbucket-sync) executes through the abstraction in vertical mode
  4. Running `node dist/job-runner.js --job <name> --data '<json>'` executes the correct handler and exits 0 on success, non-zero on failure
**Plans:** 2/2 plans complete
Plans:
- [x] 23-01-PLAN.md — Wire discovery + agent-ops-scheduler through executor, register in entrypoint
- [x] 23-02-PLAN.md — Standalone job-runner.ts entrypoint + export handlers

### Phase 24: Horizontal Executor + Infra
**Goal**: HorizontalExecutor dispatches each pg-boss job to an ephemeral ECS Fargate task via RunTask, and Pulumi provisions all required infrastructure
**Depends on**: Phase 23
**Requirements**: EXEC-04, INFRA-01, INFRA-02, INFRA-03
**Success Criteria** (what must be TRUE):
  1. With WORKER_ARCH=horizontal, a pg-boss job triggers an ECS RunTask call with job name and serialized data passed via container environment overrides
  2. The ephemeral ECS task runs job-runner.js, completes the job, and exits — pg-boss marks the job complete when the handler returns
  3. Pulumi provisions the ephemeral worker task definition, security group, and CloudWatch log group without errors on `pulumi up`
  4. The IAM task role grants STS AssumeRole, RDS connect, S3 read/write, and Bedrock invoke — sufficient for all 3 job types
**Plans:** 2 plans
Plans:
- [x] 23-01-PLAN.md — Wire discovery + agent-ops-scheduler through executor, register in entrypoint
- [ ] 23-02-PLAN.md — Standalone job-runner.ts entrypoint + export handlers

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 12. Auth Foundation | v3.0 | 3/3 | Complete | 2026-03-31 |
| 13. Custom RBAC | v3.0 | 4/4 | Complete | 2026-03-31 |
| 14. Tenant Context Enforcement | v3.0 | 4/4 | Complete | 2026-04-01 |
| 15. Super Admin + Onboarding + Suspension | v3.0 | 2/2 | Complete | 2026-04-01 |
| 16. User Invitations + Onboarding Completion | v3.0 | 2/2 | Complete | 2026-04-01 |
| 17. Org Switcher + Tenant Settings | v3.0 | 3/3 | Complete | 2026-04-01 |
| 18. Accounts & Scheduler Isolation | v4.0 | 2/2 | Complete | 2026-04-03 |
| 19. Inventory & Agent Ops Isolation | v4.0 | 2/2 | Complete | 2026-04-03 |
| 20. Knowledge Base & Channels Isolation | v4.0 | 2/2 | Complete | 2026-04-03 |
| 21. Audit, Settings & Regression Tests | v4.0 | 3/3 | Complete | 2026-04-03 |
| 22. Executor Abstraction Foundation | v5.0 | 1/2 | Complete    | 2026-04-09 |
| 23. Job Wiring + Runner Entrypoint | v5.0 | 2/2 | Complete   | 2026-04-09 |
| 24. Horizontal Executor + Infra | v5.0 | 0/? | Not started | - |
