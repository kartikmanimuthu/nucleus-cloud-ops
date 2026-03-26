# Stack Research: DynamoDB to PostgreSQL Migration

## Recommended Stack

### ORM: Drizzle ORM
- **Package:** `drizzle-orm` + `drizzle-kit` (dev)
- **Why:** ~50KB runtime vs Prisma's 2-4MB. No binary engine. Works with esbuild bundling (project already uses esbuild for Lambdas). SQL-first with full TypeScript inference from schema. Schema-as-code in `.ts` files aligns with project's "TypeScript everywhere" convention.
- **Confidence:** High

### PostgreSQL Driver: `pg` (node-postgres)
- **Package:** `pg` + `@types/pg` (dev)
- **Why:** Most mature Node.js PostgreSQL driver. Drizzle supports it natively. Connection pooling built-in.
- **Confidence:** High

### Local Dev: Docker Compose + PostgreSQL 16
- **Image:** `postgres:16-alpine`
- **Why:** Lightweight, matches what RDS offers. Alpine for small image size.
- **Confidence:** High

### LangGraph Persistence: @langchain/langgraph-checkpoint-postgres
- **Package:** `@langchain/langgraph-checkpoint-postgres`
- **Why:** Official LangGraph PostgreSQL persistence. Replaces `@farukada/aws-langgraph-dynamodb-ts`. Handles checkpoints, writes, and thread state.
- **Note:** Chat history and memory tables need custom migration — no direct LangGraph library replacement for DynamoDBChatMessageHistory and DynamoDBStore.
- **Confidence:** Medium — need to verify API compatibility with current persistence.ts usage

### Python Lambda PostgreSQL: psycopg2-binary
- **Package:** `psycopg2-binary` (for discovery Lambda)
- **Why:** Standard Python PostgreSQL adapter. `-binary` variant avoids compilation issues in Lambda.
- **Confidence:** High

### Migration Scripts: tsx
- **Package:** `tsx` (already in project)
- **Why:** Run TypeScript migration scripts directly. No build step needed.
- **Confidence:** High

## What NOT to Use

| Tool | Why Not |
|------|---------|
| Prisma | 2-4MB runtime, binary engine breaks esbuild Lambda bundling |
| TypeORM | Heavy, decorator-based, poor TypeScript inference |
| Knex.js | Query builder only, no schema-as-code |
| Aurora Serverless v2 | Overkill for current scale; decide later |
| RDS Proxy | Not needed for local dev; consider for production Lambda pooling |
| pgBouncer | External dependency; RDS Proxy preferred for AWS |

## Connection Pooling Strategy

- **Web UI (ECS):** `max: 10` connections — long-lived process
- **Lambda functions:** `max: 3`, `idleTimeoutMillis: 10000` — short-lived, avoid exhaustion
- **Production consideration:** RDS Proxy when Lambda concurrency > 50
