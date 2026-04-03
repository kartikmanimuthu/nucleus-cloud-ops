# Requirements: Nucleus Cloud Ops — v4.0 Tenant Isolation Hardening

**Defined:** 2026-04-03
**Core Value:** Every PostgreSQL CRUD operation across all modules is correctly scoped to the active tenant — no cross-tenant data leakage, no missing tenantId on inserts, no unscoped list/filter queries.

## v4.0 Requirements

### AWS Accounts

- [x] **ACCT-01**: User can list only their tenant's AWS accounts
- [x] **ACCT-02**: User can create an AWS account scoped to their tenant
- [x] **ACCT-03**: User can update an AWS account only within their tenant
- [x] **ACCT-04**: User can delete an AWS account only within their tenant
- [x] **ACCT-05**: User can search/filter AWS accounts within their tenant only

### Cost Scheduler

- [ ] **SCHED-01**: User can list only their tenant's schedules
- [ ] **SCHED-02**: User can create a schedule scoped to their tenant
- [ ] **SCHED-03**: User can update a schedule only within their tenant
- [ ] **SCHED-04**: User can delete a schedule only within their tenant
- [ ] **SCHED-05**: User can view execution history scoped to their tenant
- [ ] **SCHED-06**: User can manage targeted resources scoped to their tenant

### Inventory Discovery

- [ ] **INVT-01**: User can list inventory resources scoped to their tenant
- [ ] **INVT-02**: User can filter/search inventory resources within their tenant only
- [ ] **INVT-03**: User can view resource details only within their tenant

### AI Ops / Agent Ops

- [ ] **AIOP-01**: User can list agent ops runs scoped to their tenant
- [ ] **AIOP-02**: User can create agent ops runs scoped to their tenant
- [ ] **AIOP-03**: User can view agent ops events scoped to their tenant
- [ ] **AIOP-04**: User can list and manage scheduled tasks scoped to their tenant

### Knowledge Base

- [ ] **KB-01**: User can list knowledge bases scoped to their tenant
- [ ] **KB-02**: User can create a knowledge base scoped to their tenant
- [ ] **KB-03**: User can update a knowledge base only within their tenant
- [ ] **KB-04**: User can delete a knowledge base only within their tenant
- [ ] **KB-05**: User can manage data sources scoped to their tenant

### Channels

- [ ] **CHAN-01**: User can list channels scoped to their tenant
- [ ] **CHAN-02**: User can create a channel scoped to their tenant
- [ ] **CHAN-03**: User can update a channel only within their tenant
- [ ] **CHAN-04**: User can delete a channel only within their tenant

### Audit Logs

- [ ] **AUDT-01**: User can view audit logs scoped to their tenant only
- [ ] **AUDT-02**: All audit log write operations include tenantId

### Settings

- [ ] **STNG-04**: User can read tenant settings scoped to their tenant
- [ ] **STNG-05**: User can update tenant settings only within their tenant

### Regression Tests

- [ ] **TEST-01**: Vitest unit tests assert tenantId is present in all repository WHERE clauses for each module
- [ ] **TEST-02**: Cross-tenant isolation tests confirm tenant A cannot access tenant B data

## Future Requirements (v4.1+)

### Super Admin Panel (deferred from v3.0)

- **ADMIN-01**: Super admin can view all tenants
- **ADMIN-02**: Super admin can view tenant details and member list
- **ADMIN-03**: Super admin can suspend a tenant
- **ADMIN-04**: Super admin can unsuspend a tenant
- **ADMIN-05**: Super admin can impersonate a tenant (read-only)
- **ADMIN-06**: Super admin can delete a tenant and all its data
- **ADMIN-07**: Super admin dashboard shows platform-wide metrics

### Tenant Suspension (deferred from v3.0)

- **SUSP-01**: Suspended tenant users cannot log in
- **SUSP-02**: Suspended tenant API requests return 403
- **SUSP-03**: Tenant owner receives email notification on suspension
- **SUSP-04**: Suspension reason is logged in audit trail

## Out of Scope

| Feature | Reason |
|---------|--------|
| Schema-per-tenant isolation | Row-level with tenant_id is correct at this scale |
| Raw SQL audit ($executeRaw) | Addressed by getTenantClient pattern; manual audit deferred |
| E2E cross-tenant Playwright tests | Unit-level isolation tests (TEST-01/02) sufficient for v4.0 |
| Users & RBAC module re-audit | Already hardened in v3.0 phases 13–14 |
| SSO/SAML per tenant | Cognito covers enterprise SSO at platform level |
| Billing/subscription tiers | Significant complexity (Stripe); defer to v4.0+ |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ACCT-01 | Phase 18 | Complete |
| ACCT-02 | Phase 18 | Complete |
| ACCT-03 | Phase 18 | Complete |
| ACCT-04 | Phase 18 | Complete |
| ACCT-05 | Phase 18 | Complete |
| SCHED-01 | Phase 18 | Pending |
| SCHED-02 | Phase 18 | Pending |
| SCHED-03 | Phase 18 | Pending |
| SCHED-04 | Phase 18 | Pending |
| SCHED-05 | Phase 18 | Pending |
| SCHED-06 | Phase 18 | Pending |
| INVT-01 | Phase 19 | Pending |
| INVT-02 | Phase 19 | Pending |
| INVT-03 | Phase 19 | Pending |
| AIOP-01 | Phase 19 | Pending |
| AIOP-02 | Phase 19 | Pending |
| AIOP-03 | Phase 19 | Pending |
| AIOP-04 | Phase 19 | Pending |
| KB-01 | Phase 20 | Pending |
| KB-02 | Phase 20 | Pending |
| KB-03 | Phase 20 | Pending |
| KB-04 | Phase 20 | Pending |
| KB-05 | Phase 20 | Pending |
| CHAN-01 | Phase 20 | Pending |
| CHAN-02 | Phase 20 | Pending |
| CHAN-03 | Phase 20 | Pending |
| CHAN-04 | Phase 20 | Pending |
| AUDT-01 | Phase 21 | Pending |
| AUDT-02 | Phase 21 | Pending |
| STNG-04 | Phase 21 | Pending |
| STNG-05 | Phase 21 | Pending |
| TEST-01 | Phase 21 | Pending |
| TEST-02 | Phase 21 | Pending |

**Coverage:**
- v4.0 requirements: 33 total
- Mapped to phases: 33 ✓
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-03*
*Last updated: 2026-04-03 — traceability filled after roadmap creation*
