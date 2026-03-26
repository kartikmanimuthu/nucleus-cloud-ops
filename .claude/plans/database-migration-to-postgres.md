# DynamoDB to PostgreSQL Migration Plan

## Context

The Nucleus Cloud Ops platform currently uses 10 DynamoDB tables across a single-table design (NucleusAppTable) plus dedicated tables for audit, inventory, agent ops, RBAC, and LangGraph persistence. DynamoDB limitations around complex filtering, ad-hoc queries, relational joins, and client-side pagination are driving this migration. The goal is to move business data to PostgreSQL one model at a time, with local Docker for development and cloud PostgreSQL (RDS) for production later.

---

## Current DynamoDB Landscape (10 Tables)

| # | Table | Purpose | Service Files | Lambda Consumers |
|---|-------|---------|---------------|------------------|
| 1 | **NucleusAppTable** | Accounts, Schedules, Executions, Configs, KBs, DataSources, VectorKeys (single-table) | account-service, schedule-service, schedule-execution-service, tenant-config-service, knowledge-base/service | scheduler, vector_processor, kb_sync_processor, discovery |
| 2 | **NucleusAuditTable** | Immutable audit logs (90-day TTL) | audit-service | scheduler, vector_processor |
| 3 | **NucleusInventoryTable** | Auto-discovered AWS resources | (discovery Lambda only) | discovery |
| 4 | **AgentOpsTable** | Agent runs + events (Dynamoose ODM) | agent-ops-service, scheduled-task-service | — |
| 5 | **UsersTeamsTable** | RBAC user-tenant-role mappings | rbac/role-service | — |
| 6 | **CheckpointTable** | LangGraph checkpoints | agent/persistence.ts | — |
| 7 | **WritesTable** | LangGraph writes | agent/persistence.ts | — |
| 8 | **ChatHistoryTable** | Chat session messages | agent/persistence.ts | — |
| 9 | **MemoryTable** | Long-term agent memory + embeddings | agent/persistence.ts | — |
| 10 | **AgentConversationsTable** | Agent conversation threads | (possibly unused) | — |

**Tables 6-9 (LangGraph): KEEP IN DYNAMODB** — they use `@farukada/aws-langgraph-dynamodb-ts`, a DynamoDB-specific library. These are ephemeral (30-90 day TTL) and orthogonal to business data. Migrate in a future phase using `@langchain/langgraph-checkpoint-postgres` if needed.

**Table 10 (AgentConversations): VERIFY** — appears unused in application code. Confirm before migrating.

---

## Tech Decisions

### ORM: Drizzle ORM (not Prisma)
- ~50KB runtime vs Prisma's ~2-4MB (critical for Lambda cold starts)
- No binary engine — works with esbuild bundling (project already uses esbuild for Lambdas)
- SQL-first with full TypeScript inference from schema (no codegen step)
- `drizzle-kit` for migration generation from schema diffs
- Schema-as-code in `.ts` files aligns with "TypeScript everywhere" convention

### Architecture: Repository Pattern with Feature Flags
Each service gets a repository interface with two implementations (DynamoDB + PostgreSQL), swappable via env var per entity. API routes don't change.

---

## Phase 0: Foundation (No Data Migration)

### 0.1 Docker Compose Setup
Create `docker-compose.yml` at project root:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: nucleus
      POSTGRES_USER: nucleus
      POSTGRES_PASSWORD: nucleus_dev
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nucleus"]
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  pgdata:
```

### 0.2 Install Dependencies
```bash
cd web-ui
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

### 0.3 Create PostgreSQL Connection Singleton
New file: `web-ui/lib/db/pg-config.ts` (mirrors `aws-config.ts` pattern)
- Singleton `getDb()` returning Drizzle instance
- Connection pool with `max: 10` for web-ui, `max: 3` for Lambda
- Graceful shutdown hook

### 0.4 Create Drizzle Config
New file: `web-ui/drizzle.config.ts`
- Schema dir: `web-ui/lib/db/schema/`
- Migrations dir: `web-ui/lib/db/migrations/`

