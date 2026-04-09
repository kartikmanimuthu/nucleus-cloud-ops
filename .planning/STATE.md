---
gsd_state_version: 1.0
milestone: v5.0
milestone_name: Horizontal Worker Architecture
status: planning
stopped_at: Phase 22 context gathered
last_updated: "2026-04-09T03:30:41.718Z"
last_activity: 2026-04-08 — Roadmap created for v5.0
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-08)

**Core value:** Multi-tenant SaaS cloud ops platform with dual auth, custom RBAC, tenant isolation, invitations, org switching, and branding
**Current focus:** v5.0 Horizontal Worker Architecture — WORKER_ARCH env-driven execution strategy for pg-boss jobs

## Current Position

Phase: 22 (not started)
Plan: —
Status: Roadmap ready — awaiting phase planning
Last activity: 2026-04-08 — Roadmap created for v5.0

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 18
- Timeline: 2 days (2026-03-31 → 2026-04-01)

**By Phase:**

| Phase | Plans | Completed |
|-------|-------|-----------|
| 12. Auth Foundation | 3 | 2026-03-31 |
| 13. Custom RBAC | 4 | 2026-03-31 |
| 14. Tenant Context Enforcement | 4 | 2026-04-01 |
| 15. Super Admin + Onboarding | 2 | 2026-04-01 |
| 16. User Invitations | 2 | 2026-04-01 |
| 17. Org Switcher + Settings | 3 | 2026-04-01 |
| Phase 18 P01 | 5 | 2 tasks | 2 files |
| Phase 18 P02 | 8 | 2 tasks | 8 files |
| Phase 19-inventory-agent-ops-isolation P01 | 10 | 2 tasks | 4 files |
| Phase 19-inventory-agent-ops-isolation P02 | 15 | 2 tasks | 15 files |
| Phase 20-knowledge-base-channels-isolation P02 | 5 | 1 tasks | 2 files |
| Phase 20-knowledge-base-channels-isolation P01 | 15 | 2 tasks | 8 files |
| Phase 21-audit-settings-regression-tests P01 | 10 | 2 tasks | 6 files |
| Phase 21-audit-settings-regression-tests P03 | 8 | 2 tasks | 6 files |
| Phase 21-audit-settings-regression-tests P02 | 18 | 2 tasks | 10 files |

## Accumulated Context

### Decisions

See PROJECT.md Key Decisions table for full log.

- [Phase 18]: getTenantClient(tenantId) in repository layer — Prisma middleware auto-injects tenantId on every query
- [Phase 18]: Pre-flight ownership check in API route layer returns 403 before any cross-tenant mutation attempt
- [Phase 18]: getTenantClient(tenantId) in SchedulePostgresRepository and ScheduleExecutionPostgresRepository — all 9 methods now tenant-scoped
- [Phase 18]: Pre-flight ownership checks on schedule PUT/DELETE/toggle return 403 before any cross-tenant mutation
- [Phase 19-inventory-agent-ops-isolation]: getPrismaClient() retained only for cross-entity account→tenantId lookup in upsertResource/upsertBatch
- [Phase 19-inventory-agent-ops-isolation]: getTenantClient(tenantId) in all 3 agent-ops repositories; cross-tenant webhook methods kept on getPrismaClient with explicit comments
- [Phase 19-inventory-agent-ops-isolation]: All 11 agent-ops API routes derive tenantId from getSessionTenantId(); pre-flight 403 on approve/cancel/resume (D-06) and all scheduled-task mutations (D-08)
- [Phase 20-knowledge-base-channels-isolation]: TenantConfigService already accepted tenantId — no service changes needed, only route-layer fix
- [Phase 20-knowledge-base-channels-isolation]: getTenantClient(tenantId) in KB and DataSource repos — consistent with Phase 18/19 pattern
- [Phase 20-knowledge-base-channels-isolation]: Data source service methods called without tenantId — isolation via parent KB ownership pre-flight
- [Phase 20-knowledge-base-channels-isolation]: Query route: tenantId extracted unconditionally; no-kbId path filters to tenant KB IDs to prevent cross-tenant vector leakage
- [Phase 21-audit-settings-regression-tests]: AuditLogPostgresRepository uses getTenantClient(tenantId) for both createAuditLog and getAuditLogs — consistent with Phase 18/19/20 pattern
- [Phase 21-audit-settings-regression-tests]: tenantId promoted from metadata-only to top-level property in all logUserAction/logResourceAction calls so repository layer can extract it
- [Phase 21-audit-settings-regression-tests]: Mock at service layer for static-class routes; mock at repo/service-object layer for direct-call routes
- [Phase 21-audit-settings-regression-tests]: audit-logs.test.ts: session-error path returns 500 with AuditService never called — proves no unscoped data path
- [Phase 21-audit-settings-regression-tests]: Repos with cross-tenant methods mock both getTenantClient and getPrismaClient; isolation assertions only cover tenant-scoped methods
- [260406-rju]: Scheduler settings backed by TenantConfigService (key: scheduler-cron) — no EventBridge dependency
- [260406-rju]: Per-tenant pg-boss queues (scheduler-scan:<tenantId>) registered on workers startup; scheduler-reschedule queue handles live interval changes

