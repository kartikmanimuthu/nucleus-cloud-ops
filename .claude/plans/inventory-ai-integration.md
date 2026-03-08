# Inventory AI Integration — Implementation Plan

## Context

The inventory module has a working discovery pipeline (ECS → DynamoDB + S3 + S3 Tables) but the "Ask AI" feature is broken end-to-end. The deployed TypeScript vector processor (`lambda/vector_processor/src/index.ts`) treats inventory data as generic HTML documents — extracting `title`, `slug`, `author` fields that don't exist on inventory resources. Meanwhile, a correct inventory-aware Python implementation (`vector_utils.py`) exists but is orphaned. The Ask AI API depends on S3 Vectors (preview) and uses an outdated Claude 3 Haiku model. There's no SQS buffering, no local runner for vectors, and no conversation history in the UI.

**Goal**: Fix the broken vector pipeline, add SQS reliability, make Ask AI work end-to-end with proper inventory context, and add a local runner for vector processing.

---

## Phase 1: Rewrite Vector Processor Lambda (Inventory-Aware)

**Files to modify:**
- `lambda/vector_processor/src/index.ts` — full rewrite

**Files to create:**
- `lambda/vector_processor/src/resource-text.ts` — extracted text-generation logic

**Changes:**
1. Remove cheerio dependency entirely — inventory data is structured JSON, not HTML
2. Add `createResourceText(resource)` ported from Python `vector_utils.py`:
   - `Name: {name} | Type: {resourceType} | Service: {service} | Region: {region} | Account: {accountId}`
   - Tags as `key=value` pairs
   - Metadata: flattened scalar fields from the resource's `Metadata` dict
3. Process each resource in the merged JSON array as an individual vector (not chunked file text)
4. Set proper vector metadata: `resourceId`, `resourceArn`, `resourceType`, `name`, `region`, `accountId`, `state`, `service`, `text_content`, `source_key`
5. Use Titan v2 consistently (`amazon.titan-embed-text-v2:0`, dim=1024) — matches CDK index config
6. Handle SQS event wrapper (unwrap `SQSEvent` → extract S3 event from `record.body`)
7. Add content hash (SHA-256 of text representation) to support delta processing — skip re-embedding if unchanged

---

## Phase 2: Add SQS Queue for Reliability

**Files to modify:**
- `lib/computeStack.ts` — CDK infrastructure

**Changes:**
1. Create SQS queue `${appName}-vector-processing-queue`:
   - `visibilityTimeout`: 900s (matches Lambda 15min timeout)
   - `receiveMessageWaitTimeSeconds`: 20
   - DLQ: `${appName}-vector-processing-dlq` with `maxReceiveCount: 3`
2. Change S3 event notification from `LambdaDestination(vectorProcessor)` → `SqsDestination(vectorQueue)` (keep `{ prefix: "merged/" }` filter)
3. Add SQS event source to Lambda: `batchSize: 1`, `maxConcurrency: 5`
4. Grant permissions: S3 → SQS `sendMessage`, Lambda → SQS `receiveMessage/deleteMessage`
5. Add CloudWatch alarm on DLQ depth > 0
6. Add reserved concurrency of 10 on vector processor Lambda (avoid Bedrock throttling)

---

## Phase 3: Enhance Ask AI API

**Files to modify:**
- `web-ui/app/api/ask-ai/route.ts` — major enhancement

**Changes:**
1. Upgrade generation model from Claude 3 Haiku → configurable via env var (default: `anthropic.claude-3-5-haiku-20241022-v1:0`)
2. Switch from `useCompletion`-compatible endpoint to `useChat`-compatible (return chat-format messages for multi-turn)
3. Accept optional filters in request body:
   ```ts
   { prompt: string; filters?: { accountId?: string; region?: string; resourceType?: string }; conversationId?: string }
   ```
4. Increase topK from 5 → 10, apply relevance threshold (discard vectors with distance > 0.7)
5. Add source citations — stream structured source data alongside text response using AI SDK data annotations
6. Add conversation history support — store messages in memory (or DynamoDB) keyed by `conversationId`, include last N messages for follow-ups
7. Add hybrid query routing — detect count/list/aggregate queries and route to DynamoDB inventory API for exact answers instead of vector search
8. Improve system prompt with inventory-specific instructions (cite resource names/IDs, use tables for lists, include filter context)

---

## Phase 4: Enhance Ask AI UI

**Files to modify:**
- `web-ui/components/inventory/ask-ai-dialog.tsx` — major enhancement

**Files to create:**
- `web-ui/components/inventory/ask-ai-sources.tsx` — source citation component

