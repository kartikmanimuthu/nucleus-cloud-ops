---
phase: quick
plan: 260328-udt
type: execute
wave: 1
depends_on: []
files_modified:
  - web-ui/.env.local
autonomous: false
requirements: [LOCAL-SETUP]

must_haves:
  truths:
    - "PostgreSQL container is running and accepting connections on port 5432"
    - "All Prisma migrations have been applied (schema matches prisma/migrations/)"
    - "Prisma client is generated and importable"
    - "Dev server starts without errors"
    - "App loads at http://localhost:3000"
  artifacts:
    - path: "web-ui/.env.local"
      provides: "Runtime config with DATABASE_URL and feature flags"
    - path: "prisma/schema.prisma"
      provides: "PostgreSQL schema (already exists)"
  key_links:
    - from: "web-ui/.env.local"
      to: "PostgreSQL container"
      via: "DATABASE_URL=postgresql://nucleus:nucleus_dev@localhost:5432/nucleus"
    - from: "prisma/schema.prisma"
      to: "nucleus-postgres container"
      via: "prisma migrate deploy"
---

<objective>
Set up the local PostgreSQL development environment and verify the DynamoDB→PostgreSQL migration works end-to-end.

Purpose: Confirm the v1.0 migration is functional locally before any production work begins.
Output: Running dev server backed by PostgreSQL with all schema migrations applied.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md
@web-ui/.env.local.example
@docker-compose.yml
</context>

<tasks>

<task type="auto">
  <name>Task 1: Start PostgreSQL and configure environment</name>
  <files>web-ui/.env.local</files>
  <action>
    Run these commands from the repo root (/Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration):

    1. Start the PostgreSQL container (pgvector/pgvector:pg16):
       ```
       docker compose up -d postgres
       ```

    2. Wait for healthy status (up to 30s):
       ```
       docker compose ps
       docker exec nucleus-postgres pg_isready -U nucleus -d nucleus
       ```

    3. Install root dependencies:
       ```
       npm install
       ```

    4. Install web-ui dependencies:
       ```
       cd web-ui && npm install
       ```

    5. Copy .env.local from example if it doesn't already exist:
       ```
       cp web-ui/.env.local.example web-ui/.env.local
       ```
       If it already exists, skip the copy — do not overwrite existing config.

    6. In web-ui/.env.local, ensure these values are set (they should already match the example):
       - DATABASE_URL=postgresql://nucleus:nucleus_dev@localhost:5432/nucleus?connection_limit=10
       - NEXTAUTH_SECRET=local-dev-secret-change-me  (set to any non-empty string if placeholder)
       - USE_PG_TENANT_CONFIG=true
       - USE_PG_ACCOUNTS=true
       - USE_PG_SCHEDULES=true
       - USE_PG_AUDIT=true
       - USE_PG_KB=true
       - USE_PG_INVENTORY=true
       - USE_PG_AGENT_OPS=true

    Note: Cognito/AWS vars can stay as example placeholders for local dev — they are only needed for auth flows and cross-account AWS calls, not for PostgreSQL verification.
  </action>
  <verify>
    <automated>docker exec nucleus-postgres pg_isready -U nucleus -d nucleus</automated>
  </verify>
  <done>Container responds "nucleus:5432 - accepting connections". web-ui/.env.local exists with DATABASE_URL and all USE_PG_* flags set to true.</done>
</task>

<task type="auto">
  <name>Task 2: Apply Prisma migrations and generate client</name>
  <files>prisma/migrations/, web-ui/node_modules/.prisma/</files>
  <action>
    Run from the repo root:

    1. Apply all pending migrations (non-interactive deploy, safe for existing schema):
       ```
       npx prisma migrate deploy --schema=prisma/schema.prisma
       ```

    2. Generate the Prisma client (needed for web-ui imports):
       ```
       npx prisma generate --schema=prisma/schema.prisma
       ```

    3. Verify the schema was applied — list tables in the nucleus DB:
       ```
       docker exec nucleus-postgres psql -U nucleus -d nucleus -c "\dt"
       ```
       Expected: tables like tenants, tenant_configs, accounts, schedules, audit_logs, knowledge_bases, inventory_resources, agent_ops_runs, langgraph_checkpoints, agent_memory, etc.

    4. Run the verify-migration script (PostgreSQL connectivity check only — skip DynamoDB comparison if AWS creds are unavailable):
       ```
       PG_ONLY=true npx ts-node --project tsconfig.json scripts/verify-migration.ts 2>&1 | head -50
       ```
       If PG_ONLY flag is not supported, run without it and note any DynamoDB errors as expected (no live DynamoDB in local dev).
  </action>
  <verify>
    <automated>docker exec nucleus-postgres psql -U nucleus -d nucleus -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"</automated>
  </verify>
  <done>Query returns count > 10 (all migration tables present). Prisma client generated without errors.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
    PostgreSQL running locally with all migrations applied. web-ui/.env.local configured with DATABASE_URL and all USE_PG_* feature flags enabled. Prisma client generated.
  </what-built>
  <how-to-verify>
    1. Start the dev server (run this manually in a separate terminal):
       ```
       cd web-ui && npm run dev
       ```

    2. Wait for "Ready" message, then open http://localhost:3000

    3. Check the app loads without a crash page. The login/auth screen is expected (Cognito not configured locally).

    4. Optionally verify PostgreSQL is being used — check the terminal running `npm run dev` for any Prisma connection logs or errors. No "DynamoDB" errors should appear for entities with USE_PG_* flags enabled.

    5. If you have AWS_PROFILE=PLATFORM-ADMIN available and want to run the full migration verification:
       ```
       AWS_PROFILE=PLATFORM-ADMIN npx ts-node --project tsconfig.json scripts/verify-migration.ts
       ```
       This compares DynamoDB record counts against PostgreSQL counts for all migrated entities.
  </how-to-verify>
  <resume-signal>Type "approved" if the app loads, or describe any errors you see.</resume-signal>
</task>

</tasks>

<verification>
- `docker compose ps` shows nucleus-postgres as healthy
- `\dt` in psql shows all expected tables
- Dev server starts without unhandled exceptions
- http://localhost:3000 returns a page (auth screen or dashboard)
</verification>

<success_criteria>
PostgreSQL container running, all Prisma migrations applied, Prisma client generated, dev server starts cleanly, app reachable at localhost:3000 with all USE_PG_* flags enabled.
</success_criteria>

<output>
After completion, create `.planning/quick/260328-udt-set-up-local-dev-environment-and-verify-/260328-udt-SUMMARY.md`
</output>
