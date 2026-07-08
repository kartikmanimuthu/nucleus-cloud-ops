# Right Sizing — Recommendation Detail Page

## Problem

Recommendation detail today is a modal (`recommendation-detail-dialog.tsx`) triggered by
a table row click. It's cramped: the cost/config/chart/actions all compete for space in
a fixed-height dialog, and there's no room to add the context a reviewer actually wants
(resource metadata, per-metric trends, why the finding fired). Screenshot from the user
shows a real recommendation (`vol-0569512768763aa4c`, EBS, idle) where the modal is
already tight with just today's content.

## Goal

Replace the modal with a dedicated page per recommendation — same review actions
(approve/dismiss/snooze), more room, and enough added context that a reviewer rarely
needs to leave the page to make a decision.

## Non-goals

- No change to the recommendation engine, worker pipeline, or scoring logic.
- No live CloudWatch re-fetch on page load — charts use the `metricsSummary` stats
  already computed and stored at scan time (avg/max/p95/p99 per signal). A true 14-day
  trend line would require a new on-demand CloudWatch call; explicitly deferred.
- No new run-history UI (separate known gap, out of scope here).

## Routing & navigation

- New route: `apps/web-ui/app/app/right-sizing/[id]/page.tsx` — thin async server
  component (mirrors `certificates/[id]/accounts/[accountId]/page.tsx`): awaits
  `params`, sets `generateMetadata`, renders a client component
  `RecommendationDetailPage` from `apps/web-ui/components/right-sizing/`.
- `recommendations-table.tsx` rows become `Link`s (not an `onClick` + dialog-state
  handler) to `/app/right-sizing/{id}?resourceType=&finding=&status=&search=&sort=` —
  the current list filters are carried in the query string (page/limit are **not**
  carried; see Prev/Next below).
- Back button (`ArrowLeft`, `router.push`, same convention as the certificate detail
  page) returns to `/app/right-sizing?<same filters>`, restoring the list as left.

### Prev / Next (triage flow)

The detail page must let a reviewer step through the same filtered/sorted set they
came from, without returning to the list each time.

- On mount, `RecommendationDetailPage` calls the existing
  `useRightSizingRecommendations(filters)` hook with the filters from the URL and a
  large `limit` (1000) instead of the table's normal page size, to get the full
  ordered set matching those filters.
- `currentIndex = data.findIndex(r => r.id === recommendationId)`; `prevId` /
  `nextId` are the neighboring entries. Buttons disable at either edge. A "14 of 538"
  position indicator is shown next to them.
- Prev/Next links preserve the same query-string filters, so stepping through never
  loses context.
- **Known limitation**: this walks at most the first 1000 matching rows. At today's
  scale (538 total recommendations for the largest tenant tested) this is a
  non-issue. If a tenant's filtered set exceeds it, Prev/Next silently stops at row
  1000 rather than erroring — acceptable for v1; revisit with a dedicated
  ids-only endpoint if it becomes a real constraint.

## Backend changes

All additions — no schema changes, no new repository methods beyond one service
method that composes three existing repository calls.

### `RightSizingService.getRecommendationDetail(id, tenantId)` (new)

Composes:
1. `RightSizingService.getRecommendation(id, tenantId)` — the recommendation row
   (already exists).
2. `getInventoryRepository().getResource(tenantId, accountId, resourceType, resourceId)`
   — resource metadata (VPC/subnet/launch time/etc., already exists).
3. `getAccountRepository().getAccount(accountId, tenantId)` — account display name
   (already exists).

Returns `null` if the recommendation itself isn't found (steps 2/3 are best-effort —
missing inventory/account rows degrade to omitted fields, they don't 404 the page).

### `GET /api/right-sizing/recommendations/[id]` (new — route currently only exports `PATCH`)

- `authorize('read', 'RightSizing')`.
- Calls `RightSizingService.getRecommendationDetail(id, tenantId)`.
- 404 (masked, same as other routes) when not found or cross-tenant.
- Response: `{ success: true, data: { recommendation, resource, account } }`.

### Query layer (`apps/web-ui/lib/queries/right-sizing.ts`)

- `queryKeys.rightSizing.details()` / `.detail(id)` — mirrors the `certificates` key
  factory shape.
