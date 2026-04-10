# Text-to-SQL Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace RAG-based Ask AI with a LangGraph Text-to-SQL reflection agent that queries inventory_resources via raw pg and streams step-by-step progress.

**Architecture:** Standalone LangGraph StateGraph with 5 nodes (describe_schema → generate_sql → execute_sql → reflect → synthesize) and a conditional reflection loop (max 3 retries). Raw pg Pool for SQL execution, SSE for streaming events to the frontend.

**Tech Stack:** LangGraph, ChatBedrockConverse (Claude Sonnet 4.6), pg (raw Pool), Next.js API routes (SSE), React (SSE parsing)

**Spec:** `docs/superpowers/specs/2026-04-11-text-to-sql-agent-design.md`

---

## File Structure

### New Files
```
web-ui/lib/agent/text-to-sql/
├── state.ts              — TextToSQLState Annotation + types
├── db.ts                 — Raw pg Pool singleton + executeReadOnlyQuery
├── sql-validator.ts      — SELECT-only, tenant check, table allowlist, LIMIT enforcement
├── prompts.ts            — System prompts for SQL generation, reflection, synthesis
├── nodes/
│   ├── describe-schema.ts — information_schema introspection + sample rows
│   ├── generate-sql.ts    — LLM SQL generation node
│   ├── execute-sql.ts     — SQL validation + raw pg execution node
│   ├── reflect.ts         — LLM result quality evaluation node
│   └── synthesize.ts      — LLM natural language answer generation node
├── graph.ts              — StateGraph wiring (nodes + edges)
└── index.ts              — Public API: invokeTextToSQL()
```

### Modified Files
- `web-ui/app/api/ask-ai/route.ts` — Replace RAG with graph invocation + SSE
- `web-ui/components/inventory/ask-ai-dialog.tsx` — SSE parsing + step indicators + SQL block

### Removed Files
- `web-ui/components/inventory/ask-ai-sources.tsx` — No more RAG sources

---

### Task 1: Install pg dependency

**Files:**
- Modify: `web-ui/package.json`

- [ ] **Step 1: Install pg and @types/pg**

```bash
cd web-ui && npm install pg && npm install -D @types/pg
```

- [ ] **Step 2: Verify installation**

```bash
cd web-ui && node -e "require('pg'); console.log('pg OK')"
```
Expected: `pg OK`

- [ ] **Step 3: Commit**

```bash
git add web-ui/package.json web-ui/package-lock.json
git commit -m "chore: add pg dependency for text-to-sql agent"
```

---

### Task 2: State definition

**Files:**
- Create: `web-ui/lib/agent/text-to-sql/state.ts`

- [ ] **Step 1: Create state.ts**

```typescript
import { Annotation } from "@langchain/langgraph";

export interface SQLResult {
    rows: Record<string, unknown>[];
    rowCount: number;
}

export interface TextToSQLFilters {
    accountIds?: string[];
    region?: string;
    resourceType?: string;
}

export const TextToSQLAnnotation = Annotation.Root({
    question: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    conversationHistory: Annotation<Array<{ role: string; content: string }>>({
        reducer: (_x, y) => y, default: () => [],
    }),
    tenantId: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    filters: Annotation<TextToSQLFilters | undefined>({
        reducer: (_x, y) => y, default: () => undefined,
    }),
    schemaDescription: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    sampleRows: Annotation<Record<string, unknown>[]>({
        reducer: (_x, y) => y, default: () => [],
    }),
    generatedSQL: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    sqlResult: Annotation<SQLResult | null>({ reducer: (_x, y) => y, default: () => null }),
    sqlError: Annotation<string | null>({ reducer: (_x, y) => y, default: () => null }),
    reflectionFeedback: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    iteration: Annotation<number>({ reducer: (_x, y) => y, default: () => 0 }),
    maxIterations: Annotation<number>({ reducer: (_x, y) => y, default: () => 3 }),
    satisfied: Annotation<boolean>({ reducer: (_x, y) => y, default: () => false }),
    finalAnswer: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
});

export type TextToSQLState = typeof TextToSQLAnnotation.State;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit lib/agent/text-to-sql/state.ts 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/agent/text-to-sql/state.ts
git commit -m "feat(text-to-sql): add state annotation definition"
```

---

### Task 3: SQL Validator + Tests (TDD)

