---
phase: 01-foundation-tenant-config
verified: 2026-03-26T19:50:31Z
status: gaps_found
score: 15/17 requirements verified
re_verification: false
gaps:
  - truth: "npm run db:migrate applies the schema without error (prisma migrate dev)"
    status: partial
    reason: "prisma/migrations/ directory does not exist. `prisma migrate dev` was never run against a live database, so no migration history files were created. The schema is valid and the Prisma client was generated, but FOUND-02 explicitly requires a migration directory."
    artifacts:
      - path: "prisma/migrations/"
        issue: "Directory missing — prisma migrate dev was never executed against a running PostgreSQL instance"
    missing:
      - "Run `cd web-ui && npm run db:start && npm run db:migrate` to create the prisma/migrations/ directory and initial migration file"
      - "Commit the generated prisma/migrations/TIMESTAMP_init/ folder to source control"
  - truth: "pg-config.ts exports a singleton Prisma client with max 10 pool connections for ECS"
    status: partial
    reason: "pg-config.ts documents the connection_limit pattern in comments but does not enforce it. The .env.local.example DATABASE_URL omits the ?connection_limit=10 query parameter. FOUND-03 requires pool sizes to be configured, not merely documented."
    artifacts:
      - path: "web-ui/.env.local.example"
        issue: "DATABASE_URL=postgresql://nucleus:nucleus_dev@localhost:5432/nucleus is missing ?connection_limit=10 for ECS"
    missing:
      - "Update .env.local.example DATABASE_URL to: postgresql://nucleus:nucleus_dev@localhost:5432/nucleus?connection_limit=10"
      - "Add a comment noting Lambda functions should use ?connection_limit=3 in their own DATABASE_URL"
human_verification:
  - test: "Start Docker Compose and run prisma migrate dev"
    expected: "nucleus-postgres container starts healthy; prisma migrate dev creates prisma/migrations/TIMESTAMP_init/ with SQL migration; exit code 0"
    why_human: "Requires Docker daemon running locally — cannot verify in automated environment"
  - test: "Set USE_PG_TENANT_CONFIG=true and exercise TenantConfigService against live PostgreSQL"
    expected: "getConfig, saveConfig, deleteConfig, listConfigs all execute against tenant_configs table without error"
    why_human: "Requires live PostgreSQL with migrated schema"
---

# Phase 1: Foundation + Tenant Config Verification Report

