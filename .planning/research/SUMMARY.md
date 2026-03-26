# Research Summary: DynamoDB to PostgreSQL Migration

## Key Findings

### Stack
- **Drizzle ORM** is the clear choice: ~50KB runtime, esbuild-compatible, SQL-first TypeScript inference
- **pg (node-postgres)** for driver, Docker Compose + PostgreSQL 16 for local dev
- **@langchain/langgraph-checkpoint-postgres** for LangGraph persistence migration
- **psycopg2-binary** for Python discovery Lambda

### Table Stakes
1. Repository pattern with per-entity feature flags (`USE_PG_<ENTITY>`)
2. Idempotent data migration scripts (DynamoDB → PostgreSQL)
3. Server-side filtering (replacing ALL client-side filter patterns)
4. TTL replacement via scheduled cleanup
5. Multi-tenant safety (tenant_id in every query)
6. Instant rollback via feature flags

### Biggest Risks
1. **Lambda connection exhaustion** — pool size must be small (max: 3), consider RDS Proxy for production
2. **Tenant data leakage** — PostgreSQL requires explicit WHERE tenant_id, unlike DynamoDB's composite keys
3. **Dynamoose rewrite (Agent Ops)** — most complex phase, ~15 API routes + 6 service files
4. **LangGraph checkpoint format** — different library may mean incompatible format; ephemeral data (30-day TTL) may allow fresh start

### Build Order
Foundation → Tenant Config → Accounts+RBAC → Schedules+Executions+Audit → KB+Inventory+Vector → Agent Ops → LangGraph

### Key Improvements Over DynamoDB
- Real transactions (atomic multi-table operations)
- Relational joins (single query instead of multiple)
- Server-side filtering, sorting, pagination
- Complex ad-hoc queries (ILIKE, date ranges, full-text)

## Codebase Impact Summary

| Area | Files Affected | DynamoDB Tables |
|------|---------------|-----------------|
| Tenant Config | ~4 API routes, 1 service | APP_TABLE (CONFIG# items) |
| Accounts | ~5 API routes, 1 service | APP_TABLE (ACCOUNT# items) |
| RBAC | ~2 API routes, 1 service | USERS_TEAMS_TABLE |
| Schedules | ~6 API routes, 1 service, 1 Lambda | APP_TABLE (SCHEDULE# items) |
| Executions | ~4 API routes, 1 service, 1 Lambda | APP_TABLE (EXEC# items) |
| Audit | ~2 API routes, 1 service | AUDIT_TABLE |
| Knowledge Base | ~4 API routes, 2 services | APP_TABLE (KB#, DATASOURCE# items) |
| Inventory | 1 Python Lambda | INVENTORY_TABLE |
| Agent Ops | ~15 API routes, 6 services | AGENT_OPS_TABLE |
| LangGraph | persistence.ts, chat routes | CHECKPOINTS, WRITES, CHAT_HISTORY, MEMORY |
| Agent Conversations | TBD (verify usage first) | AGENT_CONVERSATIONS |
