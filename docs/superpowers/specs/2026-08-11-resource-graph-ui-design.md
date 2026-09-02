# Resource Dependency Graph UI — Dependencies Tab

**Goal:** Let an operator answer "what breaks if I touch this?" from the resource they are
already looking at, using the `resource_edges` graph that until now only the AI agent could read.

**Scope:** A **Dependencies tab** in the existing
[resource-detail-dialog.tsx](../../../apps/web-ui/components/inventory/resource-detail-dialog.tsx),
plus the API and repository work it needs.

**Out of scope (separate spec):** the standalone graph explorer page — multi-hop expansion, depth
controls, relation filters, pan/zoom. See [the follow-ups doc](../plans/2026-08-11-resource-graph-followups.md).

**Why a list, with a diagram on top of it — not a diagram alone.** The graph holds 32,871 edges.
A node-link rendering at that scale is a demo asset, not a tool: readable at ~10–30 nodes, a
hairball beyond, with labels overlapping and no question answerable from the picture. And the
question this tab exists to answer needs a definite countable result — *"1 thing depends on
this"* — not a shape to trace by eye. AWS Config renders resource relationships as a table for
exactly this reason; Backstage's per-entity relations view stays ego-centric and expand-on-demand.

So the list is the substance and the answer of record. Above it sits a **capped, depth-1 ego
mini-map** (§5) which makes the relationships legible at a glance and gives the feature something
worth showing someone. It earns its place by being small and deterministic: one focus, one hop,
six nodes a side, fixed layout. Everything that tempts a diagram toward the hairball — more hops,
free-floating layout, no cap — belongs to the explorer page, under its own controls.

---

## 1. Relation kinds — the core modelling decision

The 24 relations discovery emits are **not equivalent**, and presenting them as a flat list is
the main way this UI could mislead. `routes_to_instance` means live traffic breaks.
`monitors` means an alarm goes stale. Both would otherwise render as an identical row.

Edges are therefore classified into kinds, ordered by operational severity:

| kind | label | relations |
| --- | --- | --- |
| `traffic` | Serves traffic | `routes_to_instance`, `attached_to_load_balancer`, `registers_with_target_group`, `origin_is` |
| `reachability` | Network reachability | `allows_ingress_from`, `allows_egress_to`, `peers_vpc`, `attached_to_tgw`, `attaches_vpc` |
| `containment` | Runs in / contains | `in_vpc`, `in_subnet`, `in_cluster`, `member_of_cluster`, `has_member` |
| `attachment` | Attached / uses | `has_volume`, `has_network_interface`, `attached_to`, `uses_security_group`, `uses_instance_profile`, `uses_iam_role`, `encrypted_with`, `uses_certificate` |
| `observation` | Observed by | `monitors`, `notifies` |

**Kind order differs by direction, and both are deliberate.**

- **"Depends on this"** renders in the severity order above — `traffic` first, because the
  question being asked is "what breaks", and traffic-bearing relations are the answer.
- **"This depends on"** renders `containment` first, then `attachment`, `reachability`,
  `traffic`, `observation`. Reading what a resource *needs* goes foundation-upward: the VPC and
  subnet it lives in before the certificate it uses. Applying severity order here would lead with
  whatever happens to serve traffic, which is not how anyone reads a requirements list.

Two rules that matter more than the grouping itself:

- **A guard test asserts every relation in `EDGE_SPECS` and `CUSTOM_DERIVERS` is explicitly
  mapped**, in the spirit of the existing checks in
  [edge-spec.test.ts](../../../apps/workers/src/jobs/discovery/__tests__/edge-spec.test.ts).
  Adding a relation without classifying it fails the build.
- **An unmapped relation still renders, under an `other` kind.** Given the guard test, this
  should be unreachable in development — its job is **version skew**: a deployed web-ui reading
  edges written by a newer worker that emits a relation this build has never heard of. A lookup
  table that silently drops unknown keys is the same defect class as the resource-type
  mismatches that hit this feature three times, and a rolling deploy is exactly when it would
  bite. Nothing disappears because a mapping is missing.