### 0.5 Create Repository Pattern Base
New file: `web-ui/lib/db/repository-factory.ts`
- Feature flag reader: `USE_PG_<ENTITY>` env vars
- Factory function per entity that returns DynamoDB or PG implementation

### 0.6 Add npm Scripts
```json
"db:start": "docker compose up -d postgres",
"db:stop": "docker compose down",
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:studio": "drizzle-kit studio"
```

### Files Created
- `docker-compose.yml`
- `web-ui/lib/db/pg-config.ts`
- `web-ui/drizzle.config.ts`
- `web-ui/lib/db/repository-factory.ts`
- `web-ui/lib/db/schema/` (directory)

---

## Phase 1: Tenant Config (Lowest Risk)

**Why first:** Zero dependencies, simple key-value CRUD, ~4 API routes, no Lambda consumers.

### 1.1 PostgreSQL Schema
```sql
CREATE TABLE tenants (
    id          TEXT PRIMARY KEY DEFAULT 'org-default',
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenant_configs (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    config_key  TEXT NOT NULL,
    data        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  TEXT NOT NULL DEFAULT 'system',
    PRIMARY KEY (tenant_id, config_key)
);
```

### 1.2 Drizzle Schema
New file: `web-ui/lib/db/schema/tenants.ts`

### 1.3 Repository Implementation
- `web-ui/lib/db/tenant-config/tenant-config-repository.ts` (interface)
- `web-ui/lib/db/tenant-config/dynamo-tenant-config-repository.ts` (extract from existing `tenant-config-service.ts`)
- `web-ui/lib/db/tenant-config/pg-tenant-config-repository.ts` (Drizzle implementation)

### 1.4 Refactor Service
Update `web-ui/lib/tenant-config-service.ts` to delegate to `getRepository()`.

### 1.5 Data Migration Script
`scripts/db/migrate-tenant-configs.ts`:
- Scan DynamoDB: `pk = TENANT#org-default`, `sk begins_with CONFIG#`
- Transform: extract config_key from SK, map data field
- Insert into PostgreSQL with `ON CONFLICT DO UPDATE`

### 1.6 Verification
- Run existing tests: `cd web-ui && npm run test`
- Manual: toggle `USE_PG_TENANT_CONFIG=true`, verify config read/write via UI

### Feature Flag
```
USE_PG_TENANT_CONFIG=true
```

---

## Phase 2: Accounts + RBAC

**Why second:** Accounts are referenced by schedules (FK dependency). RBAC is a standalone table — clean cut.

### 2.1 PostgreSQL Schema
```sql
CREATE TABLE accounts (
    id                TEXT PRIMARY KEY,  -- AWS account ID
    tenant_id         TEXT NOT NULL REFERENCES tenants(id),
    name              TEXT NOT NULL,
    role_arn          TEXT NOT NULL,
    external_id       TEXT,
    regions           TEXT[] NOT NULL DEFAULT '{}',
    active            BOOLEAN NOT NULL DEFAULT true,
    description       TEXT DEFAULT '',
    connection_status TEXT NOT NULL DEFAULT 'unknown',
    connection_error  TEXT,
    resource_count    INTEGER DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by        TEXT NOT NULL DEFAULT 'system',
    updated_by        TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX idx_accounts_tenant ON accounts(tenant_id);
CREATE INDEX idx_accounts_active ON accounts(active);

CREATE TABLE user_tenant_roles (
    user_id     TEXT NOT NULL,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    email       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by TEXT NOT NULL,
    PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX idx_utr_tenant ON user_tenant_roles(tenant_id);
```

### 2.2 Key Improvement: Server-Side Filtering
Current `AccountService.getAccounts()` fetches ALL accounts from GSI1 and filters in memory. PostgreSQL version uses proper `WHERE` clauses:
```sql
SELECT * FROM accounts
WHERE tenant_id = $1
  AND ($2::boolean IS NULL OR active = $2)
  AND ($3::text IS NULL OR connection_status = $3)
  AND ($4::text IS NULL OR name ILIKE '%' || $4 || '%' OR id ILIKE '%' || $4 || '%')
ORDER BY created_at DESC
LIMIT $5 OFFSET $6;
```