**Files:**
- Create: `web-ui/lib/agent/text-to-sql/sql-validator.ts`
- Create: `web-ui/lib/agent/text-to-sql/__tests__/sql-validator.test.ts`
- Create: `web-ui/lib/agent/text-to-sql/__tests__/sql-validator.security.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `web-ui/lib/agent/text-to-sql/__tests__/sql-validator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateSQL } from '../sql-validator';

describe('validateSQL', () => {
    it('passes a valid SELECT with tenant_id param', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 100");
        expect(result.valid).toBe(true);
        expect(result.sql).toContain('LIMIT');
    });

    it('rejects INSERT statements', () => {
        const result = validateSQL("INSERT INTO inventory_resources (tenant_id) VALUES ($1)");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/SELECT.*only/i);
    });

    it('rejects UPDATE statements', () => {
        expect(validateSQL("UPDATE inventory_resources SET name = 'x' WHERE tenant_id = $1").valid).toBe(false);
    });

    it('rejects DELETE statements', () => {
        expect(validateSQL("DELETE FROM inventory_resources WHERE tenant_id = $1").valid).toBe(false);
    });

    it('rejects DROP statements', () => {
        expect(validateSQL("DROP TABLE inventory_resources").valid).toBe(false);
    });

    it('rejects ALTER statements', () => {
        expect(validateSQL("ALTER TABLE inventory_resources ADD COLUMN x TEXT").valid).toBe(false);
    });

    it('rejects CREATE statements', () => {
        expect(validateSQL("CREATE TABLE evil (id TEXT)").valid).toBe(false);
    });

    it('rejects TRUNCATE statements', () => {
        expect(validateSQL("TRUNCATE inventory_resources").valid).toBe(false);
    });

    it('rejects queries without $1 tenant param', () => {
        const result = validateSQL("SELECT * FROM inventory_resources LIMIT 100");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/tenant/i);
    });

    it('rejects queries referencing other tables', () => {
        const result = validateSQL("SELECT * FROM auth_users WHERE tenant_id = $1");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/inventory_resources/i);
    });

    it('rejects queries referencing information_schema', () => {
        expect(validateSQL("SELECT * FROM information_schema.columns WHERE tenant_id = $1").valid).toBe(false);
    });

    it('rejects queries referencing pg_catalog', () => {
        expect(validateSQL("SELECT * FROM pg_catalog.pg_tables WHERE tenant_id = $1").valid).toBe(false);
    });

    it('appends LIMIT 500 when no LIMIT present', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1");
        expect(result.valid).toBe(true);
        expect(result.sql).toMatch(/LIMIT 500$/i);
    });

    it('preserves existing LIMIT if <= 500', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 100");
        expect(result.valid).toBe(true);
        expect(result.sql).toMatch(/LIMIT 100/i);
    });

    it('caps LIMIT to 500 if > 500', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 9999");
        expect(result.valid).toBe(true);
        expect(result.sql).toMatch(/LIMIT 500/i);
    });

    it('handles GROUP BY queries', () => {
        const result = validateSQL(
            "SELECT resource_type, COUNT(*) FROM inventory_resources WHERE tenant_id = $1 GROUP BY resource_type LIMIT 50"
        );
        expect(result.valid).toBe(true);
    });
});
```

- [ ] **Step 2: Write the failing security tests**

Create `web-ui/lib/agent/text-to-sql/__tests__/sql-validator.security.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateSQL } from '../sql-validator';

