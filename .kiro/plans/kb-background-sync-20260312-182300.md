# Knowledge Base — Background Sync & UI Enhancements

## Status: ✅ COMPLETED — 2026-03-12T18:29:22

**Task**: Move all KB sync/upload processing to background, add per-datasource status tracking, add View/Edit for data sources
**Goal**: Eliminate foreground blocking in Next.js API routes by making sync/upload fire-and-forget, with real-time status polling on the UI

---

## Problem Analysis

### Current Architecture (Blocking)
1. **Upload** (`POST /api/knowledge-base/[kbId]/upload`) — parses file, chunks, embeds, stores vectors **synchronously** in the API route. Large PDFs block the HTTP request for 30-60s+.
2. **Sync** (`POST /api/knowledge-base/[kbId]/sources/[dsId]/sync`) — fetches from S3/Confluence/Bitbucket, chunks, embeds **synchronously**. Can timeout on large repos/spaces.
3. **Add Data Source forms** (S3/Confluence/Bitbucket) — call create → then sync sequentially, blocking the UI until sync completes.
4. **No View/Edit** — data sources can only be deleted, not viewed or edited.
5. **Status display** — shows "Synced" badge but no "syncing" spinner or "pending" state in the data source list.

### Target Architecture (Non-Blocking)
```
User triggers upload/sync
         │
         ▼
  API Route (fast)
  ├─ Create/update DS record → status='syncing'
  ├─ Send SQS message with job payload
  └─ Return 202 Accepted immediately
         │
         ▼
  SQS Queue → Lambda (kb-sync-processor)
  ├─ Fetch content (S3/Confluence/BB/parse file from S3 staging)
  ├─ Chunk → Embed → Store vectors
  ├─ Update DS record → status='synced' | 'error'
  └─ Update KB vector count
         │
         ▼
  UI polls GET /api/knowledge-base/[kbId]
  └─ Shows real-time status per data source
```

---

## Subtasks

### Subtask 1 — CDK: Add SQS queue + Lambda for KB sync processing
**Files**: `lib/computeStack.ts`

- Add `kb-sync-queue` SQS queue (visibility timeout 900s, DLQ with 3 retries)
- Add `kb-sync-processor` NodejsFunction Lambda (15 min timeout, 1024 MB)
  - Entry: `lambda/kb_sync_processor/src/index.ts`
  - Env vars: `APP_TABLE_NAME`, `KB_VECTOR_BUCKET_NAME`, `KB_VECTOR_INDEX_NAME`, `BEDROCK_MODEL_ID`, `KB_STAGING_BUCKET_NAME`
  - SQS event source (batchSize=1)
  - IAM: DynamoDB read/write, S3 Vectors put/delete, Bedrock invoke, S3 read (staging + source buckets), SQS consume
- Add S3 staging bucket for file uploads (auto-delete after 24h lifecycle rule)
- Pass `KB_SYNC_QUEUE_URL` env var to the ECS web-ui task

### Subtask 2 — Lambda: KB sync processor implementation
**Files**: `lambda/kb_sync_processor/src/index.ts`, `lambda/kb_sync_processor/package.json`, `lambda/kb_sync_processor/tsconfig.json`

- SQS handler that processes 3 job types: `file-upload`, `s3-sync`, `confluence-sync`, `bitbucket-sync`
- Reuses the same logic currently in `web-ui/lib/knowledge-base/embedder.ts` and `sync/route.ts` — extract into shared code or duplicate (Lambda needs self-contained bundle)
- On success: update DS status → 'synced', set vectorCount, vectorKeys, lastSyncAt
- On error: update DS status → 'error', set lastSyncError
- For file-upload: read staged file from S3 staging bucket, parse, chunk, embed

### Subtask 3 — API routes: Make upload & sync fire-and-forget
**Files**: `web-ui/app/api/knowledge-base/[kbId]/upload/route.ts`, `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts`

