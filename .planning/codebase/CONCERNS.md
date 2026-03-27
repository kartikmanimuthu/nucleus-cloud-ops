# Codebase Concerns

**Analysis Date:** 2026-03-26

---

## Technical Debt

**In-progress DynamoDB → PostgreSQL migration (branch context):**
- Issue: This worktree (`database-migration` branch) exists to plan a migration from 10 DynamoDB tables to PostgreSQL, but no migration code has been committed yet. The plan lives in `.claude/plans/database-migration-to-postgres.md` — foundation work (Docker Compose, Drizzle ORM, repository pattern) is all still TODO.
- Files: `.claude/plans/database-migration-to-postgres.md`, `web-ui/lib/` (all service files still use DynamoDB)
- Impact: Until Phase 0 is implemented, the migration plan is aspirational. Nothing in the app is wired to PostgreSQL.
- Fix approach: Execute Phase 0 (pg-config.ts, drizzle.config.ts, repository-factory.ts) before branching any entity migration.

**Orphaned page-updated.tsx file:**
- Issue: `web-ui/app/app/accounts/page-updated.tsx` exists alongside `page.tsx` but is not imported or referenced anywhere in the codebase.
- Files: `web-ui/app/app/accounts/page-updated.tsx`
- Impact: Dead code; contains a stub `// TODO: Implement export functionality` at line 105.
- Fix approach: Remove the file or merge its content into the canonical `page.tsx`.

**Unverified AgentConversationsTable:**
- Issue: The migration plan notes `AgentConversationsTable` (table 10) "appears unused in application code — confirm before migrating." Grep confirms zero references to `agentConversations` outside CDK provisioning code.
- Files: `lib/computeStack.ts` (provisioned), `web-ui/lib/` (no references found)
- Impact: A DynamoDB table is provisioned and paying for itself with no consumers.
- Fix approach: Audit and remove the table and its CDK construct if truly unused.

**Unimplemented toast notifications on form errors:**
- Issue: Three `// TODO: Toast` / `// TODO: Show error toast` comments exist — form error states are silently swallowed without user feedback.
- Files: `web-ui/app/app/schedules/[scheduleId]/edit/edit-schedule-form.tsx:116`, `web-ui/components/schedule-form.tsx:198`, `web-ui/components/schedule-form.tsx:230`
- Impact: Users receive no feedback when schedule create/edit operations fail.
- Fix approach: Wire the `sonner` toast library (already in `package.json`) to those catch blocks.

**Commented-out container health check in ECS task definition:**
- Issue: The ECS Fargate task's container-level health check is entirely commented out (`lib/computeStack.ts:969-975`). Only the ALB target group health check is active.
- Files: `lib/computeStack.ts:969-975`
- Impact: ECS does not proactively restart unhealthy containers before the ALB detects the failure; recovery is slower.
- Fix approach: Uncomment and enable the container health check targeting `/api/health`.

**Commented-out HTTPS listener in CDK:**
- Issue: The ALB HTTPS listener (port 443 with ACM certificate) is fully commented out at `lib/computeStack.ts:1117-1134`. Traffic currently runs over HTTP only.
- Files: `lib/computeStack.ts:1117-1134`
- Impact: All web traffic between users and the ALB is unencrypted.
- Fix approach: Uncomment the HTTPS listener block and configure `ENABLE_CUSTOM_DOMAIN=true` with a valid `CERTIFICATE_ARN`.

**Dynamoose ODM mixed with raw DynamoDB SDK:**
- Issue: `AgentOpsTable` uses `dynamoose` (v4) ODM while all other tables use `@aws-sdk/lib-dynamodb` directly. Two different DynamoDB access patterns co-exist.
- Files: `web-ui/lib/agent-ops/models/`, `web-ui/lib/agent-ops/dynamoose-config.ts`, `web-ui/lib/account-service.ts`
- Impact: Increases cognitive load; Dynamoose v4 has its own marshalling behavior that differs from DocumentClient, making cross-table queries complex.
- Fix approach: Migrate AgentOps to raw DocumentClient when implementing the Postgres repository pattern for that entity.

**`[DEBUG]` console logs committed in production API route:**
- Issue: `web-ui/app/api/chat/route.ts` contains 28 `console.log` / `console.debug` statements, many labeled `[DEBUG]`, that log internal stream state and tool call IDs.
- Files: `web-ui/app/api/chat/route.ts:438`, `:469`, `:554`, `:572`, `:580`, `:614` (and more)
- Impact: Verbose logs in production CloudWatch increase cost and expose internal agent state in log streams.
- Fix approach: Replace with the structured logger from `web-ui/lib/agent/` or remove before deploying.

---

## Security Concerns

