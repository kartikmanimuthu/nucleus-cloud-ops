# Vector Processor — Local Runbook

Generates Bedrock Titan v2 embeddings from normalized inventory files and writes them to either **PostgreSQL** (pgvector) or **S3 Vectors**.

Pipeline:
```
Discovery ECS → S3 (normalized/) → SQS → Vector Processor Lambda → PostgreSQL (embedding column)
                                                                   → S3 Vectors (legacy)
```

---

## Prerequisites

- Docker running with `nucleus-postgres` container (`docker compose up -d`)
- AWS SSO logged in: `aws sso login --profile PLATFORM-ADMIN`
- Python deps installed: `pip install -r requirements.txt`
- Bedrock access in `ap-south-1` (Titan v2 model: `amazon.titan-embed-text-v2:0`)

---

## Option A — PostgreSQL backfill (recommended)

Reads all `inventory_resources` rows with `NULL` embedding, generates embeddings via Bedrock, and writes them back to the `embedding` + `contentHash` columns.

### Dry run (no Bedrock calls, no DB writes)

```bash
DATABASE_URL="postgresql://nucleus:nucleus_dev@localhost:5432/nucleus" \
AWS_REGION=ap-south-1 \
AWS_PROFILE=PLATFORM-ADMIN \
DRY_RUN=true \
  npx tsx scripts/backfill-embeddings.ts
```

### Live backfill

```bash
DATABASE_URL="postgresql://nucleus:nucleus_dev@localhost:5432/nucleus" \
AWS_REGION=ap-south-1 \
AWS_PROFILE=PLATFORM-ADMIN \
BATCH_SIZE=100 \
CONCURRENCY=5 \
  npx tsx scripts/backfill-embeddings.ts
```

### Options

| Env var | Default | Description |
|---------|---------|-------------|
| `BATCH_SIZE` | `100` | Rows fetched per DB page |
| `CONCURRENCY` | `5` | Parallel Bedrock calls per batch |
| `DRY_RUN` | `false` | Skip Bedrock + DB writes, just count rows |
| `TENANT_ID` | _(all)_ | Only backfill a specific tenant |

The script uses cursor-based pagination (`WHERE id > $lastId`) so it's safe to interrupt and re-run — already-embedded rows are skipped automatically.

---

## Option B — S3 Vectors via local_runner.py

Use this to test the S3 Vectors write path or to process a local JSON file.

### Install Python dependencies

```bash
cd lambda/vector_processor
pip install -r requirements.txt
```

### Dry run on a local file (no Bedrock calls)

```bash
cd lambda/vector_processor
AWS_PROFILE=PLATFORM-ADMIN \
  python local_runner.py --file ./sample.json --dry-run --verbose
```

### Generate embeddings from a local file (no upload)

```bash
cd lambda/vector_processor
AWS_PROFILE=PLATFORM-ADMIN AWS_REGION=ap-south-1 \
  python local_runner.py --file ./sample.json \
    --output ./sample-vectors.json
```

### Generate embeddings and upload to S3 Vectors

```bash
cd lambda/vector_processor
AWS_PROFILE=PLATFORM-ADMIN AWS_REGION=ap-south-1 \
  python local_runner.py --file ./sample.json \
    --upload \
    --vector-bucket nucleus-app-vectors-970547372609-ap-south-1 \
    --vector-index text-embeddings
```

### Process normalized files directly from S3

```bash
cd lambda/vector_processor
AWS_PROFILE=PLATFORM-ADMIN AWS_REGION=ap-south-1 \
  python local_runner.py \
    --bucket nucleus-app-inventory-970547372609-ap-south-1 \
    --prefix normalized/ \
    --upload \
    --vector-bucket nucleus-app-vectors-970547372609-ap-south-1 \
    --vector-index text-embeddings
```

---

## Verify embeddings in PostgreSQL

```bash
# Coverage — how many rows have embeddings
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
SELECT
  COUNT(*) as total,
  COUNT(embedding) as with_embedding,
  COUNT(*) - COUNT(embedding) as missing
FROM inventory_resources;
"

# Breakdown by resource type
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
SELECT
  \"resourceType\",
  COUNT(*) as total,
  COUNT(embedding) as embedded
FROM inventory_resources
GROUP BY \"resourceType\"
ORDER BY total DESC;
"

# Sample a vector (first 5 dimensions)
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
SELECT \"resourceId\", \"resourceType\",
       (embedding::text)::varchar(80) as embedding_preview
FROM inventory_resources
WHERE embedding IS NOT NULL
LIMIT 3;
"
```

---

## Test Ask AI semantic search locally

Once embeddings are populated, test the pgvector search directly:

```bash
# Start the dev server first (in a separate terminal)
cd web-ui && npm run dev

# Then ask a question via curl
curl -s -X POST http://localhost:3000/api/ask-ai \
  -H "Content-Type: application/json" \
  -d '{"prompt": "How many EC2 instances are running?", "id": "test-1"}' \
  | head -c 500
```

---

## Directory structure

```
vector_processor/
├── src/
│   ├── index.ts          # Lambda handler (SQS → S3 → Bedrock → S3 Vectors / PG)
│   ├── resource-text.ts  # createResourceText() — text representation for embedding
│   └── vector_utils.py   # Python equivalent of resource-text.ts (used by local_runner.py)
├── local_runner.py       # Python local runner → S3 Vectors path
├── sample.json           # Sample normalized inventory file for testing
├── requirements.txt      # Python deps (boto3)
└── LOCAL_DEV.md          # This file
```

The TypeScript Lambda (`src/index.ts`) is the production path. The Python `local_runner.py` is for ad-hoc S3 Vectors testing. For PostgreSQL embedding backfill, use `scripts/backfill-embeddings.ts` at the repo root.

---

## Notes

- `CONCURRENCY=5` is safe for Bedrock Titan v2 — higher values may hit throttling
- The backfill script is idempotent: rows with existing embeddings are never re-processed
- `contentHash` stores a SHA-256 prefix of the resource text — used by the Lambda to skip re-embedding unchanged resources on future syncs
- Embeddings are 1024-dimensional (Titan v2) — matches the `vector(1024)` column and the ivfflat index on `inventory_resources`
