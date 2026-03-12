# Knowledge Base Module — Implementation Plan

## Context


---

## Architecture

- **Inline embedding**: Documents chunked and embedded directly in API routes (not SQS/Lambda) for immediate feedback.
- **Four data source types**:
  - **File upload** — PDF, Markdown, text files uploaded directly
  - **S3 bucket** — Direct AWS SDK access (`ListObjectsV2` + `GetObject`)
  - **Confluence** — Via MCP server (user configures in Channels → MCP Servers)
  - **Bitbucket** — Via Bitbucket REST API with app password/OAuth token (same credential pattern as Slack/Jira)
- **CDK change**: Add one new `Index` construct (~5 lines) for the KB vector index in `lib/computeStack.ts`

---

## Data Model (DynamoDB Single-Table)

### Knowledge Base entity
| Attribute | Pattern |
|-----------|---------|
| PK | `TENANT#<tenantId>` |
| SK | `KB#<kbId>` |
| GSI1PK | `TYPE#KNOWLEDGE_BASE` |
| GSI1SK | `<name>` |
| Fields | `name`, `description`, `status` (active/inactive), `vectorCount`, `dataSourceCount`, `createdAt`, `updatedAt`, `createdBy` |

### Data Source entity
| Attribute | Pattern |
|-----------|---------|
| PK | `KB#<kbId>` |
| SK | `DATASOURCE#<dsId>` |
| GSI1PK | `TYPE#KB_DATASOURCE` |
| GSI1SK | `KB#<kbId>#<name>` |

**Data Source config shapes**:
- `file-upload`: `{ fileName, fileSize, mimeType, s3Key, chunkCount }`
- `s3-bucket`: `{ bucketName, prefix, filePatterns, region }`
- `confluence`: `{ spaceKey, pageIds, mcpServerId, baseUrl }`
- `bitbucket`: `{ workspace, repoSlug, branch, paths, appPassword, baseUrl }`

---

## Vector Metadata Schema

Each KB vector stored in the `knowledge-base-embeddings` index:
```
key: "kb_{kbId}_{dsId}_{chunkIndex}_{contentHash}"
metadata: {
  knowledgeBaseId, dataSourceId, sourceType,
  documentName,               // file name, page title, or repo file path
  chunkIndex, totalChunks, contentHash,
  text_content (first 500 chars for RAG context display),
  s3Key?,                     // for file-upload / s3-bucket sources
  confluencePageId?,          // for confluence sources
  bitbucketRepo?, bitbucketPath?  // for bitbucket sources
}
```

---

## Chunking Strategy

- **Chunk size**: 1500 chars | **Overlap**: 200 chars
- **Separators** (priority): `\n\n`, `\n`, `. `, ` `
- **Metadata prefix** per chunk: `"Document: {name} | Chunk {i}/{n}\n\n"`
- **Implementation**: Simple recursive character splitter (~50 lines, no extra deps)

---

## File Structure

### New files to create

```
web-ui/lib/knowledge-base/
├── types.ts                              # All TypeScript interfaces
├── service.ts                            # DynamoDB CRUD (KnowledgeBaseService)
└── embedder.ts                           # Chunking, embedding, vector CRUD

web-ui/app/api/knowledge-base/
├── route.ts                              # GET (list KBs), POST (create KB)
├── [kbId]/
│   ├── route.ts                          # GET, PUT, DELETE single KB
│   ├── upload/
│   │   └── route.ts                      # POST file upload + inline embed
│   └── sources/
│       ├── route.ts                      # GET (list), POST (create data source)
│       └── [dsId]/
│           ├── route.ts                  # DELETE data source + vectors
│           └── sync/
│               └── route.ts              # POST trigger sync
└── query/
    └── route.ts                          # POST RAG query (streaming)

web-ui/app/knowledge-base/
├── page.tsx                              # KB listing (card grid)
├── [kbId]/
│   ├── page.tsx                          # KB detail + data sources + upload
│   └── sources/
│       └── new/
│           └── page.tsx                  # Add data source wizard
└── ask/
    └── page.tsx                          # Full-page KB chat

web-ui/components/knowledge-base/
├── kb-card.tsx                           # Card for grid display
├── kb-data-source-list.tsx               # Data sources table with status/actions
├── kb-file-upload.tsx                    # Drag-and-drop file upload with progress
├── kb-source-type-selector.tsx           # Card selector (4 types)
├── kb-s3-config-form.tsx                 # S3 bucket source config form
├── kb-confluence-config-form.tsx         # Confluence source config form
├── kb-bitbucket-config-form.tsx          # Bitbucket source config form
├── kb-chat.tsx                           # Chat interface (streaming, sources)
└── kb-chat-sources.tsx                   # Document citation component
```

