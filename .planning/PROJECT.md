# Nucleus Cloud Ops Platform

## What This Is

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock. Now a multi-tenant SaaS product with dual auth (Cognito + Credentials), custom per-module RBAC, row-level tenant isolation, email invitations, org switching, and tenant branding.

## Core Value

A fully operational multi-tenant cloud ops SaaS: every user authenticates via Cognito or email/password, every query is tenant-scoped, every action is role-checked, and tenants can self-service onboard, invite members, switch orgs, and configure branding.

## Current Milestone: v5.0 (TBD)

**Status:** Planning — run `/gsd:new-milestone` to define next milestone goals.

## Current State

**v4.0 Tenant Isolation Hardening shipped 2026-04-03.** All 4 phases (18–21), 9 plans complete. Every PostgreSQL CRUD operation across all modules is correctly scoped to the active tenant via `getTenantClient()`. 10 repository test files + 6 cross-tenant API isolation test files added as regression coverage.

## Requirements

### Validated — v1.0

- ✓ Docker Compose + Prisma ORM foundation — v1.0
- ✓ All 8 DynamoDB tables migrated to PostgreSQL with repository pattern — v1.0
- ✓ Data migration scripts (migrate-all.ts + verify-migration.ts) — v1.0
- ✓ Unit tests (TDD) for each repository implementation — v1.0
- ✓ Playwright E2E tests for all migrated modules — v1.0

### Validated — v2.0

- ✓ Pulumi project scaffold: S3 backend, KMS secrets provider — PULUMI-01
- ✓ NetworkingStack: VPC, 4-tier subnets, NAT gateway, VPC endpoints — PULUMI-02, PULUMI-03
- ✓ Data Layer: 9 DynamoDB tables, 4 S3 buckets, SQS, Cognito — PULUMI-04 through PULUMI-07
- ✓ Lambda + EventBridge: Scheduler, VectorProcessor, KBSyncProcessor, Discovery — PULUMI-08 through PULUMI-11
- ✓ ECS + ALB + CloudFront: Fargate service, circuit breaker, auto scaling — PULUMI-12 through PULUMI-15
- ✓ Cutover: generate-env.ts, CDK source deleted, S3 Vectors/Tables wrapped — PULUMI-16 through PULUMI-18

### Validated — v3.0

- ✓ Dual auth (Cognito + Credentials) with Prisma adapter and database sessions — AUTH-01 through AUTH-07
- ✓ Custom RBAC replacing CASL — per-module permissions with custom roles per tenant — RBAC-01 through RBAC-07
- ✓ Row-level tenant isolation via scoped Prisma client factory — ISOL-01 through ISOL-06
- ✓ Self-service signup + org creation with slug uniqueness — ONBD-01
- ✓ Email invitations via Resend with accept/decline flow and multi-org membership — INVT-01 through INVT-06, ONBD-02, ONBD-03
- ✓ Org switcher + tenant settings (display name, timezone, logo upload) — ORGW-01 through ORGW-04, STNG-01 through STNG-03

### Validated — v4.0

- ✓ All 10 Postgres repositories migrated to getTenantClient() — v4.0
- ✓ Pre-flight 403 ownership checks on all cross-tenant mutations — v4.0
- ✓ Discovery Lambda write path resolves tenantId from accountId — v4.0
- ✓ KnowledgeBaseService wired to repository factory (USE_PG_KB flag) — v4.0
- ✓ Full AuditService call site sweep — all writes include tenantId — v4.0
- ✓ Regression tests: 10 repo test files + 6 cross-tenant API isolation tests — v4.0

### Active — v5.0

- [ ] TBD — run `/gsd:new-milestone` to define next milestone goals

### Out of Scope

- Rewriting discovery Lambda from Python to TypeScript
- Performance benchmarking CDK vs Pulumi deploy times
- WebUIStack migration to Pulumi (deferred from v2.0)
- Schema-per-tenant isolation — row-level with tenant_id is correct at this scale
- SSO/SAML per tenant — Cognito covers enterprise SSO at platform level; defer to v4.0+
- Billing/subscription tiers — significant complexity (Stripe); defer to v4.0+
- Usage quotas/rate limits per tenant — defer to v4.0+
- Permission inheritance chains — explicit permission sets are more auditable
- Impersonation (login as tenant) — security/audit risk
- Real-time permission sync (WebSocket) — re-validate on each API request is sufficient

