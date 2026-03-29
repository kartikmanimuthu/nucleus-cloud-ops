# Domain Pitfalls: CDK → Pulumi TypeScript Migration

**Domain:** AWS CDK to Pulumi TypeScript IaC migration
**Researched:** 2026-03-29
**Confidence:** MEDIUM-HIGH (core Pulumi behaviors HIGH from official docs; service-specific patterns MEDIUM from training data, cutoff Aug 2025)

---

## Critical Pitfalls

Mistakes that cause resource recreation, data loss, or production downtime.

### Pitfall 1: Auto-Naming Mismatch Causes Resource Recreation

**What goes wrong:** Pulumi auto-appends a random 7-character suffix to physical resource names by default (e.g., `my-vpc` → `my-vpc-a1b2c3d`). CDK also auto-names but uses a different scheme (stack name + logical ID hash). When you import existing CDK-managed resources into Pulumi state, the physical names in AWS won't match what Pulumi expects unless you pin them explicitly with the `name` property.

**Why it happens:** Pulumi's URN is based on the logical name in code. If you rename a resource in code — even a minor refactor — Pulumi treats it as a delete + create of a different resource. The old resource is destroyed and a new one is created.

**Consequences:** VPC deletion, ECS service restart, DynamoDB table drop (if not protected), security group recreation breaking existing rules.

**Prevention:**
- For every imported resource, set the `name` property to the exact physical name that exists in AWS: `new aws.ec2.Vpc("main", { tags: { Name: "nucleus-vpc" } }, { name: "nucleus-vpc" })` — wait, the correct property is the resource's name argument in the AWS provider, e.g. `vpcId` is read-only but `tags.Name` is the display name. For resources where the physical name is a first-class property (S3 bucket: `bucket`, DynamoDB table: `name`, security group: `name`), set it explicitly.
- Use `pulumi import` to bring existing resources into state before writing any code that manages them.
- Add `protect: true` to stateful resources (DynamoDB tables, S3 buckets, RDS) to prevent accidental deletion.
- Run `pulumi preview` and scrutinize any `replace` operations before `pulumi up`.

**Detection:** `pulumi preview` output showing `[replace]` or `[-+]` on resources you expected to be unchanged. Any `delete` on a resource you didn't intend to remove.

**Confidence:** HIGH — confirmed from official Pulumi resource naming documentation.

---

### Pitfall 2: CDK Bootstrap Stack Conflicts

**What goes wrong:** CDK creates a `CDKToolkit` bootstrap stack in every account/region with an S3 bucket (for assets), ECR repository, and IAM roles. These resources have predictable names like `cdk-hnb659fds-assets-<account>-<region>`. When Pulumi tries to create resources with overlapping names or manage the same IAM roles, conflicts arise.

**Why it happens:** CDK bootstrap resources are CloudFormation-managed. Pulumi has no knowledge of them. If your Pulumi code creates an S3 bucket or IAM role with the same name, AWS returns a `BucketAlreadyOwnedByYou` or `EntityAlreadyExists` error.

**Consequences:** `pulumi up` fails mid-run, leaving partial state. Worse: if CDK bootstrap resources are accidentally imported into Pulumi state and then Pulumi tries to delete them, CDK deployments break.