- `useRightSizingRecommendation(id)` — fetches the new GET route.
- `useUpdateRightSizingRecommendation()` — mutation wrapping
  `PATCH /api/right-sizing/recommendations/[id]`, replacing the dialog's inline
  `fetch` calls. `onSuccess` invalidates `queryKeys.rightSizing.all` (covers both the
  list and the detail query since TanStack Query invalidation matches by key prefix).

## Page content

Composed as a stack of cards inside `RecommendationDetailPage`, using
`PageHeader`-style conventions already used elsewhere in the app:

1. **Header** — a custom header block (plain `Button` + `ArrowLeft` back link, same as
   the certificate detail page — this does **not** use the shared `PageHeader`
   component, which has no back-button slot), resource name/id as title,
   finding/risk/status/confidence chips, Prev/Next + "X of N" position, top-right.
2. **Action bar** — Approve / Dismiss / Snooze (with the existing date picker for
   snooze), always visible near the top — not scrolled past, unlike the modal footer.
3. **Cost card** — current monthly cost vs. estimated savings; keeps today's
   "pricing unavailable for this resource" warning banner when `currentMonthlyCost`
   is null.
4. **Resource context panel** (new) — account name + id, region, current vs.
   recommended config side by side, type-specific metadata pulled from the joined
   `inventory_resources.metadata` (VPC/subnet/launch time/private IP for EC2; engine/
   class for RDS; volumeType/iops/sizeGiB for EBS), and an "Open in AWS Console"
   external link built per resource type from `region` + `resourceId`:
   - `ec2_instances` → `https://{region}.console.aws.amazon.com/ec2/home?region={region}#InstanceDetails:instanceId={resourceId}`
   - `ec2_volumes` → `https://{region}.console.aws.amazon.com/ec2/home?region={region}#VolumeDetails:volumeId={resourceId}`
   - `rds_db_instances` → `https://{region}.console.aws.amazon.com/rds/home?region={region}#database:id={resourceId};is-cluster=false`
   - `autoscaling_auto_scaling_groups` → `https://{region}.console.aws.amazon.com/ec2autoscaling/home?region={region}#/details/{resourceId}`

   These link into the *member* account's console — the viewer needs their own access
   to that account (e.g. via AWS SSO) for the link to resolve; it's a convenience
   deep link, not an assumed-role hop.
5. **Metrics** (new layout) — one small chart per signal present in `metricsSummary`
   (CPU, memory, network in/out, disk read/write ops, IOPS, burst balance, throughput
   %), each rendering avg/max/p95/p99 as a compact bar group; signals that are `null`
   are omitted, not shown empty. A coverage/density line ("9.7 of 14 days observed,
   69% density") sits above the chart grid.
6. **Reasoning** (new) — expands the existing one-line `rationale` string into an
   explicit threshold comparison, computed client-side from `metricsSummary` against
   the thresholds already mirrored in `apps/web-ui/lib/right-sizing/config.ts` (e.g.
   "CPU avg 18.3%, p95 25.5% — below the 40% over-provisioned threshold for EC2"), plus
   a confidence-driver line derived from `coverageDays`/`datapointDensity` against
   `minCoverageDaysHighConfidence` (7) / `minDatapointDensityHighConfidence` (0.8).

## Removed

- `apps/web-ui/components/right-sizing/recommendation-detail-dialog.tsx` — deleted.
- `right-sizing/page.tsx`'s `selected` / `dialogOpen` state and dialog render — removed.

## Error handling

- Recommendation not found / cross-tenant → dedicated "Recommendation not found" state
  on the page with a link back to the list (same convention as the certificate detail
  page's not-found handling), not a Next.js `notFound()` 404 page.
- Mutation failures (approve/dismiss/snooze) → toast via `sonner`, as today.
- Missing `resource`/`account` join data → context panel sections render "—" for
  unavailable fields rather than failing the whole page.

## Testing

- Vitest: new `getRecommendationDetail` service method (found / not-found / missing
  join data), and the new GET route handler (tenant scoping, 404 masking) — same
  style as existing `right-sizing-service.test.ts` / `postgres.test.ts`.
- Manual verification: run through the actual dev flow (list → detail → prev/next →
  back preserves filters → approve/dismiss/snooze updates the list) using
  `bun run dev` + the local job-runner data already in Postgres from this week's
  scans.
