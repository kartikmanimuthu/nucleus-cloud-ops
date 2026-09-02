# Tenant Resource Graph — Design

Status: approved design, not yet implemented
Branch: `feature/knowledge-graph`
Supersedes nothing. Extends `docs/RESOURCE_GRAPH_ARCHITECTURE.md`.

## Why

The dependency graph shipped on this branch answers questions about **one resource at a
time**: `get_resource_neighbors` and `get_blast_radius` both take a single resource id, and
the Dependencies tab renders a fixed three-column mini-map around one focus node.

Nothing in the product can answer a question that spans more than one resource:

- How is this instance connected to that S3 bucket?
- What does this account actually look like?
- Show me everything internet-facing with no alarm on it.

The agent can zoom in perfectly and is blind to the shape of the estate. This design adds
the zoomed-out layer, for both the agent and a human.

## What exists today

| Piece | Location |
| --- | --- |
| `resource_edges` table | `libs/prisma/schema.prisma` (model `ResourceEdge`) |
| Deterministic edge derivation | `apps/workers/src/jobs/discovery/services/edge-spec.ts`, `edge-extractor.ts`, `edge-derivers.ts` |
| Edge persistence + staleness reconciliation | `apps/workers/src/jobs/discovery/services/edge-writer.ts` |
| Traversal repository (recursive CTEs) | `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts` |
| Read-only API | `apps/web-ui/app/api/resource-graph/route.ts` |
| Relation taxonomy | `apps/web-ui/lib/resource-graph/relation-kinds.ts` |
| Agent tools | `apps/web-ui/lib/agent/resource-graph-tool.ts` |

All of it stays. This design adds alongside it.

## Measured reality

Measured against the populated local database on 2026-08-25. These numbers drove every
decision below and should be re-measured before Phase 2.

| Metric | Value |
| --- | --- |
| Current resources | 49,975 |
| Current edges | 34,815 |
| Distinct resources appearing in any edge | 19,821 (60% of inventory is isolated) |
| Accounts | 99 |
| Regions | 1 |
| Cross-account edges (`toAccountId` non-null) | 0 |
| Edges per account | avg 352, p90 970, max 1,725 |
| Largest single hub | `kms_keys/alias/aws/ssm` — 9,294 edges (27% of the graph) |
| Largest hub after AWS-managed KMS aliases are excluded | 237 (an ECS cluster); VPCs peak at 235 |
| Edges excluding AWS-managed KMS aliases | 25,521 |
| Resources of type `ssm_parameters` / `iam_roles` | 15,979 / 13,424 (59% of inventory) |

Three consequences:

1. **The hub problem is a single node.** One `WHERE` clause excluding AWS-managed KMS
   aliases drops the maximum degree from 9,294 to 237. No hub-splitting machinery is
   required.
2. **The graph is far smaller than the inventory.** 19,821 nodes participate in edges;
   the rest are `ssm_parameters`, `iam_roles` and unattached `s3_buckets` that belong in
   the table, not on a canvas.
3. **An account is already the right canvas size.** At avg 352 / p90 970 / max 1,725
   edges, one account renders fully with no level-of-detail machinery at all.

## Design decisions

### D1 — The account is the canvas unit, not the tenant

With zero cross-account edges, a tenant-wide node-link view is 99 disconnected dots. The
landing surface is therefore an **account grid** (tiles with resource/edge counts and
problem badges), and the graph proper opens scoped to one account.

This is revisited if and when D6 populates cross-account edges.

### D2 — Containment is a container, not a line

`in_vpc`, `in_subnet`, `in_cluster` account for 11,868 of 34,815 edges and connect
everything to a handful of hubs. Drawn as lines they collapse any force layout into a
ball. They are rendered as **nesting** (compound nodes) instead. The remaining relation
kinds keep their existing `relation-kinds.ts` classification as the visual encoding:

| Kind | Rendering |
| --- | --- |
| `containment` | Nesting — the node sits inside a box |
| `traffic` | Thick, directed |
| `reachability` | Dashed |
| `attachment` | Thin, faded |
| `observation` | Quiet dashed line, visible by default |

### D3 — Noise is filtered by default, never deleted

Default-hidden, all toggleable, none of it removed from the database:

- Edges whose target is an AWS-managed KMS alias (`kms_keys` with id matching `alias/aws/%`)
- Nodes of type `ssm_parameters` and `iam_roles`

Edges of kind `observation` (`monitors`, `notifies`) are **visible by default**
(`includeObservation` defaults to on; pass `includeObservation: false` to exclude them).
Measured on account `869935102658` (2026-08-26): 186 `monitors` and 57 `notifies` edges
already existed and were being hidden. Making them visible took the count of resources
connected to anything from **305 to 512 of 821**, because an alarm edge lights up both ends —
every monitored instance, database and function joined the graph alongside the alarm itself.
On a graph whose problem is emptiness, hiding 243 real edges was the wrong trade.

