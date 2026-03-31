---
phase: quick
plan: 260331-ocp
type: execute
wave: 1
depends_on: []
files_modified:
  - prisma/schema.prisma
  - prisma/migrations/YYYYMMDD_add_inventory_embedding/migration.sql
  - web-ui/lib/db/repositories/inventory/interface.ts
  - web-ui/lib/db/repositories/inventory/postgres.ts
  - web-ui/lib/db/repositories/inventory/dynamo.ts
  - web-ui/app/api/ask-ai/route.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "Ask AI semantic search queries return relevant inventory resources from PostgreSQL pgvector"
    - "Ask AI exhaustive queries (list all X) return complete results from PostgreSQL listResources"
    - "No DynamoDB or S3 Vectors clients remain in ask-ai route"
  artifacts:
    - path: "prisma/schema.prisma"
      provides: "embedding + contentHash columns on InventoryResource"
      contains: "Unsupported(\"vector(1024)\")"
    - path: "web-ui/lib/db/repositories/inventory/interface.ts"
      provides: "searchByVector method on IInventoryRepository"
      contains: "searchByVector"
    - path: "web-ui/lib/db/repositories/inventory/postgres.ts"
      provides: "pgvector cosine distance search implementation"
      contains: "$queryRawUnsafe"
    - path: "web-ui/app/api/ask-ai/route.ts"
      provides: "Rewritten route using PostgreSQL repository"
      exports: ["POST"]
  key_links:
    - from: "web-ui/app/api/ask-ai/route.ts"
      to: "web-ui/lib/db/repositories/inventory/postgres.ts"
      via: "getInventoryRepository() from repository-factory"
      pattern: "getInventoryRepository"
    - from: "web-ui/app/api/ask-ai/route.ts"
      to: "BedrockRuntimeClient"
      via: "getEmbedding() for vector queries"
      pattern: "getEmbedding"
---

<objective>
Migrate the Ask AI API route from S3 Vectors + DynamoDB to PostgreSQL pgvector.

Purpose: The ask-ai route currently queries DynamoDB inventory table (returns 0 results since data migrated to PG) and S3 Vectors (stale/empty). This rewires both query paths to use the existing PostgreSQL inventory data with pgvector for semantic search.

Output: Working ask-ai route backed entirely by PostgreSQL — exhaustive queries use `listResources()`, semantic queries use new `searchByVector()` with pgvector cosine distance.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md

@prisma/schema.prisma (InventoryResource model at line 250, AgentMemory pgvector pattern at line 415)
@web-ui/lib/db/repositories/inventory/interface.ts
@web-ui/lib/db/repositories/inventory/postgres.ts
@web-ui/lib/db/repositories/inventory/dynamo.ts
@web-ui/lib/db/repository-factory.ts (getInventoryRepository at line 218)
@web-ui/app/api/ask-ai/route.ts

<interfaces>
From web-ui/lib/db/repositories/inventory/interface.ts:
```typescript
export interface IInventoryRepository {
    listResources(filters: InventoryFilters): Promise<InventoryPage>;
    getResource(tenantId, accountId, resourceType, resourceId): Promise<InventoryResource | null>;
    upsertResource(resource): Promise<InventoryResource>;
    upsertBatch(resources): Promise<number>;
    getResourceCounts(tenantId): Promise<ResourceCount[]>;
    deleteResourcesByAccount(tenantId, accountId): Promise<number>;
}
```

From web-ui/lib/db/repository-factory.ts:
```typescript
export function getInventoryRepository(): IInventoryRepository;
// Controlled by USE_PG_INVENTORY env var
```

