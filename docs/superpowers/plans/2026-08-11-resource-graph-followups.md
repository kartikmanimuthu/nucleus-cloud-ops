# Resource Dependency Graph — Follow-Ups

> Continuation of [2026-08-10-resource-dependency-graph.md](2026-08-10-resource-dependency-graph.md).
> Everything below was verified against the live `smc-omar-non-prod` tenant (account
> `970547372609`) on 2026-08-11, not inferred. Steps use checkbox (`- [ ]`) syntax.

**Shipped state:** edges are produced and queryable. A scoped rescan of one account wrote
418 edges from 784 resources with zero errors, and the agent successfully answered
"what depends on the target group `nucleus-cloud-ops-web-ui-tg`" from the graph
(`dependentCount: 1` → the ECS service that registers with it).

## The bug class that keeps recurring — read this first

Three separate defects in this feature had the same shape: **a resource type string that
matches nothing**. A wrong type is not an error. The query simply returns zero rows, the
tool reports "no edges", and the agent silently falls back to AWS CLI. Nothing fails loudly.

The root cause is that the derivation in [scanner.ts:562](../../../apps/workers/src/jobs/discovery/services/scanner.ts)
is not what it appears to be:

```ts
`${service}_${functionName}`.replace('describe_', '').replace('list_', '').replace('get_', '')
```

Plain `replace` strips those substrings **anywhere in the string, not just as a prefix**. The
original plan documented this as "the first prefix stripped", which is why
`elbv2 describe_target_groups` was assumed to yield `elbv2_target_groups`. It actually
yields **`elbv2_targroups`** — `get_` is removed from the middle of `target_groups`.

Guard tests now exist in
[edge-spec.test.ts](../../../apps/workers/src/jobs/discovery/__tests__/edge-spec.test.ts):
they derive the real type set by running `normalizeResources` over the actual scanfile and
assert every spec key, deriver key and `toType` is either in that set or explicitly listed as
unscanned by design. **Any new edge spec must keep those green.** Do not "correct" a type
name to the spelling that reads better.

---

## 1. Resolve resources by name, not just id (highest value)

**Observed:** asked "what depends on the target group `nucleus-cloud-ops-web-ui-tg`", the
agent passed that **name** as `resourceId`. Resolution correctly found nothing — inventory
keys target groups by ARN — so the agent spent two extra executor iterations and an
`aws elbv2 describe-target-groups` call just to convert name → ARN, then re-queried and got
the right answer.

Inventory already stores the name, so the round-trip is avoidable:

| resourceType | name | resourceId |
| --- | --- | --- |
| `elbv2_targroups` | `nucleus-cloud-ops-web-ui-tg` | `arn:aws:elasticloadbalancing:...` |

Affects every ARN-keyed type: target groups, load balancers, ECS services and clusters, SNS
topics, ACM certificates.

- [ ] Change `resolveResourceType` in [interface.ts](../../../apps/web-ui/lib/db/repositories/resource-graph/interface.ts)
      to return `{ resourceType, resourceId } | null` rather than a bare type string, so the
      caller learns the canonical id too.
- [ ] In [postgres.ts](../../../apps/web-ui/lib/db/repositories/resource-graph/postgres.ts),
      match `resourceId` first, then fall back to `name`. Keep it on `getTenantClient` model
      access so the extension scopes it. Keep a deterministic `orderBy` for the ambiguous case
      (a name is not unique across accounts/regions the way an ARN is).
- [ ] In [resource-graph-tool.ts](../../../apps/web-ui/lib/agent/resource-graph-tool.ts), feed the
      resolved `resourceId` into the traversal and echo it back alongside `resourceType`.
- [ ] Decide the ambiguity policy explicitly: if a name matches several resources, either
      return the candidates and ask the agent to disambiguate, or pick one and say which.
      Silently picking is the failure mode this whole document is about.
- [ ] Tests: unit coverage for name-hit, id-hit, ambiguous-name; an integration case in
      [repository.integration.test.ts](../../../apps/web-ui/tests/resource-graph/repository.integration.test.ts)
      seeding two same-named rows.

Side effect: the agent taught itself a workaround for this gap and stored it as the procedural
memory `resolve-arn-before-blast-radius-lookup`. Once this lands, that rule is obsolete and
should be superseded rather than left to fire.

## 2. Deep mode cannot see the graph

[deep-agent.ts](../../../apps/web-ui/lib/agent/deep-agent.ts) never calls `assembleTools`; it
builds its own literal tool lists (lines ~174, ~191, ~207), so `get_resource_neighbors` and
`get_blast_radius` are absent. Fast and Plan both have them. Switching a chat to Deep silently
loses graph access.

- [ ] Add both tools to the deep agent's orchestrator list, or document the omission as
      deliberate.

## 3. Inventory "Ask AI" cannot reach the graph

[/api/ask-ai](../../../apps/web-ui/app/api/ask-ai/route.ts) assembles **no tools at all** — it is
vector search plus a summary. It is also the most intuitive place a user would ask
"what depends on this?", sitting right next to the resource list.

- [ ] Either wire the two graph tools into that route, or add a blast-radius panel to the
      Inventory resource detail page (see item 6), or make the limitation explicit in the
      dialog copy.