**Hidden node types are a display filter, not a traversal filter.** `findPath` walks
through them, because a genuine path may run through a hidden node — two Lambdas sharing
an IAM role are connected through it. A path is returned whole, with its hidden hops
marked so the UI can grey them rather than pretend the path does not exist. Reporting
"no path" because of a display preference would be a lie.

**The AWS-managed KMS exclusion is different and does apply to traversal.** `alias/aws/ssm`
sits between 9,294 resources that have nothing to do with each other; a path through it is
an artefact of AWS defaults, not a real relationship, and admitting it would both produce
nonsense answers and make breadth-first search fan out to 9,294 nodes in one hop. `findPath`
therefore sets `includeHiddenTypes: true` and leaves the managed-key exclusion in force.

### D4 — Every expansion is capped and reports its overflow

An expansion returns at most N neighbours per node plus a true total, so the UI shows
"50 shown, +187 more" rather than silently truncating. This mirrors the `truncated` flag
already returned by `getResourceDependencies`.

### D5 — One engine, three consumers

A single query service answers graph questions. The canvas calls it over HTTP, the agent
calls it as a tool, and the existing Dependencies tab is untouched. Sharing the engine is
what makes "the agent answered, now open that on the canvas" possible without a second
implementation.

### D6 — Populate `toAccountId` (the gap)

`toAccountId` exists on `ResourceEdge`, is written by `edge-writer.ts`, and is covered by
a test — but `EdgeSpec` has no field to populate it and no custom deriver sets it, so the
column is permanently null. The relationships that genuinely cross accounts are already
extracted; only the owning account is dropped.

Fix: add an optional `accountPath` to `EdgeSpec`, resolve it in `extractEdges` with the
existing `resolvePath`, and set it on the specs where the describe response carries the
far side's owner:

- `ec2_vpc_peering_connections` → `RequesterVpcInfo.OwnerId` and `AccepterVpcInfo.OwnerId`
  (one per existing spec entry, so the mapping is 1:1)
- `ec2_transit_gateway_attachments` → `ResourceOwnerId`