describe('SQL Validator Security', () => {
    it('blocks UNION-based table access', () => {
        expect(validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1 UNION SELECT * FROM auth_users"
        ).valid).toBe(false);
    });

    it('blocks subquery accessing other tables', () => {
        expect(validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1 AND account_id IN (SELECT id FROM accounts)"
        ).valid).toBe(false);
    });

    it('allows commented-out dangerous SQL (comments stripped)', () => {
        const result = validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1 -- UNION SELECT * FROM auth_users"
        );
        expect(result.valid).toBe(true);
    });

    it('blocks semicolon-separated statements', () => {
        expect(validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1; DELETE FROM inventory_resources"
        ).valid).toBe(false);
    });

    it('blocks GRANT/REVOKE', () => {
        expect(validateSQL("GRANT ALL ON inventory_resources TO public").valid).toBe(false);
        expect(validateSQL("REVOKE ALL ON inventory_resources FROM public").valid).toBe(false);
    });

    it('blocks COPY command', () => {
        expect(validateSQL(
            "COPY inventory_resources TO '/tmp/dump.csv' WHERE tenant_id = $1"
        ).valid).toBe(false);
    });

    it('is case-insensitive for dangerous keywords', () => {
        expect(validateSQL("insert INTO inventory_resources VALUES ($1)").valid).toBe(false);
        expect(validateSQL("DeLeTe FROM inventory_resources WHERE tenant_id = $1").valid).toBe(false);
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd web-ui && npx vitest run lib/agent/text-to-sql/__tests__/sql-validator.test.ts lib/agent/text-to-sql/__tests__/sql-validator.security.test.ts 2>&1 | tail -20
```
Expected: FAIL — `Cannot find module '../sql-validator'`

- [ ] **Step 4: Implement sql-validator.ts**

Create `web-ui/lib/agent/text-to-sql/sql-validator.ts`:

```typescript
export interface ValidationResult {
    valid: boolean;
    sql: string;
    error?: string;
}

const ALLOWED_TABLES = ['inventory_resources'];

const FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE',
    'TRUNCATE', 'GRANT', 'REVOKE', 'COPY', 'EXECUTE',
];

export function validateSQL(rawSQL: string): ValidationResult {
    // Strip SQL comments to prevent bypass
    let sql = rawSQL
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

    // Reject multiple statements
    const statements = sql.split(';').filter(s => s.trim().length > 0);
    if (statements.length > 1) {
        return { valid: false, sql: rawSQL, error: 'Multiple SQL statements are not allowed.' };
    }
    sql = statements[0].trim();

    // Must start with SELECT
    if (!/^\s*SELECT\b/i.test(sql)) {
        return { valid: false, sql: rawSQL, error: 'Only SELECT queries are allowed.' };
    }

    // Check for forbidden keywords
    for (const keyword of FORBIDDEN_KEYWORDS) {
        if (new RegExp(`\\b${keyword}\\b`, 'i').test(sql)) {
            return { valid: false, sql: rawSQL, error: `Forbidden SQL keyword: ${keyword}. Only SELECT queries are allowed.` };
        }
    }

    // Must reference $1 for tenant_id
    if (!sql.includes('$1')) {
        return { valid: false, sql: rawSQL, error: 'Query must include $1 parameter for tenant_id isolation.' };
    }

    // Table allowlist
    const tablePattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
    let match;
    while ((match = tablePattern.exec(sql)) !== null) {
        const tableName = match[1].toLowerCase();
        if (!ALLOWED_TABLES.includes(tableName)) {
            return { valid: false, sql: rawSQL, error: `Table "${match[1]}" is not allowed. Only inventory_resources can be queried.` };
        }
    }

    // Block system catalog access
    if (/\binformation_schema\b/i.test(sql) || /\bpg_catalog\b/i.test(sql) || /\bpg_\w+\b/i.test(sql)) {
        return { valid: false, sql: rawSQL, error: 'System catalog access is not allowed.' };
    }

    // LIMIT enforcement
    const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
    if (limitMatch) {
        const limit = parseInt(limitMatch[1], 10);
        if (limit > 500) {
            sql = sql.replace(/\bLIMIT\s+\d+/i, 'LIMIT 500');
        }
    } else {
        sql = sql.replace(/\s*$/, ' LIMIT 500');
    }

    return { valid: true, sql };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd web-ui && npx vitest run lib/agent/text-to-sql/__tests__/sql-validator.test.ts lib/agent/text-to-sql/__tests__/sql-validator.security.test.ts 2>&1 | tail -30
```
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add web-ui/lib/agent/text-to-sql/sql-validator.ts web-ui/lib/agent/text-to-sql/__tests__/
git commit -m "feat(text-to-sql): add SQL validator with security tests (TDD)"
```

---

### Task 4: Database pool + read-only execution

**Files:**
- Create: `web-ui/lib/agent/text-to-sql/db.ts`

- [ ] **Step 1: Create db.ts**

```typescript
import { Pool, type PoolClient } from 'pg';

let pool: Pool | null = null;

export function getTextToSQLPool(): Pool {
    if (!pool) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) throw new Error('DATABASE_URL is required for text-to-sql agent');
        pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    }
    return pool;
}

export interface QueryResult {
    rows: Record<string, unknown>[];
    rowCount: number;
}

export async function executeReadOnlyQuery(sql: string, params: unknown[]): Promise<QueryResult> {
    const client: PoolClient = await getTextToSQLPool().connect();
    try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query('SET LOCAL statement_timeout = 10000');
        const result = await client.query(sql, params);
        await client.query('COMMIT');
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function executeSchemaQuery(sql: string): Promise<Record<string, unknown>[]> {
    const client: PoolClient = await getTextToSQLPool().connect();
    try { return (await client.query(sql)).rows; }
    finally { client.release(); }
}

export async function closeTextToSQLPool(): Promise<void> {
    if (pool) { await pool.end(); pool = null; }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/agent/text-to-sql/db.ts
git commit -m "feat(text-to-sql): add raw pg pool with read-only execution"
```

---

### Task 5: Prompt templates

**Files:**
- Create: `web-ui/lib/agent/text-to-sql/prompts.ts`

- [ ] **Step 1: Create prompts.ts with three prompt builders**

`buildSQLGenerationPrompt(schemaDescription, sampleRows, filters?)` — instructs LLM to generate a single SELECT with `$1` tenant param, JSONB operators for tags/metadata, LIMIT clause. Includes schema + sample rows + active filters.

`buildReflectionPrompt(question, sql, result, error)` — asks LLM to evaluate if query answered the question. Returns JSON `{satisfied: boolean, feedback: string}`.

`buildSynthesisPrompt(question, sql, result, wasRetried)` — instructs LLM to generate natural language answer from results. Markdown tables for lists, no mention of SQL/databases.

See spec section "Node Descriptions" for full prompt content.

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/agent/text-to-sql/prompts.ts
git commit -m "feat(text-to-sql): add prompt templates for generation, reflection, synthesis"
```

---

### Task 6: Graph nodes (describe_schema, generate_sql, execute_sql, reflect, synthesize)

**Files:**
- Create: `web-ui/lib/agent/text-to-sql/nodes/describe-schema.ts`
- Create: `web-ui/lib/agent/text-to-sql/nodes/generate-sql.ts`
- Create: `web-ui/lib/agent/text-to-sql/nodes/execute-sql.ts`
- Create: `web-ui/lib/agent/text-to-sql/nodes/reflect.ts`
- Create: `web-ui/lib/agent/text-to-sql/nodes/synthesize.ts`

- [ ] **Step 1: Create describe-schema.ts**

Queries `information_schema.columns WHERE table_name = 'inventory_resources'` via `executeSchemaQuery()`. Fetches 5 sample rows via `executeReadOnlyQuery('SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 5', [tenantId])`. Formats columns as `column_name (data_type, nullable: yes/no)`. Returns `{ schemaDescription, sampleRows }`. Skips if `state.schemaDescription` is already populated (cached).

- [ ] **Step 2: Create generate-sql.ts**

Uses `ChatBedrockConverse` from model-factory.ts (temperature: 0, maxTokens: 1024). Builds prompt via `buildSQLGenerationPrompt()`. Includes `state.reflectionFeedback` and `state.sqlError` if present (retry context). Includes `state.conversationHistory` for follow-up questions. Extracts raw SQL from LLM response (strips markdown fences if present). Returns `{ generatedSQL, sqlError: null }`.

- [ ] **Step 3: Create execute-sql.ts**

Calls `validateSQL(state.generatedSQL)` first. If invalid: returns `{ sqlError: validationResult.error, sqlResult: null }`. If valid: calls `executeReadOnlyQuery(validatedSQL, [state.tenantId])`. On success: returns `{ sqlResult: { rows, rowCount }, sqlError: null }`. On error: returns `{ sqlError: err.message, sqlResult: null }`.

- [ ] **Step 4: Create reflect.ts**

Uses `ChatBedrockConverse` (temperature: 0, maxTokens: 1024, non-streaming). Builds prompt via `buildReflectionPrompt()`. Parses JSON response `{satisfied, feedback}`. Increments `state.iteration`. If `satisfied` or `iteration >= maxIterations`: returns `{ satisfied: true }`. If not satisfied: returns `{ satisfied: false, reflectionFeedback: feedback }`.

- [ ] **Step 5: Create synthesize.ts**

Uses `ChatBedrockConverse` (temperature: 0.1, maxTokens: 4096, streaming). Builds prompt via `buildSynthesisPrompt()`. Returns `{ finalAnswer }`. Note: actual token streaming happens at the API route level — this node returns the full text.

- [ ] **Step 6: Commit**

```bash
git add web-ui/lib/agent/text-to-sql/nodes/
git commit -m "feat(text-to-sql): add all 5 graph nodes"
```

---

### Task 7: Graph wiring + public API

**Files:**
- Create: `web-ui/lib/agent/text-to-sql/graph.ts`
- Create: `web-ui/lib/agent/text-to-sql/index.ts`

- [ ] **Step 1: Create graph.ts**

```typescript
import { StateGraph, START, END } from "@langchain/langgraph";
import { TextToSQLAnnotation, type TextToSQLState } from "./state";
import { describeSchemaNode } from "./nodes/describe-schema";
import { generateSQLNode } from "./nodes/generate-sql";
import { executeSQLNode } from "./nodes/execute-sql";
import { reflectNode } from "./nodes/reflect";
import { synthesizeNode } from "./nodes/synthesize";

function shouldRetryOrSynthesize(state: TextToSQLState): "generate_sql" | "synthesize" {
    if (!state.satisfied && state.iteration < state.maxIterations) {
        return "generate_sql";
    }
    return "synthesize";
}

export function createTextToSQLGraph() {
    const workflow = new StateGraph(TextToSQLAnnotation)
        .addNode("describe_schema", describeSchemaNode)
        .addNode("generate_sql", generateSQLNode)
        .addNode("execute_sql", executeSQLNode)
        .addNode("reflect", reflectNode)
        .addNode("synthesize", synthesizeNode)
        .addEdge(START, "describe_schema")
        .addEdge("describe_schema", "generate_sql")
        .addEdge("generate_sql", "execute_sql")
        .addEdge("execute_sql", "reflect")
        .addConditionalEdges("reflect", shouldRetryOrSynthesize, {
            generate_sql: "generate_sql",
            synthesize: "synthesize",
        })
        .addEdge("synthesize", END);

    return workflow.compile();
}
```

- [ ] **Step 2: Create index.ts**

```typescript
import { createTextToSQLGraph } from "./graph";
import type { TextToSQLFilters } from "./state";

export interface TextToSQLInput {
    question: string;
    tenantId: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    filters?: TextToSQLFilters;
}

export interface TextToSQLEvent {
    type: 'step' | 'sql' | 'result' | 'reflection' | 'token' | 'error' | 'done';
    [key: string]: unknown;
}

export async function* invokeTextToSQL(input: TextToSQLInput): AsyncGenerator<TextToSQLEvent> {
    const graph = createTextToSQLGraph();

    yield { type: 'step', step: 'describe_schema', status: 'running' };

    const result = await graph.invoke({
        question: input.question,
        tenantId: input.tenantId,
        conversationHistory: input.conversationHistory ?? [],
        filters: input.filters,
        maxIterations: 3,
    });

    // After full invocation, emit events from the result
    // (For streaming synthesis, Task 8 will enhance this with streamEvents)
    if (result.generatedSQL) {
        yield { type: 'sql', query: result.generatedSQL };
    }
    if (result.sqlResult) {
        yield { type: 'result', rowCount: result.sqlResult.rowCount, preview: result.sqlResult.rows.slice(0, 5) };
    }
    if (result.finalAnswer) {
        yield { type: 'token', content: result.finalAnswer };
    }
    yield { type: 'done' };
}

export type { TextToSQLFilters } from "./state";
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/agent/text-to-sql/graph.ts web-ui/lib/agent/text-to-sql/index.ts
git commit -m "feat(text-to-sql): wire StateGraph + public invokeTextToSQL API"
```

---

### Task 8: API route — replace RAG with Text-to-SQL + SSE

**Files:**
- Modify: `web-ui/app/api/ask-ai/route.ts`

- [ ] **Step 1: Rewrite route.ts**

Replace the entire file. Key changes:
- Remove: Bedrock embedding client, `getEmbedding()`, `buildSystemPrompt()`, `EXHAUSTIVE_PATTERNS`, vector search, `streamText()`
- Add: Import `invokeTextToSQL` from `@/lib/agent/text-to-sql`
- Add: SSE streaming via `ReadableStream` + `TextEncoder`
- Keep: Auth, request parsing, conversation store, error handling structure

The route should:
1. Parse request body (messages, conversationId, filters) — same shape as before
2. Extract tenantId from session (or 'default' for now)
3. Call `invokeTextToSQL()` async generator
4. For each event, write `data: ${JSON.stringify(event)}\n\n` to the SSE stream
5. Return `new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })`

- [ ] **Step 2: Verify build**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | grep -i "ask-ai" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/app/api/ask-ai/route.ts
git commit -m "feat(text-to-sql): replace RAG route with Text-to-SQL agent + SSE streaming"
```