**Broad S3 wildcard permission on ECS task role:**
- Risk: The ECS task role policy grants `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on `arn:aws:s3:::*` (all buckets in the account and potentially accessible cross-account).
- Files: `lib/computeStack.ts:884-887`
- Current mitigation: None — the `resources` array is `['arn:aws:s3:::*']`.
- Recommendations: Scope to specific bucket ARNs (`checkpointBucket`, `inventoryBucket`, `agentTempBucket`, `kbStagingBucket`).

**Broad Bedrock permission on ECS task role:**
- Risk: `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` are granted with `resources: ['*']` — covers all foundation models including expensive ones.
- Files: `lib/computeStack.ts:894-896`
- Current mitigation: None.
- Recommendations: Scope to specific model ARNs (e.g., `arn:aws:bedrock:<region>::foundation-model/anthropic.claude-*`).

**`s3tables:*` wildcard on discovery task role:**
- Risk: The discovery task role has `s3tables:*` on `resources: ['*']` with inline comment "Allow all s3tables actions for now as ARN construction is tricky."
- Files: `lib/computeStack.ts:581-584`
- Current mitigation: None; comment acknowledges this is a shortcut.
- Recommendations: Scope once ARN patterns for the new service are documented.

**Jira native-webhook secret passed as URL query parameter:**
- Risk: Native Jira webhooks authenticate via `?secret=<value>` query parameter. Query params are logged by ALB access logs, CloudFront, and any proxy in the path.
- Files: `web-ui/app/api/v1/trigger/jira/route.ts:53`, `web-ui/lib/agent-ops/jira-validator.ts:155`
- Current mitigation: Automation-rule path uses the `Authorization` header (safer). The query-param path is a documented fallback for native webhooks only.
- Recommendations: Document this risk clearly; prefer Jira Automation rules over native webhooks in production; strip the param from logs.

**Large number of unprotected API routes:**
- Risk: 40+ API routes under `web-ui/app/api/` do not call `authorize()`, `getServerSession()`, or `getSessionUserId()`. The middleware (`web-ui/middleware.ts`) excludes `api/auth`, `api/health`, and `api/v1/trigger` from auth — but the middleware matcher does NOT cover the `/api/` namespace by default for all routes.
- Files: `web-ui/middleware.ts:24`, `web-ui/app/api/agent-ops/route.ts`, `web-ui/app/api/inventory/resources/route.ts`, `web-ui/app/api/ask-ai/route.ts`, `web-ui/app/api/inventory/export/route.ts` (and ~35 others)
- Current mitigation: The middleware's `matcher` pattern covers `/((?!api/auth|api/health|api/v1/trigger|...).*)`— meaning all other paths do go through `withAuth`. However, individual routes do not perform RBAC checks beyond the session token check.
- Recommendations: Add `authorize()` from `@/lib/rbac/authorize` to all mutating routes (POST/PUT/DELETE); audit read routes for data sensitivity.

**No input validation (Zod) on API route bodies:**
- Risk: API routes parse `request.json()` and destructure fields directly without schema validation. Malformed or malicious payloads can pass through to DynamoDB or AWS SDK calls.
- Files: `web-ui/app/api/accounts/validate/route.ts:6-7`, `web-ui/app/api/accounts/route.ts:20-21` (and majority of other routes)
- Current mitigation: None — zero `safeParse` or `z.object()` calls found in `web-ui/app/api/`.
- Recommendations: Add Zod schema validation at the top of each route handler before touching business logic.

**No rate limiting on AI/agent endpoints:**
- Risk: `/api/chat`, `/api/ask-ai`, `/api/enhance-prompt`, and `/api/deep-agent/chat` invoke paid AWS Bedrock models. There is no rate-limiting middleware in the codebase.
- Files: `web-ui/app/api/chat/route.ts`, `web-ui/app/api/ask-ai/route.ts`, `web-ui/app/api/enhance-prompt/route.ts`
- Current mitigation: CloudFront can be configured with WAF rate rules but none are defined in CDK.
- Recommendations: Add `upstash/ratelimit` or similar per-user rate limiting at the API route level; add WAF rate rules via CDK.

---

## Performance Concerns

**In-memory filtering after capped DynamoDB scan (agent-ops-service):**
- Problem: `findJiraRun()` and `findSlackRun()` in the agent-ops service fetch up to 50 most-recent runs and then filter in memory by issue key / channel.
- Files: `web-ui/lib/agent-ops/agent-ops-service.ts:309`, `:328`, `:348`
- Cause: DynamoDB GSI design does not support filtering by external IDs directly; workaround is client-side.
- Improvement path: Add a dedicated GSI on `externalId` (Jira issue key / Slack channel+ts), or migrate AgentOps to PostgreSQL (Phase N of database migration plan) which supports indexed lookups.

**Audit stats query noted as expensive:**
- Problem: `audit-service.ts:325` carries an inline comment: "This operation is expensive (Scan/Large Query) so we might want to limit scope or cache it."
- Files: `web-ui/lib/audit-service.ts:325`
- Cause: Stats aggregation queries the entire audit index without pagination or caching.
- Improvement path: Add a TTL-based cache (e.g., Redis or DynamoDB item with TTL) or precompute stats via a scheduled Lambda.

**ECS container health check disabled:**
- Problem: Container-level health check is commented out, so the ALB health check (60s interval, 3 unhealthy threshold = 3 minutes before replacement) is the only recovery mechanism.
- Files: `lib/computeStack.ts:969-975`
- Cause: Commented out — likely a deployment convenience shortcut.
- Improvement path: Re-enable the container health check.

**Chat interface component at 1,857 lines:**
- Problem: `web-ui/components/agent/chat-interface.tsx` is a single 1,857-line component mixing streaming logic, HITL approval UI, tool rendering, and phase display.
- Files: `web-ui/components/agent/chat-interface.tsx`
- Cause: Iterative feature accretion without decomposition.
- Improvement path: Extract `ToolApprovalPanel`, `PhaseTimeline`, and `StreamingMessage` into separate components.

---

## Dependency Risks

**Four packages pinned to `latest` (no semver range):**
- Risk: `date-fns`, `next-themes`, `react-day-picker`, `recharts` are pinned to `"latest"` rather than a semver range. A major version bump on `npm install` can silently introduce breaking API changes.
- Files: `web-ui/package.json:84,102,108,113`
- Impact: Any `npm ci` on a fresh environment (CI, new dev, Docker build) can pick up a different major version than what was tested.
- Migration plan: Pin to explicit versions (e.g., `"date-fns": "^4.1.0"`) after running `npm ls` to capture current resolved versions.

**`xlsx` package (`^0.18.5`) — abandoned upstream:**
- Risk: `xlsx` (SheetJS CE) v0.18.x has known prototype-pollution vulnerabilities and the CE branch has been abandoned. The maintainer moved to a commercial-only model.
- Files: `web-ui/package.json:121`, `web-ui/app/api/inventory/export/route.ts`
- Impact: Parsing untrusted XLSX input (not currently done) would be exploitable; library receives no security patches.
- Migration plan: Switch to `exceljs` (`^4.4.0`) which is actively maintained and MIT-licensed; API surface is comparable.

**`deepagents` package (`^1.8.1`) — third-party, low-visibility:**
- Risk: `deepagents` is a small third-party package with no obvious open-source repository visible in the npm registry. Supply-chain provenance is unclear.
- Files: `web-ui/package.json:85`
- Impact: Any compromise of this package's npm account would affect the application.
- Migration plan: Audit the package source; consider vendoring if the deep-agent feature is critical.

**`next-auth` v4 (end of active development):**
- Risk: `next-auth@^4.24.11` is in maintenance-only mode. Auth.js v5 (formerly NextAuth v5) is the active branch and has breaking API changes. The project uses Next.js 15 with React 19, which Auth.js v5 targets natively.
- Files: `web-ui/package.json:101`, `web-ui/app/api/auth/[...nextauth]/route.ts`
- Impact: Security patches may not be backported to v4 indefinitely.
- Migration plan: Schedule migration to Auth.js v5; main changes are session callback signatures and the `auth()` helper replacing `getServerSession()`.

**`@farukada/aws-langgraph-dynamodb-ts` (`^0.1.0`) — pre-1.0, single-author:**
- Risk: Pre-1.0 semver signals unstable API; the package is DynamoDB-specific and not part of the official LangGraph ecosystem.
- Files: `web-ui/package.json:37`
- Impact: If the package is abandoned or breaks with LangGraph updates, the checkpointing layer for planning/fast agents breaks.
- Migration plan: The database-migration plan notes migrating to `@langchain/langgraph-checkpoint-postgres` as a future phase — this should be prioritized.

---

## Operational Risks

**All DynamoDB tables use `RemovalPolicy.DESTROY`:**
- Risk: Every DynamoDB table in `lib/computeStack.ts` (all 10 tables) and every S3 bucket uses `RemovalPolicy.DESTROY` + `autoDeleteObjects: true`. A `cdk destroy` or accidental stack deletion permanently destroys all data.
- Files: `lib/computeStack.ts:88,116,144,178,193,203,212,222,232,241`, `lib/webUIStack.ts:61,81,91,101,111,117`
- Current mitigation: None — no point-in-time recovery (PITR) is enabled on any table either.
- Recommendations: Set `RemovalPolicy.RETAIN` on production tables; enable PITR (`pointInTimeRecovery: true`) on `NucleusAppTable`, `NucleusAuditTable`, `NucleusInventoryTable`.

**No point-in-time recovery (PITR) on any DynamoDB table:**
- Risk: Zero DynamoDB tables have `pointInTimeRecovery` enabled. A bad write (application bug, agent mutation) cannot be rolled back without restoring from a manual backup.
- Files: `lib/computeStack.ts` (all table definitions)
- Current mitigation: None.
- Recommendations: Enable PITR on all production tables; at minimum on `NucleusAppTable` and `NucleusAuditTable`.

**ECS service desired count defaults to 0:**
- Risk: `lib/computeStack.ts:1080` sets `desiredCount = ecsConfig.webUi?.desiredCount || 0`. If the CDK config does not supply a value, the service starts with 0 running tasks.
- Files: `lib/computeStack.ts:1080-1084`
- Current mitigation: `.env.example` sets `WEB_UI_DESIRED_COUNT=1` but this is not enforced.
- Recommendations: Change the fallback to `|| 1` or add a CDK assertion (`cdk.Aspects`) that rejects a `desiredCount` of 0.

**Only one CloudWatch alarm defined:**
- Risk: The only CloudWatch alarm in the entire CDK codebase is on the vector processor DLQ (`lib/computeStack.ts:485-488`). No alarms exist for: ECS service task count dropping to 0, ALB 5xx error rate, Lambda error rate (scheduler/kb-sync), DynamoDB throttling, or Bedrock invocation failures.
- Files: `lib/computeStack.ts:484-491`
- Current mitigation: CloudWatch metrics exist but no alerting.
- Recommendations: Add alarms for ECS `RunningTaskCount < 1`, ALB `HTTPCode_Target_5XX_Count`, and Lambda `Errors > 0`.

**MongoDB/DocumentDB dependency undocumented in web-ui `.env.local.example`:**
- Risk: The deep-agent feature requires a MongoDB/DocumentDB connection. The `MONGODB_URI`, `DOCDB_ENDPOINT`, `DOCDB_USERNAME`, `DOCDB_PASSWORD` env vars are needed at runtime but are commented out (optional) in `web-ui/.env.local.example`. The mongo client falls back to `mongodb://localhost:27017` silently.
- Files: `web-ui/lib/db/mongo-client.ts:42`, `web-ui/.env.local.example`
- Current mitigation: Silent fallback to localhost — deep agent works in local dev without configuration.
- Recommendations: Log a warning when none of the DocumentDB vars are set in production (`NODE_ENV === 'production'`); document the required CDK/ECS provisioning for DocumentDB.