`toAccountId` is only set when the resolved owner differs from the scanning account, so
same-account relationships stay null and the existing semantics ("set for cross-account
edges") hold.

### D7 — No new infrastructure

No graph database. No precomputation in Phase 1 or 2 — node size comes from degree within
the loaded subgraph, colour from resource type. Postgres recursive CTEs continue to serve
traversal. No LLM participates in graph construction at any point.

## Architecture

```
resource_edges  (written nightly by the discovery scan)
      |
graph query service      getSeed / expand / findPath / queryGraph / summarise
      |
  +---+-----------+------------------+
Canvas       Agent tools      Existing Dependencies tab (unchanged)
```

The service lives with the existing traversal code in
`apps/web-ui/lib/db/repositories/resource-graph/`. All of its SQL is raw and therefore not
intercepted by the Prisma tenant extension, so every statement binds `tenantId` explicitly
— the rule already followed by `getNeighbors`, `getBlastRadius` and `dependencySql`.

## Phase 1 — query engine and agent tools

No UI. Ships value on its own: the agent gains three questions it cannot answer today.

### 1a. Close the `toAccountId` gap (D6)

`EdgeSpec.accountPath`, resolution in `extractEdges`, and the three spec entries above.
Unit tests in the existing `edge-extractor.test.ts` / `edge-spec.test.ts`.

### 1b. Graph query service

Five operations added to `IResourceGraphRepository` and its Postgres implementation:

| Operation | Contract |
| --- | --- |
| `getSeed(accountId, filters)` | The opening canvas for one account. Returns the account whole when its visible node count is at or below `SEED_NODE_CAP` (1,500); above that, returns structural types only. The response states which of the two it returned, so the UI never has to guess. |
| `expand(node, filters)` | Neighbours of exactly one node — matching a single click. At most `EXPAND_CAP` (50) neighbours plus the true total. Multi-node expansion is not in Phase 1. |
| `findPath(from, to, maxDepth)` | Shortest chain between two resources, or an explicit "no path within N hops". Traverses the full graph per D3. |
| `queryGraph(predicate, filters)` | Nodes matching one predicate from a fixed enumeration, plus the edges among them. Phase 1 ships: `by-type`, `by-vpc`, `internet-facing`, `unmonitored`, `isolated`. Not a free-form query language. |
| `summarise(accountId?)` | With an `accountId`, counts by VPC, resource type and relation for that account. Without one, one row per account — which is what the Phase 2 account grid renders. |

Structural types, used by `getSeed` above the cap. Defined in the web-ui graph lib
(`apps/web-ui/lib/resource-graph/`) beside `relation-kinds.ts`, not beside `EDGE_SPECS` —
`getSeed` runs in web-ui and the workers package is not importable from it: `ec2_vpcs`, `ec2_subnets`, `ec2_nat_gateways`, `ec2_transit_gateways`,
`elbv2_load_balancers`, `elbv2_targroups`, `rds_db_instances`, `rds_db_clusters`,
`docdb_db_clusters`, `elasticache_cache_clusters`, `ecs_clusters`, `ecs_services`,
`eks_clusters`, `autoscaling_auto_scaling_groups`, `cloudfront_distributions`. Measured at
3,017 rows tenant-wide, roughly 30 per account.

Shared behaviour: depth capped at the existing `MAX_DEPTH` of 5, every query carries a
`LIMIT`, D3 display filters applied by default and overridable per call, and every result
reports what it truncated.

### 1c. Agent tools

Three tools in a new `apps/web-ui/lib/agent/resource-graph-query-tool.ts`, registered in
`assembleTools()` next to the existing two:

| Tool | Purpose |
| --- | --- |
| `find_path` | "How is this instance connected to that bucket?" — returns the chain, or states plainly that none exists within the depth limit. |
| `query_graph` | "Internet-facing EC2 in prod with no alarm" — returns a compact subgraph. |
| `describe_environment` | "What does this account look like?" — the `summarise` aggregate as text. |

They follow the conventions the existing tools established: JSON string results, explicit
notes distinguishing "not in inventory" from "in inventory but no edges", and resource-type
resolution from the id rather than trusting a caller-supplied type.

`CORE_PRINCIPLES` gains a sentence directing the agent to `find_path` for connectivity
questions and `describe_environment` before reasoning about an unfamiliar account, in the
same style as the existing principle 10.

### 1d. HTTP routes

New routes under `apps/web-ui/app/api/resource-graph/`: `seed`, `expand`, `path`, `query`,
`summary`. All `GET`, all read-only, all guarded by `authorize('read', 'ResourceGraph')`
using the existing RBAC subject. `expand` takes a single node, so every one of them fits
comfortably in a query string. The current `/api/resource-graph` route is unchanged.

## Phase 2 — the canvas

New page under Cloud Operations → Resource Graph.

- **Landing:** account grid — 99 tiles with resource count, edge count and problem badges.
- **Account view:** Cytoscape.js with the fcose layout, chosen because it is the only
  mainstream library with compound nodes, which is what D2 requires. VPCs and subnets are
  compound parents; everything else nests inside them.
- **Interaction:** click to expand, click to collapse, capped per D4 with a "+N more"
  badge; search box to jump to any resource; filter bar for account, region, VPC, resource
  type and relation kind; right-click for expand / blast radius / open in inventory.
- **State:** canvas contents in `zustand` (already a dependency), data through TanStack
  Query hooks in `apps/web-ui/lib/queries/resource-graph.ts` keyed via `query-keys.ts`.
- **URL state** so a canvas is shareable, following the deep-linkable dialog pattern
  already established on this branch.

New dependencies: `cytoscape`, `cytoscape-fcose`. Used directly through a ref rather than
through a React wrapper.

## Phase 3 — clusters, problems, and the agent handoff

- **Workload clusters:** connected components over `traffic` and `attachment` edges with
  hub types excluded, computed at the end of each discovery scan into a small table.
  Colouring by cluster makes each colour a real application.
- **Problem overlays:** orphans (single-node components), unmonitored resources (no
  inbound `monitors` edge), and — once D6 lands — cross-account links.
- **"Open in graph"** from agent chat: the agent answers, and a button loads exactly the
  subgraph it queried onto the canvas.

## Non-goals

- Rendering all 49,975 resources at once.
- A graph database, or any storage engine beyond the existing Postgres table.
- LLM-driven node or relationship extraction.
- Editing the graph from the UI. Every surface here is read-only; edges come only from the
  discovery scan.
- Multi-region concerns. The measured estate is single-region; region is a filter, not a
  structural level.

## Testing

Following the conventions already used by the resource-graph work on this branch:

- Unit tests for the new `EdgeSpec.accountPath` resolution, alongside the existing
  extractor and spec tests.
- Repository integration tests against a real database in
  `apps/web-ui/tests/resource-graph/`, extending `repository.integration.test.ts`, covering
  caps, overflow totals, noise filters, tenant scoping, and the no-path case.
- Tool tests in `apps/web-ui/tests/resource-graph/tools.test.ts` covering type resolution,
  the empty-result notes, and truncation reporting.
- Phase 2 adds Playwright coverage for the account grid and one expand-and-collapse flow.

## Risks

- **Numbers are from one tenant's local database.** The design is sized for avg 352 / p90
  970 edges per account. An account an order of magnitude larger would need Phase 2 to
  fall back to a seeded skeleton rather than loading the account whole. Re-measure before
  Phase 2 and keep the seed path in the service contract so the fallback exists.
- **Cytoscape canvas rendering** is comfortable to a few thousand elements. If an account
  view exceeds that, the escape hatch is sigma.js with graphology (WebGL), which costs the
  compound-node support and would require hulls instead of nesting.
- **`toAccountId` correctness depends on the describe payload.** If `OwnerId` or
  `ResourceOwnerId` is absent in a real response the edge stays null, which is the current
  behaviour and therefore not a regression.
