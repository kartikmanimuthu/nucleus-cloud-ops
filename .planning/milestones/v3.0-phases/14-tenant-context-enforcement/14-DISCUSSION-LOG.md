# Phase 14: Tenant Context Enforcement - Discussion Log (Assumptions Mode)

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the analysis.

**Date:** 2026-04-01
**Phase:** 14-tenant-context-enforcement
**Mode:** assumptions
**Areas analyzed:** Scoped Prisma Client, DEFAULT_TENANT_ID Removal, Scheduler Lambda Tenant Isolation, Discovery Lambda Tenant Isolation, LangGraph Thread Isolation, Two-Tenant Isolation Test

## Assumptions Presented

### Scoped Prisma Client Approach
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| getTenantClient(tenantId) uses Prisma Client Extensions ($extends) wrapping singleton from pg-config.ts | Likely | web-ui/lib/db/pg-config.ts, web-ui/prisma/schema.prisma (all models have tenantId + @@index) |
| Raw SQL queries ($executeRaw, $queryRawUnsafe) bypass Extensions — need manual scoping | Likely | web-ui/lib/agent/persistence.ts line 130, web-ui/lib/db/repositories/inventory/postgres.ts line 284 |

### DEFAULT_TENANT_ID Removal
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| ~8 service files + ~12 API routes + 2 Lambdas need DEFAULT_TENANT_ID removed | Confident | grep across account-service.ts, schedule-service.ts, schedule-execution-service.ts, tenant-config-service.ts, knowledge-base/service.ts, scheduler Lambda |
| API routes source tenantId from getSessionTenantId(), Lambdas from record data | Confident | web-ui/lib/auth-session.ts already throws on missing tenantId |

### Scheduler Lambda Multi-Tenant
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| Scheduler iterates all active tenants instead of hardcoded DEFAULT_TENANT_ID | Likely | lambda/scheduler/src/services/scheduler-service.ts lines 24, 36 |
| Add minimal status column to Tenant model for scheduler filtering | Likely | Tenant model in prisma/schema.prisma lacks status field, ISOL-03 requires skipping suspended tenants |

### LangGraph Thread Isolation
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| Thread IDs namespaced as tenantId:userId:uuid with validation on access | Likely | web-ui/app/api/chat/route.ts line 49 (no tenant validation), web-ui/app/api/threads/route.ts (full scan, no tenant filter) |
| Tenant-scoped wrapper around PostgresSaver and getChatHistory() | Likely | web-ui/lib/agent/persistence.ts — PostgresChatHistory conflates userId with tenantId |

## Corrections Made

No corrections — all assumptions confirmed (auto mode).

## Auto-Resolved

- Scoped Prisma Client: auto-selected Prisma Client Extensions over middleware ($use) or PostgreSQL RLS
- Scheduler Lambda: auto-selected minimal status column (active/suspended) over suspended_at timestamp
- LangGraph Thread Isolation: auto-selected tenant-scoped wrapper approach over separate threads table

## External Research

- Prisma Client Extensions $allOperations hook behavior with $executeRaw/$queryRawUnsafe
- @langchain/langgraph-checkpoint-postgres PostgresSaver tenant-scoped key prefixing