**Edge direction is not the direction of consequence.** An instance `has_volume` a volume, so
the instance appears in that volume's inbound set — but deleting the instance does not destroy
the volume. The UI therefore never says "this will break". It says what is connected, how, and
in which direction, and leaves the judgement to the reader. Section headers are
**"Depends on this"** and **"This depends on"**, not "will break".

## 2. API

`GET /api/resource-graph?resourceType=<type>&resourceId=<id>`

```jsonc
{ "success": true, "data": {
    "focus":      { "resourceType": "...", "resourceId": "...", "name": "...", "exists": true },
    "asOf":       { "oldestSyncedAt": "2026-08-10T22:14:00Z", "accountsRepresented": 3,
                    "staleAccounts": [] },
    "dependents": { "edges": [ /* inbound, depth 1 */ ], "total": 3,  "truncated": false },
    "dependsOn":  { "edges": [ /* outbound, depth 1 */ ], "total": 6, "truncated": false }
} }
```

Each edge:

```jsonc
{ "relation": "registers_with_target_group",
  "kind": "traffic",
  "region": "ap-south-1",
  "other": { "resourceType": "ecs_services", "resourceId": "arn:aws:ecs:...",
             "name": "nucleus-cloud-ops-web-ui-service", "status": "ACTIVE",
             "accountId": "970547372609", "exists": true } }
```

**One route, both directions.** The tab always renders both, so splitting into two endpoints
would mean two round-trips for one panel.

**RBAC:** `authorize('read', 'ResourceGraph')`. Add `ResourceGraph: 'Inventory'` to
[rbac/types.ts](../../../apps/web-ui/lib/rbac/types.ts), alongside `RightSizing: 'Inventory'`.
Read-only — no `update`/`delete` action exists for this subject, so it cannot become the
privilege escalation that file's comments warn about.

**Response conventions** follow the rest of `app/api`: `{ success, data }` / `{ success, error }`.

A focus resource that is not in inventory returns **200 with `focus.exists: false`**, not 404.
It is a valid, meaningful answer — and the UI must still show `asOf` in that state, which a 404
body could not carry. 4xx is reserved for auth failures and malformed requests.

### `asOf` is worst-case across every account in the answer

Two wrong models were rejected before this one.

Deriving freshness from the newest edge's `discoveredAt` breaks in the case that matters most:
a resource with **no** current edges has no rows, so there would be no timestamp at all — the
"nothing depends on this" state would render with no indication of when we last looked. That is
the one cell in this UI capable of getting something live deleted.

Using only the *focused* resource's account is also wrong, and more subtly. Edges cross accounts
— `resource_edges.toAccountId` exists precisely for that — so a dependent in account B can be a
week stale while account A was scanned minutes ago. A single confident "as of 2 hours ago" would
then be a freshness claim broader than the data supports, on a platform whose whole premise is
multi-account.

So `asOf` reports the **oldest** `accounts.lastSyncedAt` among every account represented in the
response (focus plus every edge endpoint), with the account count alongside it:

```jsonc
"asOf": { "oldestSyncedAt": "2026-08-10T22:14:00Z", "accountsRepresented": 3,
          "staleAccounts": [ { "accountId": "111122223333", "lastSyncedAt": "2026-08-04T…" } ] }
```

The UI shows the worst case ("as of 6 days ago, across 3 accounts") and names the laggards on
hover. `asOf` is **always present**, including on both empty states. Any account that has never
been scanned makes this an explicit "never scanned" warning rather than a relative time —
never-scanned outranks any timestamp.

### Counts must not lie

Each direction's `total` is the **pre-limit** count, obtained with `COUNT(*) OVER ()` **in the
same query as the rows** — not as a separate round-trip, and never from `edges.length`. The fetch is capped at 200
per direction, so a length-derived count would silently under-report: the exact silent-truncation
problem flagged in the follow-ups doc. `truncated` is per-direction, and the UI says
"showing first 200 of N" on whichever direction was cut.

## 3. Repository

Add to [interface.ts](../../../apps/web-ui/lib/db/repositories/resource-graph/interface.ts) /
[postgres.ts](../../../apps/web-ui/lib/db/repositories/resource-graph/postgres.ts):

