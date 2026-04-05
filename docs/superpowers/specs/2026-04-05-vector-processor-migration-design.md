# Vector Processor Migration: Lambda → Discovery Worker (Inline)

**Date:** 2026-04-05
**Branch:** pg-boss-migration
**Status:** Approved

## Summary

Migrate the TypeScript vector processor logic from `lambda/vector_processor/` into the existing `workers` pg-boss service as an inline step inside the `discovery-scan` job. The Lambda and all its Python dead code are deleted after migration.

## Motivation

- The Lambda was triggered via SQS wrapping S3 `ObjectCreated` events on `normalized/` files — an indirect, asynchronous pipeline that adds operational complexity (SQS queue, DLQ, S3 trigger wiring).
- Discovery already runs in the workers process and writes resources to PostgreSQL. Vector embedding is a natural follow-on step per account, not a separate concern.
- Eliminating the Lambda removes one deployment artifact, one SQS queue, and one S3 trigger from the infrastructure.

## Architecture

```
discovery-scan job (pg-boss)
  └── for each account:
        ├── assumeRole()
        ├── runInventoryScan()
        ├── writeResourcesToPg()       ← existing
        └── processAccountVectors()    ← new (non-fatal, errors logged only)
```

No new queue. No new job type. Vector processing is inline per account, called after the PostgreSQL write succeeds.

## New File: `workers/src/jobs/discovery/services/vector-processor.ts`

Single public function:

```ts
processAccountVectors(
  resources: Resource[],
  accountId: string,
  tenantId: string,
): Promise<number>  // returns count of vectors upserted
```

### Internals

1. **Text generation** — `createResourceText(resource)` ported from `lambda/vector_processor/src/resource-text.ts`. Produces a human-readable pipe-delimited string for embedding.
2. **Content hash** — `computeContentHash(text)` (SHA-256 first 16 chars) for deduplication key suffix.
3. **Embedding** — Bedrock Titan Embed v2 (`amazon.titan-embed-text-v2:0`), batched at concurrency 5 to respect rate limits.
4. **Deduplication** — keys deduplicated by `${resourceId}_${contentHash}` before writing to S3 Vectors (prevents `ValidationException` on duplicate keys in a batch).
5. **S3 Vectors upsert** — batches of 20 via `PutVectorsCommand`.
6. **Stale key cleanup** — previous keys fetched from PostgreSQL (`inventory_vector_keys` table), keys no longer present in current sync deleted via `DeleteVectorsCommand` in batches of 500.
7. **Key persistence** — new keys saved to PostgreSQL via `inventoryVectorKey.upsert`. `USE_PG_INVENTORY=false` skips this (DynamoDB fallback path removed — this migration targets PG-only).

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `VECTOR_BUCKET_NAME` | S3 Vectors bucket name | required |
| `VECTOR_INDEX_NAME` | S3 Vectors index name | required |
| `BEDROCK_MODEL_ID` | Embedding model | `amazon.titan-embed-text-v2:0` |
| `USE_PG_INVENTORY` | Feature flag — enable vector key tracking in PG | `false` |

## Changes to `workers/src/jobs/discovery/index.ts`

After `writeResourcesToPg` succeeds per account:

```ts
try {
  const vectorCount = await processAccountVectors(result.resources, account.accountId, tenantId);
  console.log(`[discovery] Vectorized ${vectorCount} resources for ${account.accountId}`);
} catch (err) {
  console.error(`[discovery] Vector processing failed for ${account.accountId} (non-fatal):`, err);
}
```

Vector errors are **non-fatal** — a failure does not fail the scan job or trigger a pg-boss retry. The scan result (resources written to PG, sync status updated) is preserved. This matches the spirit of the Lambda's DLQ behavior but adapted to the worker context where failing the whole scan over a vector error is too aggressive.

## Files Changed

| Action | Path |
|--------|------|
| Create | `workers/src/jobs/discovery/services/vector-processor.ts` |
| Modify | `workers/src/jobs/discovery/index.ts` |
| Modify | `workers/.env.example` |
| Delete | `lambda/vector_processor/` (entire directory) |

## What Is NOT Migrated

- `lambda/vector_processor/src/index.py` — dead code, never deployed after TS rewrite
- `lambda/vector_processor/src/vector_utils.py` — dead code
- `lambda/vector_processor/local_runner.py` — dev utility only, deleted with the directory
- DynamoDB dual-write path (`saveVectorKeys` to DynamoDB) — this migration targets PostgreSQL; the DynamoDB fallback in the Lambda is not ported

## Testing

- Unit test `createResourceText` with a sample `Resource` object — verify pipe-delimited output
- Unit test `computeContentHash` — verify deterministic 16-char hex output
- Integration: run `discovery-scan` locally against a test account, verify vectors appear in S3 Vectors index