**Changes:**
1. Switch from `useCompletion` → `useChat` from `@ai-sdk/react` (enables multi-turn conversation)
2. Display full conversation history with alternating user/assistant bubbles
3. Add filter chips above input — Account, Region, Resource Type (pre-populated from parent grid filters, passed as props)
4. Add collapsible "Sources" section after each AI response — list resources that informed the answer, clickable to open resource detail dialog
5. Add suggested follow-up prompts after each response
6. Widen dialog: `max-w-2xl` → `max-w-3xl`, increase height
7. Add "New conversation" button to reset chat history

---

## Phase 5: Add Local Runner for Vector Processing

**Files to create:**
- `lambda/vector_processor/local_runner.py`
- `lambda/vector_processor/requirements.txt`

**Features:**
```bash
# Process from S3 bucket
python local_runner.py --bucket nucleus-inventory-xxx --prefix merged/20260308

# Process a local JSON file
python local_runner.py --file ./test-merged.json

# Dry run — show text representations without calling Bedrock
python local_runner.py --file ./test-merged.json --dry-run

# Upload vectors to S3 Vectors
python local_runner.py --bucket nucleus-inventory-xxx --prefix merged/ --upload --vector-bucket nucleus-vectors-xxx --vector-index text-embeddings
```

Implementation:
1. Port `createResourceText()` logic to Python (extend existing `vector_utils.py`)
2. S3 mode: list + process files from `merged/` prefix
3. Local file mode: process local JSON without S3
4. Dry-run mode: generate text representations only (validate quality without Bedrock cost)
5. Upload mode: generate embeddings and PUT to S3 Vectors via boto3
6. Print stats: resource count, embedding count, processing time

---

## Phase 6: CDK Infrastructure Updates

**Files to modify:**
- `lib/computeStack.ts`

**Summary of all infra changes:**
1. Add SQS queue + DLQ (Phase 2)
2. Change S3 notification target to SQS
3. Add SQS event source to Lambda
4. Update Lambda bundling — remove cheerio, keep `@aws-sdk/client-s3vectors` bundled
5. Add env var `ASK_AI_GENERATION_MODEL` to ECS task definition
6. Add `s3vectors:QueryVectors`, `s3vectors:DeleteVectors` permissions to ECS web-ui task role (for Ask AI API)
7. Add CloudWatch alarm on DLQ
8. Add Lambda reserved concurrency

---

## Gap Analysis & Industry Suggestions

### Gaps Found in Current Implementation
| # | Gap | Severity | Fix Phase |
|---|-----|----------|-----------|
| 1 | Vector processor extracts wrong fields (title/slug/author) | Critical | Phase 1 |
| 2 | No SQS buffering — lost events on failure | High | Phase 2 |
| 3 | Titan v1 vs v2 mismatch (Python uses v1, CDK uses v2 1024-dim) | High | Phase 1 |
| 4 | No local runner for vector testing | Medium | Phase 5 |
| 5 | Ask AI uses outdated Claude 3 Haiku | Medium | Phase 3 |
| 6 | No conversation history in Ask AI | Medium | Phase 3+4 |
| 7 | No source citations | Medium | Phase 3+4 |
| 8 | No embedding cleanup for decommissioned resources | Medium | Phase 1 (hash) |
| 9 | No relevance threshold — low-quality results returned | Low | Phase 3 |
| 10 | No metrics/observability on vector pipeline | Low | Enhancement |

### Industry-Standard Enhancements (Post-Core)
1. **Delta Processing**: Store content hash per resource vector; skip re-embedding if unchanged (~90% savings on typical daily runs)
2. **Stale Vector Cleanup**: When resources marked `missing`, delete their vectors
3. **Hybrid Search**: Route count/aggregate queries to DynamoDB, semantic queries to vector store
4. **Observability**: CloudWatch custom metrics (`EmbeddingsGenerated`, `VectorSearchLatencyMs`, `RAGResponseLatencyMs`), X-Ray tracing
5. **Rate Limiting**: Per-user query rate limiting on Ask AI endpoint (Bedrock cost control)
6. **Resource-Type-Aware Prompts**: Customize RAG prompt based on resource type for more precise answers

---

## Verification Plan

1. **Vector Processor**: Run local runner in dry-run mode against real merged data, validate text representations include correct fields
2. **SQS Pipeline**: Deploy CDK, trigger a manual sync, verify SQS receives message, Lambda processes it, vectors appear in S3 Vectors
3. **Ask AI E2E**: Open inventory page → click "Ask AI" → ask "How many EC2 instances are in ap-south-1?" → verify response references correct resources with citations
4. **Multi-turn**: Ask a follow-up like "Tell me more about the first one" → verify context is maintained
5. **Local Runner**: `python local_runner.py --file test.json --dry-run` → verify output format
6. **CDK Diff**: Run `npx cdk diff --profile STX-CLOUD-PLATFORM-ADMIN` before deploying to validate no unintended changes