**Phase Goal:** Stand up the PostgreSQL 16 local development environment, define the Prisma schema for tenants and tenant_configs, wire the repository factory with feature flags for zero-downtime cutover, implement both DynamoDB and PostgreSQL repository implementations for tenant config, rewrite the service layer to delegate to the factory, write TDD tests, and create the data migration script.
**Verified:** 2026-03-26T19:50:31Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `docker compose up` starts a healthy PostgreSQL 16 container on port 5432 | ✓ VERIFIED | `docker-compose.yml` has `postgres:16-alpine`, healthcheck `pg_isready -U nucleus -d nucleus`, port `5432:5432`, persistent volume `postgres_data` |
| 2 | `prisma/schema.prisma` defines tenants and tenant_configs tables with correct columns and FK | ✓ VERIFIED | Schema has `model Tenant` (`@@map("tenants")`), `model TenantConfig` (`@@map("tenant_configs")`), FK relation, `@@unique([tenantId, configKey])`, `@@index([tenantId])`, `data Json` field |
| 3 | `npm run db:migrate` applies the schema without error | ✗ PARTIAL | `db:migrate` script exists and schema validates (`prisma validate` exits 0), but `prisma/migrations/` directory is absent — migration was never run against a live DB; no migration history tracked |
| 4 | `npm run db:generate` produces the Prisma TypeScript client | ✓ VERIFIED | `web-ui/node_modules/.prisma/client/` exists with `index.d.ts` (123KB), `libquery_engine-darwin-arm64.dylib.node`, and full client artifacts |
| 5 | `web-ui/.env.local.example` contains DATABASE_URL and all USE_PG_* flags | ✓ VERIFIED | `DATABASE_URL=postgresql://nucleus:nucleus_dev@localhost:5432/nucleus` present; all 6 flags (`USE_PG_TENANT_CONFIG`, `USE_PG_ACCOUNTS`, `USE_PG_SCHEDULES`, `USE_PG_AUDIT`, `USE_PG_KB`, `USE_PG_AGENT_OPS`) present, all default `false` |
| 6 | `pg-config.ts` exports a singleton Prisma client with max 10 pool connections for ECS | ✗ PARTIAL | `getPrismaClient()` and `disconnectPrisma()` exported with hot-reload safety. Pool size documented in comments but `connection_limit=10` is NOT in the `.env.local.example` DATABASE_URL; pattern is defined but not enforced in the example configuration |
| 7 | `repository-factory.ts` reads `USE_PG_TENANT_CONFIG` env var and returns the correct repo implementation | ✓ VERIFIED | `getTenantConfigRepository()` checks `process.env.USE_PG_TENANT_CONFIG === 'true'`, uses dynamic `require()` for both implementations; real `ITenantConfigRepository` type imported (no `any` placeholder) |
| 8 | `ITenantConfigRepository` interface defines `getConfig`, `saveConfig`, `deleteConfig`, `listConfigs` with typed signatures | ✓ VERIFIED | `interface.ts` has all 4 methods with correct generics: `getConfig<T>`, `saveConfig<T>`, `deleteConfig`, `listConfigs` returning `Promise<Array<{configKey, updatedAt}>>` |
| 9 | `TenantConfigDynamoRepository` implements the interface using DynamoDB SDK with TENANT#/CONFIG# PK/SK pattern | ✓ VERIFIED | `dynamo.ts` implements all 4 methods using `GetCommand`, `PutCommand`, `DeleteCommand`, `QueryCommand`; PK=`TENANT#<tenantId>`, SK=`CONFIG#<configKey>`, GSI1PK=`TYPE#CONFIG` |
| 10 | `TenantConfigPostgresRepository` implements the interface using Prisma against `tenant_configs` table | ✓ VERIFIED | `postgres.ts` implements all 4 methods using `findUnique`, `upsert`, `deleteMany`, `findMany`; all queries scoped by `tenantId`; `deleteMany` used to avoid P2025 error on missing records |
| 11 | `tenant-config-service.ts` delegates to `getTenantConfigRepository()` — no direct DynamoDB SDK imports | ✓ VERIFIED | Service is 58 lines; imports only `DEFAULT_TENANT_ID` from `aws-config` and `getTenantConfigRepository` from factory; zero DynamoDB command imports; all 4 static methods delegate to the repository |
| 12 | Vitest unit tests pass for both DynamoDB and PostgreSQL repository implementations | ✓ VERIFIED | 16 tests (8 DynamoDB + 8 PostgreSQL) all PASS; ran `vitest run lib/db/repositories/tenant-config/` — exit 0; tests mock `getDynamoDBDocumentClient` and `getPrismaClient` respectively |
| 13 | Tests pass with `USE_PG_TENANT_CONFIG=true` (TCFG-08) | ✓ VERIFIED | Ran `USE_PG_TENANT_CONFIG=true vitest run lib/db/repositories/tenant-config/` — 16 PASS, 0 FAIL |
| 14 | `scripts/migrate-tenant-configs.ts` uses `AWS_PROFILE=PLATFORM-ADMIN` and produces "Migrated X/Y records..." logging | ✓ VERIFIED | Script respects `AWS_PROFILE` via default provider chain; logs `AWS_PROFILE:` at startup; logs `Migrated ${count}/${total} records... (configKey=..., tenantId=...)` per record |
| 15 | Migration script is idempotent (ON CONFLICT DO UPDATE / Prisma upsert) | ✓ VERIFIED | Uses `prisma.tenant.upsert` + `prisma.tenantConfig.upsert` with `tenantId_configKey` unique key; comment explicitly states "safe to re-run"; `seenTenants` Set prevents redundant tenant upserts in a single run |
| 16 | Migration script uses paginated DynamoDB scan | ✓ VERIFIED | `scanAllTenantConfigs()` loops on `LastEvaluatedKey`; `FilterExpression: 'begins_with(sk, :skPrefix)'` with `:skPrefix = 'CONFIG#'`; handles multi-page tables >1MB |
| 17 | Tenant FK safety: `ensureTenantExists()` called before config upsert | ✓ VERIFIED | `ensureTenantExists(tenantId)` calls `prisma.tenant.upsert` before each config write; prevents FK constraint violation since `tenant_configs.tenantId` references `tenants.id` |

