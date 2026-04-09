# Phase 24: Horizontal Executor + Infra - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

HorizontalExecutor dispatches each pg-boss job to an ephemeral ECS Fargate task via RunTask, and Pulumi provisions all required infrastructure (task definition, security group, CloudWatch log group). The existing `job-runner.ts` entrypoint (Phase 23) is the container command — this phase wires HorizontalExecutor to launch it via ECS.

Fan-out jobs (discovery orchestration) always run in-process regardless of WORKER_ARCH — only leaf execution jobs are dispatched horizontally.

</domain>

<decisions>
## Implementation Decisions

### ECS RunTask Dispatch
- **D-01:** HorizontalExecutor passes job name and data via ECS RunTask `overrides.containerOverrides[0].command` — command: `["node", "dist/job-runner.js", "--job", jobName, "--data", serializedData]`
- **D-02:** ECS configuration (cluster ARN, task definition ARN, subnets, security group) read from environment variables at worker startup: `HORIZONTAL_CLUSTER_ARN`, `HORIZONTAL_TASK_DEF_ARN`, `HORIZONTAL_SUBNETS` (comma-separated), `HORIZONTAL_SECURITY_GROUP`
- **D-03:** HorizontalExecutor uses `@aws-sdk/client-ecs` `RunTaskCommand` with `launchType: "FARGATE"`, `networkConfiguration` from env vars, and `assignPublicIp: "DISABLED"`
- **D-04:** Job data is JSON-serialized and passed as a single CLI argument — job-runner.ts already handles `--data '<json>'` parsing

### Ephemeral Task Definition
- **D-05:** Separate ECS task definition `nucleus-cloud-ops-ephemeral-worker-task` using the same Docker image as the workers service (same ECR repo)
- **D-06:** Ephemeral tasks use smaller resource allocation: 256 CPU / 512 memory (vs 512/1024 for the long-running workers service)
- **D-07:** No default command in the task definition — command override comes from each RunTask call
- **D-08:** Same environment variables as the workers task definition (DATABASE_URL, AWS_REGION, table names, etc.) — ephemeral tasks need identical runtime config

### IAM & Networking
- **D-09:** Reuse the existing `workersTaskRole` for ephemeral tasks — identical permission requirements (STS AssumeRole, RDS connect, S3, Bedrock, SNS, CloudWatch Logs)
- **D-10:** Reuse the existing `workersSecurityGroup` (egress-only) — ephemeral tasks have the same network access pattern
- **D-11:** Dedicated CloudWatch log group `/ecs/nucleus-cloud-ops-ephemeral-workers` with separate stream prefix for observability separation

### Job Completion Tracking
- **D-12:** After RunTask, HorizontalExecutor polls ECS `DescribeTasks` with exponential backoff until the task reaches STOPPED state
- **D-13:** Exit code 0 = success (executor returns normally), non-zero = throw error (pg-boss retryLimit handles retries)
- **D-14:** Configurable max wait timeout via `HORIZONTAL_TASK_TIMEOUT_MS` env var, default 15 minutes (900000ms)
- **D-15:** If RunTask itself fails (capacity, permissions), throw immediately — don't poll

### Pulumi Infrastructure
- **D-16:** New resources in `infra/compute/index.ts`: ephemeral task definition + CloudWatch log group
- **D-17:** Reuse existing resources: `workersTaskRole`, `workersSecurityGroup`, `ecsTaskExecutionRole`, `workersImage`
- **D-18:** Export new Pulumi outputs: `ephemeralWorkerTaskDefArn` — needed by the workers service env vars
- **D-19:** Workers service task definition gains 4 new env vars (HORIZONTAL_CLUSTER_ARN, HORIZONTAL_TASK_DEF_ARN, HORIZONTAL_SUBNETS, HORIZONTAL_SECURITY_GROUP) so HorizontalExecutor can dispatch

### Claude's Discretion
- Polling interval and backoff strategy for DescribeTasks (e.g., 2s initial, 2x backoff, cap at 30s)
- Whether to add an `ecs:RunTask` IAM policy to workersTaskRole or create a separate policy attachment
- Log formatting for dispatch/completion events in HorizontalExecutor

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Executor Abstraction (Phase 22 output)
- `workers/src/executor/types.ts` — JobExecutor interface and HandlerFn type
- `workers/src/executor/horizontal.ts` — Current stub to be replaced with ECS RunTask dispatch
- `workers/src/executor/vertical.ts` — VerticalExecutor reference implementation
- `workers/src/executor/factory.ts` — createExecutor factory (already returns HorizontalExecutor for "horizontal")

### Job Runner (Phase 23 output)
- `workers/src/job-runner.ts` — Standalone entrypoint that ECS tasks will run; parses `--job` and `--data` args
- `workers/src/index.ts` — Main worker entrypoint; reads WORKER_ARCH, creates executor, registers jobs

### Pulumi Infrastructure
- `infra/compute/index.ts` lines 1402–1671 — Workers ECS section: ECR repo, image build, task role, IAM policies, task definition, security group, service
- `infra/compute/index.ts` lines 1577–1629 — Workers task definition (reference for ephemeral task def structure)
- `infra/compute/index.ts` lines 1436–1575 — Workers IAM role and policies (to be reused)
- `infra/compute/index.ts` lines 1631–1642 — Workers security group (to be reused)

### Requirements
- `.planning/REQUIREMENTS.md` — EXEC-04, INFRA-01, INFRA-02, INFRA-03 are Phase 24 requirements

### Prior Phase Context
- `.planning/phases/22-executor-abstraction-foundation/22-CONTEXT.md` — Executor interface decisions
- `.planning/phases/23-job-wiring-runner-entrypoint/23-CONTEXT.md` — Job wiring and runner entrypoint decisions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `HorizontalExecutor` stub in `workers/src/executor/horizontal.ts` — replace stub with ECS RunTask implementation
- `createExecutor("horizontal")` in factory already returns HorizontalExecutor — no factory changes needed
- `job-runner.ts` — complete standalone entrypoint, handles `--job` + `--data` args, exits with proper codes
- Workers Dockerfile already builds `dist/job-runner.js` — same image works for ephemeral tasks

### Established Patterns
- Pulumi task definitions use `pulumi.all([...]).apply(...)` for container definitions with env vars
- IAM policies are individual `aws.iam.RolePolicy` resources attached to the task role
- Security groups are standalone resources referenced by ARN in service/task network config
- Workers service uses `privateSubnetIds` for networking — ephemeral tasks use the same

### Integration Points
- `workers/src/executor/horizontal.ts` — stub → full ECS RunTask implementation
- `infra/compute/index.ts` after workers section (~line 1656) — add ephemeral task def + log group
- Workers task definition env vars — add HORIZONTAL_* config pointing to ephemeral resources
- `workersTaskRole` — needs `ecs:RunTask` + `ecs:DescribeTasks` permissions added

</code_context>

<specifics>
## Specific Ideas

No specific requirements — follow the established Pulumi patterns in `infra/compute/index.ts` for the new task definition. The key constraint is that ephemeral tasks use the exact same Docker image with a different command, keeping the deployment pipeline simple (one image build, two task definitions).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 24-horizontal-executor-infra*
*Context gathered: 2026-04-09*