### Pending Todos

- LangGraph thread ID migration script (bare UUIDs → tenantId:userId:uuid) — needed before production launch
- Resend domain verification (SPF/DKIM) — blocks production email delivery

### Blockers/Concerns

None.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260328-udt | Set up local dev environment and verify PostgreSQL migration works end-to-end | 2026-03-28 | bff3e55 | [260328-udt-set-up-local-dev-environment-and-verify-](./quick/260328-udt-set-up-local-dev-environment-and-verify-/) |
| 260330-nds | write all test cases for account module - add, edit, delete, activate, search, filter, pagination - unit and e2e tests, execute and validate, report bugs | 2026-03-30 | cdd518f | [260330-nds-write-all-test-cases-for-account-module-](./quick/260330-nds-write-all-test-cases-for-account-module-/) |
| 260330-qkm | Schedule module full test coverage — unit tests for ScheduleService, API routes, and E2E tests for CRUD, activate/deactivate, search, filter, pagination | 2026-03-30 | 3dc4981 | [260330-qkm-schedule-module-full-test-coverage-unit-](./quick/260330-qkm-schedule-module-full-test-coverage-unit-/) |
| 260330-qkm | schedule module full test coverage — 67 unit tests for ScheduleService, ScheduleExecutionService, and all API routes | 2026-03-30 | a8b580d | [260330-qkm-schedule-module-full-test-coverage-unit-](./quick/260330-qkm-schedule-module-full-test-coverage-unit-/) |
| 260331-00a | Fix 7 schedule bugs: duplicate React keys, resourceTypes dedup, day ordering, nextExecution computation, start/end time validation, stats cards filtering, E2E test fix | 2026-03-31 | 86884a1 | [260331-00a-fix-7-schedule-bugs-duplicate-react-keys](./quick/260331-00a-fix-7-schedule-bugs-duplicate-react-keys/) |
| 260331-jd8 | Add pagination support for accounts and schedules modules — total records, page size selector, next/previous navigation, PostgreSQL server-side pagination | 2026-03-31 | e6a3924 | [260331-jd8-add-pagination-support-for-the-account-m](./quick/260331-jd8-add-pagination-support-for-the-account-m/) |
| 260331-m7t | Implement server-side pagination UI — reusable PaginationBar component applied to accounts, schedules, and inventory; inventory switched to offset-based pagination | 2026-03-31 | ce25d19 | [260331-m7t-implement-server-side-pagination-ui-and-](./quick/260331-m7t-implement-server-side-pagination-ui-and-/) |
| 260331-ocp | Migrate Ask AI from S3 Vectors + DynamoDB to PostgreSQL pgvector | 2026-03-31 | 2fef9ab | [260331-ocp-migrate-ask-ai-from-s3-vectors-dynamodb-](./quick/260331-ocp-migrate-ask-ai-from-s3-vectors-dynamodb-/) |
| 260331-rpk | Create PostgreSQL RDS database in Pulumi and wire DATABASE_URL to all dependent services | 2026-03-31 | f09d2d3 | [260331-rpk-create-postgresql-rds-database-in-pulumi](./quick/260331-rpk-create-postgresql-rds-database-in-pulumi/) |
| 260331-vh0 | Disable DynamoDB and enable PostgreSQL via feature flag environment variable, deploy via Pulumi | 2026-03-31 | a749767 | [260331-vh0-disable-dynamodb-and-enable-postgresql-v](./quick/260331-vh0-disable-dynamodb-and-enable-postgresql-v/) |
| 260402-1et | fix post-login redirect loop cognito and credentials login not navigating to app | 2026-04-01 | 8e914bf | [260402-1et-fix-post-login-redirect-loop-cognito-and](.planning/quick/260402-1et-fix-post-login-redirect-loop-cognito-and/) |
| 260403-j7b | logged in user should have provision to create his new tenant and switch the tenant and the whole application should render based on the switched tenant | 2026-04-03 | d9912b2 | [260403-j7b-logged-in-user-should-have-provision-to-](.planning/quick/260403-j7b-logged-in-user-should-have-provision-to-/) |
| 260406-q66 | Remove DynamoDB from inventory module, replace EventBridge sync with pg-boss | 2026-04-06 | 96b6313 | [260406-q66-remove-dynamodb-from-inventory-module-re](./quick/260406-q66-remove-dynamodb-from-inventory-module-re/) |
| 260403-s0b | fix invitation login - invited users cannot login with temporary credentials | 2026-04-03 | bf1f57e | [260403-s0b-fix-invitation-login-invited-users-canno](.planning/quick/260403-s0b-fix-invitation-login-invited-users-canno/) |
| 260403-seb | fix custom roles not appearing in invite dropdown + logo upload silent failure | 2026-04-03 | e994405 | [260403-seb-fix-custom-roles-not-appearing-in-invite](.planning/quick/260403-seb-fix-custom-roles-not-appearing-in-invite/) |
| 260403-t3i | fix scheduler account dropdown to show tenant-scoped accounts and scope schedule creation to tenant | 2026-04-03 | — | [260403-t3i-fix-scheduler-account-dropdown-to-show-t](.planning/quick/260403-t3i-fix-scheduler-account-dropdown-to-show-t/) |
| 260403-u7l | fix role ID gap, seed default roles, multi-org membership | 2026-04-03 | 10f5497 | [260403-u7l-fix-role-id-gap-seed-default-roles-multi](.planning/quick/260403-u7l-fix-role-id-gap-seed-default-roles-multi/) |
| 260403-wqs | add preset/custom type segregation to custom_roles table and UI | 2026-04-03 | 41bda37 | [260403-wqs-add-preset-custom-type-segregation-to-cu](.planning/quick/260403-wqs-add-preset-custom-type-segregation-to-cu/) |
| 260404-g74 | Add role editing for team members and pagination to both Team Members and Pending Invitations grids on the Settings Members page | 2026-04-04 | a16f820 | [260404-g74-add-role-editing-for-team-members-and-pa](.planning/quick/260404-g74-add-role-editing-for-team-members-and-pa/) |
| 260405-o6h | add fulltext search for inventory module with metadata column and search_vector column | 2026-04-05 | 957de18 | [260405-o6h-add-fulltext-search-for-inventory-module](.planning/quick/260405-o6h-add-fulltext-search-for-inventory-module/) |
| 260405-r0e | tenant isolation and postgres migration for aiops agent and agent-ops modules | 2026-04-05 | d1ab61f | [260405-r0e-tenant-isolation-and-postgres-migration-](./quick/260405-r0e-tenant-isolation-and-postgres-migration-/) |
| 260405-r9g | migrate knowledge base module from DynamoDB to PostgreSQL with tenant isolation | 2026-04-05 | 8eff2ff | [260405-r9g-migrate-knowledge-base-module-from-dynam](./quick/260405-r9g-migrate-knowledge-base-module-from-dynam/) |
| 260405-rce | migrate channels module from DynamoDB to PostgreSQL with tenant isolation | 2026-04-05 | 2f5a2b8 | [260405-rce-migrate-channels-module-from-dynamodb-to](./quick/260405-rce-migrate-channels-module-from-dynamodb-to/) |
| 260406-rm8 | Remove the old user modules implementation as we are currently moved to RBAC implementation | 2026-04-06 | d314c52 | [260406-rm8-remove-the-old-user-modules-implementati](./quick/260406-rm8-remove-the-old-user-modules-implementati/) |
| 260406-rju | Per-tenant scheduler cron configuration with pg-boss replacing EventBridge | 2026-04-06 | — | [260406-rju-per-tenant-scheduler-cron-configuration-](.planning/quick/260406-rju-per-tenant-scheduler-cron-configuration-/) |
| 260406-vff | add logging for inventory discovery worker similar like scheduler pattern | 2026-04-06 | d70da12 | [260406-vff-add-logging-for-inventory-discovery-work](./quick/260406-vff-add-logging-for-inventory-discovery-work/) |
| 260406-wz6 | Move Members and Roles from Settings to dedicated Users & Permissions sidebar section | 2026-04-06 | 8a85bd5 | [260406-wz6-move-members-and-roles-from-settings-to-](./quick/260406-wz6-move-members-and-roles-from-settings-to-/) |
| 260407-dqr | Refactor logging to industry-standard log levels in kb-sync and discovery jobs | 2026-04-07 | 8943881 | [260407-dqr-refactor-logging-to-industry-standard-lo](./quick/260407-dqr-refactor-logging-to-industry-standard-lo/) |
| 260408-1ew | Remove S3 Vectors, store KB embeddings in PostgreSQL pgvector | 2026-04-07 | ddd638e | [260408-1ew-remove-s3-vectors-implementation-store-k](./quick/260408-1ew-remove-s3-vectors-implementation-store-k/) |
| 260408-1mm | Fix inventory discovery worker reliability — singletonKey silent drops, expiry blocking, status persistence | 2026-04-07 | — | [260408-1mm-fix-inventory-discovery-worker-job-not-t](./quick/260408-1mm-fix-inventory-discovery-worker-job-not-t/) |
| 260408-32q | Fix discovery scanner stuck — not scanning all AWS account resources | 2026-04-07 | — | [260408-32q-fix-discovery-scanner-stuck-not-scanning](./quick/260408-32q-fix-discovery-scanner-stuck-not-scanning/) |
| 260408-nhh | Remove DynamoDB dead code and feature flags from agent persistence — PostgreSQL only | 2026-04-08 | 519c9a8 | [260408-nhh-remove-dynamodb-dead-code-and-feature-fl](./quick/260408-nhh-remove-dynamodb-dead-code-and-feature-fl/) |
| 260408-stg | Fix back button navigation across all modules to prevent 404 errors | 2026-04-08 | — | [260408-stg-fix-back-button-navigation-across-all-mo](./quick/260408-stg-fix-back-button-navigation-across-all-mo/) |
| 260408-t9s | Remove DynamoDB dependencies from agent-ops module, use PostgreSQL only, agent-ops scheduled tasks should use pg-boss | 2026-04-08 | f192312 | [260408-t9s-remove-dynamodb-dependencies-from-agent-](./quick/260408-t9s-remove-dynamodb-dependencies-from-agent-/) |

## Session Continuity

Last activity: 2026-04-08 - Completed quick task 260408-t9s: Remove DynamoDB from agent-ops, migrate scheduler to pg-boss
Last session: 2026-04-09T03:30:41.714Z
Stopped at: Phase 22 context gathered
Resume file: .planning/phases/22-executor-abstraction-foundation/22-CONTEXT.md
