# Text-to-SQL Agent for Inventory Ask AI

**Date:** 2026-04-11
**Branch:** `text-to-sql`
**Status:** Approved

## Summary

Replace the existing RAG-based Ask AI (vector search + embedding) with a LangGraph Text-to-SQL reflection agent that directly queries the `inventory_resources` PostgreSQL table. The agent generates SQL from natural language, executes it, evaluates result quality, self-corrects up to 3 times, and streams a natural language answer with step-by-step visibility.

## Goals

- Users ask natural language questions about their AWS inventory and get accurate, data-driven answers
- The agent queries PostgreSQL directly — no vector embeddings, no semantic search
- Full quality reflection loop: generate SQL → execute → evaluate → retry if unsatisfied
- Step-by-step streaming UX: user sees "Schema loaded → SQL generated → Query executed → Results verified" as the agent works
- 5-layer SQL safety: SELECT-only, tenant isolation, read-only transaction, table allowlist, resource limits

## Non-Goals

- No JOINs to other tables (accounts, audit_logs, etc.) — `inventory_resources` only
- No write operations — strictly read-only
- No RAG fallback — vector search is fully removed
- No persistent conversation store — in-memory for now (same as current)

## Architecture

### LangGraph StateGraph

5 nodes with a conditional reflection loop:

```
START → describe_schema → generate_sql → execute_sql → reflect → [satisfied?]
                              ↑                                       |
                              └──── NO (max 3 retries) ──────────────┘
                                                                      |
                                                               YES → synthesize → END
```

### State Definition

```typescript
// web-ui/lib/agent/text-to-sql/state.ts
interface TextToSQLState {
  // Input
  question: string;
  conversationHistory: BaseMessage[];
  tenantId: string;
  filters?: { accountIds?: string[]; region?: string; resourceType?: string };

  // Schema (cached after first call)
  schemaDescription: string;
  sampleRows: Record<string, unknown>[];

  // SQL generation loop
  generatedSQL: string;
  sqlResult: { rows: Record<string, unknown>[]; rowCount: number } | null;
  sqlError: string | null;
  reflectionFeedback: string;
  iteration: number;
  maxIterations: number; // default 3
  satisfied: boolean;

  // Output
  finalAnswer: string;
}
```

### Node Descriptions

**describe_schema** — Runs `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'inventory_resources'` plus fetches 5 sample rows. Result is cached in state — follow-up questions in the same conversation skip this node.

**generate_sql** — LLM (Bedrock Claude Sonnet 4.6) generates a SQL query from the user's question, schema description, conversation history, active filters, and any prior reflection feedback. The prompt instructs the LLM to:
- Always use `$1` as the tenant_id parameter
- Only query `inventory_resources`
- Include a LIMIT clause
- Use JSONB operators for tags/metadata queries (e.g., `tags->>'Environment'`, `metadata->>'vCpuCount'`)

**execute_sql** — Validates the SQL via `sql-validator.ts`, then executes via raw `pg` Pool in a read-only transaction with 10s statement timeout. Returns rows + rowCount, or captures the error message.

**reflect** — LLM evaluates: "Did this query correctly answer the user's question?" Checks for:
- SQL execution errors
- Empty results when data was expected
- Wrong columns or aggregations
- Incomplete answers
Returns `{ satisfied: boolean, feedback: string }`. If not satisfied and retries remain, feedback goes back to `generate_sql`.

**synthesize** — LLM generates a natural language answer from the query results. Streams tokens to the user via SSE. Formats data as markdown tables, counts, summaries as appropriate.

### LLM Configuration

- **Model:** `global.anthropic.claude-sonnet-4-6` via `ChatBedrockConverse` (existing model-factory.ts)
- **Temperature:** 0 for SQL generation, 0.1 for synthesis
- **Max tokens:** 1024 for SQL generation, 4096 for synthesis

## Database Access

### Raw pg Pool

