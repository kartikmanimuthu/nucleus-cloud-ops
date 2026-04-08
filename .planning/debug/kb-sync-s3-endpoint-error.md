---
status: awaiting_human_verify
trigger: "KB sync worker fails with S3 region/endpoint mismatch when processing file-upload jobs for knowledge base data sources."
created: 2026-04-08T00:00:00Z
updated: 2026-04-08T00:00:00Z
---

## Current Focus

hypothesis: S3 client in file-upload.ts uses AWS_REGION=ap-south-1 but the staging bucket lives in us-east-1
test: Compare AWS_REGION in workers/.env vs region suffix in KB_STAGING_BUCKET_NAME
expecting: Mismatch confirmed → fix by introducing KB_STAGING_BUCKET_REGION env var
next_action: Apply fix to file-upload.ts, workers/.env, workers/.env.example

## Symptoms

expected: File uploads to knowledge base should be processed by the kb-sync worker, stored in S3, chunked, embedded, and stored as vectors in PostgreSQL (pgvector).
actual: Job fails immediately with S3 error on every retry attempt.
errors: "The bucket you are attempting to access must be addressed using the specified endpoint. Please send all future requests to this endpoint."
reproduction: Upload any file as a data source to a knowledge base via the UI.
started: Current state on pg-boss-migration branch after kb-sync worker was migrated to pg-boss.

## Eliminated

(none — root cause confirmed on first hypothesis)

## Evidence

- timestamp: 2026-04-08T00:00:00Z
  checked: workers/.env
  found: AWS_REGION="ap-south-1", KB_STAGING_BUCKET_NAME="nucleus-cloud-ops-kb-staging-970547372609-us-east-1"
  implication: Bucket name encodes its region (us-east-1). Worker's general AWS_REGION is ap-south-1 — a different region.

- timestamp: 2026-04-08T00:00:00Z
  checked: workers/src/jobs/kb-sync/handlers/file-upload.ts line 11-12
  found: const region = process.env.AWS_REGION || 'ap-south-1'; const s3 = new S3Client({ region });
  implication: S3 client is built with ap-south-1. GetObjectCommand on a us-east-1 bucket → S3 returns PermanentRedirect / endpoint mismatch error.

- timestamp: 2026-04-08T00:00:00Z
  checked: web-ui/app/api/knowledge-base/[kbId]/upload/route.ts line 14
  found: const s3 = new S3Client({ region: process.env.AWS_REGION }); — web-ui AWS_REGION is presumably us-east-1
  implication: Upload succeeds (correct region). Worker reads with wrong region → fails. Classic producer/consumer region split.

- timestamp: 2026-04-08T00:00:00Z
  checked: workers/src/jobs/kb-sync/handlers/s3-sync.ts
  found: Uses job.config.region || region — region comes from user-supplied job config, not the staging bucket
  implication: s3-sync is unaffected. Only file-upload.ts uses the staging bucket and is broken.

## Resolution

root_cause: file-upload.ts creates its S3 client using AWS_REGION (ap-south-1) but the KB staging bucket (nucleus-cloud-ops-kb-staging-970547372609-us-east-1) lives in us-east-1. S3 rejects the GetObjectCommand with a PermanentRedirect / endpoint mismatch error on every job attempt.
fix: Introduce KB_STAGING_BUCKET_REGION env var. file-upload.ts reads this var for its S3 client, falling back to AWS_REGION. Set KB_STAGING_BUCKET_REGION=us-east-1 in workers/.env and document it in workers/.env.example.
verification:
files_changed:
  - workers/src/jobs/kb-sync/handlers/file-upload.ts
  - workers/.env
  - workers/.env.example