---

### Task 9: Frontend — SSE parsing + step indicators + SQL block

**Files:**
- Modify: `web-ui/components/inventory/ask-ai-dialog.tsx`
- Remove: `web-ui/components/inventory/ask-ai-sources.tsx`

- [ ] **Step 1: Update ask-ai-dialog.tsx**

Key changes:
- Replace plain text stream reader with SSE line parser (`data: {...}\n\n` format)
- Add state: `steps` array of `{ name: string; status: 'running' | 'done'; detail?: string }[]`
- Add state: `sqlQuery` string for the collapsible SQL block
- Add state: `sqlExpanded` boolean toggle
- Remove: `sourcesMap`, `AskAISources` import, `X-AI-Sources` header parsing

SSE parsing logic:
```typescript
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        // Handle event.type: step, sql, result, reflection, token, error, done
    }
}
```

Step indicator pills (rendered above the answer):
```tsx
<div className="flex flex-wrap gap-1.5 mb-3">
    {steps.map((step) => (
        <div key={step.name} className={cn(
            "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border",
            step.status === 'done' ? "bg-green-500/10 border-green-500/30 text-green-600" : "bg-blue-500/10 border-blue-500/30 text-blue-600 animate-pulse"
        )}>
            {step.status === 'done' ? '✓' : '⟳'} {step.name}{step.detail ? ` (${step.detail})` : ''}
        </div>
    ))}
</div>
```