## Context

- **Auth**: NextAuth with dual providers (Cognito + Credentials), Prisma adapter, database sessions with 24h TTL, normalized session shape `{ id, email, tenantId, role, isSuperAdmin }`.
- **RBAC**: Custom role/permission system with static ROLE_PERMISSIONS map + custom roles per tenant. CASL fully removed.
- **Tenant isolation**: Scoped Prisma client factory (`getTenantClient`) using `$extends` enforces `tenant_id` on every query. LangGraph threads namespaced as `tenantId:userId:timestamp`. Lambda functions filter by tenant.
- **Onboarding**: Self-service signup → create org → auto-assigned Owner role. Email invitations via Resend with 48h expiry tokens.
- **Org switching**: `activeTenantId` on AuthUser persists across sessions. Sidebar dropdown for multi-org users.
- **Settings**: Tenant admins can configure display name, timezone, notification preferences, and upload org logo via S3 presigned URLs.
- **Super admin**: Platform-level only — not yet implemented (deferred ADMIN-01–07 to v4.0).
- **Suspension**: Not yet implemented (deferred SUSP-01–04 to v4.0).

## Constraints

- **AWS Profile**: All migration scripts use `AWS_PROFILE=PLATFORM-ADMIN` for DynamoDB access
- **Zero downtime**: Feature flags per entity enable instant rollback; DynamoDB tables never deleted
- **Lambda cold starts**: Prisma engine ~2-4MB — monitor cold start impact in production
- **Python Lambda**: Discovery Lambda stays Python with psycopg2
- **Multi-tenant safety**: Every PostgreSQL query includes `WHERE tenant_id = $1` via scoped Prisma client
- **Raw SQL caveat**: `$executeRaw` / `$queryRawUnsafe` NOT intercepted by tenant hook — callers must manually scope
- **Thread migration**: Legacy bare UUID threads need migration to `tenantId:userId:uuid` format before production launch

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Prisma ORM over Drizzle | User prefers Prisma DX | ✓ Shipped v1.0 |
| Repository pattern with feature flags | Zero-downtime migration | ✓ Shipped v1.0 |
| S3 backend (no DynamoDB lock) | Pulumi uses S3 conditional writes | ✓ Shipped v2.0 |
| KMS secrets provider | No passphrase; CI-ready | ✓ Shipped v2.0 |
| `@pulumi/aws` primitives only | CDK parity easier to verify | ✓ Shipped v2.0 |
| Explicit physical names | Pulumi auto-naming causes delete+create on rename | ✓ Shipped v2.0 |
| `retainOnDelete: true` on tables/buckets | Protection against accidental destroy | ✓ Shipped v2.0 |
| Blue/green cutover | CDK stays live until Pulumi smoke-tested | ✓ Shipped v2.0 |
| Dual auth (Cognito + Credentials) | Enterprise SSO via Cognito + direct-managed users via Credentials | ✓ Shipped v3.0 |
| Database sessions (not JWT) | Required for suspension enforcement — adds DB lookup per request | ✓ Shipped v3.0 |
| Prisma adapter proxy pattern | AuthUser/AuthAccount/AuthSession @@map to auth_* tables avoids Account collision | ✓ Shipped v3.0 |
| Remove CASL, build custom RBAC | Need per-module granular permissions with custom roles per tenant | ✓ Shipped v3.0 |
| Row-level isolation (not schema-per-tenant) | Builds on existing tenant_id pattern, less operational complexity | ✓ Shipped v3.0 |
| getTenantClient via $extends | Per-request scoped client, not cached — simple and safe | ✓ Shipped v3.0 |
| Thread ID format tenantId:userId:timestamp | O(1) tenant validation without DB lookup | ✓ Shipped v3.0 |
| activeTenantId on AuthUser (not session) | Persists across sessions, survives logout | ✓ Shipped v3.0 |
| Self-service onboarding (not admin-initiated) | User decided self-service replaces admin flow | ✓ Shipped v3.0 |
| ADMIN/SUSP deferred to v4.0 | Core multi-tenancy shipped without admin panel or suspension | ✓ Accepted |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-02 after v3.0 milestone*
