---
status: investigating
trigger: "Fix 3 bugs: /api/mcp-servers tenantId missing, /api/threads history HistoryValidationError, dynamoose critical dependency warning"
created: 2026-04-05T00:00:00Z
updated: 2026-04-05T00:00:00Z
symptoms_prefilled: true
---

## Current Focus

hypothesis: Reading relevant files to confirm root causes before fixing
test: Read route files, repository, persistence, and repository-factory
expecting: Confirm exact lines causing each bug
next_action: Read app/api/mcp-servers/route.ts, lib/db/repositories/tenant-config/postgres.ts, app/api/threads/[threadId]/history/route.ts, lib/agent/persistence.ts, lib/db/repository-factory.ts

## Symptoms

expected: All 3 API endpoints work correctly with tenant isolation
actual:
  1. GET /api/mcp-servers → PrismaClientValidationError: tenantId argument missing
  2. GET /api/threads/[threadId]/history → HistoryValidationError: Session ID must be a string
  3. dynamoose critical dependency warning even when USE_PG_AGENT_OPS=true
errors:
  - "[TenantConfigPostgresRepository] Error getting config mcp-servers: Argument tenantId is missing"
  - "Error [HistoryValidationError]: Session ID must be a string"
  - "Critical dependency: the request of a dependency is an expression" from dynamoose import chain
reproduction:
  1. GET /api/mcp-servers with valid session
  2. GET /api/threads/[threadId]/history with valid session
  3. Any import of lib/tenant-config-service.ts triggers dynamoose load
started: unknown

## Eliminated

## Evidence

## Resolution

root_cause:
fix:
verification:
files_changed: []