```ts
type Direction = { edges: EnrichedEdge[]; total: number; truncated: boolean };

getResourceDependencies(args: { tenantId, resourceType, resourceId, limit? })
  : Promise<{ dependents: Direction; dependsOn: Direction }>
```

**Depth 1 needs no recursion.** One hop is a flat predicate, so this is a plain query. The
recursive CTEs in `getNeighbors` / `getBlastRadius` stay untouched for the agent tools and the
future explorer page.

**One query per direction, not a single `OR`.** Each direction needs its **own** `LIMIT`: a
resource with 5,000 inbound edges and 3 outbound would let a shared cap fill entirely with
inbound rows and render **zero** outbound, with no truncation signal on the direction that got
starved. Independent caps are the reason for the split.

It is *not* for index reasons — that was measured, and a combined `OR` plans perfectly well:

```
Bitmap Heap Scan on resource_edges (actual time=0.186..0.237 rows=8)
  ->  BitmapOr
        ->  Bitmap Index Scan on resource_edges_forward_idx
        ->  Bitmap Index Scan on resource_edges_reverse_idx
Execution Time: 0.304 ms          -- 32,871 edges, real data
```

Recorded so nobody merges the two queries back together for performance and silently
reintroduces the starvation bug. `resource_edges_forward_idx` and `resource_edges_reverse_idx`
already cover one direction each exactly.

**Enrichment** left-joins each edge's far endpoint to `inventory_resources` on
`(tenantId, resourceType, resourceId, isCurrent)` for `name`, `status`, `accountId`. A missing
row sets `exists: false`. Two things fall out for free: rows show human names instead of
unreadable ARNs, and dangling targets become visible — which covers graph verification without
a separate view.

`$queryRawUnsafe` is not intercepted by the tenant extension, so every statement carries an
explicit `"tenantId" = $1`, as the existing methods do. Left joins must also constrain the
joined inventory row to the same tenant, or enrichment becomes a cross-tenant read.

## 4. Inventory API: a single-resource route

[/api/inventory/resources](../../../apps/web-ui/app/api/inventory/resources/route.ts) filters by
type, region, account and free-text search, but cannot fetch one resource by id, and does not
return `tags`/`metadata`.