### 2.3 Repository Implementation
- `web-ui/lib/db/accounts/account-repository.ts` (interface)
- `web-ui/lib/db/accounts/dynamo-account-repository.ts`
- `web-ui/lib/db/accounts/pg-account-repository.ts`
- Same pattern for RBAC: `web-ui/lib/db/rbac/`

### 2.4 Refactor Services
- Update `web-ui/lib/account-service.ts` → delegate to repository (keep `scanResources`/`validateCredentials` unchanged — pure AWS SDK)
- Update `web-ui/lib/rbac/role-service.ts` → delegate to repository

### 2.5 Data Migration Scripts
- `scripts/db/migrate-accounts.ts`: Scan GSI1 `TYPE#ACCOUNT` → insert into `accounts`
- `scripts/db/migrate-rbac.ts`: Scan UsersTeamsTable → insert into `user_tenant_roles`

### 2.6 Affected Files (~8 API routes)
- `web-ui/app/api/accounts/route.ts`
- `web-ui/app/api/accounts/[accountId]/route.ts`
- `web-ui/app/api/accounts/[accountId]/validate/route.ts`
- `web-ui/app/api/accounts/[accountId]/scan/route.ts`
- `web-ui/app/api/admin/users/route.ts`

### Feature Flags
```
USE_PG_ACCOUNTS=true
USE_PG_RBAC=true
```

---

## Phase 3: Schedules + Executions + Audit Logs (Highest Risk)

**Why third:** Schedules depend on accounts (FK). This phase also migrates the scheduler Lambda — the highest-risk component.

### 3.1 PostgreSQL Schema
```sql
CREATE TABLE schedules (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    account_id      TEXT NOT NULL REFERENCES accounts(id),
    name            TEXT NOT NULL,
    days            TEXT[] NOT NULL,
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    timezone        TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT true,
    description     TEXT DEFAULT '',
    resources       JSONB DEFAULT '[]',
    last_execution  TIMESTAMPTZ,
    execution_count INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      TEXT NOT NULL DEFAULT 'system',
    updated_by      TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX idx_schedules_tenant ON schedules(tenant_id);
CREATE INDEX idx_schedules_account ON schedules(account_id);
CREATE INDEX idx_schedules_active ON schedules(active);

CREATE TABLE schedule_executions (
    id                TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL,
    account_id        TEXT NOT NULL,
    schedule_id       TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    execution_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status            TEXT NOT NULL,
    resources_started INTEGER DEFAULT 0,
    resources_stopped INTEGER DEFAULT 0,
    resources_failed  INTEGER DEFAULT 0,
    duration          INTEGER,
    error_message     TEXT,
    details           JSONB,
    schedule_metadata JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ
);
CREATE INDEX idx_exec_schedule ON schedule_executions(schedule_id, execution_time DESC);
CREATE INDEX idx_exec_expires ON schedule_executions(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE audit_logs (
    id              TEXT PRIMARY KEY,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type      TEXT NOT NULL,
    action          TEXT NOT NULL,
    "user"          TEXT NOT NULL DEFAULT 'system',
    user_type       TEXT NOT NULL DEFAULT 'system',
    resource        TEXT,
    resource_type   TEXT,
    resource_id     TEXT,
    status          TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'info',
    details         TEXT,
    metadata        JSONB,
    ip_address      TEXT,
    user_agent      TEXT,
    session_id      TEXT,
    correlation_id  TEXT,
    execution_id    TEXT,
    region          TEXT,
    account_id      TEXT,
    duration        INTEGER,
    error_code      TEXT,
    source          TEXT,
    expires_at      TIMESTAMPTZ
);
CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_user ON audit_logs("user", timestamp DESC);
CREATE INDEX idx_audit_event_type ON audit_logs(event_type, timestamp DESC);
CREATE INDEX idx_audit_correlation ON audit_logs(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_audit_expires ON audit_logs(expires_at) WHERE expires_at IS NOT NULL;
```