**Score:** 15/17 truths verified (2 partial gaps)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `docker-compose.yml` | PostgreSQL 16 with healthcheck and volume | ✓ VERIFIED | `postgres:16-alpine`, healthcheck, port 5432, `postgres_data` volume |
| `prisma/schema.prisma` | Tenant + TenantConfig models | ✓ VERIFIED | Both models present with correct constraints, FK, and mappings; `prisma validate` exits 0 |
| `prisma/migrations/` | Migration directory with initial SQL | ✗ MISSING | Directory does not exist — `prisma migrate dev` was never run against a live database |
| `web-ui/lib/db/pg-config.ts` | Prisma singleton | ✓ VERIFIED | 53 lines; `getPrismaClient()` + `disconnectPrisma()`; globalThis guard for dev hot reloads |
| `web-ui/lib/db/repository-factory.ts` | Feature-flag-driven factory | ✓ VERIFIED | `getTenantConfigRepository()`, `isUsingPostgres()`; real typed import from interface.ts |
| `web-ui/lib/db/repositories/tenant-config/interface.ts` | ITenantConfigRepository interface | ✓ VERIFIED | 4-method interface with correct generic signatures |
| `web-ui/lib/db/repositories/tenant-config/dynamo.ts` | DynamoDB implementation | ✓ VERIFIED | Full implementation with PK/SK pattern, all 4 methods |
| `web-ui/lib/db/repositories/tenant-config/postgres.ts` | PostgreSQL/Prisma implementation | ✓ VERIFIED | Full Prisma implementation, all 4 methods, multi-tenant safe |
| `web-ui/lib/db/repositories/tenant-config/dynamo.test.ts` | Vitest tests for DynamoDB repo | ✓ VERIFIED | 8 tests, all PASS |
| `web-ui/lib/db/repositories/tenant-config/postgres.test.ts` | Vitest tests for PostgreSQL repo | ✓ VERIFIED | 8 tests, all PASS |
| `web-ui/lib/tenant-config-service.ts` | Thin delegation layer | ✓ VERIFIED | 58 lines; delegates all calls to factory; no DynamoDB SDK imports |
| `scripts/migrate-tenant-configs.ts` | Idempotent DynamoDB-to-PostgreSQL migration | ✓ VERIFIED | 179 lines; paginated scan, tenant FK safety, upsert idempotency, progress logging |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `docker-compose.yml` | `prisma/schema.prisma` | DATABASE_URL env var → localhost:5432 | ✓ WIRED | `.env.local.example` has `DATABASE_URL=postgresql://...localhost:5432/nucleus` |
| `web-ui/package.json` | `prisma/schema.prisma` | `db:migrate` script | ✓ WIRED | `prisma migrate dev --schema=../prisma/schema.prisma` |
| `repository-factory.ts` | `pg-config.ts` | `getPrismaClient()` import | ✓ WIRED | `import type { ITenantConfigRepository }` + dynamic `require('./repositories/tenant-config/postgres')` which imports `getPrismaClient` |
| `repository-factory.ts` | `process.env.USE_PG_TENANT_CONFIG` | Feature flag check | ✓ WIRED | `process.env.USE_PG_TENANT_CONFIG === 'true'` at line 30 |
| `dynamo.ts` | `aws-config.ts` | `getDynamoDBDocumentClient()` import | ✓ WIRED | `import { getDynamoDBDocumentClient, APP_TABLE_NAME } from '@/lib/aws-config'` |
| `postgres.ts` | `pg-config.ts` | `getPrismaClient()` import | ✓ WIRED | `import { getPrismaClient } from '@/lib/db/pg-config'` |
| `repository-factory.ts` | `interface.ts` | `ITenantConfigRepository` type | ✓ WIRED | `import type { ITenantConfigRepository } from './repositories/tenant-config/interface'` (no `any` placeholder) |
| `tenant-config-service.ts` | `repository-factory.ts` | `getTenantConfigRepository()` import | ✓ WIRED | `import { getTenantConfigRepository } from './db/repository-factory'` at line 14 |
| `migrate-tenant-configs.ts` | DynamoDB APP_TABLE_NAME | `ScanCommand` with `begins_with(sk, 'CONFIG#')` | ✓ WIRED | `FilterExpression: 'begins_with(sk, :skPrefix)'` with `:skPrefix = 'CONFIG#'` |
| `migrate-tenant-configs.ts` | `prisma/schema.prisma` tenant_configs table | `prisma.tenantConfig.upsert` | ✓ WIRED | Direct Prisma client calls using `tenantId_configKey` composite unique index |

