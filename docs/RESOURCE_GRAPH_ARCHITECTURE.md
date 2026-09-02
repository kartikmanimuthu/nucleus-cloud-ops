# Resource Dependency Graph Architecture

## Why

A flat `inventory_resources` table cannot answer blast-radius or root-cause questions. AWS describe-API responses already contain every relationship (VpcId, SubnetId, SecurityGroups, etc.), but these were previously discarded by `extractMetadata()`. The resource dependency graph persists them so the AI Ops agent can traverse relationships instead of guessing.

## Approach

Edges are derived **deterministically** from `rawData` during the discovery scan — no LLM extraction, no graph database. A declarative spec table (`EDGE_SPECS`) maps each resource type's fields to edges. Postgres recursive CTEs handle traversal.

## Data Model

Table: `resource_edges`

| Column | Meaning |
|--------|---------|
| `id` | CUID primary key |
| `tenantId` | Multi-tenant scope |
| `accountId` | AWS account |
| `region` | AWS region |
| `fromType`, `fromId` | Source resource |
| `relation` | e.g. `in_vpc`, `uses_security_group`, `routes_to_instance` |
| `toType`, `toId` | Target resource |
| `toAccountId` | Set for cross-account edges (e.g. VPC peering) |
| `jobRunId` | Discovery scan that produced this edge |
| `isCurrent` | `false` if not seen in latest scan |
| `discoveredAt`, `updatedAt` | Timestamps |

**No foreign key to `inventory_resources`**: edge targets routinely do not exist as rows (unscanned region, failed scanner, cross-account VPC peer). Dangling edges are valid data.

## Coverage

24 source types in `EDGE_SPECS` plus 6 custom derivers (CloudWatch alarms, CloudFront origins, EventBridge rule targets, CodePipeline sources/targets, S3 bucket notifications, ECS service task-definition images). ~10 types are inbound-only by nature (`ec2_vpcs`, `kms_keys`, `sns_topics`, `sqs_queues`, `iam_roles`, `iam_users`, `acm_certificates`, `wafv2_web_acls`, `ec2_transit_gateways`, `ecs_clusters`).

## Known Limitations

