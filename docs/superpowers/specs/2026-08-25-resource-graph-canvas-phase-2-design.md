# Resource Graph Canvas — Phase 2 Design

Status: approved design, not yet implemented
Depends on: `docs/superpowers/specs/2026-08-25-tenant-resource-graph-design.md` (Phase 1, delivered)

## Why

Phase 1 gave the agent a multi-resource graph layer. A human still cannot see the graph —
the only visual surface is a three-column mini-map inside one resource's dialog. This phase
adds the canvas.

## The interaction, stated first because everything follows from it

Open the page and a real graph is already on screen — roughly 100 nodes, laid out and
connected. Not a blank canvas, not a list, not 20,000 nodes. Tap a node and its children
pop out around it. Tap again to collapse. The picture grows only where the user asked it to.

```
open        2 transit gateways + 99 accounts        ~101 nodes
tap account         its VPCs appear                 + a handful
tap VPC             subnets, load balancers, DBs    + up to 50
tap subnet          instances, volumes              + up to 50
tap resource        everything it touches           + up to 50
```

Node count stays between ~100 and a few hundred, which is the band where a force-directed
graph is legible rather than a grey disc.

## Measured reality

Re-measured 2026-08-25 with Phase 1's display filters applied.

| Metric | Value |
| --- | --- |
| Accounts | 99 |
| Visible resources, all accounts | 20,572 |
| Visible edges, all accounts | 21,818 |
| Largest single account | 821 nodes, 736 edges |
| Accounts exceeding `SEED_NODE_CAP` (1,500) | 0 |

**Shared resources across accounts — the entire list:**

| Resource | Accounts |
| --- | --- |
| `ec2_transit_gateways/tgw-0aacc12b5ee138da9` | 42 |
| `ec2_transit_gateways/tgw-0490f03c643a18a9d` | 36 |

Nothing else is shared. 78 accounts hang off a transit gateway, **0** sit on both, and 21
are standalone. The estate is therefore two disjoint hub-and-spoke networks plus 21 isolated
accounts — and that is the opening screen, because it is both the truth and the interesting
picture.

## Scope

**This phase adds no backend code.** Every level is served by a Phase 1 route. That is a
hard constraint: anything requiring a new aggregate, route or repository method is out.

| Level | Data source (all Phase 1) |
| --- | --- |
| Opening view — accounts | `GET /api/resource-graph/summary` (no accountId) → 99 rows |
| Opening view — hubs and spokes | `GET /api/resource-graph/query?predicate=by-type&resourceType=ec2_transit_gateways` — every returned node carries `accountId`, so hub-to-account links are grouped client-side |
| Tap an account | `query?predicate=by-type&resourceType=ec2_vpcs&accountId=…` |
| Tap anything else | `GET /api/resource-graph/expand?resourceId=…` — capped at 50 with true totals |
| "Show whole account" escape hatch | `GET /api/resource-graph/seed?accountId=…` |

Out of scope, and why:
- **Problem badges / overlays** — need a per-account rollup `summarise` does not return. Phase 3.
- **"Open in graph" from agent chat** — Phase 3, once the canvas is proven.
- **Cross-account edges from peering** — `toAccountId` is populated by Phase 1 but no scan has
  run since. The two shared transit gateways are derived from inventory rows, not from
  `toAccountId`, so the opening view works today regardless.

## Design decisions

### D1 — Route and navigation

Page at `/app/resource-graph`; nav entry under Cloud Operations, beside Inventory.

The entry **must** carry `module: "Inventory"`, matching `SUBJECT_TO_MODULE.ResourceGraph` in
`lib/rbac/types.ts`. Not cosmetic: `nav-config.ts` documents that an entry whose href no
subject claims by `navPath`, and which carries no `module`, fails **OPEN** and renders for
every role. Adding a `navPath` registry row for the `ResourceGraph` subject is per-tenant
data, not code — recorded here as an operational follow-up rather than silently assumed.

### D2 — Accounts and hubs are synthetic nodes; everything below is real

The opening view contains two kinds of node that do not exist in `resource_edges`:
an **account** node per account, and a **hub** node per shared transit gateway. They are
constructed client-side from the two queries above and carry a marker distinguishing them
from discovered resources, so nothing downstream mistakes an account for a resource.

A transit gateway is inventoried once per account that can see it — 42 rows for one id.
Those rows collapse to a single hub node keyed on `(resourceType, resourceId)`, which is
what turns 99 islands into two connected networks. This is the same identity rule Phase 1
already applies inside `edgesAmong`.

### D3 — Containment nests; everything else is an edge

