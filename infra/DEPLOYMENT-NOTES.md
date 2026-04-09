# Deployment Notes — 2026-04-09

## Issues Fixed During Deploy

### 1. `cacheSubnetGroupName` — missing stack output
**Error:** `Required output 'cacheSubnetGroupName' does not exist on stack 'organization/nucleus-networking/prod'`

**Cause:** `infra/compute/index.ts` imported `cacheSubnetGroupName` from the networking stack, but the networking stack never exported it (no ElastiCache resource exists).

**Fix:** Removed the unused `requireOutput("cacheSubnetGroupName")` line from `infra/compute/index.ts`.

---

### 2. `vector_processor/lambda.zip` — missing at program startup
**Error:** `open .../lambda/vector_processor/lambda.zip: no such file or directory`

**Cause:** `pulumi.asset.FileArchive` hashes the zip path at program-evaluation time, before Pulumi's resource dependency ordering kicks in. The `command.local.Command` build step runs later, so the zip doesn't exist yet on first run.

**Fix:** Added a synchronous bootstrap in `infra/compute/index.ts` — if the zip doesn't exist, run `build-lambdas.sh` via `execSync` before declaring the Lambda resource.

---

### 3. `build-lambdas.sh` — unnecessary Prisma copy steps
**Error:** `cp: node_modules/@prisma/client: No such file or directory`

**Cause:** The build script tried to copy `@prisma/client` into the vector_processor zip, but the vector_processor source (`lambda/vector_processor/src/index.ts`) is a stub that doesn't use Prisma at all.

**Fix:** Removed the Prisma `mkdir`/`cp` steps and `--external:@prisma/client` flags from `build_vector_processor()` in `infra/build-lambdas.sh`.

---

### 4. Docker builds — `public.ecr.aws` 403 Forbidden
**Error:** `unexpected status from HEAD request to https://public.ecr.aws/v2/docker/library/node/manifests/20.9.0-slim: 403 Forbidden`

**Cause:** Docker pulls from ECR Public require authentication even for public images when rate limits are hit or credentials are absent.

**Fix:** Run `AWS_PROFILE=PLATFORM-ADMIN aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws` before deploying.

---

### 5. `deep-agent.ts` / `deep-agent-graph.ts` — renamed tool imports
**Error:** `Attempted import error: 'getAwsCredentialsTool' is not exported from './tools'`

**Cause:** `getAwsCredentialsTool` and `listAwsAccountsTool` were refactored into factory functions (`createGetAwsCredentialsTool(tenantId)` / `createListAwsAccountsTool(tenantId)`) to support multi-tenancy, but the import sites in `deep-agent.ts` and `lib/deep-agent/deep-agent-graph.ts` were not updated.

**Fix:** Updated both files to import the factory functions and call them with `tenantId` before building the tools array.

---

### 6. `workers/src/jobs/kb-sync/index.ts` — duplicate imports and undefined variables
**Error:** `Duplicate identifier 'createLogger'` / `Cannot find name 'shortMessage'`

**Cause:** The file had `createLogger` imported twice and `const log` declared twice. The error handler also referenced `shortMessage` and `fullDetail` variables that were never defined.

**Fix:** Removed the duplicate import/declaration and added local variable definitions for `shortMessage` and `fullDetail` in the catch block.

---

### 7. `web-ui/Dockerfile.ecs` — Prisma client not initialized at build time
**Error:** `@prisma/client did not initialize yet. Please run "prisma generate"`

**Cause:** `prisma/schema.prisma` defines `output = "../web-ui/node_modules/.prisma/client"` relative to the schema file. In the Docker build context, `COPY web-ui/ .` places web-ui contents directly at `/app/` (not `/app/web-ui/`), so `prisma generate` outputs to `/app/web-ui/node_modules/.prisma/client` — a path that doesn't exist. Next.js resolves `@prisma/client` from `/app/node_modules/`.

**Fix:**
1. Before `prisma generate`, patch the schema output path with `sed` to point to `../node_modules/.prisma/client`.
2. After generate, copy the generated client into the runner stage at `./node_modules/.prisma` and `./node_modules/@prisma/client`.

---

## Outcome

All resources deployed successfully. ECS rolled out:
- `web-ui-task` → revision :14
- `workers-task` → updated
- `ephemeral-worker-task` → created (new)

CloudFront URL: https://d11lr8aqp8vqde.cloudfront.net