Pivoting needs both. The alternative — greying out Tags and Metadata for pivoted resources —
would reuse the existing `disabled={!hasMetadata}` pattern for a different meaning ("we didn't
fetch it" rather than "it has none") and read as a bug on the feature's headline interaction.

**A new route, not a new flag on the list route:** `GET /api/inventory/resources/[type]/[id]`,
returning one resource with `tags` and `metadata`. Adding a `resourceId` param to the list
endpoint would make one route return two different shapes depending on which filter was passed,
which is the kind of API that is fine to write and miserable to consume. A single-resource route
is also what the grid would want for its own detail hydration later.

## 5. Component

**New:** `components/inventory/resource-dependencies-tab.tsx`.

**Changed:** `resource-detail-dialog.tsx` gains a `Dependencies` trigger and owns a **focus
stack** (`ResourceDetailProps[]`) for the breadcrumb trail. The tab is presentational: it takes
the current focus and an `onPivot(resourceType, resourceId)` callback.

Layout, in order:

```
vpc-0e4a3da2 › nucleus-web-ui-tg › nucleus-web-ui-svc      <- breadcrumb, click to go back
──────────────────────────────────────────────────────────
DEPENDS ON THIS                                        3
  Serves traffic
    ecs_services   nucleus-cloud-ops-web-ui-service     ›
  Runs in / contains
    ...
THIS DEPENDS ON                                        6
  ...
                       as of 2 hours ago   [ explorer → ]
```

- Grouped by kind, kinds in severity order, `traffic` first.
- Row shows the far resource's **name** with type as secondary; the raw id is available but not
  the primary label. `exists: false` rows render the id with a muted "not in inventory" marker.
- 8 rows per kind, then "+N more" expanding to what was fetched.
- Fetched via a TanStack Query hook in `lib/queries/resource-graph.ts`, keyed through
  `lib/queries/query-keys.ts`, following `right-sizing.ts`. **Fetched on tab activation, not on
  dialog open**, so it costs nothing for users who never open it.
- Pivot pushes onto the focus stack and refetches; breadcrumb entries pop.

### Mini-map

Above the list, a compact ego diagram — the visual answer to "show this to someone", and the
part that makes the panel feel like a graph rather than a report.

```
      DEPENDS ON THIS                         THIS DEPENDS ON

  ecs_services                                        ec2_vpcs
  web-ui-service ──registers_with──▶ ⬢ web-ui-tg ──in_vpc──▶ vpc-0e4a3da2
                                       (focus)
                                               ──attached_to_load_balancer──▶ ops-alb
                                                                      elbv2_load_balancers
                            [ open in explorer → ]
```

**Deterministic three-column layout, never force-directed.** Inbound left, focus centre,
outbound right; within a column, nodes stack in the same kind order the list uses, then by name.
Fixed column positions and fixed row spacing mean the same input always draws the same picture.
Force-directed layout is precisely what produces the overlapping labels and unreadable centre
seen in tools that render infrastructure as a free-floating web — at this data volume it would
be a hairball, not a diagram.

**Caps:** 6 nodes per side. Beyond that, a `+N` pill at the foot of the column links to the
explorer. Height grows to a ceiling (~260px) and then stops — a cramped map is worse than a
truncated one.

**Node treatment**, following what works in Resolve.ai's explore view: a circular badge carrying
the type icon (reuse `getResourceIcon`), the name beside it at medium weight, the resource type
underneath in muted mono. The focus node is larger with an accent ring. `exists: false` nodes get
a dashed ring and stay non-interactive.

**Relation names print on the edges** — the single most valuable thing in that reference, because
it turns "these are connected" into "this *registers with* that". Rendered inline when total
nodes ≤ 8, on hover beyond that, so labels never collide.

**Colour encodes kind, not resource type.** Five kinds is a legible palette; colouring by type
across dozens of nodes conveys nothing without a legend. And the diagram needs no legend of its
own — the kind names are already the group headers in the list directly beneath it.

This is **hand-rolled SVG, no graph library.** A deterministic three-column layout is a few
lines of arithmetic; react-flow or d3-force would add bundle weight and an API surface to buy a
layout engine whose behaviour we have explicitly rejected.

**Note on colour, since §8 forbids severity colours in the list and this permits kind colours
here:** the list conveys kind through grouping under headers, so colour would be redundant
decoration. The diagram has no such grouping available, so colour is doing real categorical
work. Colour where spatial grouping is unavailable; grouping where it is.

### Interaction details

These are the difference between a panel that gets used and one that gets clicked once.

- **Deep-linkable.** The inventory page reflects the open resource in the URL
  (`/app/inventory?resource=<type>:<id>&tab=dependencies`) and restores it on load. Without
  this you cannot send anyone a link to what you are looking at — which silently defeats the
  "show it to someone" use case this feature was partly built for.
- **Pivot uses `push`, so Back walks the trail.** Backstage and the AWS console both push on
  entity navigation, and a pivot *is* navigation — the user moved to a different resource.
  `replace` would make Back close the whole dialog, discarding a trail the breadcrumb is
  visibly advertising. Flagged in §10: if history noise turns out to be worse than the
  surprise, this is a one-line change.
- **Rows are `button` elements**, not clickable `div`s: reachable by Tab, activated by
  Enter/Space, with `aria-label` naming the relation and target. Non-existent targets are
  rendered as plain text, since nothing can be pivoted to.
- **Absolute time on hover.** "2 hours ago" is the right default density, but a freshness
  signal you cannot pin down is not much of a signal — the exact timestamp goes in a `title`.
- **Ids are copyable.** A one-click copy on each row's id, because the next thing an operator
  does with an ARN is paste it into a CLI. Uses the existing `sonner` toast for confirmation.

## 6. States

| state | render |
| --- | --- |
| loading | skeleton rows, breadcrumb stays interactive |
| error | inline error + retry; never an empty list, which would read as "no dependencies" |
| focus not in inventory | "This resource is not in inventory for this tenant" + `asOf` |
| in inventory, no edges | "No recorded relationships" + `asOf` — explicitly *not* "nothing depends on this" |
| never scanned | "This account has never been scanned" — no relative time |
| truncated | "showing first 200 of N" |

The distinction between *"not discovered"* and *"no relationships"* is load-bearing: collapsing
them into one "no edges" message is what would let someone read an unscanned resource as safe.

## 7. Testing

Component (`components/inventory/__tests__/resource-dependencies-tab.test.tsx` — that path gets
jsdom via the existing `environmentMatchGlobs` for `**/__tests__/**/*.test.tsx`):

- groups by kind and orders `traffic` first
- an unmapped relation renders under `other` rather than vanishing
- renders each of the five states above distinctly
- "+N more" reveals the remaining fetched rows
- clicking a row calls `onPivot` with that row's type and id
- `exists: false` rows are marked and are not clickable

Mini-map:

- identical input renders identical geometry — snapshot the computed node positions, since a
  layout that drifts between renders is the defect this design exists to avoid
- caps at 6 per side and emits a `+N` affordance beyond that
- relation labels render inline at ≤ 8 nodes and not inline above it
- clicking a node calls `onPivot`; an `exists: false` node does not

URL state:

- opening a resource writes `?resource=<type>:<id>&tab=dependencies`; a cold load of that URL
  restores the dialog on the right tab
- a pivot pushes history, and Back returns to the previous focus rather than closing the dialog

API route test, following the existing `app/api/**/route.test.ts` pattern: RBAC rejection,
`exists: false` (200, not 404) for a focus absent from inventory, shape of a populated response,
and `truncated` set **per direction** — specifically that a direction with thousands of edges
does not suppress the other one.

`asOf` deserves its own cases, since it is the safety-critical field: worst-case wins across
accounts, a never-scanned account outranks any timestamp, and `asOf` is present on both empty
states.

Repository, added to
[repository.integration.test.ts](../../../apps/web-ui/tests/resource-graph/repository.integration.test.ts)
against real Postgres: enrichment resolves names, a dangling target yields `exists: false`,
counts are real rather than row lengths, and neither direction leaks another tenant's rows.

Worker-side guard test: every relation in `EDGE_SPECS` + `CUSTOM_DERIVERS` is classified.

## 8. Visual and interaction standards

Compose from existing primitives in `components/ui/` — `Badge`, `Separator`, `Tooltip`,
`Button variant="ghost"` — and **do not modify them** (repo rule). Reuse the dialog's existing
`getResourceIcon` so a type looks the same here as it does in the grid.

**Hierarchy, three levels and no more.** Direction (section) → kind (group) → row. A fourth
level turns the panel into a tree the reader has to parse. Section headers carry a
right-aligned count; kind headers are small, muted, uppercase.

**Typography.** Geist Sans for labels, **Geist Mono for every identifier** — ids, ARNs, relation
names. Both are already wired as CSS vars. Monospaced identifiers are the convention in the AWS
console, GCP and Datadog for the same reason: they make near-identical strings scannable.

**Middle-truncate identifiers, never tail-truncate.** The distinguishing part of an ARN is at
the end (`…:service/nucleus-ops-cluster/web-ui-service`), so `text-overflow: ellipsis` hides
exactly the part the reader needs. Truncate the middle and keep both ends.

**No severity colours.** Ordering and grouping convey severity; rows stay neutral. Painting
"Serves traffic" rows red would manufacture alarm on a read-only informational panel, and once
everything is coloured nothing reads as urgent. Colour is reserved for two genuinely exceptional
states: `exists: false` (muted, dashed border) and stale/never-scanned freshness (warning tone).

**Tokens only, never hard-coded colour.** `muted-foreground`, `border`, `destructive` and
friends, so light and dark both work without a second code path. The kind palette is defined as
tokens too, with dark-mode values, so the mini-map is not a light-mode-only feature.

**Polished means restrained, not decorated.** What makes a panel like this look considered is
whitespace, a strict type scale, and exactly one accent colour — carrying the focused node and
nothing else. Every additional colour, border and weight spends attention the reader needs for
the data. Three specifics: generous padding around the mini-map so it reads as a figure rather
than crowding the list; secondary text (types, relations) one step down in size *and* muted,
never merely smaller; and alignment so strict that the name column, the type column and the
chevrons form clean vertical edges. Misalignment is the single most common reason an otherwise
correct panel looks unfinished.

**Density and layout.** Rows around 32–36px, single line on desktop, collapsing to two lines
(name above type + relation) on narrow widths. Nothing may scroll horizontally inside the
modal — a table that forces sideways scrolling in a dialog is worse than a stacked list.

**Loading is skeleton rows, not a spinner** — matching final row height so the panel does not
jump when data lands. Three skeletons is enough to read as "loading a list".

**Motion is minimal.** A height/opacity transition on "+N more" only, honouring
`prefers-reduced-motion`. Do not stagger rows in on load; it delays reading for decoration.

**Empty states get an icon, one plain sentence, and the freshness line** — never a bare
"No data", which is indistinguishable from a failure.

**Semantics for assistive tech.** Section titles are real headings so they appear in the
landmark list, and each heading's accessible name includes its count ("Depends on this, 3
items"). Rows are buttons with labels naming relation and target.

## 9. Where the relation-kind mapping lives

Non-obvious, and I initially hand-waved it: `EDGE_SPECS` lives in `apps/workers`, the kind
mapping belongs to `apps/web-ui`, and there is no shared TypeScript library between them
(`libs/` holds only Prisma). So the completeness guard cannot simply import both.

The mapping is therefore owned by web-ui at
`apps/web-ui/lib/resource-graph/relation-kinds.ts`, and its guard test **reads the workers
`edge-spec.ts` and `edge-derivers.ts` as text** and extracts every `relation: '...'` literal,
asserting each one is classified. Parsing source in a test is unusual, but it beats the
alternatives: duplicating the relation list invites drift, and standing up a shared lib is a
larger change than this feature warrants. If a third consumer ever appears, promote the
vocabulary into a shared lib then — not now.

## 10. Open risks

- **Breadcrumbs inside a modal fight the pattern.** Modals are for one bounded task;
  re-focusing in place is explorer behaviour. This is the part most likely to feel wrong in the
  hand, so build it first and be prepared to move the tab into a side sheet.
- **Relation kinds are a judgement call.** The mapping is a starting point and will want revision
  once real resources are browsed. It is one table in one file, deliberately cheap to change.
- **`push` on pivot may make history noisy.** Ten pivots means ten entries before Back leaves the
  dialog. The alternative surprises people by discarding a trail the breadcrumb advertises.
  Validate in the hand; switching is a one-line change.
- **Scope sits at the top of what one plan should hold** — graph API, repository method, RBAC
  subject, single-resource inventory route, URL state, new component, dialog changes, and the
  relation-kinds module with its guard test. The two clean seams if it needs splitting are the
  **single-resource route** (§4) and the **URL state** (§5): the tab works without either, just
  with degraded pivot and no shareable link.
- **Depth 1 only.** Chosen because depth 2 inbound on a VPC returns hundreds of rows that answer
  nothing. If a genuine two-hop need appears (instance → target group → load balancer), it
  belongs to the explorer page with its own controls, not to this tab.

## 11. Deliberately not in this spec

**A dependency count badge on the inventory grid.** This is the single biggest experience lever
available — it turns dependency data from something you go looking for into something you
notice, and removes the three-click journey to any signal at all. It is excluded only because it
needs a per-page aggregate query and touches `resource-grid.tsx`, which widens the change beyond
one tab. Worth doing immediately after, and worth reconsidering now if reach matters more than
a small diff.

**Retired edges.** `isCurrent = false` rows are kept as history and are useful for "what changed",
but showing them in a safety panel adds a dimension the reader has to filter mentally. Current
only.

**Anything the explorer page owns:** multi-hop expansion, depth controls, relation-kind filters,
whole-VPC views, pan/zoom. The tab's mini-map is deliberately depth-1 and capped; the explorer is
where exploring belongs.