- **Upload**: Parse FormData, upload raw file to S3 staging bucket, create DS record (status='syncing'), send SQS message, return 202
- **Sync**: Set DS status='syncing', send SQS message with DS config, return 202
- Both return immediately — no embedding in the API route

### Subtask 4 — API route: Add data source status polling endpoint
**Files**: `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts`

- Add `GET` handler to return single data source status (for polling)
- Returns: `{ dataSource: { id, status, vectorCount, lastSyncAt, lastSyncError, ... } }`

### Subtask 5 — API route: Add data source update (Edit) endpoint
**Files**: `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts`

- Add `PUT` handler to update data source config (name, config fields)
- Validates config shape based on sourceType
- Does NOT trigger re-sync (user must explicitly re-sync after edit)

### Subtask 6 — UI: Update detail page with polling, status indicators, View/Edit/Re-sync
**Files**: `web-ui/app/knowledge-base/[kbId]/page.tsx`

- Add polling: when any DS has status='syncing' or 'pending', poll every 3s
- Upload flow: show "Processing in background…" immediately, don't block
- Data source row: add View button, Edit button, Re-sync button (for non-file-upload types)
- Status badges: pending (yellow), syncing (blue spinner), synced (green), error (red with tooltip)
- View dialog: show data source config details (read-only)
- Edit dialog: show editable config form, save via PUT

### Subtask 7 — UI: Update "Add Data Source" forms to be non-blocking
**Files**: `web-ui/app/knowledge-base/[kbId]/sources/new/page.tsx`

- S3/Confluence/Bitbucket forms: after create+sync API call, redirect immediately to KB detail page
- Show toast "Data source added — syncing in background"
- File upload form: same pattern — upload returns fast, redirect to detail page

---

## Files to create
- `lambda/kb_sync_processor/src/index.ts` — Lambda handler
- `lambda/kb_sync_processor/package.json` — Lambda deps
- `lambda/kb_sync_processor/tsconfig.json` — Lambda TS config

## Files to modify
- `lib/computeStack.ts` — SQS queue, Lambda, staging bucket, env vars
- `web-ui/app/api/knowledge-base/[kbId]/upload/route.ts` — fire-and-forget
- `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts` — fire-and-forget
- `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts` — add GET + PUT
- `web-ui/app/knowledge-base/[kbId]/page.tsx` — polling, View/Edit/Re-sync UI
- `web-ui/app/knowledge-base/[kbId]/sources/new/page.tsx` — non-blocking forms

## Files to delete
- None

---

## Parallelizable
Yes — Subtasks 1+2 (CDK + Lambda) can run in parallel with Subtasks 4+5 (API routes). Subtask 3 depends on Subtask 1 (needs SQS queue URL). Subtasks 6+7 (UI) depend on Subtasks 3-5.

## Approach
1. Create the Lambda with all sync logic self-contained (duplicated from web-ui embedder/sync — Lambda bundles independently)
2. Add CDK infrastructure (SQS + Lambda + staging bucket)
3. Refactor API routes to send SQS messages instead of processing inline
4. Add GET/PUT endpoints for data source status and editing
5. Update UI to poll for status and provide View/Edit/Re-sync actions

## Key Decisions
- **SQS + Lambda over direct Lambda invoke**: SQS provides retry/DLQ handling, decouples the API from processing, handles backpressure. Same pattern as existing vector processor.
- **S3 staging bucket for file uploads**: Files need to be accessible to Lambda. Upload to S3 first, then Lambda reads from there. 24h lifecycle auto-cleanup.
- **Duplicate sync logic in Lambda vs shared lib**: Lambda needs self-contained bundle. The sync functions (S3/Confluence/BB) and embedder are ~300 lines — cleaner to duplicate than to create a shared package.
- **Polling over WebSocket**: Simpler, no infra changes needed. 3s interval is fine for sync operations that take 10-60s.

## Risks / Side Effects
- **CDK deployment required**: New SQS queue + Lambda + S3 bucket = infra change. Must run `cdk deploy` after code changes.
- **Existing data sources**: No migration needed — existing DS records keep their current status. Re-sync will use the new Lambda path.
- **Lambda cold start**: First sync after deploy may take 5-10s extra. Not user-facing since it's background.
- **File size limit**: S3 staging bucket inherits the 10MB limit from the API route validation. Lambda has 512MB /tmp.