### Test Commands
```bash
# CDK validation
npx cdk diff --profile STX-CLOUD-PLATFORM-ADMIN

# Local vector runner
cd lambda/vector_processor && python local_runner.py --file ../../test-fixtures/merged-sample.json --dry-run

# Web UI build
cd web-ui && npm run build

# Web UI lint
cd web-ui && npm run lint

# Dev server test
cd web-ui && npm run dev
# Then open http://localhost:3000/inventory → click "Ask AI"
```

---

## Critical Files Reference
| File | Role |
|------|------|
| `lambda/vector_processor/src/index.ts` | Vector processor Lambda (REWRITE) |
| `lambda/vector_processor/src/vector_utils.py` | Python reference for text generation |
| `lib/computeStack.ts` | CDK infrastructure (SQS, permissions) |
| `web-ui/app/api/ask-ai/route.ts` | Ask AI API route (ENHANCE) |
| `web-ui/components/inventory/ask-ai-dialog.tsx` | Ask AI UI (ENHANCE) |
| `web-ui/app/inventory/page.tsx` | Inventory page (pass filters to dialog) |
| `lambda/discovery/local_runner.py` | Pattern reference for local runner |
| `lambda/discovery/src/data_processor.py` | Merged file format reference |


---


Summary of Changes

  Phase 1: Vector Processor (Fixed — Critical Bug)

  - lambda/vector_processor/src/resource-text.ts (new) — createResourceText() generates proper inventory-aware text: Name | Type | Service | Region | Account | State | Tags |
   Metadata. Includes computeContentHash() for delta deduplication.
  - lambda/vector_processor/src/index.ts (rewrite) — Now SQS-aware (unwraps SQS → S3 event), processes normalized inventory resources (not generic HTML docs), stores proper
  metadata (resourceId, resourceType, region, accountId, etc.), uses Titan v2 with concurrency limit.
  - lambda/vector_processor/src/vector_utils.py — Updated to Titan v2 (amazon.titan-embed-text-v2:0) to match CDK index dimension (1024).

  Phase 2: Discovery Pipeline Fix

  - lambda/discovery/src/data_processor.py — Added _store_normalized_for_vectors() that writes clean normalized resources (no rawData) to
  normalized/{timestamp}/{accountId}.json after every DynamoDB write. This triggers the vector pipeline.

  Phase 3: SQS + CDK Infrastructure

  - lib/computeStack.ts — Added: SQS queue + DLQ (900s visibility, 3 retries), changed S3 trigger from merged/ → normalized/ prefix, SQS event source on Lambda (batchSize=1,
  maxConcurrency=5), CloudWatch alarm on DLQ depth, Lambda reserved concurrency=10, new env var ASK_AI_GENERATION_MODEL.

  Phase 4: Ask AI API

  - web-ui/app/api/ask-ai/route.ts — Upgraded to Claude 3.5 Haiku (configurable via env), useChat format for multi-turn, metadata filtering (account/region/type), relevance
  threshold (distance > 0.7 discarded), source citations via X-AI-Sources response header, conversation history via in-memory store.

  Phase 5: Ask AI UI

  - web-ui/components/inventory/ask-ai-sources.tsx (new) — Collapsible source citations panel showing which resources informed each answer.
  - web-ui/components/inventory/ask-ai-dialog.tsx (rewrite) — Multi-turn useChat, active filter badges, source citations after each response, follow-up suggestions, wider
  dialog (max-w-3xl), "New chat" button.
  - web-ui/app/inventory/page.tsx — Passes active grid filters to AskAIDialog.

  Phase 6: Local Runner

  - lambda/vector_processor/local_runner.py (new) — Supports --file, --bucket/--prefix, --dry-run, --upload, --output modes. Same pattern as lambda/discovery/local_runner.py.
  - lambda/vector_processor/requirements.txt (new).

  To Deploy

  # CDK diff first
  npx cdk diff ComputeStack --profile STX-CLOUD-PLATFORM-ADMIN

  # Deploy
  npx cdk deploy ComputeStack --profile STX-CLOUD-PLATFORM-ADMIN

  # Test vector runner locally (dry-run, no cost)
  cd lambda/vector_processor
  python local_runner.py --file sample.json --dry-run