### 3.2 Scheduler Lambda Migration
Critical path — the scheduler Lambda (`lambda/scheduler/`) has its own DynamoDB clients:
- Create `lambda/scheduler/src/services/pg-service.ts` (same exports as `dynamodb-service.ts`)
- Create `lambda/scheduler/src/services/pg-execution-history-service.ts`
- Swap imports in `lambda/scheduler/src/index.ts` behind `USE_PG_SCHEDULES` env flag
- Lambda connection pooling: `max: 3`, `idleTimeoutMillis: 10000`

### 3.3 TTL Replacement
DynamoDB TTL is automatic. PostgreSQL needs a cleanup job:
- Create `scripts/db/cleanup-expired.ts` — runs `DELETE FROM audit_logs WHERE expires_at < NOW()` etc.
- For local dev: add npm script `"db:cleanup": "tsx scripts/db/cleanup-expired.ts"`
- For production: schedule via EventBridge → Lambda or pg_cron

### 3.4 Key Improvement: Audit Log Queries
Current audit service fetches up to 10 pages from DynamoDB and filters client-side. PostgreSQL version:
```sql
SELECT * FROM audit_logs
WHERE ($1::text IS NULL OR "user" = $1)
  AND ($2::text IS NULL OR event_type = $2)
  AND ($3::timestamptz IS NULL OR timestamp >= $3)
  AND ($4::timestamptz IS NULL OR timestamp <= $4)
  AND ($5::text IS NULL OR status = $5)
ORDER BY timestamp DESC
LIMIT $6 OFFSET $7;
```

### 3.5 Data Migration Scripts
- `scripts/db/migrate-schedules.ts`: Scan GSI1 `TYPE#SCHEDULE`
- `scripts/db/migrate-executions.ts`: Scan GSI1 `TYPE#EXECUTION` (paginated, large dataset)
- `scripts/db/migrate-audit-logs.ts`: Scan GSI1 `TYPE#LOG` (largest table — batch of 1000, cursor-based)

### 3.6 Affected Files (~12 API routes + 2 Lambda service files)
- `web-ui/lib/schedule-service.ts`
- `web-ui/lib/schedule-execution-service.ts`
- `web-ui/lib/audit-service.ts`
- `lambda/scheduler/src/services/dynamodb-service.ts`
- `lambda/scheduler/src/services/execution-history-service.ts`
- All schedule/audit API routes

### 3.7 Dual-Write Recommendation
For this phase only, consider dual-writing to both DynamoDB and PostgreSQL for 1-2 weeks before cutting over reads. This catches transformation bugs in the highest-risk area.

### Feature Flags
```
USE_PG_SCHEDULES=true
USE_PG_AUDIT=true
```

---

## Phase 4: Knowledge Base + Vector Processor Lambda

### 4.1 PostgreSQL Schema
```sql
CREATE TABLE knowledge_bases (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         TEXT NOT NULL REFERENCES tenants(id),
    name              TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    vector_count      INTEGER NOT NULL DEFAULT 0,
    data_source_count INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by        TEXT
);

CREATE TABLE data_sources (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    config            JSONB NOT NULL DEFAULT '{}',
    vector_count      INTEGER NOT NULL DEFAULT 0,
    vector_keys       TEXT[] DEFAULT '{}',
    last_sync_at      TIMESTAMPTZ,
    last_sync_error   TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_vector_keys (
    account_id  TEXT PRIMARY KEY,
    vector_keys TEXT[] NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.2 Key Improvement: Atomic Counter Updates
Current KB service uses DynamoDB `SET vector_count = if_not_exists(vector_count, :zero) + :delta`. PostgreSQL equivalent:
```sql
UPDATE knowledge_bases SET vector_count = vector_count + $1 WHERE id = $2;
```
Simpler and transactional.

### 4.3 Lambda Migrations
- `lambda/vector_processor/src/index.ts` — replace `getPreviousVectorKeys`/`saveVectorKeys`/`writeAuditLog` with PG equivalents
- `lambda/kb_sync_processor/src/index.ts` — replace `getDataSource`/`updateDS`/`updateKBVectorCount`

### 4.4 Data Migration
- `scripts/db/migrate-knowledge-bases.ts`: Scan `sk begins_with KB#` and `DATASOURCE#`
- `scripts/db/migrate-vector-keys.ts`: Scan `INVENTORY_VECTORS#` items

