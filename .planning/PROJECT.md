# Nucleus Cloud Ops Platform

## What This Is

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock. v1.0 completed a full DynamoDB → PostgreSQL migration (Prisma ORM, repository pattern, feature flags, pgvector). v2.0 replaced AWS CDK with Pulumi TypeScript for the core infrastructure stacks (NetworkingStack + ComputeStack), using an S3 backend for state.

## Core Value

A fully operational cloud ops platform with modern IaC: Pulumi TypeScript managing all core AWS infrastructure (VPC, ECS Fargate, ALB, CloudFront, Lambda, DynamoDB, SQS, EventBridge, Cognito) — CDK removed for migrated stacks, WebUIStack stays in CDK.

## Current Milestone: v3.0 Multi-Tenancy

**Goal:** Transform Nucleus Cloud Ops into a standard SaaS product with full multi-tenant isolation, custom per-module RBAC (replacing CASL), tenant lifecycle management, and dual auth (Cognito + Credentials).

**Target features:**
- Dual Auth (Cognito + Credentials) — NextAuth with both providers, Prisma adapter for user persistence
- Org/Tenant Switching — Header dropdown switcher, data reloads scoped to selected tenant
- Row-Level Data Isolation — Enforce tenant_id on all queries across every module
- Custom RBAC Per Module — Replace CASL with new custom role/permission system; granular per-module permissions (Accounts, Schedules, AI Ops, Inventory); actions: create, read, update, delete
- Super Admin Panel (/admin) — Platform-level admin; onboard tenants, manage root users, suspend/unsuspend, view all orgs
- Tenant Onboarding — Create org, set up root user, configure initial settings
- User Invitations — Invite users to org via email link, accept/decline flow
- Tenant Suspension — Freeze tenant (read-only or fully locked) without deleting data
- Tenant-Level Settings — Custom branding, default timezone, notification preferences per org

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

### Active — v3.0

(Defined in REQUIREMENTS.md)

### Out of Scope

- Rewriting discovery Lambda from Python to TypeScript
- Performance benchmarking CDK vs Pulumi deploy times
- WebUIStack migration to Pulumi (deferred from v2.0)
- Subscription/plan tiers with billing integration — deferred to v4.0
- SSO/SAML per tenant — deferred to v4.0
- Usage quotas/rate limits per tenant — deferred to v4.0

## Context

- **Auth**: Currently NextAuth with Cognito provider. v3.0 adds Credentials provider alongside Cognito, with Prisma adapter for user persistence in PostgreSQL.
- **RBAC**: Currently CASL-based (`@casl/ability`). v3.0 removes CASL entirely and builds custom role/permission system with Prisma models.
- **Tenant isolation**: `tenant_id` column already exists on most PostgreSQL tables from v1.0 migration. v3.0 enforces it consistently across all queries and UI.
- **Super admin**: Platform-level only — not a member of any tenant. Manages all tenants from `/admin` route.
- **Admin panel**: Built into existing Next.js app at `/admin` route, behind super-admin auth guard.

## Constraints

- **AWS Profile**: All migration scripts use `AWS_PROFILE=PLATFORM-ADMIN` for DynamoDB access
- **Zero downtime**: Feature flags per entity enable instant rollback; DynamoDB tables never deleted
- **Lambda cold starts**: Prisma engine ~2-4MB — monitor cold start impact in production
- **Python Lambda**: Discovery Lambda stays Python with psycopg2
- **Multi-tenant safety**: Every PostgreSQL query includes `WHERE tenant_id = $1`
- **CASL removal**: All `@casl/ability` imports and RBAC middleware must be replaced before new RBAC goes live

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
| Remove CASL, build custom RBAC | Need per-module granular permissions with custom roles per tenant | — Pending v3.0 |
| Dual auth (Cognito + Credentials) | Enterprise SSO via Cognito + direct-managed users via Credentials | — Pending v3.0 |
| Row-level isolation (not schema-per-tenant) | Builds on existing tenant_id pattern, less operational complexity | — Pending v3.0 |
| Super admin is platform-level only | Clean separation between platform management and tenant operations | — Pending v3.0 |
| Admin panel at /admin route | Same app, simpler deployment, auth guard sufficient | — Pending v3.0 |

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
*Last updated: 2026-03-31 — v3.0 milestone started (Multi-Tenancy)*