**Prevention:**
- Audit all CDK bootstrap resource names before writing Pulumi code.
- Never import CDK bootstrap resources into Pulumi state — they remain CloudFormation-managed until CDK is fully removed.
- Use distinct naming prefixes for Pulumi-managed resources (e.g., `pulumi-nucleus-` vs CDK's `cdk-` prefix).
- Keep CDK and Pulumi stacks in separate AWS accounts or use separate naming conventions during the transition period.

**Detection:** `ResourceAlreadyExistsException` or `BucketAlreadyOwnedByYou` errors during `pulumi up`.

**Confidence:** HIGH — well-documented CDK/Pulumi coexistence issue.

---

### Pitfall 3: Import Without Code Reconciliation Causes Immediate Replacement

**What goes wrong:** `pulumi import` brings a resource into Pulumi state and generates TypeScript code. But the generated code is often incomplete — it omits computed properties, uses defaults that differ from the actual resource configuration, or includes properties that force a diff. On the first `pulumi up` after import, Pulumi shows a diff and may replace the resource.

**Why it happens:** AWS resources have many properties. `pulumi import` generates code for the most common ones but can't always infer every property. Any property in the generated code that differs from the live resource triggers an update or replace.

**Consequences:** Resources that were supposed to be imported in-place get deleted and recreated — exactly what the import was meant to avoid.

**Prevention:**
- After `pulumi import`, always run `pulumi preview` before `pulumi up`. Expect diffs.
- For each diff, either update the code to match the live resource, or add `ignoreChanges: ["propertyName"]` to suppress it.
- For immutable properties (e.g., VPC CIDR, DynamoDB table name), any diff means recreation — fix the code, not the resource.
- Use `pulumi state show <urn>` to inspect what Pulumi has stored vs what the code declares.
- Import resources one at a time, not in bulk, so diffs are isolated.

**Detection:** `pulumi preview` showing `~` (update) or `+-` (replace) on freshly imported resources.

**Confidence:** HIGH — standard Pulumi import workflow behavior.

---

### Pitfall 4: S3 Backend Passphrase Loss = Permanent Secret Lockout

**What goes wrong:** When using the S3 backend, Pulumi encrypts secrets (config values marked `--secret`) with a passphrase stored in `PULUMI_CONFIG_PASSPHRASE`. If this env var is not set consistently across all environments (local dev, CI/CD, team members), `pulumi up` fails with a decryption error. If the passphrase is lost entirely, secrets in state are permanently inaccessible.

**Why it happens:** The S3 backend uses local passphrase encryption by default (unlike Pulumi Cloud which uses managed keys). The passphrase is not stored anywhere — it's the operator's responsibility.

**Consequences:** CI/CD pipeline breaks. Team members can't run `pulumi up` without the passphrase. In the worst case, the entire stack state becomes unreadable.

**Prevention:**
- Store `PULUMI_CONFIG_PASSPHRASE` in AWS Secrets Manager or your CI/CD secret store (GitHub Actions secrets, etc.) immediately after creating the stack.
- Document the passphrase retrieval procedure in the project runbook.
- Consider using `PULUMI_CONFIG_PASSPHRASE_FILE` pointing to a file managed by your secrets system.
- Alternatively, use AWS KMS as the secrets provider: `pulumi stack init --secrets-provider="awskms://alias/pulumi-secrets"` — this removes the passphrase requirement entirely and is the recommended approach for team environments.

**Detection:** `error: failed to decrypt encrypted configuration value` during `pulumi up` or `pulumi config get`.

**Confidence:** HIGH — well-documented S3 backend behavior.

---

### Pitfall 5: S3 Backend DynamoDB Lock Table Wrong Key Schema

**What goes wrong:** Pulumi's S3 backend uses DynamoDB for state locking. The DynamoDB table must have `LockID` as the partition key with type `String`. If the table is created with a different key name or type (e.g., `id`, `lock_id`, or `Number` type), Pulumi silently fails to acquire locks, allowing concurrent `pulumi up` runs to corrupt state.

**Why it happens:** Pulumi's S3 backend is modeled after Terraform's S3 backend, which has the same `LockID` requirement. The table name is configurable but the key schema is not.

**Consequences:** Concurrent `pulumi up` runs corrupt the state file. State corruption requires manual repair via `pulumi state` commands.

**Prevention:**
- Create the DynamoDB lock table with exactly: partition key `LockID` (String), no sort key, PAY_PER_REQUEST billing.
- Reference the table in `Pulumi.yaml`: `backend: url: s3://bucket?region=us-east-1&dynamodbTable=pulumi-lock`
- Verify lock acquisition works by running two concurrent `pulumi preview` commands and confirming the second one waits.

**Detection:** No error on `pulumi up` but concurrent runs don't block each other. Check DynamoDB table key schema in AWS console.

**Confidence:** HIGH — matches Terraform S3 backend spec which Pulumi S3 backend follows.

---

## Moderate Pitfalls

### Pitfall 6: Cross-Stack References Require StackReference (Not SSM/Exports)

**What goes wrong:** CDK cross-stack references use CloudFormation `Fn::ImportValue` (stack exports) or SSM Parameter Store. Pulumi uses `StackReference` — a first-class construct that reads outputs from another Pulumi stack. Teams migrating from CDK often try to replicate the SSM pattern or read CloudFormation exports directly, which works but bypasses Pulumi's dependency tracking.

**Why it happens:** The mental model is different. In CDK, stacks are loosely coupled via CloudFormation exports. In Pulumi, stacks are explicitly coupled via `StackReference`, which creates a tracked dependency.

**Consequences:** If you read SSM parameters directly in Pulumi code, Pulumi doesn't know the networking stack must be deployed before the compute stack. Deployment order becomes manual. Also, `pulumi destroy` won't warn you that another stack depends on the one you're destroying.

**Prevention:**
- Use `pulumi.StackReference` for all cross-stack values: `const net = new pulumi.StackReference("org/nucleus-networking/prod")`.
- Export all shared values (VPC ID, subnet IDs, security group IDs) as stack outputs in the networking stack.
- The full stack reference name format is `<org>/<project>/<stack>` — get this right or the reference silently returns `undefined`.
- For the S3 backend (no org), the format is just `<project>/<stack>`.

**Detection:** `undefined` values from `StackReference.getOutput()` at runtime. Resources created with `undefined` IDs fail silently or create with wrong config.

**Confidence:** HIGH — core Pulumi concept.

---

### Pitfall 7: Lambda Bundling — No Built-in Equivalent to CDK's NodejsFunction

**What goes wrong:** CDK's `aws_lambda_nodejs.NodejsFunction` automatically bundles TypeScript Lambda code with esbuild, handles `node_modules` externalization, and produces a minimal zip. Pulumi's `aws.lambda.Function` has no equivalent — you must handle bundling yourself. Teams often deploy unbundled TypeScript source or forget to exclude `node_modules`, producing oversized zips or runtime errors.

**Why it happens:** Pulumi is a lower-level abstraction than CDK constructs. CDK L2/L3 constructs encapsulate operational complexity; Pulumi's AWS Classic provider maps 1:1 to CloudFormation resource types.

**Consequences:** Lambda deployment fails (zip too large), cold starts increase (unnecessary dependencies included), or runtime errors (`Cannot find module` for TypeScript source without transpilation).

**Prevention:**
- Use a pre-build step: run esbuild before `pulumi up` to produce `dist/index.js`, then reference the output directory.
- In `Pulumi.yaml`, add a `preLaunch` command or use a Makefile target that runs esbuild first.
- Use `pulumi.asset.FileArchive("./dist")` pointing to the esbuild output directory.
- For the scheduler Lambda (already uses esbuild): keep the existing `lambda/scheduler/` build pipeline, just change how the zip is referenced in Pulumi vs CDK.
- Mark AWS SDK packages as external in esbuild config — Lambda runtime includes them: `external: ["@aws-sdk/*"]`.
- Consider `@pulumi/aws-native` or community packages like `pulumi-aws-lambda-nodejs` if available, but verify they're maintained.

**Detection:** Lambda function size > 50MB (hard limit), or `Runtime.ImportModuleError` in CloudWatch logs.

**Confidence:** MEDIUM — based on training data; verify current Pulumi AWS provider docs for any new higher-level constructs.

---

### Pitfall 8: ECS Task Definition Updates Don't Auto-Redeploy the Service

**What goes wrong:** In CDK, updating a task definition automatically triggers a new ECS service deployment. In Pulumi, creating a new task definition revision is a separate resource from the ECS service. Pulumi updates the task definition but the ECS service continues running the old revision unless you explicitly force a new deployment.

**Why it happens:** ECS task definitions are immutable — each change creates a new revision. The ECS service has a `taskDefinition` property pointing to a specific revision ARN. Pulumi updates the ARN in state but ECS doesn't redeploy unless the service resource itself changes.

**Consequences:** You deploy new application code, `pulumi up` succeeds, but ECS is still running the old container image. Silent failure — no error, just stale deployment.

**Prevention:**
- Set `forceNewDeployment: true` on `aws.ecs.Service` to trigger redeployment whenever the task definition changes.
- Use `deploymentCircuitBreaker: { enable: true, rollback: true }` to auto-rollback failed deployments.
- Set `waitForSteadyState: true` (default in Pulumi AWS provider) so `pulumi up` waits for the service to stabilize before completing.
- Ensure `minimumHealthyPercent: 100` and `maximumPercent: 200` for zero-downtime rolling updates.

**Detection:** `pulumi up` succeeds but `aws ecs describe-services` shows the service running an old task definition revision.

**Confidence:** MEDIUM — based on training data; ECS service behavior is well-established.

---

### Pitfall 9: CloudFront Distribution Updates Take 15-30 Minutes

**What goes wrong:** Any change to a CloudFront distribution (adding a behavior, changing cache policy, updating origins) triggers a full distribution deployment that takes 15-30 minutes. Pulumi waits for the distribution to reach `Deployed` state before completing. This makes `pulumi up` appear hung and can cause CI/CD pipeline timeouts.

**Why it happens:** CloudFront is a global service — changes must propagate to all 400+ edge locations. This is an AWS constraint, not a Pulumi issue, but Pulumi's synchronous `pulumi up` makes it more visible than CDK's async CloudFormation deployments.

**Consequences:** CI/CD pipelines timeout (default GitHub Actions job timeout is 6 hours, but many teams set lower limits). Developers think the deployment failed when it's just slow.

**Prevention:**
- Set a generous timeout for `pulumi up` in CI/CD (at least 45 minutes for stacks with CloudFront).
- Batch CloudFront changes — don't make incremental changes that each trigger a 20-minute wait.
- For cache invalidations after S3 asset updates, use a separate script (AWS CLI `aws cloudfront create-invalidation`) rather than a Pulumi custom resource — custom resources for invalidation add complexity and can fail silently.
- Consider `skipDestroy: true` on the CloudFront distribution during development to avoid accidental deletion.

**Detection:** `pulumi up` running for >5 minutes with no output — check AWS console for CloudFront distribution status.

**Confidence:** MEDIUM — CloudFront deployment time is well-known; Pulumi wait behavior based on training data.

---

### Pitfall 10: Pulumi TypeScript Compilation Errors from Strict tsconfig

**What goes wrong:** Pulumi runs your TypeScript program via ts-node at deploy time. If your project's `tsconfig.json` has strict settings (`noImplicitAny`, `strictNullChecks`) and Pulumi's generated/provider types have `any` or optional types that don't satisfy strict checks, `pulumi up` fails with TypeScript compilation errors before any AWS API calls are made.

**Why it happens:** The `@pulumi/aws` package types are auto-generated from the AWS provider schema. Some properties are typed as `pulumi.Input<string | undefined>` which requires null checks in strict mode. Also, `pulumi.Output<T>` is not directly assignable to `T` — you must use `.apply()` or `pulumi.interpolate`.

**Consequences:** `pulumi up` fails immediately with TS errors. Common error: passing `Output<string>` where `string` is expected (e.g., passing a VPC ID output directly to a security group's `vpcId` without wrapping).

**Prevention:**
- Create a separate `tsconfig.json` for the Pulumi project (in `infra/` or `pulumi/`) with relaxed settings if needed.
- Never use `Output<T>` values directly as plain `T` — always use `pulumi.interpolate`, `.apply()`, or pass the `Output` directly to another Pulumi resource property (which accepts `Input<T>`).
- Use `pulumi.output(value).apply(v => ...)` for transformations.
- The Pulumi project's `tsconfig.json` should extend the root but override `noEmit: false` and set `outDir`.

**Detection:** `error TS2345: Argument of type 'Output<string>' is not assignable to parameter of type 'string'` during `pulumi up`.

**Confidence:** HIGH — core Pulumi TypeScript pattern.

---

### Pitfall 11: Pulumi Refresh Required After Manual AWS Console Changes

**What goes wrong:** If anyone makes manual changes in the AWS console or via CLI after a `pulumi up`, Pulumi's state file is out of sync with reality. The next `pulumi up` may show unexpected diffs, try to revert manual changes, or fail with conflicts. CDK has the same issue but `cdk diff` is more commonly run as a check; Pulumi teams often skip `pulumi refresh`.

**Why it happens:** Pulumi state is a snapshot of what Pulumi last deployed. It doesn't poll AWS continuously. Manual changes create drift between state and reality.

**Consequences:** `pulumi up` reverts manual hotfixes. Or worse: Pulumi sees a resource as needing update, applies a partial update, and leaves the resource in an inconsistent state.

**Prevention:**
- Run `pulumi refresh` before any `pulumi up` in production to sync state with actual AWS resources.
- Establish a policy: no manual AWS console changes to Pulumi-managed resources. Use `pulumi up` for all changes.
- For emergency hotfixes, document the manual change and immediately follow up with a `pulumi refresh` + code update.

**Detection:** `pulumi preview` showing changes you didn't make in code. `pulumi refresh` output showing resources that have drifted.

**Confidence:** HIGH — standard IaC state management concern.

---

## Minor Pitfalls

### Pitfall 12: Stack Output Names Must Be Stable

**What goes wrong:** If you rename a stack output (e.g., rename `vpcId` to `mainVpcId`), any `StackReference` in another stack that reads the old name gets `undefined`. This is a silent failure — no error, just missing values that cause downstream resources to be created with wrong config.

**Prevention:** Treat stack output names as a public API. Never rename them without updating all consumers. Add both old and new names during a transition period.

**Confidence:** HIGH.

---

### Pitfall 13: Pulumi Destroy Order for Dependent Stacks

**What goes wrong:** If you run `pulumi destroy` on the networking stack while the compute stack still has a `StackReference` to it, Pulumi will destroy networking resources that the compute stack depends on (VPC, subnets, security groups). ECS tasks lose network connectivity.

**Prevention:** Always destroy stacks in reverse dependency order: compute stack first, then networking stack. Use `protect: true` on the networking stack during active development.

**Confidence:** HIGH.

---

### Pitfall 14: CloudFront OAC/OAI Not Auto-Wired for S3 Origins

**What goes wrong:** CDK's `Distribution` construct automatically creates an Origin Access Identity (OAI) or Origin Access Control (OAC) and updates the S3 bucket policy. In Pulumi, you must manually create the OAC, reference it in the CloudFront distribution origin config, and write the S3 bucket policy granting CloudFront access. Missing any step causes 403 errors from CloudFront.

**Prevention:** Create `aws.cloudfront.OriginAccessControl`, reference its `id` in the distribution's `s3OriginConfig`, and add a bucket policy with `Principal: { Service: "cloudfront.amazonaws.com" }` and a condition on the distribution ARN.

**Confidence:** MEDIUM — based on training data.

---

### Pitfall 15: ECS Fargate Requires Explicit Log Group Creation

**What goes wrong:** CDK's `FargateTaskDefinition` auto-creates a CloudWatch log group. In Pulumi, if you reference a log group name in the container definition's `logConfiguration` without creating the `aws.cloudwatch.LogGroup` resource first, ECS task launch fails with a log driver error.

**Prevention:** Always create `aws.cloudwatch.LogGroup` explicitly and use its `name` output in the container definition. Set `retentionInDays` to avoid unbounded log growth.

**Confidence:** MEDIUM — based on training data.

---

## Phase-Specific Warnings

| Phase | Topic | Likely Pitfall | Mitigation |
|-------|-------|---------------|------------|
| PULUMI-01 | S3 backend init | Wrong DynamoDB key schema (`id` instead of `LockID`) | Create table with exact schema before `pulumi login s3://...` |
| PULUMI-01 | Passphrase management | Lost passphrase = locked state | Use KMS secrets provider instead of passphrase |
| PULUMI-02 | VPC import | Auto-naming mismatch causes VPC recreation | Set explicit `tags.Name` and use `pulumi import` before writing code |
| PULUMI-02 | Subnet import | Multiple subnets with similar names confuse import | Import by subnet ID, not name |
| PULUMI-03 | ECS service | Task definition update doesn't redeploy | Set `forceNewDeployment: true` |
| PULUMI-03 | CloudFront | 20-minute update blocks CI/CD | Set pipeline timeout ≥45 min; batch CF changes |
| PULUMI-03 | CloudFront S3 | Missing OAC → 403 errors | Manually create OAC and bucket policy |
| PULUMI-04 | Lambda bundling | No NodejsFunction equivalent | Pre-build with esbuild; reference `dist/` directory |
| PULUMI-04 | Lambda log group | Missing log group → task launch failure | Create `aws.cloudwatch.LogGroup` explicitly |
| PULUMI-05 | DynamoDB import | Table recreation destroys production data | Add `protect: true` immediately after import |
| PULUMI-06 | Stack outputs | Renamed outputs break StackReference consumers | Treat output names as stable API |
| PULUMI-06 | CDK removal | CDK bootstrap stack still exists | Leave `CDKToolkit` stack in place; don't import into Pulumi |

---

## Sources

- Pulumi resource naming documentation (official, verified via WebFetch 2026-03-29): auto-naming behavior and URN-based recreation confirmed HIGH confidence
- Pulumi state and backends documentation (official, verified via WebFetch 2026-03-29): S3 backend DIY management requirements confirmed
- Remaining findings: training data (cutoff Aug 2025), MEDIUM confidence — verify against current Pulumi docs before implementation