### Feature Flag
```
USE_PG_KNOWLEDGE_BASE=true
```

---

## Phase 5: Agent Ops (Dynamoose Rewrite)

**Why last:** Highest complexity — complete Dynamoose ODM rewrite. Self-contained, no FK dependencies on other migrated tables.

### 5.1 PostgreSQL Schema
```sql
CREATE TABLE agent_ops_runs (
    id               UUID PRIMARY KEY,
    tenant_id        TEXT NOT NULL,
    source           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued',
    task_description TEXT NOT NULL,
    mode             TEXT NOT NULL DEFAULT 'plan',
    thread_id        TEXT NOT NULL,
    account_id       TEXT,
    account_name     TEXT,
    selected_skill   TEXT,
    mcp_server_ids   TEXT[],
    auto_approve     BOOLEAN NOT NULL DEFAULT false,
    model            TEXT,
    trigger          JSONB NOT NULL,
    clarification    JSONB,
    approval_request JSONB,
    result           JSONB,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    duration_ms      INTEGER,
    expires_at       TIMESTAMPTZ
);
CREATE INDEX idx_runs_source ON agent_ops_runs(source, created_at DESC);
CREATE INDEX idx_runs_status ON agent_ops_runs(status);

CREATE TABLE agent_ops_events (
    id          BIGSERIAL PRIMARY KEY,
    run_id      UUID NOT NULL REFERENCES agent_ops_runs(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    node        TEXT NOT NULL,
    content     TEXT,
    tool_name   TEXT,
    tool_args   JSONB,
    tool_output TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_run ON agent_ops_events(run_id, created_at ASC);

CREATE TABLE scheduled_tasks (
    id              UUID PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    timezone        TEXT NOT NULL,
    task_status     TEXT NOT NULL DEFAULT 'active',
    mode            TEXT NOT NULL DEFAULT 'plan',
    auto_approve    BOOLEAN NOT NULL DEFAULT false,
    model           TEXT,
    account_id      TEXT,
    account_name    TEXT,
    mcp_server_ids  TEXT[],
    notification    JSONB,
    last_run_id     UUID,
    last_run_at     TIMESTAMPTZ,
    last_run_status TEXT,
    next_run_at     TIMESTAMPTZ,
    run_count       INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      TEXT NOT NULL
);

-- Replaces Dynamoose conditional PutItem for execution locking
CREATE TABLE scheduled_task_locks (
    task_id      TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    acquired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (task_id, scheduled_at)
);
```

### 5.2 Dynamoose → Drizzle Rewrite
Every `Model.create()`, `Model.get()`, `Model.query()`, `Model.update()` call becomes a Drizzle equivalent. The Dynamoose schema validation is replaced by Drizzle's TypeScript schema + PostgreSQL constraints.

### 5.3 Data Migration
- `scripts/db/migrate-agent-ops.ts`: Scan AgentOpsTable `RUN#`, `EVENT#`, `SCHED#` items

### Feature Flag
```
USE_PG_AGENT_OPS=true
```

---

## Data Migration Scripts

### Directory Structure
```
scripts/db/
  migrate-tenant-configs.ts
  migrate-accounts.ts
  migrate-rbac.ts
  migrate-schedules.ts
  migrate-executions.ts
  migrate-audit-logs.ts
  migrate-knowledge-bases.ts
  migrate-vector-keys.ts
  migrate-agent-ops.ts
  migrate-all.ts              # Orchestrator (runs in dependency order)
  verify-migration.ts         # Count comparison + spot-check
  cleanup-expired.ts          # TTL replacement cron
```

### Script Pattern
Each script:
1. Connects to cloud DynamoDB (via `AWS_PROFILE=STX-CLOUD-PLATFORM-ADMIN`)
2. Paginated scan/query of source table
3. Transforms DynamoDB item → PostgreSQL row (camelCase → snake_case, epoch TTL → timestamptz)
4. Batch inserts (chunks of 100) with `ON CONFLICT DO UPDATE` for idempotency
5. Logs progress: `Migrated 500/1234 accounts...`
6. Final count comparison

