# Pitfalls Research: DynamoDB to PostgreSQL Migration

## Critical Pitfalls

### 1. Lambda Connection Exhaustion
- **Risk:** High
- **Phase:** Foundation (affects all Lambda phases)
- **Problem:** DynamoDB is HTTP-per-request with no persistent connections. PostgreSQL requires connection pools. Lambda concurrency spikes can exhaust PostgreSQL's max_connections (default 100 on RDS).
- **Warning signs:** "too many connections" errors during concurrent Lambda invocations
- **Prevention:**
  - Set `max: 3` pool per Lambda function
  - Set `idleTimeoutMillis: 10000` to release idle connections quickly
  - For production: use RDS Proxy to multiplex Lambda connections
  - Add connection error handling with retry logic

### 2. Tenant Data Leakage
- **Risk:** High
- **Phase:** Every entity phase
- **Problem:** DynamoDB scopes queries via composite keys (TENANT#<id>). In PostgreSQL, forgetting `WHERE tenant_id = $1` returns cross-tenant data.
- **Warning signs:** Tests pass but return unexpected data; data from wrong tenant visible
- **Prevention:**
  - Enforce tenant_id in repository interface (required parameter, not optional)
  - Add row-level security (RLS) as defense-in-depth
  - Write explicit cross-tenant isolation tests for every repository

### 3. DynamoDB Single-Table → Relational Mapping Errors
- **Risk:** Medium-High
- **Phase:** Phases 2-6
- **Problem:** Single-table design packs multiple entity types into one table with composite keys. Decomposing into separate PostgreSQL tables requires understanding all PK/SK patterns and GSI access patterns.
- **Warning signs:** Missing data after migration; queries returning empty results
- **Prevention:**
  - Document every PK/SK pattern before migrating (done in codebase exploration)
  - Verify row counts after each migration script
  - Run verification script comparing DynamoDB scan count vs PostgreSQL row count

### 4. Dynamoose → Drizzle Rewrite Complexity (Phase: Agent Ops)
- **Risk:** High
- **Phase:** Agent Ops
- **Problem:** Agent-ops uses Dynamoose ODM with schema validation, conditional expressions, and model lifecycle hooks. Every `Model.create()`, `.get()`, `.query()`, `.update()` needs manual rewrite.
- **Warning signs:** ~15 API routes and 6 service files affected; subtle behavioral differences
- **Prevention:**
  - Write comprehensive TDD tests before rewriting
  - Map every Dynamoose operation to Drizzle equivalent
  - Test conditional puts (execution locking) carefully — Dynamoose `condition` → PostgreSQL `INSERT ... ON CONFLICT`

### 5. Audit Log Volume
- **Risk:** Medium
- **Phase:** Schedules + Audit
- **Problem:** Audit table is the largest. DynamoDB handles TTL automatically. PostgreSQL needs explicit cleanup. Migration script must handle potentially millions of records.
- **Warning signs:** Migration script OOM; cleanup job takes too long
- **Prevention:**
  - Batch inserts in chunks of 100-500
  - Use cursor-based pagination for DynamoDB scan (not offset)
  - Add `expires_at` index for efficient cleanup queries
  - Consider partitioning audit_logs by month for production

### 6. LangGraph Checkpoint Format Incompatibility
- **Risk:** Medium
- **Phase:** LangGraph
- **Problem:** `@farukada/aws-langgraph-dynamodb-ts` stores checkpoints in DynamoDB-specific format. `@langchain/langgraph-checkpoint-postgres` expects different schema. Direct data migration may not work.
- **Warning signs:** Agent errors after switching; "invalid checkpoint" exceptions
- **Prevention:**
  - Research @langchain/langgraph-checkpoint-postgres schema format
  - Compare with current DynamoDB checkpoint structure
  - Consider: existing checkpoints may be ephemeral (30-day TTL) — fresh start may be acceptable
  - If migrating: write custom transformer between formats

### 7. Fire-and-Forget Audit Logging Must Stay Non-Blocking
- **Risk:** Medium
- **Phase:** Schedules + Audit
- **Problem:** Current AuditService silently catches all errors. If PostgreSQL audit writes start throwing connection errors, they could propagate to business operations.
- **Warning signs:** Audit logging failures cascading to schedule execution failures
- **Prevention:**
  - Maintain try/catch pattern in audit repository
  - Add logging for audit write failures (but never throw)
  - Monitor audit write error rates separately

### 8. Migration Script Idempotency
- **Risk:** Medium
- **Phase:** All migration scripts
- **Problem:** Migration scripts may be run multiple times (retry after failure, re-run for verification). Non-idempotent scripts will create duplicates or fail on unique constraints.
- **Warning signs:** Duplicate rows; unique constraint violations on re-run
- **Prevention:**
  - Use `ON CONFLICT DO UPDATE` for all inserts
  - Make every script re-runnable
  - Add `--dry-run` flag to preview changes before applying

### 9. Dual-Write Consistency (Schedules Phase)
- **Risk:** Medium
- **Phase:** Schedules + Executions + Audit
- **Problem:** Dual-writing to both DynamoDB and PostgreSQL can drift if one write succeeds and other fails.
- **Warning signs:** Data mismatch between backends
- **Prevention:**
  - Write to PostgreSQL first (source of truth), then DynamoDB (best-effort)
  - Log any DynamoDB write failures during dual-write period
  - Time-box dual-write to 1-2 weeks maximum
  - Run verification script daily during dual-write period

### 10. Python Lambda psycopg2 Layer
- **Risk:** Low-Medium
- **Phase:** Inventory + Discovery Lambda
- **Problem:** psycopg2 requires libpq. Lambda needs a compiled binary matching the Lambda runtime architecture.
- **Warning signs:** Import errors in Lambda; "libpq" not found
- **Prevention:**
  - Use `psycopg2-binary` which includes compiled binaries
  - Or use a Lambda Layer with pre-compiled psycopg2
  - Test in Docker container matching Lambda runtime before deploying