### Data-Flow Trace (Level 4)

Not applicable — this phase produces repository infrastructure and a CLI migration script, not components that render dynamic data. The repository layer connects DynamoDB/PostgreSQL to the service layer; the data flow is: `TenantConfigService.getConfig()` → `getTenantConfigRepository().getConfig()` → DynamoDB `GetCommand` or Prisma `findUnique`. All paths trace to real I/O calls (no hardcoded returns).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Prisma schema validates | `DATABASE_URL=... prisma validate --schema=../prisma/schema.prisma` | "The schema at ../prisma/schema.prisma is valid" | ✓ PASS |
| Prisma client generated | `ls web-ui/node_modules/.prisma/client/index.d.ts` | 123KB TypeScript declarations present | ✓ PASS |
| All 16 Vitest unit tests pass (default mode) | `vitest run lib/db/repositories/tenant-config/` | PASS (16) FAIL (0) | ✓ PASS |
| All 16 Vitest unit tests pass (USE_PG_TENANT_CONFIG=true) | `USE_PG_TENANT_CONFIG=true vitest run lib/db/repositories/tenant-config/` | PASS (16) FAIL (0) | ✓ PASS |
| npm scripts present | `node -e "require('./package.json').scripts['db:migrate']"` | `prisma migrate dev --schema=../prisma/schema.prisma` | ✓ PASS |
| prisma migrate dev against live DB | Requires Docker running | Cannot test without active Docker daemon | ? SKIP |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| FOUND-01 | 01-01 | Docker Compose starts PostgreSQL 16 with healthcheck and persistent volume | ✓ SATISFIED | `docker-compose.yml` has `postgres:16-alpine`, healthcheck `pg_isready`, port 5432, `postgres_data` volume |
| FOUND-02 | 01-01 | Prisma ORM configured with schema file, migration directory, and TypeScript client generation | ✗ PARTIAL | Schema file exists and validates; TypeScript client generated; **`prisma/migrations/` directory missing** — migration was never applied to a live database |
| FOUND-03 | 01-02 | PostgreSQL connection singleton (pg-config.ts) with pool sizes: max 10 for ECS, max 3 for Lambda | ✗ PARTIAL | `pg-config.ts` singleton exists and is correct; pool sizes documented in comments; **`.env.local.example` DATABASE_URL omits `?connection_limit=10`** — pattern documented but not applied in example config |
| FOUND-04 | 01-02 | Repository factory reads `USE_PG_<ENTITY>` env vars and returns correct implementation | ✓ SATISFIED | `getTenantConfigRepository()` reads `USE_PG_TENANT_CONFIG`; returns DynamoDB or PostgreSQL impl via dynamic require |
| FOUND-05 | 01-01 | npm scripts added: db:start, db:stop, db:generate, db:migrate, db:studio | ✓ SATISFIED | All 5 scripts present plus `db:migrate:deploy` bonus script |
| FOUND-06 | 01-01 | .env.local.example updated with DATABASE_URL and all USE_PG_* flags | ✓ SATISFIED | `DATABASE_URL` + 6 `USE_PG_*` flags all present, all default `false` |
| TCFG-01 | 01-01 | Prisma schema defines tenants and tenant_configs tables with correct types and constraints | ✓ SATISFIED | Both models with FK, `@@unique([tenantId, configKey])`, `@@index([tenantId])`, `data Json`, `@@map` annotations |
| TCFG-02 | 01-03 | Repository interface defined with getConfig, saveConfig, deleteConfig, listConfigs | ✓ SATISFIED | `interface.ts` exports `ITenantConfigRepository` with all 4 methods and correct TypeScript signatures |
| TCFG-03 | 01-03 | DynamoDB repository implementation extracted from existing tenant-config-service.ts | ✓ SATISFIED | `dynamo.ts` implements all 4 methods with original TENANT#/CONFIG# PK/SK pattern, GSI1PK=TYPE#CONFIG |
| TCFG-04 | 01-03 | PostgreSQL repository implementation using Prisma client | ✓ SATISFIED | `postgres.ts` uses `findUnique`, `upsert`, `deleteMany`, `findMany`; all queries scoped by `tenantId` |
| TCFG-05 | 01-04 | tenant-config-service.ts delegates to repository factory (no direct DynamoDB calls) | ✓ SATISFIED | Service is 58 lines; zero DynamoDB command imports; delegates all 4 methods to `getTenantConfigRepository()` |
| TCFG-06 | 01-04 | TDD unit tests pass for both DynamoDB and PostgreSQL repository implementations | ✓ SATISFIED | 16 tests pass (8 DynamoDB + 8 PostgreSQL); confirmed via `vitest run` |
| TCFG-07 | 01-05 | Data migration script seeds tenant configs from DynamoDB (AWS_PROFILE=PLATFORM-ADMIN) | ✓ SATISFIED | `scripts/migrate-tenant-configs.ts` scans DynamoDB with `AWS_PROFILE` support; upserts to PostgreSQL; **Note: REQUIREMENTS.md traceability not updated — still shows "Pending"** |
| TCFG-08 | 01-04 | Existing Vitest tests continue passing with USE_PG_TENANT_CONFIG=true | ✓ SATISFIED | Confirmed: 16 PASS with `USE_PG_TENANT_CONFIG=true` |
| MIGR-01 | 01-05 | Each migration script uses AWS_PROFILE=PLATFORM-ADMIN for DynamoDB access | ✓ SATISFIED | Script respects `AWS_PROFILE` via default AWS credential provider chain; logs `AWS_PROFILE` at startup; **Note: REQUIREMENTS.md traceability not updated** |
| MIGR-02 | 01-05 | All scripts are idempotent (ON CONFLICT DO UPDATE) for safe re-runs | ✓ SATISFIED | `prisma.tenant.upsert` + `prisma.tenantConfig.upsert` with unique key; comment confirms "safe to re-run"; **Note: REQUIREMENTS.md traceability not updated** |
| MIGR-06 | 01-05 | Progress logging shows "Migrated X/Y records..." during execution | ✓ SATISFIED | Line 163: `console.log(\`Migrated ${count}/${total} records... (configKey=${configKey}, tenantId=${tenantId})\`)`; final summary line on completion; **Note: REQUIREMENTS.md traceability not updated** |