### Run Order
```bash
docker compose up -d postgres
npm run db:migrate
npx tsx scripts/db/migrate-all.ts --profile STX-CLOUD-PLATFORM-ADMIN
npx tsx scripts/db/verify-migration.ts
```

---

## Rollback Strategy

1. **Feature flags** — flip `USE_PG_<ENTITY>=false` and restart. Instant rollback per entity.
2. **DynamoDB tables are never deleted** — they remain as source of truth until each phase is validated for 2+ weeks in production.
3. **PostgreSQL can be re-seeded** — truncate and re-run migration scripts from DynamoDB at any time.
4. **CDK stacks unchanged** — DynamoDB table definitions stay in CDK throughout migration. Remove only after full cutover.

---

## Testing Strategy

| Phase | Tests |
|-------|-------|
| 0 (Foundation) | Integration: connect to Docker PG, run migrations, verify tables |
| 1-5 (Each entity) | Repository interface tests against both backends; data migration verification script; existing `npm run test` regression |
| 3 (Schedules) | E2E: `npx playwright test`; Lambda: `cd lambda/scheduler && npm run test` |
| 5 (Agent Ops) | Full agent-ops API route integration tests |

---

## Things You Might Be Missing

1. **Client-side pagination → server-side.** Every service currently fetches ALL records and filters in JS. PostgreSQL gives you `WHERE`/`ORDER BY`/`LIMIT`/`OFFSET`. Don't port the "fetch all" pattern — rewrite queries properly. This is a major win.

2. **TTL needs a cron job.** DynamoDB TTL is automatic. PostgreSQL needs `DELETE FROM ... WHERE expires_at < NOW()` via pg_cron, EventBridge Lambda, or a daily script.

3. **Lambda connection pooling.** DynamoDB is HTTP-per-request. PostgreSQL needs persistent connections. Use `max: 3` pool per Lambda. For production, consider RDS Proxy to avoid connection exhaustion under concurrency spikes.

4. **Transactions are now free.** Current codebase has zero DynamoDB transactions. PostgreSQL gives you real transactions — use them for "create schedule + log audit" atomicity. This is an improvement.

5. **Multi-tenant safety.** DynamoDB uses composite keys (`TENANT#<id>`) to scope queries. In PostgreSQL, every query must include `WHERE tenant_id = $1`. Easy to accidentally leak across tenants — enforce via repository layer.

6. **The `AgentConversationsTable` may be dead code.** Defined in CDK but no service-layer references found. Verify before migrating.

7. **The `NucleusInventoryTable` is only used by the Python discovery Lambda.** The vector processor reads from S3 `normalized/` files, not from this table. Consider whether it needs migration at all.

8. **Audit logging must remain fire-and-forget.** Current `AuditService` silently catches errors. Maintain this pattern — never let a PG connection error propagate to business operations.

9. **Cloud PostgreSQL choice.** For production: RDS PostgreSQL `db.t4g.medium` is sufficient at current scale (< 1000 accounts). Aurora Serverless v2 if Lambda concurrency spikes are a concern.

10. **The Dynamoose rewrite (Phase 5) is the riskiest.** Budget extra time — every `Model.query()`, `.update()`, `.create()`, `.get()` needs manual rewrite. ~15 API routes and 6 service files affected.

11. **Discovery Lambda is Python.** All other Lambdas are TypeScript. The Python Lambda uses `boto3` for DynamoDB. If migrating it to PostgreSQL, you'd use `psycopg2` or `asyncpg` — a different driver ecosystem. Consider keeping it on DynamoDB or rewriting in TypeScript.

---

## Verification

After each phase:
1. Run `npx tsx scripts/db/verify-migration.ts` — compares row counts between DynamoDB and PostgreSQL
2. Run `cd web-ui && npm run test` — existing unit tests
3. Run `npx playwright test` — E2E tests (after phases 2 and 3)
4. Manual smoke test with feature flag toggled on
5. Monitor for errors in console/CloudWatch for 48 hours before proceeding to next phase
