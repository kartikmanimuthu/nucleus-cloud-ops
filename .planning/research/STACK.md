# Technology Stack: Pulumi IaC Migration

**Project:** Nucleus Cloud Ops — CDK → Pulumi TypeScript
**Researched:** 2026-03-29
**Scope:** Stack additions/changes needed for Pulumi migration only. Existing AWS services (ECS, ALB, Lambda, DynamoDB, etc.) are validated — not re-researched.

---

## Recommended Stack

### Core Pulumi Packages

| Package | Version | Purpose | Why |
|---------|---------|---------|-----|
| `@pulumi/pulumi` | `^3.228.0` | Core SDK — stack, config, outputs, resource model | Required for all Pulumi programs |
| `@pulumi/aws` | `^7.23.0` | AWS Classic provider — VPC, ECS, Lambda, DynamoDB, SQS, etc. | Broadest AWS resource coverage; stable API; use this over aws-native |

**Confidence:** HIGH — versions verified directly from npm registry.

### Pulumi CLI

Install via Homebrew (macOS):

```bash
brew install pulumi/tap/pulumi
```

Or via install script:

```bash
curl -fsSL https://get.pulumi.com | sh
```

Verify: `pulumi version` — should be v3.x.

**Confidence:** HIGH — official install method, no version pinning needed for CLI.

---

## S3 Backend Setup

Pulumi uses **file-based locking stored in the S3 bucket itself** (`.pulumi/locks/` prefix). This is NOT Terraform — there is no DynamoDB lock table needed. Pulumi's S3 backend handles concurrency via S3 object writes.

### Login command

```bash
pulumi login 's3://nucleus-pulumi-state?region=us-east-1&awssdk=v2&profile=PLATFORM-ADMIN'
```

Query parameters:
- `region` — AWS region of the state bucket
- `awssdk=v2` — required as of Pulumi CLI v3.33.1+ for profile support
- `profile` — AWS named profile (use `PLATFORM-ADMIN`)

### State bucket requirements

- Standard S3 bucket with versioning enabled (for state history/rollback)
- No DynamoDB table needed — Pulumi manages locking internally via S3
- Bucket policy: restrict to deployment IAM role only

### Pulumi.yaml backend config (optional — can also set via env)

```yaml
name: nucleus-cloud-ops
runtime: nodejs
backend:
  url: s3://nucleus-pulumi-state?region=us-east-1&awssdk=v2
```

**Confidence:** MEDIUM — S3 backend URL format verified via official docs. DynamoDB-not-needed claim verified via Pulumi docs (file-based locking confirmed). The `dynamodbTable` parameter that exists in Terraform's S3 backend does NOT exist in Pulumi.

---

## Project File Structure

```
pulumi/                        # New directory — Pulumi project lives here
├── Pulumi.yaml                # Project metadata + backend URL
├── Pulumi.production.yaml     # Stack config (region, env vars)
├── index.ts                   # Entry point — imports and exports stacks
├── networking/
│   └── index.ts               # NetworkingStack equivalent
├── compute/
│   └── index.ts               # ComputeStack equivalent
├── package.json               # Pulumi-specific deps
└── tsconfig.json              # Pulumi-specific TS config
```

Keep the Pulumi project in a `pulumi/` subdirectory to avoid conflicts with the root CDK project (WebUIStack stays in CDK).

---

## TypeScript Configuration

The existing root `tsconfig.json` uses `"module": "commonjs"` and `"target": "ES2020"` — both compatible with Pulumi. The Pulumi subdirectory needs its own `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "bin",
    "declaration": true
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules", "bin"]
}
```

Key points:
- `"module": "commonjs"` — Pulumi's default; do NOT use `nodenext` unless you need ESM (adds complexity)
- `ts-node` is already in root devDependencies (`^10.9.2`) — Pulumi uses it to run TypeScript directly
- TypeScript `~5.6.2` already in root devDependencies — compatible (Pulumi supports TS 3.8+)

---

## Pulumi Subdirectory package.json

```json
{
  "name": "nucleus-cloud-ops-pulumi",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "build": "tsc",
    "preview": "pulumi preview",
    "deploy": "pulumi up",
    "destroy": "pulumi destroy"
  },
  "dependencies": {
    "@pulumi/pulumi": "^3.228.0",
    "@pulumi/aws": "^7.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.4",
    "typescript": "~5.6.2",
    "ts-node": "^10.9.2"
  }
}
```

---

## What NOT to Add

| Package / Tool | Why Not |
|----------------|---------|
| `@pulumi/aws-native` | Cloud Control API provider — incomplete coverage, slower, less stable than `@pulumi/aws` classic. Only needed for resources not yet in classic provider (none in this project). |
| `@pulumi/awsx` | Higher-level component library (v3.3.1). Useful for ECS patterns but adds abstraction that makes migration harder to reason about. Stick with `@pulumi/aws` for 1:1 CDK parity. |
| Pulumi Cloud backend | Requires `pulumi login` to app.pulumi.com — adds SaaS dependency, costs money at scale. Use S3 backend instead. |
| DynamoDB lock table | Not needed — Pulumi S3 backend uses file-based locking, not DynamoDB (that's Terraform). |
| `@pulumi/cdk` | Pulumi CDK adapter — lets you run CDK constructs inside Pulumi. Defeats the purpose of migrating away from CDK. |
| Root-level Pulumi deps | Don't add `@pulumi/pulumi` or `@pulumi/aws` to the root `package.json` — keep Pulumi isolated in `pulumi/` subdirectory to avoid CDK/Pulumi conflicts. |

---

## CDK Removal (Post-Migration)

Once NetworkingStack and ComputeStack are migrated, these can be removed from root `package.json`:

```bash
# Remove from dependencies (after WebUIStack also migrated or moved)
aws-cdk-lib
@aws-cdk/aws-s3tables-alpha
constructs

# Remove from devDependencies
aws-cdk
```

WebUIStack stays in CDK for now — do NOT remove CDK until that stack is also migrated or explicitly decommissioned.

---

## Stack Config Pattern

Pulumi uses `Pulumi.<stack>.yaml` for per-environment config (replaces CDK's `cdk.context.json` + env vars):

```yaml
# Pulumi.production.yaml
config:
  aws:region: us-east-1
  nucleus:appName: nucleus-cloud-ops
  nucleus:vpcCidr: "10.0.0.0/16"
  nucleus:maxAzs: "2"
  nucleus:natGateways: "1"
```

Access in TypeScript via `new pulumi.Config("nucleus").require("appName")`.

---

## Sources

- `@pulumi/pulumi` version: https://registry.npmjs.org/@pulumi/pulumi/latest (verified 2026-03-29)
- `@pulumi/aws` version: https://registry.npmjs.org/@pulumi/aws/latest (verified 2026-03-29)
- `@pulumi/awsx` version: https://registry.npmjs.org/@pulumi/awsx/latest (verified 2026-03-29)
- S3 backend URL format: https://www.pulumi.com/docs/iac/concepts/state-and-backends/ (MEDIUM — 404 on some sub-pages, main page confirmed)
- Pulumi.yaml structure: https://www.pulumi.com/docs/iac/concepts/projects/project-file/ (HIGH)
- TypeScript config: https://www.pulumi.com/docs/iac/languages-sdks/javascript/ (HIGH)