### Files to modify

| File | Change |
|------|--------|
| `lib/computeStack.ts` | Add `knowledge-base-embeddings` Index construct (~5 lines), export index name as env var to web UI task |
| `web-ui/components/sidebar.tsx` | Add "Knowledge Base" nav item (`BookOpen` icon, after Inventory Discovery) |
| `web-ui/lib/rbac/types.ts` | Add `'KnowledgeBase'` to `Subjects` union |
| `web-ui/lib/rbac/abilities.ts` | Add KB permissions per role |
| `web-ui/package.json` | Add `pdf-parse` dependency |

---

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/knowledge-base` | List all KBs for tenant |
| POST | `/api/knowledge-base` | Create KB `{name, description}` |
| GET | `/api/knowledge-base/[kbId]` | Get KB details + data source summaries |
| PUT | `/api/knowledge-base/[kbId]` | Update KB name/description |
| DELETE | `/api/knowledge-base/[kbId]` | Delete KB + all vectors + all data sources |
| POST | `/api/knowledge-base/[kbId]/upload` | Upload file (FormData), parse, chunk, embed inline |
| GET | `/api/knowledge-base/[kbId]/sources` | List data sources for KB |
| POST | `/api/knowledge-base/[kbId]/sources` | Add data source config |
| DELETE | `/api/knowledge-base/[kbId]/sources/[dsId]` | Delete source + its vectors |
| POST | `/api/knowledge-base/[kbId]/sources/[dsId]/sync` | Trigger sync (S3/Confluence/Bitbucket) |
| POST | `/api/knowledge-base/query` | RAG query `{query, knowledgeBaseId?, messages[]}` → streaming |

---

## Frontend Pages

### `/knowledge-base` — KB Listing
- Header: "Knowledge Base" + BookOpen icon + "Create Knowledge Base" button (opens dialog)
- Card grid (same pattern as Channels page)
- Each card: name, description, source count, vector count, status badge, "Open" button

### `/knowledge-base/[kbId]` — KB Detail
- Back nav to `/knowledge-base`
- Editable name/description header
- Stats bar: vector count, data source count, last sync time
- "Ask Knowledge Base" button → navigates to `/knowledge-base/ask?kb=<kbId>`
- **File upload dropzone** — drag-and-drop + click, shows upload/embedding progress
- **Data sources table** — name, type icon (Confluence/Bitbucket/S3/File), vector count, status badge, last sync, sync/delete actions
- "Add Data Source" button → `/knowledge-base/[kbId]/sources/new`

### `/knowledge-base/[kbId]/sources/new` — Add Data Source
- Back nav to KB detail
- Source type selector (4 cards: File Upload, S3 Bucket, Confluence, Bitbucket)
- Type-specific config form appears below selected card:
  - **File Upload**: drag-and-drop zone, shows progress
  - **S3 Bucket**: bucket name, prefix, file patterns (globs), region
  - **Confluence**: space key, page IDs, MCP server dropdown, base URL
  - **Bitbucket**: workspace, repo slug, branch, file paths/patterns, app password (masked)

### `/knowledge-base/ask` — KB Chat
- Full-page chat (not a dialog) following `ask-ai-dialog.tsx` pattern
- KB selector dropdown at top to scope queries (or "All Knowledge Bases")
- Streaming responses with document source citations
- Example prompts adapted for knowledge base content
- Multi-turn conversation support

---

## Key Implementation Details

### Reuse patterns from existing code
- **`getEmbedding()`** — extract from `web-ui/app/api/ask-ai/route.ts:57-68` into `embedder.ts`
- **`searchVectors()`** — adapt from `web-ui/app/api/ask-ai/route.ts:87-135`, point at KB index
- **`streamText()`** — same Bedrock Claude streaming from `web-ui/app/api/ask-ai/route.ts:227-250`
- **`PutVectorsCommand`** batching — same pattern from `lambda/vector_processor/src/index.ts:117-131`
- **Chat UI** — adapt from `web-ui/components/inventory/ask-ai-dialog.tsx` (full page, not dialog)
- **Sources component** — adapt from `web-ui/components/inventory/ask-ai-sources.tsx` (doc name + chunk instead of resourceType)
- **Service class** — follow `web-ui/lib/tenant-config-service.ts` DynamoDB CRUD pattern
- **Card grid** — follow `web-ui/app/channels/page.tsx` layout pattern

### File upload flow
1. Frontend sends `FormData` with file to `/api/knowledge-base/[kbId]/upload`
2. API reads file via `request.formData()`
3. Parse: PDF via `pdf-parse`, .md/.txt as UTF-8
4. Chunk text (1500 chars, 200 overlap)
5. Embed each chunk with Titan v2 (5 concurrent)
6. Store via `PutVectorsCommand` to `knowledge-base-embeddings` index (batches of 20)
7. Create data source record in DynamoDB with `vectorKeys[]`
8. Return `{dataSource, vectorCount}`

### S3 bucket sync flow
1. Use `S3Client` directly (`ListObjectsV2Command` + `GetObjectCommand`)
2. Filter by prefix and file patterns
3. Read → parse → chunk → embed → store (same pipeline as file upload)
4. Update data source status and vectorCount

### Confluence sync flow
1. Get MCP server config from `mcpServerId`
2. Connect via `getMCPManager().connectServer(config)`
3. Call MCP tools to list/read pages by space key or page IDs
4. Same chunk → embed → store pipeline

### Bitbucket sync flow
1. Use Bitbucket REST API: `GET /2.0/repositories/{workspace}/{repo}/src/{branch}/{path}`
2. Auth: Basic auth with app password (stored encrypted in data source config)
3. List files matching path patterns, read each file content
4. Same chunk → embed → store pipeline

### Vector deletion (for data source/KB removal)
1. Data source record stores `vectorKeys: string[]`
2. On delete: `DeleteVectorsCommand` with the stored keys
3. On KB delete: iterate all data sources, delete their vectors, then delete KB record

### Query pipeline (POST /api/knowledge-base/query)
1. Embed query with Titan v2
2. `QueryVectorsCommand` on `knowledge-base-embeddings` index (top 10)
3. If `knowledgeBaseId` provided, post-filter by `metadata.knowledgeBaseId`
4. Build system prompt tailored for document Q&A (not AWS resources)
5. Stream response via Bedrock Claude + return sources in `X-AI-Sources` header

---

## Implementation Phases

### Phase 1: Core infrastructure + CDK
1. CDK: Add `knowledge-base-embeddings` index to `lib/computeStack.ts`
2. `web-ui/lib/knowledge-base/types.ts` — all interfaces
3. `web-ui/lib/knowledge-base/service.ts` — DynamoDB CRUD
4. `web-ui/lib/knowledge-base/embedder.ts` — chunking, embedding, vector CRUD
5. RBAC additions (`types.ts`, `abilities.ts`)
6. Sidebar nav entry
7. `npm install pdf-parse`

### Phase 2: KB CRUD + File upload
1. API routes: `/api/knowledge-base/route.ts`, `/api/knowledge-base/[kbId]/route.ts`
2. File upload route: `/api/knowledge-base/[kbId]/upload/route.ts`
3. KB listing page with card grid
4. KB detail page with file upload dropzone + data source table

### Phase 3: Query pipeline + Chat UI
1. Query route: `/api/knowledge-base/query/route.ts`
2. Chat components: `kb-chat.tsx`, `kb-chat-sources.tsx`
3. Chat page: `/knowledge-base/ask/page.tsx`

### Phase 4: External data sources
1. Data source CRUD API routes
2. S3 bucket sync endpoint (direct SDK)
3. Confluence sync endpoint (via MCP)
4. Bitbucket sync endpoint (REST API)
5. "Add Data Source" page with all 4 config forms
6. Data source list component with type icons + status

---

## Verification

1. **Create KB**: POST `/api/knowledge-base` → verify DynamoDB record created
2. **Upload file**: Upload a PDF/MD → verify vectors in `knowledge-base-embeddings` index with correct metadata
3. **Query**: Ask a question about uploaded content → verify streaming response with document citations
4. **Delete**: Delete a data source → verify vectors removed from index
5. **S3 sync**: Add S3 bucket source → sync → verify vectors created
6. **Bitbucket sync**: Add Bitbucket repo → sync → verify repo files embedded
7. **Confluence sync**: Add Confluence space → sync → verify pages embedded
8. **Frontend E2E**: Sidebar → KB listing → create KB → upload file → ask question → see answer with citations
9. **Lint**: `cd web-ui && npm run lint` — no new errors from KB module