Phase 1's `relation-kinds.ts` classification is the rendering rule. `containment` relations
(`in_vpc`, `in_subnet`, `in_cluster`) become **Cytoscape compound-node parentage**, not drawn
lines — drawing them is what collapses a force layout into a ball, because one VPC connects
to hundreds of nodes. Remaining kinds are drawn: `traffic` thick and directed, `reachability`
dashed, `attachment` thin, `observation` hidden by default.

A Cytoscape node has at most one parent, so parentage is subnet-before-VPC: a resource with
an `in_subnet` edge parents to that subnet, one with only `in_vpc` parents to the VPC, one
with neither sits at top level. Total function on the data — no resource has two subnets.

### D4 — Colour is resource type, not workload cluster

Colour encodes resource type (an AWS-recognisable palette), size scales with degree within
the loaded graph.

The Phase 1 spec deferred *workload cluster* colouring to Phase 3, and an earlier draft of
this document pulled it forward on the assumption the canvas would load a whole account at
once. Progressive expansion makes that wrong: a partially expanded graph rarely holds a
complete connected component, so cluster colours would shift as nodes arrive. Type colouring
is stable under expansion. Cluster colouring returns in Phase 3 alongside the overlays, where
a whole-account view justifies it.

### D5 — Light and dark

The canvas follows the app theme rather than being permanently dark. Two palettes are
defined as CSS custom properties driven by the existing theme, so the graph is legible on
white and on near-black. Contrast is checked for both; a palette that only works on dark is
a defect, not a preference.

### D6 — Selection versus expansion

Single click **selects**: the node highlights and a panel opens on the right edge with name,
type, status, account, region and connection count, plus an **Expand** button and a link to
the full Inventory dialog. Double click, or that button, **expands**.

The panel overlays the right edge rather than resizing the canvas — pushing the graph would
slide the node out from under the cursor at the moment of clicking it.

Separating the two matters: if a single click expanded, every idle click would grow the graph
and the user would arrive at a mess they never asked for.

### D7 — Library and state

`cytoscape@3.34.1` with `cytoscape-fcose@2.2.0`, driven through a ref rather than a React
wrapper. Chosen as the only mainstream option with native compound nodes, which D3 requires.
Layout runs incrementally on expansion (`fit: false`, existing node positions fixed) so the
graph does not jump when nodes arrive.

Canvas state — loaded elements, expanded set, selection, filters — in a `zustand` store under
`lib/stores/`, following the existing `theme-config-store.ts`. Server data through TanStack
Query hooks in `lib/queries/resource-graph.ts`, keyed via `query-keys.ts`; both files exist
and gain entries rather than being replaced. URL carries the expanded set and selection so a
view is shareable, following the deep-linkable resource dialog already on this branch.

### D8 — Honesty carries through to the canvas

Phase 1 forbids silent truncation and the UI must not undo it. `expand`'s per-direction
totals render as "50 shown, +187 more" on the node; a `structural` seed says so rather than
implying the account is small. A node whose expansion returned nothing is visibly marked as
expanded-and-empty, distinct from never-expanded.

## Non-goals

- Rendering all 20,572 nodes at once.
- Editing anything. Every surface is read-only; edges come only from the discovery scan.
- Any new API route, repository method, database table, or worker change.
- Replacing the existing Dependencies tab, which keeps working unchanged.

## Testing

- **Unit (Vitest):** the pure functions — building opening-view elements from summary + TGW
  rows, collapsing per-account TGW rows into one hub, parent assignment, mapping an `expand`
  response into new elements while ignoring ones already on canvas.
- **Component:** truncation text renders when totals exceed what was returned; the panel shows
  the selected node; expanding an empty node marks it rather than looking broken.
- **E2E (Playwright, `apps/web-ui-e2e/`):** page loads with the opening graph present; tapping
  an account adds nodes; tapping again collapses; search focuses a resource. Existing
  conventions — `getByRole`/`getByTestId`, never `waitForTimeout`.

## Risks

- **Force layout is non-deterministic.** Tests assert structure — node counts, presence,
  truncation text — never pixel positions.
- **`fcose` runs on the main thread.** At the ~100-500 nodes this design keeps on screen the
  layout pass is small; the escape hatch if a user expands aggressively is `animate: false`,
  not a different library.
- **The opening view depends on transit gateways being inventoried per account.** If a future
  discovery change stops emitting them per account, the hubs vanish and the view degrades to
  99 unconnected account nodes. It still renders and is still true, but the interesting shape
  is gone — worth an explicit test that the hub grouping produces two hubs on the fixture.
- **Measurements come from one tenant.** An estate with genuinely shared VPCs or KMS keys
  would produce more hubs; the grouping rule is general and does not special-case transit
  gateways.