```typescript
// web-ui/lib/agent/text-to-sql/db.ts
import { Pool } from 'pg';

let pool: Pool | null = null;

export function getTextToSQLPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function executeReadOnlyQuery(
  sql: string, params: unknown[]
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const client = await getTextToSQLPool().connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query('SET LOCAL statement_timeout = 10000');
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

No Prisma. No ORM. LLM-generated SQL goes directly to `pool.query()`.

### Table Schema (inventory_resources)

| Column | Type | Notes |
|--------|------|-------|
| id | text (cuid) | Primary key |
| tenant_id | text | Tenant isolation — always filtered via `$1` param |
| account_id | text | AWS account ID |
| region | text | AWS region |
| resource_type | text | e.g., `ec2_instances`, `rds_instances`, `lambda_functions` |
| resource_id | text | AWS resource identifier |
| name | text? | Human-readable name |
| status | text? | e.g., `running`, `stopped`, `available` |
| tags | jsonb | AWS resource tags `{"Environment": "Production", ...}` |
| metadata | jsonb | Resource-specific attributes `{"vCpuCount": "4", ...}` |
| job_run_id | text? | Discovery scan ID |
| discovered_at | timestamp | When first discovered |
| updated_at | timestamp | Last update |
| embedding | vector(1024)? | pgvector (unused by this agent) |
| content_hash | text? | For change detection |
| search_vector | tsvector? | Full-text search (unused by this agent) |

Unique constraint: `[tenant_id, account_id, resource_type, resource_id]`

## SQL Safety — 5 Layers

1. **SELECT-Only Validation** — Regex check rejects any SQL containing INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE. Runs before execution in `sql-validator.ts`.

2. **Tenant Isolation** — Every query must reference `$1` as the tenant_id parameter. Validated before execution. The actual tenantId is passed via `pool.query(sql, [tenantId])` — never string-interpolated.

3. **Read-Only Transaction** — `BEGIN TRANSACTION READ ONLY` before every query. Even if validation is bypassed, PostgreSQL blocks writes.

4. **Table Allowlist** — Only `inventory_resources` is queryable. Any reference to other tables (including `information_schema`, `pg_catalog`, system tables) is rejected. Checked via regex against the SQL. The `describe_schema` node queries `information_schema` directly via its own hardcoded SQL — not through LLM-generated queries.

5. **Resource Limits** — LIMIT 500 enforced (appended if missing). 10-second `statement_timeout`. Max 3 reflection retries.

## API Route

### Request (unchanged)

```
POST /api/ask-ai
Content-Type: application/json