Existing pgvector pattern (AgentMemory in schema.prisma):
```prisma
embedding     Unsupported("vector(1024)")?
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add embedding column to InventoryResource + searchByVector to repository layer</name>
  <files>
    prisma/schema.prisma,
    web-ui/lib/db/repositories/inventory/interface.ts,
    web-ui/lib/db/repositories/inventory/postgres.ts,
    web-ui/lib/db/repositories/inventory/dynamo.ts
  </files>
  <action>
1. In `prisma/schema.prisma`, add two columns to the `InventoryResource` model (after `updatedAt`):
   - `embedding Unsupported("vector(1024)")?` — same pattern as AgentMemory
   - `contentHash String?` — for dedup during re-embedding

2. Generate a Prisma migration using `prisma migrate diff` workflow (same as Phase 03 decision — no interactive TTY):
   - `npx prisma migrate diff --from-migrations-directory prisma/migrations --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/YYYYMMDD_add_inventory_embedding/migration.sql`
   - The migration SQL should include: `ALTER TABLE inventory_resources ADD COLUMN embedding vector(1024), ADD COLUMN "contentHash" TEXT;`
   - Add an ivfflat index: `CREATE INDEX idx_inventory_resources_embedding ON inventory_resources USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`
   - Run `npx prisma migrate deploy` to apply

3. In `web-ui/lib/db/repositories/inventory/interface.ts`:
   - Add `VectorSearchResult` interface: `{ resource: InventoryResource; distance: number }`
   - Add `searchByVector(tenantId: string, embedding: number[], topK?: number, filters?: { accountId?: string; region?: string }): Promise<VectorSearchResult[]>` to `IInventoryRepository`

4. In `web-ui/lib/db/repositories/inventory/postgres.ts`:
   - Implement `searchByVector` using `getPrismaClient().$queryRawUnsafe()`:
     ```sql
     SELECT *, embedding <=> $1::vector AS distance
     FROM inventory_resources
     WHERE tenant_id = $2
       [AND account_id = $3 if filter]
       [AND region = $4 if filter]
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $N
     ```
   - Use cosine distance operator `<=>` (matches existing AgentMemory pattern)
   - Convert the raw rows to `VectorSearchResult[]` using the existing `transformRow` helper
   - Default topK to 50

5. In `web-ui/lib/db/repositories/inventory/dynamo.ts`:
   - Add stub `searchByVector` that returns empty array `[]` — DynamoDB has no vector search
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration && npx prisma validate</automated>
  </verify>
  <done>
    - InventoryResource model has embedding + contentHash columns
    - Migration SQL created and applied
    - IInventoryRepository has searchByVector method
    - Both postgres and dynamo implementations satisfy the interface
  </done>
</task>

<task type="auto">
  <name>Task 2: Rewrite ask-ai route to use PostgreSQL repository</name>
  <files>web-ui/app/api/ask-ai/route.ts</files>
  <action>
Rewrite `web-ui/app/api/ask-ai/route.ts` to replace all DynamoDB + S3 Vectors access with PostgreSQL repository calls:

1. REMOVE these imports and clients:
   - `S3VectorsClient`, `QueryVectorsCommand` from `@aws-sdk/client-s3vectors`
   - `DynamoDBClient`, `QueryCommand` from `@aws-sdk/client-dynamodb`
   - `unmarshall` from `@aws-sdk/util-dynamodb`
   - The `s3VectorsClient` and `dynamoClient` instances
   - The `VECTOR_BUCKET_NAME`, `VECTOR_INDEX_NAME`, `INVENTORY_TABLE_NAME` config vars
   - The entire `queryDynamoExhaustive()` function
   - The entire `searchVectors()` function
   - The `DynamoResource` and `VectorSearchResult` interfaces (replaced by repository types)

2. ADD these imports:
   - `import { getInventoryRepository } from '@/lib/db/repository-factory'`
   - `import type { InventoryResource } from '@/lib/db/repositories/inventory/interface'`

3. KEEP unchanged:
   - `BedrockRuntimeClient` + `InvokeModelCommand` (still needed for embedding generation)
   - `getBedrockClient()` function (still needed for LLM streaming)
   - `getEmbedding()` function (still needed for vector queries)
   - `streamText`, `Message` from 'ai'
   - `createAmazonBedrock` from '@ai-sdk/amazon-bedrock'
   - `credentialProvider` (still needed for Bedrock)
   - `conversationStore`, `MAX_CONVERSATION_TURNS`
   - `isExhaustiveQuery()`, `detectResourceType()` helper functions
   - `buildSystemPrompt()` function (update its input type — see below)

4. REWRITE the POST handler's retrieval logic (steps 1-2):
   - For exhaustive queries: call `getInventoryRepository().listResources({ tenantId: 'default', accountId: filters?.accountId, region: filters?.region, resourceType: detectedType, limit: 2000 })` — returns `InventoryPage`
   - For semantic queries: call `getInventoryRepository().searchByVector('default', queryVector, 50, { accountId: filters?.accountId, region: filters?.region })`
   - Skip embedding generation entirely for exhaustive queries (no vector needed)

5. UPDATE `buildSystemPrompt()`:
   - Change input type from `VectorSearchResult[]` to accept `InventoryResource[]` with optional distance
   - Map resource fields: `r.status` instead of `r.state`, `r.metadata` for text content, no `r.service` or `r.resourceArn` (use metadata if available)
   - Format context text: `[i] name (resourceType) | ID: resourceId | Region: region | Account: accountId | Status: status`

6. UPDATE the sources header (X-AI-Sources):
   - Map from `InventoryResource` fields instead of `VectorSearchResult`
   - `state` → `r.status`, keep `resourceId`, `name`, `resourceType`, `region`, `accountId`
   - For semantic results, include `relevanceScore` from distance; for exhaustive, set to 100

7. REMOVE the S3 Vectors config check (lines 363-369) — no longer needed since PostgreSQL is always available when USE_PG_INVENTORY=true

8. Use tenantId `'default'` for now (matches existing migration pattern — all migrated data uses 'default' tenant)
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration/web-ui && npx tsc --noEmit --pretty 2>&1 | head -30</automated>
  </verify>
  <done>
    - ask-ai route compiles with zero type errors
    - No DynamoDB or S3 Vectors imports remain in the file
    - Exhaustive queries use listResources from inventory repository
    - Semantic queries use searchByVector from inventory repository
    - Bedrock embedding generation preserved for semantic queries
    - Conversation store and streaming logic unchanged
  </done>
</task>

</tasks>

<verification>
1. `npx prisma validate` — schema is valid
2. `cd web-ui && npx tsc --noEmit` — no type errors
3. `grep -r "S3VectorsClient\|client-s3vectors\|client-dynamodb\|unmarshall" web-ui/app/api/ask-ai/route.ts` — returns nothing (all DynamoDB/S3V imports removed)
4. `grep "getInventoryRepository\|searchByVector" web-ui/app/api/ask-ai/route.ts` — confirms PostgreSQL wiring
</verification>

<success_criteria>
- Ask AI route uses PostgreSQL for both exhaustive and semantic queries
- No DynamoDB or S3 Vectors dependencies remain in the ask-ai route
- Schema migration adds embedding column with ivfflat index
- All repository implementations satisfy the updated IInventoryRepository interface
- TypeScript compiles cleanly
</success_criteria>

<output>
After completion, create `.planning/quick/260331-ocp-migrate-ask-ai-from-s3-vectors-dynamodb-/260331-ocp-SUMMARY.md`
</output>
