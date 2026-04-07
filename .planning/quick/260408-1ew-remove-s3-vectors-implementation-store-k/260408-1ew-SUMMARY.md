---
phase: quick-260408-1ew
plan: 01
subsystem: knowledge-base
tags: [pgvector, s3-vectors-removal, kb-sync, embedding]
dependency_graph:
  requires: [prisma-schema, pgvector-extension]
  provides: [kb-document-chunks-table, pgvector-kb-search]
  affects: [workers-kb-sync, web-ui-kb-query, web-ui-kb-embedder]
tech_stack:
  added: []
  patterns: [pgvector-cosine-similarity, prisma-executeRawUnsafe, raw-pg-pool-insert]
key_files:
  created:
    - prisma/migrations/20260407194124_add_kb_document_chunks/migration.sql
  modified:
    - prisma/schema.prisma
    - workers/src/jobs/kb-sync/lib/embedding.ts
    - workers/src/jobs/kb-sync/lib/vector-store.ts
    - workers/src/jobs/kb-sync/types.ts
    - workers/src/jobs/kb-sync/handlers/file-upload.ts
    - workers/src/jobs/kb-sync/handlers/bitbucket-sync.ts
    - workers/src/jobs/kb-sync/handlers/confluence-sync.ts
    - workers/src/jobs/kb-sync/handlers/s3-sync.ts
    - web-ui/lib/knowledge-base/embedder.ts
    - web-ui/app/api/knowledge-base/query/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/upload/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts
    - web-ui/package.json
    - workers/package.json
    - workers/.env.example
  deleted:
    - lambda/kb_sync_processor/
decisions:
  - pgvector replaces S3 Vectors for all KB document chunk storage and search
  - tenantId added to BaseJob type for tenant-scoped pgvector writes
  - vector-store.ts DynamoDB dead code and USE_PG_KB flag removed (PG-only)
metrics:
  duration: 882s
  completed: "2026-04-07T19:55:04Z"
  tasks: 2
  files: 17
---

# Quick Task 260408-1ew: Remove S3 Vectors, Store KB Embeddings in pgvector Summary

KB vector storage migrated from S3 Vectors to PostgreSQL pgvector with IVFFlat cosine index, consistent with inventory module pattern.

## Commits

| # | Hash | Message |
|---|------|---------|
| 1 | 4eb0862 | feat(quick-260408-1ew): add KbDocumentChunk model and rewrite workers embedding to pgvector |
| 2 | ddd638e | feat(quick-260408-1ew): rewrite web-ui KB to pgvector, remove S3 Vectors dependency |

## What Changed

- New `KbDocumentChunk` Prisma model with `vector(1024)` embedding column and IVFFlat index (lists=100)
- Workers `embedding.ts` writes chunks via raw pg Pool INSERT with `ON CONFLICT` upsert
- Web-ui `embedder.ts` stores/deletes via Prisma `$executeRawUnsafe`
- Web-ui query route uses `1 - (embedding <=> $1::vector)` cosine similarity
- `tenantId` added to job payloads (BaseJob type + all senders)
- `vector-store.ts` cleaned: DynamoDB imports, helpers, dual-write wrappers, `USE_PG_KB` flag all removed
- `@aws-sdk/client-s3vectors` removed from both `workers/package.json` and `web-ui/package.json`
- `KB_VECTOR_BUCKET_NAME`, `KB_VECTOR_INDEX_NAME`, `KB_VECTOR_REGION` removed from `.env.example`
- Legacy `lambda/kb_sync_processor/` deleted (superseded by workers kb-sync job)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tenantId not in job payloads**
- Found during: Task 1
- Issue: Job senders (upload route, sync route) did not include tenantId in pg-boss payload
- Fix: Added tenantId to BaseJob type and updated both sender routes
- Files modified: workers/src/jobs/kb-sync/types.ts, web-ui/app/api/knowledge-base/[kbId]/upload/route.ts, web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts

## Known Stubs

None.

## Self-Check: PASSED

- All created/modified files verified on disk
- Commits 4eb0862 and ddd638e verified in git log
- lambda/kb_sync_processor source files deleted from git (build artifact lambda.zip remains untracked)