**ALB only serves HTTP (no HTTPS):**
- Risk: The HTTPS/TLS listener is commented out in CDK. The ALB serves traffic over port 80 only.
- Files: `lib/computeStack.ts:1111-1134`
- Current mitigation: CloudFront is deployed in front of the ALB and terminates TLS at the CDN edge. Direct ALB access (without CloudFront) is unencrypted.
- Recommendations: Enable ALB HTTPS listener to encrypt the CloudFront → ALB leg as well (origin protection).

---

## Missing Capabilities

**No database backup / disaster recovery for PostgreSQL (planned migration):**
- What's missing: The database migration plan (`Phase 0`) does not include automated backup configuration for the planned RDS PostgreSQL instance — no backup retention window, no cross-region replication, no restore runbook.
- Blocks: Production readiness of any migrated entity.

**No API rate limiting:**
- What's missing: No rate-limiting library or WAF rule is implemented anywhere. Bedrock-backed endpoints (`/api/chat`, `/api/ask-ai`) can be abused to run up large AWS bills.
- Blocks: Safe production exposure of AI features.

**No structured logging standard across API routes:**
- What's missing: API routes mix raw `console.log`/`console.error` (198 occurrences across `web-ui/app/api/`) with no trace IDs, request IDs, or structured fields. The Lambda scheduler has a proper structured logger (`lambda/scheduler/src/utils/logger.ts`) but nothing equivalent exists for Next.js API routes.
- Blocks: Effective incident investigation; CloudWatch Insights queries.

**No integration or API-level tests:**
- What's missing: There are 66 API routes under `web-ui/app/api/` and zero API-level test files. Test coverage exists only for `agent-ops/` domain logic (10 test files total). All other service layers (account-service, schedule-service, audit-service, knowledge-base) have no tests.
- Blocks: Safe refactoring during the DynamoDB → PostgreSQL migration; repository pattern swaps are untestable without integration tests.

**No CDK pipeline (CI/CD for infrastructure):**
- What's missing: Deployments require a developer to run `npx cdk deploy --profile <profile>` manually. There is no CDK Pipelines construct, no GitHub Actions workflow for CDK, and no approval gate before infrastructure changes hit production.
- Blocks: Safe automated deployments; auditability of infrastructure changes.

---

*Concerns audit: 2026-03-26*
