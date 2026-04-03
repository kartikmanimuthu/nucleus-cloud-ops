# Roadmap: Nucleus Cloud Ops

## Milestones

- ✅ **v1.0** DynamoDB → PostgreSQL Migration — Shipped 2026-03-28 → [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0** Pulumi IaC Migration — Shipped 2026-03-30 → [archive](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0** Multi-Tenancy — Shipped 2026-04-01 → [archive](milestones/v3.0-ROADMAP.md)
- 🔄 **v4.0** Tenant Isolation Hardening — In progress

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

### v4.0 Tenant Isolation Hardening

- [ ] **Phase 18: Accounts & Scheduler Isolation** - Fix tenant scoping for AWS Accounts and Cost Scheduler CRUD
- [ ] **Phase 19: Inventory & Agent Ops Isolation** - Fix tenant scoping for Inventory Discovery and AI Ops modules
- [ ] **Phase 20: Knowledge Base & Channels Isolation** - Fix tenant scoping for Knowledge Base and Channels CRUD
- [ ] **Phase 21: Audit, Settings & Regression Tests** - Fix audit log scoping, settings isolation, and add regression test coverage

## Phase Details

### Phase 18: Accounts & Scheduler Isolation
**Goal**: All AWS account and schedule CRUD operations are correctly scoped to the active tenant
**Depends on**: Nothing (first phase of v4.0)
**Requirements**: ACCT-01, ACCT-02, ACCT-03, ACCT-04, ACCT-05, SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05, SCHED-06
**Success Criteria** (what must be TRUE):
  1. User sees only their tenant's AWS accounts in the list — no cross-tenant accounts appear
  2. Creating an AWS account stores the active tenantId on insert
  3. Updating or deleting an account belonging to a different tenant returns 403
  4. Schedule list, execution history, and targeted resources return only the active tenant's data
  5. Creating a schedule stores the active tenantId on insert; search/filter queries include tenant scope
**Plans:** 2 plans
Plans:
- [ ] 18-01-PLAN.md — Harden AWS Account CRUD with tenant isolation (repo migration + ownership checks)
- [ ] 18-02-PLAN.md — Harden Cost Scheduler CRUD and execution history with tenant isolation

### Phase 19: Inventory & Agent Ops Isolation
**Goal**: Inventory resources and agent ops data are fully scoped to the active tenant
**Depends on**: Phase 18
**Requirements**: INVT-01, INVT-02, INVT-03, AIOP-01, AIOP-02, AIOP-03, AIOP-04
**Success Criteria** (what must be TRUE):
  1. Inventory list and search return only resources belonging to the active tenant
  2. Viewing a resource detail from another tenant returns 404 or 403 — never the resource
  3. Agent ops run list shows only the active tenant's runs
  4. Agent ops events for a run are scoped — another tenant's run ID returns empty or 404
  5. Scheduled tasks list and management operations are scoped to the active tenant
**Plans**: TBD

### Phase 20: Knowledge Base & Channels Isolation
**Goal**: Knowledge base and channel CRUD operations are fully scoped to the active tenant
**Depends on**: Phase 18
**Requirements**: KB-01, KB-02, KB-03, KB-04, KB-05, CHAN-01, CHAN-02, CHAN-03, CHAN-04
**Success Criteria** (what must be TRUE):
  1. Knowledge base list shows only the active tenant's knowledge bases
  2. Creating a knowledge base or data source stores the active tenantId on insert
  3. Updating or deleting a knowledge base belonging to a different tenant returns 403
  4. Channel list shows only the active tenant's channels
  5. Creating, updating, or deleting a channel is correctly scoped — cross-tenant mutations return 403
**Plans**: TBD

### Phase 21: Audit, Settings & Regression Tests
**Goal**: Audit logs and settings are tenant-scoped, and regression tests lock in isolation guarantees across all modules
**Depends on**: Phase 18, Phase 19, Phase 20
**Requirements**: AUDT-01, AUDT-02, STNG-04, STNG-05, TEST-01, TEST-02
**Success Criteria** (what must be TRUE):
  1. Audit log view returns only the active tenant's entries — no cross-tenant events visible
  2. All audit log write operations include tenantId in the persisted record
  3. Tenant settings read and update are scoped — a tenant cannot read or modify another tenant's settings
  4. Vitest unit tests assert tenantId is present in all repository WHERE clauses for every module
  5. Cross-tenant isolation tests confirm tenant A cannot access tenant B data via any API route
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 12. Auth Foundation | v3.0 | 3/3 | Complete | 2026-03-31 |
| 13. Custom RBAC | v3.0 | 4/4 | Complete | 2026-03-31 |
| 14. Tenant Context Enforcement | v3.0 | 4/4 | Complete | 2026-04-01 |
| 15. Super Admin + Onboarding + Suspension | v3.0 | 2/2 | Complete | 2026-04-01 |
| 16. User Invitations + Onboarding Completion | v3.0 | 2/2 | Complete | 2026-04-01 |
| 17. Org Switcher + Tenant Settings | v3.0 | 3/3 | Complete | 2026-04-01 |
| 18. Accounts & Scheduler Isolation | v4.0 | 0/2 | Planned | - |
| 19. Inventory & Agent Ops Isolation | v4.0 | 0/? | Not started | - |
| 20. Knowledge Base & Channels Isolation | v4.0 | 0/? | Not started | - |
| 21. Audit, Settings & Regression Tests | v4.0 | 0/? | Not started | - |
