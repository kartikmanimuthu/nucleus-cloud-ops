# Inventory Discovery Module — Bugs & Feature Enhancements

## Context

The inventory discovery module scans AWS resources across multi-account setups using an ECS Fargate task (Python), stores results in DynamoDB + S3, and presents them via a Next.js frontend. After thorough exploration, I've identified **critical bugs**, **performance issues**, and **high-value feature enhancements** organized by priority.

---

## P0 — Critical Bugs (Fix Now)

### 1. Status endpoint full table scan (causes timeout at scale)
- **File**: `web-ui/app/api/inventory/status/route.ts` (lines 124-142)
- **Bug**: Fetches ALL inventory items via GSI1 just to count unique accountIds — O(n) complexity
- **Impact**: Will timeout with >100k resources
- **Fix**: Use account sync metadata already in APP_TABLE (count from ACCOUNT records) instead of scanning inventory table

### 2. Pagination cursor not reset on filter/page-size changes
- **File**: `web-ui/app/inventory/page.tsx` (lines 117, 241-246, 588)
- **Bug**: When user changes filters (type, region, account, search) or page size, the DynamoDB cursor is not reset — fetches page N of NEW filters using OLD cursor
- **Impact**: Inconsistent/missing results after filter changes
- **Fix**: Reset `cursor` to `undefined` whenever filters or pageSize change

### 3. "First Page" button doesn't reset cursor
- **File**: `web-ui/app/inventory/page.tsx` (line 605)
- **Bug**: `onClick={() => fetchResources()}` doesn't clear cursor state before fetching
- **Fix**: `setCursor(undefined)` before calling `fetchResources()`

### 4. Export loads all data into memory (OOM risk)
- **File**: `web-ui/app/api/inventory/export/route.ts` (lines 89-129)
- **Bug**: Accumulates all matching resources into `const resources: any[]` — no streaming
- **Impact**: OOM for large exports (>100k resources)
- **Fix**: Stream rows to Excel/CSV writer incrementally, or cap export with warning

### 5. Export button stuck disabled on failure
- **File**: `web-ui/app/inventory/page.tsx` (line 307)
- **Bug**: If export fails, `exporting` state stays `true` — button disabled forever
- **Fix**: Reset `exporting = false` in catch block

### 6. Lambda exit code always 0 (masks failures)
- **File**: `lambda/discovery/src/main.py` (lines 304-313)
- **Bug**: Exits with code 0 even when accounts fail — ECS monitoring can't detect partial failures
- **Fix**: Exit code 1 if `failed_accounts > 0`

---

## P1 — High Priority Issues

### 7. Missing sync progress tracking
- **Files**: `web-ui/app/api/inventory/sync/route.ts`, `lambda/discovery/src/main.py`
- **Issue**: User triggers sync → gets "started" toast → no progress feedback until manual refresh
- **Enhancement**: Add scan progress records to DynamoDB (% complete, current account/region), poll from frontend

### 8. Stale "missing" resource status (no recovery)
- **File**: `lambda/discovery/src/data_processor.py` (lines 512-578)
- **Issue**: Once marked "missing", resources stay missing even if the scan that caused it had errors
- **Fix**: Add `lastMarkedMissingAt` timestamp; only mark missing if resource absent for N consecutive scans

### 9. AWS Console URL only supports ~6 resource types
- **File**: `web-ui/components/inventory/resource-detail-dialog.tsx` (lines 36-56)
- **Issue**: "Open in AWS" button disabled for Lambda, S3, API Gateway, ECR, SNS, SQS, VPC, etc.
- **Fix**: Expand URL mapping to cover all 20+ discovered resource types

### 10. Service/resource type mappings duplicated & inconsistent
- **Files**: `page.tsx` (15 mappings), `resource-detail-dialog.tsx` (6), `export/route.ts` (6)
- **Fix**: Create single shared mapping in `web-ui/lib/resource-types.ts`

### 11. No "Clear All Filters" button
- **File**: `web-ui/app/inventory/page.tsx`
- **Enhancement**: Add reset button to clear search, type, region, account filters in one click

### 12. Region & resource type filters hardcoded
- **File**: `web-ui/app/inventory/page.tsx` (lines 59-85)
- **Issue**: Only 6 regions, ~15 resource types hardcoded — goes stale when new types/regions added
- **Fix**: Fetch distinct values from backend, or derive from discovered data

### 13. Missing resource types in discovery Lambda
- **File**: `lambda/discovery/src/inventory_runner.py`
- **Issue**: No support for Glue, Kinesis, SNS, SQS, Step Functions, Redshift, ElastiCache
- **Enhancement**: Add handlers for commonly-used AWS services

---

## P2 — Medium Priority Improvements

