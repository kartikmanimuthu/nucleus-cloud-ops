# Local PostgreSQL Migration Guide

Step-by-step runbook for setting up the local PostgreSQL environment and migrating all data from DynamoDB.

## Prerequisites

- Docker Desktop running
- Node.js 20+
- AWS SSO session active (`aws sso login --profile PLATFORM-ADMIN`)
- Repo cloned and checked out to `database-migration` branch

---

## Step 1 — Start PostgreSQL

```bash
docker compose up -d postgres
docker exec nucleus-postgres pg_isready -U nucleus -d nucleus
```

Expected: `nucleus:5432 - accepting connections`

---

## Step 2 — Install dependencies

```bash
npm install
cd web-ui && npm install && cd ..
```

---

## Step 3 — Configure environment

```bash
cp .env.example .env
```

Edit the root `.env` and ensure these values are set:

```env
DATABASE_URL=postgresql://nucleus:nucleus_dev@localhost:5432/nucleus?connection_limit=10
NEXTAUTH_SECRET=local-dev-secret-change-me

USE_PG_TENANT_CONFIG=true
USE_PG_ACCOUNTS=true
USE_PG_SCHEDULES=true
USE_PG_AUDIT=true
USE_PG_KB=true
USE_PG_INVENTORY=true
USE_PG_AGENT_OPS=true
USE_PG_LANGGRAPH=true

APP_TABLE_NAME=nucleus-app-app-table
AUDIT_TABLE_NAME=nucleus-app-audit-table
AGENT_OPS_TABLE_NAME=nucleus-app-agent-ops
INVENTORY_TABLE_NAME=nucleus-app-inventory-table
AWS_REGION=ap-south-1
```

---

## Step 4 — Apply Prisma migrations

Run from the repo root:

```bash
npx prisma migrate deploy --schema=libs/prisma/schema.prisma
npx prisma generate --schema=libs/prisma/schema.prisma
```

Verify all 19 tables were created:

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "\dt"
```

---

## Step 5 — Fix Prisma client resolution (web-ui)

The web-ui has a stale local Prisma client that shadows the root client. Remove it so imports resolve to the correct generated client:

```bash
rm -rf web-ui/node_modules/.prisma web-ui/node_modules/@prisma
```

> **Why:** `web-ui/node_modules/@prisma/client` was generated during Phase 1 (Tenant/TenantConfig only). Node resolves it before the root client, causing `getPrismaClient().account` to be `undefined`. Removing it forces resolution to the root client which has all 19 models.

---

## Step 6 — Migrate data from DynamoDB to PostgreSQL

Run all 8 migration scripts in dependency order:

```bash
APP_TABLE_NAME=nucleus-app-app-table \
AUDIT_TABLE_NAME=nucleus-app-audit-table \
AGENT_OPS_TABLE_NAME=nucleus-app-agent-ops \
INVENTORY_TABLE_NAME=nucleus-app-inventory-table \
AWS_REGION=ap-south-1 \
DATABASE_URL="postgresql://nucleus:nucleus_dev@localhost:5432/nucleus?connection_limit=10" \
AWS_PROFILE=PLATFORM-ADMIN \
npx tsx scripts/migrate-all.ts
```

Migration order (handled automatically):
1. `migrate-tenant-configs` — Tenants + Tenant Configs
2. `migrate-accounts` — Accounts
3. `migrate-rbac` — User Tenant Roles
4. `migrate-schedules` — Schedules + Executions
5. `migrate-audit-logs` — Audit Logs (batched 500)
6. `migrate-kb` — Knowledge Bases + Data Sources
7. `migrate-inventory` — Inventory Resources + Vector Keys
8. `migrate-agent-ops` — Agent Ops Runs, Events, Scheduled Tasks

If a script fails, resume from where it stopped:

```bash
APP_TABLE_NAME=nucleus-app-app-table \
AUDIT_TABLE_NAME=nucleus-app-audit-table \
AGENT_OPS_TABLE_NAME=nucleus-app-agent-ops \
INVENTORY_TABLE_NAME=nucleus-app-inventory-table \
AWS_REGION=ap-south-1 \
DATABASE_URL="postgresql://nucleus:nucleus_dev@localhost:5432/nucleus?connection_limit=10" \
AWS_PROFILE=PLATFORM-ADMIN \
npx tsx scripts/migrate-all.ts --from migrate-inventory
```

> **Note:** Chat history and agent memory tables are intentionally skipped — they are ephemeral (30/90-day TTL) and start fresh on PostgreSQL.

---

## Step 7 — Verify row counts

```bash
APP_TABLE_NAME=nucleus-app-app-table \
AUDIT_TABLE_NAME=nucleus-app-audit-table \
AGENT_OPS_TABLE_NAME=nucleus-app-agent-ops \
INVENTORY_TABLE_NAME=nucleus-app-inventory-table \
AWS_REGION=ap-south-1 \
DATABASE_URL="postgresql://nucleus:nucleus_dev@localhost:5432/nucleus?connection_limit=10" \
AWS_PROFILE=PLATFORM-ADMIN \
npx tsx scripts/verify-migration.ts
```

All rows in the `Match` column should show `YES`. Any `NO` means re-run the relevant migration script.

---

## Step 8 — Start the dev server

```bash
cd web-ui && npm run dev
```

Open http://localhost:3000. The app should load (auth/login screen is expected — Cognito is not configured locally).

Check the terminal for Prisma query logs — you should see PostgreSQL queries, not DynamoDB errors, for all migrated entities.

---

## Subsequent runs (already migrated)

If PostgreSQL already has data, the migration scripts are idempotent — re-running them will skip duplicates (`skipDuplicates: true` / `ON CONFLICT DO NOTHING`). Safe to re-run.

To reset and start fresh:

```bash
docker compose down -v          # destroys the postgres volume
docker compose up -d postgres
npx prisma migrate deploy --schema=libs/prisma/schema.prisma
npx prisma generate --schema=libs/prisma/schema.prisma
# then re-run Step 6
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `getPrismaClient().account is undefined` | Run `rm -rf web-ui/node_modules/.prisma web-ui/node_modules/@prisma` then restart dev server |
| `APP_TABLE_NAME is required` | Pass all env vars inline (see Step 6) or `set -a && source .env && set +a` |
| `Token is expired` | Run `aws sso login --profile PLATFORM-ADMIN` |
| `pg_isready` fails | Docker not running or container not started — run `docker compose up -d postgres` |
| `prisma migrate deploy` fails | Check `DATABASE_URL` is set and postgres container is healthy |
| ts-node REPL opens instead of running script | Use `npx tsx` not `npx ts-node`, and keep the command on one line |