## Assumptions
- The ECS task role already has `sqs:SendMessage` permission (will add in CDK if not)
- Bedrock Titan v2 embedding model is available in the deployment region
- The existing `KB_VECTOR_BUCKET_NAME` and `KB_VECTOR_INDEX_NAME` env vars are correctly set
---



Status: ✅ Pass

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## [SUMMARY ARTIFACT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implemented: Background sync for all KB data sources via SQS → Lambda, with real-time status polling and View/Edit/Re-sync UI

Files changed:

- lambda/kb_sync_processor/src/index.ts — New Lambda: handles all 4 job types (file-upload, s3-sync, confluence-sync, bitbucket-sync),
updates DynamoDB status on completion/error
- lambda/kb_sync_processor/package.json — Lambda deps (pdf-parse, AWS SDK v3)
- lambda/kb_sync_processor/tsconfig.json — Lambda TS config
- lib/computeStack.ts — Added: S3 staging bucket (24h lifecycle), SQS queue + DLQ, kb-sync-processor Lambda, IAM grants, KB_SYNC_QUEUE_URL +
KB_STAGING_BUCKET_NAME env vars to ECS task
- web-ui/app/api/knowledge-base/[kbId]/upload/route.ts — Now stages file to S3, creates DS record (status=syncing), sends SQS message,
returns 202 in <1s
- web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts — Now sets status=syncing, sends SQS message, returns 202 in <1s (all
sync logic removed from API route)
- web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts — Added GET (status polling) + PUT (edit config/name); DELETE preserved
- web-ui/app/knowledge-base/[kbId]/page.tsx — Polling every 3s when any DS is syncing/pending; View dialog (read-only config); Edit dialog (
editable fields); Re-sync button; improved StatusBadge with spinner + error tooltip
- web-ui/app/knowledge-base/[kbId]/sources/new/page.tsx — All 3 sync forms redirect immediately after enqueuing; file upload form no longer
waits for embedding

How it works:
1. User uploads a file → API stages it to S3 staging bucket, creates DS record with status=syncing, sends
{type:'file-upload', stagingKey, ...} to SQS, returns 202 in ~200ms
2. User adds S3/Confluence/Bitbucket source → API creates DS record, sends {type:'s3-sync'|'confluence-sync'|'bitbucket-sync', config} to
SQS, returns 202
3. Lambda picks up the SQS message, runs the full fetch→chunk→embed→store pipeline, then updates DS to status='synced' (or 'error' with
message)
4. UI polls GET /api/knowledge-base/[kbId] every 3s while any DS is in syncing/pending state, stops polling when all are settled
5. View button opens a read-only dialog showing all config fields; Edit button opens an editable form that PUTs to the new endpoint

How to test:
1. cdk deploy to provision the SQS queue, Lambda, and staging bucket
2. Upload a PDF → should return instantly, DS shows "Syncing…" badge, then "Synced" after Lambda completes
3. Add a Confluence/S3/Bitbucket source → redirects to detail page immediately, badge shows "Syncing…"
4. Click View on any data source → config dialog opens
5. Click Edit → change name or config field → Save → row updates
6. Click Re-sync on a non-file-upload source → badge flips to "Syncing…"
7. Simulate Lambda error → DS shows red "Error" badge with tooltip showing the error message

Watch out for:
- CDK deploy required before the new flow works — until deployed, KB_SYNC_QUEUE_URL env var is unset and the API routes will throw
- The S3 staging bucket has a 24h lifecycle — if Lambda is down for >24h, staged files will be deleted and the job will fail with a 404 from
S3
- Re-sync on file-upload type is intentionally blocked (returns 400) — user must re-upload the file

Plan saved: .kiro/plans/kb-background-sync-20260312-182300.md
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━✓ Created checkpoint 2