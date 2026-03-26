# Features Research: DynamoDB to PostgreSQL Migration

## Table Stakes (must have or migration fails)

### Repository Pattern with Feature Flags
- **Complexity:** Medium
- Interface per entity, two implementations (DynamoDB + PostgreSQL)
- Feature flag per entity: `USE_PG_<ENTITY>=true|false`
- Factory function returns correct implementation
- **Dependencies:** Foundation phase must complete first

### Data Migration Scripts
- **Complexity:** High
- DynamoDB Scan/Query → transform → PostgreSQL batch insert
- Idempotent: `ON CONFLICT DO UPDATE` for re-runnability
- Progress logging with counts
- Paginated DynamoDB reads (1MB limit per page)
- AWS_PROFILE=PLATFORM-ADMIN for credential access
- **Dependencies:** PostgreSQL schema must exist first

### Server-Side Filtering
- **Complexity:** Low-Medium
- Replace client-side filter patterns with PostgreSQL WHERE/ORDER BY/LIMIT/OFFSET
- Every service currently fetches ALL records and filters in JS
- Key services: AccountService.getAccounts(), ScheduleService.getSchedules(), AgentOpsService.listRuns()
- **Dependencies:** Repository implementations

### TTL Replacement
- **Complexity:** Low
- DynamoDB TTL is automatic; PostgreSQL needs scheduled cleanup
- `DELETE FROM table WHERE expires_at < NOW()`
- Options: npm script for dev, EventBridge Lambda or pg_cron for production
- Tables with TTL: audit_logs (90 days), agent_ops_runs (30 days), checkpoints (30 days), chat_history, memory (90 days)
- **Dependencies:** Schema must include expires_at columns

### Multi-Tenant Safety
- **Complexity:** Medium
- Every query must include `WHERE tenant_id = $1`
- DynamoDB uses composite keys (TENANT#<id>) for scoping
- PostgreSQL: enforce in repository layer, not in service layer
- **Dependencies:** Repository pattern base

### Rollback Capability
- **Complexity:** Low
- Feature flags provide instant rollback per entity
- DynamoDB tables never deleted during migration
- PostgreSQL can be re-seeded from DynamoDB at any time
- **Dependencies:** Feature flag infrastructure

## Differentiators (quality improvements over DynamoDB)

### Real Transactions
- Current codebase has zero DynamoDB transactions
- PostgreSQL gives atomic "create schedule + log audit" operations
- Use for: schedule creation + audit log, agent run + event recording

### Relational Joins
- Schedule → Account → Tenant joins currently require multiple queries
- PostgreSQL: single query with JOINs

### Proper Pagination
- Replace DynamoDB cursor-based (LastEvaluatedKey) with LIMIT/OFFSET
- Or keyset pagination for large datasets (audit logs)

### Complex Ad-Hoc Queries
- Full-text search, ILIKE, date range filtering all server-side
- Audit log queries currently filter 10 pages client-side

## Anti-Features (deliberately NOT building)

| Feature | Reason |
|---------|--------|
| Full ORM abstraction layer | Drizzle is already thin; adding another layer is overhead |
| Real-time CDC (Change Data Capture) | Overkill; feature flags + migration scripts sufficient |
| Automated DynamoDB → PG sync | One-time migration scripts, not ongoing sync |
| Schema versioning UI | drizzle-kit CLI is sufficient |
| Multi-database support beyond PG | Only targeting PostgreSQL |