**Orphaned requirements check:** TCFG-07, MIGR-01, MIGR-02, MIGR-06 are all implemented (artifacts verified above) but the REQUIREMENTS.md traceability table still marks them as `[ ] Pending` with "Pending" status. This is a documentation sync gap — the REQUIREMENTS.md was not updated after plan 05 executed. These requirements are SATISFIED in code but their tracking status is stale.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `web-ui/.env.local.example` | DATABASE_URL | Missing `?connection_limit=10` query param for ECS | ⚠️ Warning | FOUND-03 says pool sizes should be configured; the example URL leaves this unconfigured — a developer copying the example gets unconstrained connections |
| `prisma/migrations/` | — | Directory absent — `prisma migrate dev` never run | ⚠️ Warning | FOUND-02 explicitly requires a migration directory; without it, the project has no migration history, and applying the schema in a new environment requires running migrations (not just validate) |
| `REQUIREMENTS.md` | TCFG-07, MIGR-01, MIGR-02, MIGR-06 | Traceability not updated after plan 05 completion | ℹ️ Info | Shows `[ ] Pending` for implemented requirements; misleads status readers but doesn't affect runtime behavior |

### Human Verification Required

#### 1. Full DB migration cycle

**Test:** Start Docker Compose, run `cd web-ui && npm run db:migrate`, observe output.
**Expected:** PostgreSQL container becomes healthy; `prisma migrate dev` creates `prisma/migrations/TIMESTAMP_init/` with SQL DDL (`CREATE TABLE tenants`, `CREATE TABLE tenant_configs`); exits 0.
**Why human:** Requires Docker daemon running locally — cannot verify in automated environment.