### 14. Ask AI error state — no retry button
- **File**: `web-ui/components/inventory/ask-ai-dialog.tsx` (lines 68-71)
- **Fix**: Add "Retry" button in error state

### 15. Ask AI doesn't show user messages in chat
- **File**: `web-ui/components/inventory/ask-ai-dialog.tsx`
- **Fix**: Display both user question and AI response for conversation context

### 16. Silent metadata JSON parse failures
- **File**: `web-ui/app/api/inventory/resources/route.ts` (lines 186-195)
- **Fix**: Log parse errors; set error flag on resource

### 17. S3 key collision risk in exports
- **File**: `lambda/discovery/src/data_processor.py` (lines 147-148)
- **Fix**: Add UUID to export filename: `exports/inventory-{timestamp}-{uuid}.xlsx`

### 18. Tags display — no way to see all tags
- **File**: `web-ui/app/inventory/page.tsx` (lines 556-564)
- **Issue**: Shows first 5 tags with "+N more" tooltip but detail dialog doesn't expand them well
- **Fix**: Improve tags tab in detail dialog with search/filter

### 19. Incomplete metadata extraction
- **File**: `lambda/discovery/src/data_processor.py` (lines 39-153)
- **Issue**: EC2 missing AvailabilityZone/CPU/Memory; RDS missing BackupRetention/PerformanceInsights
- **Fix**: Expand per-resource metadata extraction

### 20. No CloudWatch alarms or monitoring
- **File**: `lib/computeStack.ts`
- **Missing**: No alarms for task failure, scan timeout, DynamoDB throttling
- **Enhancement**: Add CloudWatch alarms + SNS notifications for discovery failures

### 21. Overly permissive S3 Tables IAM
- **File**: `lib/computeStack.ts`
- **Issue**: `s3tables:*` on `resources: ['*']` — should be scoped to specific table bucket ARN

### 22. Missing audit table permissions for discovery task
- **File**: `lib/computeStack.ts`
- **Bug**: Discovery task writes to audit table but no IAM permission granted

---

## P3 — Nice-to-Have Feature Enhancements

| # | Enhancement | Description |
|---|------------|-------------|
| 23 | Resource change history | Track add/remove/modify per scan — "what changed?" view |
| 24 | Tag-based filtering | GSI or composite key for `tag:Key=Value` queries |
| 25 | Resource relationships | Link EC2 → VPC → Subnet → Security Group |
| 26 | Cost estimation | Integrate AWS Cost Explorer data per resource |
| 27 | Compliance checks | Detect untagged resources, policy violations |
| 28 | Bulk actions | Select multiple resources for export/analysis |
| 29 | Column customization | Let users show/hide/reorder table columns |
| 30 | Advanced search syntax | Support `tag:Env=Prod`, `region:us-east-1`, `status:running` |
| 31 | Incremental sync | Delta detection instead of full re-scan every time |
| 32 | Resource grouping | Group by tag, account, or region in the UI |
| 33 | Export formats | Add JSON, Parquet alongside Excel/CSV |
| 34 | TTL for missing resources | Auto-archive resources missing for >30 days |

---

## Recommended Implementation Order

**Phase 1 — Bug Fixes (P0):** Items 1-6
**Phase 2 — High Priority (P1):** Items 7-13
**Phase 3 — Medium (P2):** Items 14-22
**Phase 4 — Enhancements (P3):** Items 23-34

---

## Key Files

| File | Role |
|------|------|
| `web-ui/app/inventory/page.tsx` | Inventory page (642 lines) |
| `web-ui/components/inventory/resource-detail-dialog.tsx` | Resource detail modal |
| `web-ui/components/inventory/ask-ai-dialog.tsx` | AI Q&A dialog |
| `web-ui/app/api/inventory/resources/route.ts` | List resources API |
| `web-ui/app/api/inventory/status/route.ts` | Sync status API |
| `web-ui/app/api/inventory/sync/route.ts` | Trigger sync API |
| `web-ui/app/api/inventory/export/route.ts` | Export API |
| `lambda/discovery/src/main.py` | Discovery orchestrator |
| `lambda/discovery/src/inventory_runner.py` | Parallel AWS scanner (1137 lines) |
| `lambda/discovery/src/data_processor.py` | DynamoDB/S3 storage (589 lines) |
| `lambda/discovery/src/config_generator.py` | Scan config generation |
| `lib/computeStack.ts` | CDK infrastructure |
| `docs/schema-design.md` | DynamoDB schema reference |

## Verification

- Run `cd web-ui && npm run build` to verify no TypeScript errors
- Run `cd web-ui && npm run lint` to check linting
- Run `cd web-ui && npm run test` to run Vitest suite
- Manual test: Start dev server, navigate to /inventory, test filter changes + pagination
- Manual test: Trigger sync, verify progress feedback
- Manual test: Export with various filters, verify file download