Collapsible SQL block:
```tsx
{sqlQuery && (
    <div className="mb-3 rounded-md border bg-muted/30 overflow-hidden">
        <button onClick={() => setSqlExpanded(!sqlExpanded)}
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50">
            <span>SQL Query</span>
            <ChevronDown className={cn("h-3 w-3 transition-transform", sqlExpanded && "rotate-180")} />
        </button>
        {sqlExpanded && (
            <pre className="px-3 py-2 text-xs overflow-x-auto border-t">{sqlQuery}</pre>
        )}
    </div>
)}
```

- [ ] **Step 2: Remove ask-ai-sources.tsx**

```bash
rm web-ui/components/inventory/ask-ai-sources.tsx
```

- [ ] **Step 3: Remove AskAISources import from ask-ai-dialog.tsx**

Ensure no remaining imports of `AskAISources` or `AISource` in the dialog.

- [ ] **Step 4: Verify build**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add web-ui/components/inventory/ask-ai-dialog.tsx
git rm web-ui/components/inventory/ask-ai-sources.tsx
git commit -m "feat(text-to-sql): update Ask AI dialog with SSE parsing, step indicators, SQL block"
```

---

### Task 10: Manual smoke test

- [ ] **Step 1: Start dev server**

```bash
cd web-ui && npm run dev
```

- [ ] **Step 2: Open browser and test**

Navigate to `http://localhost:3000/app/inventory` → click "Ask AI" → try these queries:
1. "How many EC2 instances are running?" — should show step indicators + count
2. "List all RDS databases in us-east-1" — should show SQL + table
3. "Show resources tagged Environment=Production" — tests JSONB query
4. "Which Lambda functions have a timeout over 5 minutes?" — tests metadata JSONB
5. Follow-up: "How many of those are in us-west-2?" — tests conversation context

Verify:
- Step indicator pills appear and progress
- SQL block is collapsible
- Answer streams in with markdown formatting
- No console errors

- [ ] **Step 3: Fix any issues found during smoke test**

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix(text-to-sql): smoke test fixes"
```

---

### Task 11: Run existing tests

- [ ] **Step 1: Run Vitest suite**

```bash
cd web-ui && npm run test 2>&1 | tail -30
```
Expected: All existing tests pass. New sql-validator tests pass.

- [ ] **Step 2: Run lint**

```bash
cd web-ui && npm run lint 2>&1 | tail -20
```
Expected: No new lint errors.

- [ ] **Step 3: Fix any failures and commit**

```bash
git add -A && git commit -m "fix(text-to-sql): resolve test/lint issues"
```
