---
quick_id: 260328-udt
status: completed
date: 2026-03-28
---

# Quick Task 260328-udt: Local Dev Setup + Migration Verification

## What was done

1. **PostgreSQL container started** — `nucleus-postgres` (pgvector/pgvector:pg16) running healthy on port 5432
2. **Prisma migrations applied** — all 19 tables created via `prisma migrate deploy`
3. **Prisma client generated** — root-level client with all models
4. **`web-ui/.env.local` configured** — `DATABASE_URL` + all 8 `USE_PG_*=true` flags set
5. **Full data migration run** — `migrate-all.ts` migrated all 8 entity groups from DynamoDB to PostgreSQL:
   - 4 tenant configs, 92 accounts, 10 RBAC roles
   - 22 schedules, 1463 executions
   - 40,656 audit logs
   - 2 knowledge bases, 3 data sources
   - 31,132 inventory resources, 90 vector keys
   - 47 agent ops runs, 2310 events, 1 scheduled task
6. **Migration verified** — `verify-migration.ts` confirmed all row counts match between DynamoDB and PostgreSQL
7. **LOCAL-MIGRATION-GUIDE.md written** — step-by-step runbook at `scripts/LOCAL-MIGRATION-GUIDE.md`

## Issues found and fixed

- **Stale Prisma client in web-ui**: `web-ui/node_modules/@prisma/client` was generated during Phase 1 (Tenant/TenantConfig only), causing `getPrismaClient().account` to return `undefined`. Fix: `rm -rf web-ui/node_modules/.prisma web-ui/node_modules/@prisma`
- **`INVENTORY_TABLE_NAME` missing from migrate-all invocation**: script requires it explicitly; added to env vars and resumed with `--from migrate-inventory`
- **ts-node REPL trap**: multiline shell command with newline before script path entered REPL mode. Fix: use `npx tsx` on a single line

## Artifacts

- `scripts/LOCAL-MIGRATION-GUIDE.md` — runbook for future local setup
