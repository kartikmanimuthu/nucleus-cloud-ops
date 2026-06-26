# Plan: Clean up `.env.example`

## Goal
Remove environment variables from `.env.example` that are no longer consumed by any code, and add any actively-used vars that are missing from the template.

## Unused variables to remove
These 14 variables appear in `.env.example` but are not referenced anywhere in the codebase (`process.env.*`, Pulumi config, or generated env files):

1. `APP_NAME`
2. `VPC_CIDR`
3. `MAX_AZS`
4. `NAT_GATEWAYS`
5. `WEB_UI_CPU`
6. `WEB_UI_MEMORY`
7. `WEB_UI_DESIRED_COUNT`
8. `WEB_UI_MIN_CAPACITY`
9. `WEB_UI_MAX_CAPACITY`
10. `ENABLE_CUSTOM_DOMAIN`
11. `DOMAIN_NAME`
12. `CERTIFICATE_ARN`
13. `FALLBACK_DOMAIN_NAME`
14. `SUBSCRIPTION_EMAILS`

Rationale: Pulumi reads networking/compute config from `Pulumi.prod.yaml` keys (`vpcCidr`, `appUrl`, `subscriptionEmails`), not from env vars. The remaining vars above have no consumers.

## Used-but-missing variables to add
Add the following variables to `.env.example` because they are actively read by the app/workers/scripts. Most have sensible defaults, but documenting them prevents confusion.

### Required/commonly used
- `NEXT_PUBLIC_APP_URL` — used in `apps/web-ui/lib/gateway/utils/dashboard-url.ts` as a fallback for `NEXTAUTH_URL`.
- `HORIZONTAL_POLL_INTERVAL_MS` — used in `apps/workers/src/executor/horizontal.ts` (default 2000 ms).

### Worker / discovery tuning
- `SERVICE_NAME` — used in `apps/workers/src/lib/logger.ts` (default `workers`).
- `DEFAULT_TENANT_ID` — used in `apps/workers/src/jobs/kb-sync/lib/vector-store.ts` (default `org-default`).
- `CONCURRENT_REGIONS` — discovery scanner parallelism (default 5).
- `CONCURRENT_SERVICES` — discovery scanner parallelism (default 10).
- `SCANFILE_PATH` — discovery local-runner output path.

### Script / utility
- `DRY_RUN` — used by `scripts/cleanup-expired.ts` and `scripts/backfill-embeddings.ts`.
- `BATCH_SIZE` / `CONCURRENCY` — used by `scripts/backfill-embeddings.ts`.

### Gateway adapters (optional integrations)
- `DISCORD_PUBLIC_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SECRET_TOKEN`
- `WEBHOOK_SECRET`

### AWS fallback
- `AWS_DEFAULT_REGION` — workers fallback when `AWS_REGION` is absent.

## Implementation
1. Edit `.env.example`:
   - Delete the 14 unused variables (including their comment blocks where they become empty).
   - Insert the new variables into appropriate sections (`AWS`, `Misc`, `Optional integrations`).
2. Do not change any code; this is a documentation-only cleanup.
3. Run a grep verification to confirm every remaining variable in `.env.example` has at least one consumer (excluding migration scripts that reference DynamoDB legacy vars).

## Verification
- `grep -R "process.env.<VAR>"` for each retained variable should return at least one hit in the app/workers code, infra, or active scripts.
- No unintended deletions of variables consumed by `infra/compute/index.ts`, `infra/cicd/index.ts`, `scripts/generate-env.ts`, web-ui, or workers.