#### 2. End-to-end tenant config with USE_PG_TENANT_CONFIG=true

**Test:** Start Docker, migrate, set `USE_PG_TENANT_CONFIG=true`, call `TenantConfigService.saveConfig('test', { val: 1 }, 'tenant-1')` then `TenantConfigService.getConfig('test', 'tenant-1')`.
**Expected:** PostgreSQL `tenant_configs` table contains the row; `getConfig` returns `{ val: 1 }` without error.
**Why human:** Requires live PostgreSQL with applied schema.

#### 3. Migration script execution

**Test:** With PostgreSQL running and schema applied, execute: `AWS_PROFILE=PLATFORM-ADMIN APP_TABLE_NAME=<table> DATABASE_URL=... npx tsx scripts/migrate-tenant-configs.ts`
**Expected:** Script scans DynamoDB, prints "Migrated X/Y records...", exits 0. Running a second time produces the same count with no errors (idempotent).
**Why human:** Requires AWS credentials, live DynamoDB access, and running PostgreSQL.

### Gaps Summary

Two partial gaps block full FOUND-02 and FOUND-03 satisfaction:

**Gap 1 — Missing prisma/migrations/ directory (FOUND-02):** The requirement for Prisma ORM configuration explicitly includes a "migration directory." The `prisma migrate dev` command was not run against a live database during phase execution, so no migration files were generated. The schema is valid and the Prisma client was generated successfully, but the migration history is absent. This is a one-command fix (`npm run db:start && npm run db:migrate` from web-ui/) but requires Docker. Without the migrations directory, a new developer cannot apply the schema to a fresh database via `prisma migrate deploy`.

**Gap 2 — Missing connection_limit in DATABASE_URL example (FOUND-03):** The pg-config.ts correctly implements the Prisma singleton with dev/prod differentiation. However, the `.env.local.example` DATABASE_URL does not include `?connection_limit=10`, which is how Prisma enforces the pool size. The FOUND-03 requirement says "with pool sizes: max 10 for ECS, max 3 for Lambda" — the design intent is clear in comments but not applied in the example configuration a developer copies to get started.

**Documentation gap (informational):** REQUIREMENTS.md traceability table was not updated after plan 05 ran. TCFG-07, MIGR-01, MIGR-02, MIGR-06 are all implemented and verified in code but show as `[ ] Pending` in the requirements file. This does not affect runtime behavior.

All other 15 out of 17 truths are fully verified. The repository pattern, feature flags, service delegation, TDD tests, and migration script are all substantive, wired, and working.

---

_Verified: 2026-03-26T19:50:31Z_
_Verifier: Claude (gsd-verifier)_