{
  "messages": [...],
  "conversationId": "...",
  "filters": {
    "accountId": "123456",
    "region": "us-east-1",
    "resourceType": "ec2_instances"
  }
}
```

### Response (SSE stream)

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Event types:

| Event Type | Payload | When |
|-----------|---------|------|
| `step` | `{ step, status, iteration? }` | Node starts/completes |
| `sql` | `{ query }` | SQL generated |
| `result` | `{ rowCount, preview }` | Query executed (preview = first 5 rows) |
| `reflection` | `{ satisfied, feedback }` | Reflection complete |
| `token` | `{ content }` | Final answer token (streamed) |
| `error` | `{ message }` | Unrecoverable error |
| `done` | `{}` | Stream complete |

## Frontend Changes

### ask-ai-dialog.tsx

- Switch from plain text stream parsing to SSE event parsing (`EventSource` or manual `ReadableStream` + line splitting)
- Render step indicator pills: "Schema loaded → SQL generated → Query executed (N rows) → Results verified"
- Render collapsible SQL code block (collapsed by default)
- On reflection retry: update step indicators to show "SQL generated (attempt 2)"
- Stream final answer tokens into markdown renderer (same as current)
- Remove `X-AI-Sources` header parsing and `AskAISources` component usage

### ask-ai-sources.tsx

Removed. No more RAG source citations.

## Error Handling

| Node | Failure | Behavior |
|------|---------|----------|
| describe_schema | DB connection error | Return error event: "Unable to connect to inventory database" |
| generate_sql | LLM timeout/throttle | Retry once, then error to user |
| generate_sql | SQL validation fails | Feed validation error as reflection feedback, retry |
| execute_sql | SQL syntax error | Capture error, pass to reflect for correction |
| execute_sql | Statement timeout (10s) | Capture error, reflection suggests simpler query |
| execute_sql | Pool exhausted | Error to user: "Database temporarily unavailable" |
| reflect | Not satisfied + retries left | Feedback → generate_sql |
| reflect | Not satisfied + max retries | Proceed to synthesize with best results + disclaimer |
| synthesize | LLM fails | Return raw results as formatted table (graceful degradation) |
| synthesize | Client disconnects | Detect abort signal, clean up |

## File Structure

### New Files

```
web-ui/lib/agent/text-to-sql/
├── graph.ts              — LangGraph StateGraph (5 nodes + conditional edges)
├── state.ts              — TextToSQLState type + Annotation
├── nodes/
│   ├── describe-schema.ts — information_schema introspection + sample rows
│   ├── generate-sql.ts    — LLM SQL generation
│   ├── execute-sql.ts     — Raw pg execution with safety
│   ├── reflect.ts         — LLM result quality evaluation
│   └── synthesize.ts      — LLM natural language answer generation
├── db.ts                  — Raw pg Pool singleton (max:3, read-only)
├── sql-validator.ts       — SELECT-only, tenant check, table allowlist, LIMIT
└── prompts.ts             — System prompts for generation, reflection, synthesis
```

### Modified Files

- `web-ui/app/api/ask-ai/route.ts` — Replace RAG logic with graph invocation + SSE streaming
- `web-ui/components/inventory/ask-ai-dialog.tsx` — Parse SSE events, render step indicators + SQL block

### Removed Files

- `web-ui/components/inventory/ask-ai-sources.tsx` — No more RAG source citations

### Dependencies

- `pg` — already in workers, needs adding to `web-ui/package.json`
- `@types/pg` — dev dependency
- No new LangGraph dependencies — already using `@langchain/langgraph`

## Testing

### Unit Tests (Vitest)

**sql-validator.test.ts**
- Rejects INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE
- Rejects queries without `$1` tenant param
- Rejects queries referencing non-allowed tables
- Appends LIMIT 500 when missing
- Passes valid SELECT queries

**prompts.test.ts**
- Schema description formatting
- Filter injection into prompts

### Integration Tests (Vitest)

**graph.test.ts**
- Mock LLM + real pg pool against test DB
- Full graph execution: question → SQL → results → answer
- Reflection loop triggers on bad SQL
- Max retries respected
- Tenant isolation enforced

**execute-sql.test.ts**
- Read-only transaction blocks writes
- Statement timeout fires at 10s
- Parameterized queries prevent injection

### Security Tests (Vitest)

**sql-validator.security.test.ts**
- SQL injection attempts blocked
- Subquery attacks (SELECT from auth_users) blocked
- UNION-based table access blocked
- Comment-based bypass attempts blocked
- Tenant ID cannot be overridden

### E2E Tests (Playwright)

**ask-ai-sql.spec.ts**
- Open Ask AI → type question → see step indicators
- SQL block appears and is collapsible
- Answer streams in with markdown table
- Follow-up question uses conversation context
- Error state renders correctly

## Edge Cases

- **Ambiguous question** ("show me everything") — agent generates broad SELECT with LIMIT 500, synthesizer summarizes by resource type
- **JSONB queries** ("resources tagged Environment=Production") — agent uses `tags->>'Environment' = 'Production'` or `tags @> '{"Environment":"Production"}'`
- **No data** (empty inventory) — describe_schema still works, agent returns "No inventory data found. Run a sync first."
- **Non-inventory question** ("what's the weather?") — agent recognizes no relevant SQL, returns "I can only answer questions about your AWS inventory."
- **Large result sets** — LIMIT 500 cap + synthesizer summarizes/aggregates rather than listing all 500 rows
- **Metadata queries** ("instances with more than 4 vCPUs") — agent uses `metadata->>'vCpuCount'` JSONB access