## 4. `local-runner.ts` does not write edges

[local-runner.ts](../../../apps/workers/src/jobs/discovery/local-runner.ts) calls
`writeResourcesToPg` (lines 73, 112) but never `extractEdges` / `writeEdgesToPg`. Anyone
testing the graph through it gets resources and **zero edges**, and will reasonably conclude
the feature is broken.

- [ ] Mirror the production path from [index.ts](../../../apps/workers/src/jobs/discovery/index.ts):
      extract edges after the resource write, and call `reconcileStaleEdges`.
- [ ] Match the per-edge region behaviour — the region argument to `writeEdgesToPg` is only a
      fallback now.

## 5. `uses_instance_profile` edges dangle (product decision needed)

518 `uses_instance_profile` edges exist, but `iam_instance_profiles` is never scanned, so the
target resolves to nothing. This is the one entry in `UNSCANNED_BY_DESIGN`.

The label is deliberately truthful: `DescribeInstances` returns only the instance-profile ARN,
and the profile name is **not** the role name — verified live, where the instance carries
`nucleus-cloud-ops-bastion-profile`. Calling it an `iam_roles` edge would be a guess.

Making it resolvable needs all three, and adds a new resource type to the customer-facing
Inventory UI — hence a product call, not a bug fix:

- [ ] Add `iam:list_instance_profiles` to [scanfile.json](../../../apps/workers/src/jobs/discovery/scanfile.json).
- [ ] Add `InstanceProfileName` to `idKeys`/`nameKeys` in [scanner.ts](../../../apps/workers/src/jobs/discovery/services/scanner.ts).
      Verified: an instance profile currently yields a **blank** `resourceId`, the same hazard
      the `TargetGroupArn` fix addressed.
- [ ] Optionally add a spec `iam_instance_profiles` → `Roles[].RoleName` → `grants_role` →
      `iam_roles`, which completes instance → profile → role as a real two-hop path.
- [ ] Remove `iam_instance_profiles` from `UNSCANNED_BY_DESIGN` once scanned.

## 6. No API and no UI for the graph

Only the agent tools read the graph — there is no API route and no page.

- [ ] Recommended first: a blast-radius panel on the Inventory resource detail page. It puts
      "12 things depend on this" in front of someone at the moment they are about to stop or
      delete, instead of requiring them to go and ask.
- [ ] A node-link viewer is the larger option; the traversal work it needs is already built
      and tested.

## 7. Coverage gaps worth closing

- [ ] `routes_to_instance` currently yields nothing in this tenant because every target group
      here is ip-type (ECS awsvpc / Fargate), where `Target.Id` is a private IP. That is now
      correctly gated on `TargetType == 'instance'`. If instance → target group → load
      balancer matters, it needs an account with instance-type groups to validate against.
      Candidate accounts with target groups **and** instances: `430118837281`,
      `682033485547`, `423623868997`.
- [ ] Consider whether ip-type targets should map to `ec2_network_interfaces` by private IP.
      Deliberately not done — it would be inference, not extraction.

---

## Pre-existing issues (flag, do not fix as part of this work)

1. **Planner JSON parse failure.** [planning-agent.ts:371](../../../apps/web-ui/lib/agent/planning-agent.ts)
   throws `SyntaxError: Unexpected non-whitespace character after JSON` on some plans and
   degrades to a generic one-step plan ("Analyze and respond to user request"), losing the
   planned graph step.
2. **`integration.test.ts` is load-flaky.** Its dynamic `import()` exceeds the 5s default
   timeout when the machine is busy; passes 4/4 in isolation. Needs an explicit timeout.
3. **Five failing workers tests on `master-v1`**: `account-service` ×2, `audit-service` ×2
   (SQL-string assertions), `custom-scanners > ecsServicesDeep` (`ClusterArn` vs `clusterArn`).
4. **web-ui baseline**: 181 `tsc` errors and ~59 failing tests, unrelated to this feature.
5. **Integration tests use the ambient `DATABASE_URL`.** Bun auto-loads the root `.env`, so a
   plain `bun run test` points them at whatever that names — a **shared** dev Postgres for this
   team. All rows written are namespaced to dedicated test tenant ids and deleted in `afterAll`,
   but this applies equally to the existing `spot-guard` integration tests and is worth making
   deliberate.

## Verification queries

Confirm edges are being produced at all:

```sql
SELECT relation, COUNT(*) FROM resource_edges WHERE "isCurrent" = true GROUP BY 1 ORDER BY 2 DESC;
```

Confirm the target-group chain specifically (was all zeros before the `elbv2_targroups` fix):

```sql
SELECT "fromType", relation, "toType", COUNT(*)
FROM resource_edges
WHERE "isCurrent" = true AND ("fromType" = 'elbv2_targroups' OR "toType" = 'elbv2_targroups')
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

Signals that the agent actually used the graph rather than AWS CLI: a
`get_resource_neighbors` / `get_blast_radius` row in the AI Ops transcript, and a
`WITH RECURSIVE reach` (neighbors) or `WITH RECURSIVE walk` (blast radius) statement in the
web-ui dev console. Asking the model whether it used the graph is not evidence — an earlier
thread fabricated a graph result, complete with field names the tool does not emit.