- `ec2_addresses` (Elastic IPs) are keyed on `AllocationId` and link `attached_to` their instance and network interface.
- All custom derivers now take a `{ accountId, region }` context (the scanning account and the alarm's own resource region), threaded through by `extractEdges`. The `cloudwatch_alarms` deriver needs it to reconstruct full ARNs for the `LoadBalancer`/`TargetGroup` alarm dimensions, whose values are only the ARN's tail. AWS documents the two tails with different shapes: `LoadBalancer` is `app/name/id` (no `loadbalancer/` segment), but `TargetGroup` is `targetgroup/name/id` (the `targetgroup/` segment is already included) — verified against real inventory rows and AWS's own CLI example. The full ARNs are `arn:aws:elasticloadbalancing:{region}:{accountId}:loadbalancer/{value}` and `arn:aws:elasticloadbalancing:{region}:{accountId}:{value}` respectively (note the target-group prefix is not re-added).
- `events_rules` targets are fetched via a custom scanner (`ListTargetsByRule` has no batch form and cannot be expressed by the declarative `tags`/`describe`/`detail` enrichment steps — `describe` flattens results across all resources, losing the rule → target correlation, and `detail`/`tags` cannot merge a list under a custom key). One call per rule, keyed on `Name` (plus `EventBusName` for non-default buses); results land in `rawData._targets` and the `events_rules` deriver maps only `lambda`/`sqs`/`sns`/`ecs` target ARNs to `triggers` edges — unmapped services (Step Functions, API Gateway, etc.) emit nothing. On failure the key is left absent, a warning is logged, and the scan still succeeds. Rules on non-default event buses are not listed at all (`ListRulesCommand` is called without `EventBusName`) — pre-existing behavior, unchanged by this task.
- `cloudfront → wafv2` omitted because CloudFront reports `WebACLId` as an ARN whose last segment is the ACL ID, but `wafv2_web_acls` resourceId is the ACL name.
- CloudFront ALB origins not derivable from hostname (no ARN in the DNS name).
- EFS mount targets, API Gateway integrations, and Backup plan selections need additional API calls and are out of scope.
- `s3_buckets → kms_keys` comes from a `GetBucketEncryption` `detail` enrichment (one call per bucket, not batchable — 2,797 buckets across 99 accounts measured, largest single account 190). `GetBucketEncryption` throws `ServerSideEncryptionConfigurationNotFoundError` for a bucket with no encryption configured; the existing per-resource try/catch in `applyDetailEnrichment` already treats that as "no key" (warning logged, scan continues) rather than a scan failure. AES256 (SSE-S3) buckets have `SSEAlgorithm` but no `KMSMasterKeyID` and correctly resolve no edge. Because `detail` merges the response flat onto the resource (no wrapper key), the edge path starts at `ServerSideEncryptionConfiguration...`, not a namespaced prefix. Buckets encrypted under an AWS-managed KMS alias produce a real edge that the default display filter (`AWS_MANAGED_KEY_PREFIX`) hides — those buckets will still look isolated on the canvas, which is correct behavior, not a bug.
- `s3_buckets → lambda_functions|sqs_queues|sns_topics` (`notifies_on_event`) comes from a `GetBucketNotificationConfiguration` `detail` enrichment — a second per-bucket call on top of the encryption one, so S3 now costs 2 calls/bucket (2,801 buckets tenant-wide measured, largest single account 190, well under the ~400 flag threshold). Like `GetBucketEncryption`, the response merges flat onto the resource with no wrapper key, so the deriver reads `LambdaFunctionConfigurations[].LambdaFunctionArn`, `QueueConfigurations[].QueueArn` and `TopicConfigurations[].TopicArn` directly off the resource; an unconfigured bucket returns `{}`, which correctly resolves no edges rather than an error. The `s3_buckets` custom deriver reuses `ARN_SERVICE_TO_TYPE`/`FULL_ARN_TYPES`/`arnResourceName` from the `events_rules` deriver rather than a parallel mechanism: `lambda_functions` and `sqs_queues` are keyed on the ARN's short name (Lambda/SQS ARNs have no `/`, so the declarative `arn-last-segment` transform cannot extract them — this is the same trap a prior task hit), `sns_topics` is keyed on the full ARN. CloudFront is out of scope for this tenant — zero `cloudfront_distributions` inventoried, so the existing `origin_is` deriver has nothing to fire on; buckets whose only real relationship is a CloudFront origin remain correctly isolated.
- `codepipeline_pipelines` sources/targets come from a `GetPipeline` `detail` enrichment (`mergeKey: "pipeline"` — the response's nested `pipeline` object, not the whole response, is merged flat onto the resource). One call per pipeline, not batchable — 84 pipelines across 99 accounts measured, largest single account 71. The `codepipeline_pipelines` deriver reads `artifactStore.location` (the pipeline's S3 artifact bucket, `stores_artifacts_in`) and walks `stages[].actions[]`, keying on `actionTypeId.provider` — never on a configuration key name alone — because two providers can share a key: both `CodeCommit` and `ECR` source actions use a `RepositoryName` configuration key, but only ECR has a matching inventory type (`ecr_repositories`); CodeCommit repositories are not scanned by this platform at all and are deliberately left unmapped. Mapped: `ECR` source → `ecr_repositories` (`sourced_from`), `Lambda` invoke → `lambda_functions` (`invokes`), `S3` deploy → `s3_buckets` (`deploys_to`). Deliberately unmapped: `ECS` deploy actions carry `ClusterName`/`ServiceName` as separate strings, but `ecs_clusters` and `ecs_services` are keyed on their full ARN in inventory — reconstructing that ARN needs the account id and region (now available via the deriver's `{ accountId, region }` context) plus resolving old-vs-new ECS ARN format ambiguity, none of which this deriver implements, so an ECS deploy action emits nothing rather than a permanently dangling edge; `CodeStarSourceConnection` (GitHub/Bitbucket) and `CodeBuild` also emit nothing — external repositories and CodeBuild projects have no inventory type to join against.

- `ecs_services → ecr_repositories` (`runs_image_from`) reads container images off the service's task definition rather than calling `DescribeTaskDefinition` per service: `ecsServicesDeep` collects the distinct `taskDefinition` ARNs across all described services first (many services in the same cluster share a definition) and issues one `DescribeTaskDefinition` call per distinct ARN, caching the extracted `containerDefinitions[].image` list under `rawData._images` for every service that references it. The deriver parses each image URI against the ECR host shape `{accountId}.dkr.ecr.{region}.amazonaws.com/{repoPath}` — `ecr_repositories.resourceId` is the bare repository name (confirmed against inventory: 113 of 638 rows, 18%, contain a `/`, e.g. `llm-powerhouse/litellm-proxy`), so the repo name is read from the host boundary to the tag/digest boundary rather than via `split('/')`, which would truncate any slash-containing name. A digest suffix (`@sha256:...`) is detected before a tag suffix so it is never mis-split as a tag. Three cases resolve to no edge rather than a dangling one: a public/third-party image (no ECR host match at all, e.g. `nginx:latest`, `public.ecr.aws/...`), an image from another account's registry (host's account id differs from the scanning account), and an image with neither a tag nor a digest (not enough to positively identify what was actually pulled — no "latest" is inferred).

## Cycle Safety

Security groups reference each other, creating cycles. The traversal caps depth at 5 and every query uses `LIMIT`.

## Multi-Tenancy

Raw SQL on both sides is NOT intercepted by the Prisma tenant extension. Every read and write binds `tenantId` explicitly.

## Required IAM Permissions

The target-group scanners need two permissions that a customer's existing cross-account read role may not grant:

```
elasticloadbalancing:DescribeTargetGroups
elasticloadbalancing:DescribeTargetHealth
```

Accounts using the AWS-managed `ReadOnlyAccess` or `SecurityAudit` policy already have both. Accounts with a hand-rolled least-privilege policy must add them. Without them, target-group scanning degrades gracefully (`_targetHealth` is `[]`, a warning is logged, the scan still succeeds) but the load-balancer → instance edge is silently absent.

## Why not SQL/PGQ (PostgreSQL native property graphs)

Reviewed 2026-08-25. Re-check when PostgreSQL 20 enters beta.

PostgreSQL is gaining native property-graph queries (SQL/PGQ, from SQL:2023), which let
you query ordinary relational tables with graph pattern syntax and no separate graph
database. The reasonable question is whether this repo should wait for it, or restructure
around it. Short answer: no, and the schema below is already the shape it would use.

**Do not take the following on trust — every claim has a source you can open, and the two
facts about this repo have commands you can run.**

### What actually shipped

| Claim | How to verify |
| --- | --- |
| SQL/PGQ was committed for PG19 by Peter Eisentraut | [commitfest.postgresql.org/patch/4904](https://commitfest.postgresql.org/patch/4904/) — the patch entry, with its full review thread |
| Discussion thread and design history | [postgresql.org message-id 5f56e720…@eisentraut.org](https://www.postgresql.org/message-id/5f56e720-7872-4095-99c9-992adb0519e2@eisentraut.org) |
| Feature walkthrough with working syntax | [depesz.com — Waiting for PostgreSQL 19: SQL/PGQ](https://www.depesz.com/2026/07/31/waiting-for-postgresql-19-sql-property-graph-queries-sql-pgq/) |
| PG19 was in beta, not GA, when this was written | [postgresql.org/developer/roadmap](https://www.postgresql.org/developer/roadmap/) and the release-notes page for 19 |

What lands in PG19: `CREATE / ALTER / DROP PROPERTY GRAPH`, and a `GRAPH_TABLE` function
taking a `MATCH` pattern, e.g.

```sql
SELECT count(*) FROM GRAPH_TABLE(big_social
    MATCH (a IS person WHERE a.id = 42)-[IS knows]->(b IS person)-[IS knows]->(c IS person)
    COLUMNS (c.id));
```

Note the pattern above spells out **exactly two** hops. That is the whole point below.

### Why it does not replace what this module does

PG19's implementation covers fixed-length patterns. Variable-length traversal (the
`(){1,5}` / `(){*}` forms) and graph algorithms such as shortest path are **not** in it —
they are described as future work in the depesz thread linked above, where the limitation
is discussed directly by commenters including the patch's own reviewers. Read that thread
rather than believing this table.

Mapping that onto the queries in this module:

| Query | Needs | Available in PG19 SQL/PGQ |
| --- | --- | --- |
| `getBlastRadius` | recursive traversal, depth 1-5 | No — variable length |
| `findPath` | shortest path between two nodes | No — no path algorithms |
| `getNeighbors` | variable depth | No — variable length |
| `expand` | one hop | Yes, but it is already a two-index lookup |
| `queryGraph` | fixed patterns | Yes, but already plain SQL |

The three queries SQL/PGQ cannot express are precisely the ones that justified this module.
The two it can express were never the difficult part. Adopting it today would mean nicer
syntax for the easy half and no help with the hard half.

### And this deployment is on PostgreSQL 16

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -tA -c "SHOW server_version;"
```

Local returned `16.14` on 2026-08-25. Production RDS is pinned in
`infra/compute/index.ts` (`const engineVersion = config.get("engineVersion") ?? "16.6"`).
AWS typically adds a new PostgreSQL major to RDS some months after upstream GA, so PG19 is
not reachable in production on the timeline this feature was built for. Check current
availability at
[docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html).

### Why the schema is unaffected either way

SQL/PGQ is **query syntax over ordinary relational tables**, not a storage engine.
`CREATE PROPERTY GRAPH` declares that existing tables should be readable as nodes and
edges; it does not move, copy, or restructure data.

`resource_edges` — `(fromType, fromId) -[relation]-> (toType, toId)` — is already the edge
table such a declaration would be written against. If this project later runs on a version
with variable-length traversal, adopting it means adding a `CREATE PROPERTY GRAPH`
statement and rewriting the traversal SQL in `lib/db/repositories/resource-graph/`. No
migration, no data movement, no change to how discovery writes edges.

### What would change this conclusion

Any one of these, and this section should be revisited:

- Variable-length path patterns and a shortest-path operator land in a released PostgreSQL.
- RDS offers that major version and this deployment upgrades to it.
- Measured traversal performance on real data becomes a problem that a native
  implementation would plausibly solve. Current scale is in the numbers recorded above.
