---
phase: quick
plan: 260407-dqr
type: execute
wave: 1
depends_on: []
files_modified:
  - workers/src/lib/logger.ts
  - workers/.env.example
  - workers/src/jobs/kb-sync/index.ts
  - workers/src/jobs/kb-sync/lib/vector-store.ts
  - workers/src/jobs/kb-sync/lib/embedding.ts
  - workers/src/jobs/kb-sync/handlers/file-upload.ts
  - workers/src/jobs/kb-sync/handlers/s3-sync.ts
  - workers/src/jobs/kb-sync/handlers/confluence-sync.ts
  - workers/src/jobs/kb-sync/handlers/bitbucket-sync.ts
  - workers/src/jobs/discovery/index.ts
  - workers/src/jobs/discovery/services/scanner.ts
  - workers/src/jobs/discovery/services/custom-scanners.ts
  - workers/src/jobs/discovery/services/pg-writer.ts
  - workers/src/jobs/discovery/services/vector-processor.ts
autonomous: true
requirements: [QUICK-260407-DQR]
must_haves:
  truths:
    - "All console.log/warn/error calls in kb-sync and discovery jobs use the structured logger"
    - "Log level is controlled by LOG_LEVEL env var, defaulting to debug"
    - "Sensitive data (tokens, passwords, connection strings) is never logged"
    - "Log output includes timestamp, level, and module prefix"
  artifacts:
    - path: "workers/src/lib/logger.ts"
      provides: "Structured logger with level filtering"
      exports: ["createLogger", "Logger"]
  key_links:
    - from: "workers/src/jobs/kb-sync/index.ts"
      to: "workers/src/lib/logger.ts"
      via: "import createLogger"
      pattern: "createLogger\\("
    - from: "workers/src/jobs/discovery/index.ts"
      to: "workers/src/lib/logger.ts"
      via: "import createLogger"
      pattern: "createLogger\\("
---

<objective>
Refactor all logging in kb-sync and discovery worker jobs from raw console.log/warn/error to a structured logger with industry-standard log levels (debug, info, warn, error).

Purpose: Enable log level filtering via LOG_LEVEL env var for production noise control while keeping debug verbosity available for troubleshooting.
Output: A shared logger module and all worker files migrated to use it.
</objective>

<context>
@workers/src/lib/logger.ts (new — to be created)
@workers/src/jobs/kb-sync/index.ts
@workers/src/jobs/kb-sync/lib/vector-store.ts
@workers/src/jobs/kb-sync/lib/embedding.ts
@workers/src/jobs/kb-sync/handlers/file-upload.ts
@workers/src/jobs/kb-sync/handlers/s3-sync.ts
@workers/src/jobs/kb-sync/handlers/confluence-sync.ts
@workers/src/jobs/kb-sync/handlers/bitbucket-sync.ts
@workers/src/jobs/discovery/index.ts
@workers/src/jobs/discovery/services/scanner.ts
@workers/src/jobs/discovery/services/custom-scanners.ts
@workers/src/jobs/discovery/services/pg-writer.ts
@workers/src/jobs/discovery/services/vector-processor.ts
@workers/.env.example
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create shared logger module and add LOG_LEVEL to env</name>
  <files>workers/src/lib/logger.ts, workers/.env.example</files>
  <action>
Create `workers/src/lib/logger.ts` — a zero-dependency console wrapper:

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'debug';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
  }

  function formatLog(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
    return `${ts} [${level.toUpperCase()}] [${module}]${message}${metaStr}`;
  }

  return {
    debug: (msg, meta) => shouldLog('debug') && console.debug(formatLog('debug', msg, meta)),
    info: (msg, meta) => shouldLog('info') && console.log(formatLog('info', msg, meta)),
    warn: (msg, meta) => shouldLog('warn') && console.warn(formatLog('warn', msg, meta)),
    error: (msg, meta) => shouldLog('error') && console.error(formatLog('error', msg, meta)),
  };
}
```

Key design decisions:
- No external dependencies — pure console wrapper with level gating
- `createLogger('module-name')` factory pattern so each file gets a prefixed logger
- Outputs structured JSON metadata alongside human-readable prefix
- Level read once at module load from `process.env.LOG_LEVEL`

Add to `workers/.env.example` after the feature flags section:

```
# --- Logging ----------------------------------------------------------------
# Log level for worker output. One of: debug, info, warn, error.
# Defaults to "debug" if not set.
LOG_LEVEL="debug"
```
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration && npx tsc --noEmit --project workers/tsconfig.json 2>&1 | head -30</automated>
  </verify>
  <done>Logger module exists at workers/src/lib/logger.ts, exports createLogger and Logger type, LOG_LEVEL documented in .env.example</done>
</task>

<task type="auto">
  <name>Task 2: Migrate all console calls in kb-sync and discovery to use logger</name>
  <files>
    workers/src/jobs/kb-sync/index.ts,
    workers/src/jobs/kb-sync/handlers/s3-sync.ts,
    workers/src/jobs/kb-sync/handlers/confluence-sync.ts,
    workers/src/jobs/kb-sync/handlers/bitbucket-sync.ts,
    workers/src/jobs/discovery/index.ts,
    workers/src/jobs/discovery/services/scanner.ts,
    workers/src/jobs/discovery/services/custom-scanners.ts,
    workers/src/jobs/discovery/services/pg-writer.ts,
    workers/src/jobs/discovery/services/vector-processor.ts
  </files>
  <action>
In each file, add `import { createLogger } from '../../lib/logger.js';` (adjust relative path per file depth) and create a module-scoped logger instance. Then replace every `console.log`, `console.warn`, `console.error` call.

Mapping rules for each file:

**kb-sync/index.ts** — `const log = createLogger('kb-sync');`
- `console.log('[kb-sync] Processing job', {...})` -> `log.info('Processing job', {...})`
- `console.log('[kb-sync] Job complete', {...})` -> `log.info('Job complete', {...})`
- `console.error('[kb-sync] Job failed', {...})` -> `log.error('Job failed', {...})`
- `console.error('[kb-sync] Status update failed', {...})` -> `log.error('Status update failed', {...})`
- `console.log('[kb-sync] Registered queues', {...})` -> `log.info('Registered queues', {...})`

**kb-sync/handlers/s3-sync.ts** — `const log = createLogger('kb-sync/s3');`
- `console.error('[KB Sync] S3 skip ...')` -> `log.warn('Skipping S3 object', { key: obj.Key, error: ... })`
- Do NOT log the full error object (may contain presigned URLs). Log only `err.message`.

**kb-sync/handlers/confluence-sync.ts** — `const log = createLogger('kb-sync/confluence');`
- `console.log('[KB Sync] Confluence: ...')` -> `log.info('Pages to ingest', { count: pages.length })`

**kb-sync/handlers/bitbucket-sync.ts** — `const log = createLogger('kb-sync/bitbucket');`
- `console.log('[KB Sync] Bitbucket: ...')` -> `log.info('Repos to scrape', { count: repos.length, workspace })`
- `console.error('[KB Sync] BB skip ...')` -> `log.warn('Skipping file', { path: fp, error: e instanceof Error ? e.message : String(e) })`
- SECURITY: The `auth` variable contains base64-encoded credentials. Ensure it is NEVER passed to any log call. Only log workspace, repoSlug, branch — never apiToken or email from config.

**discovery/index.ts** — `const log = createLogger('discovery');`
- `console.log('[discovery] Fan-out triggered', {...})` -> `log.info('Fan-out triggered', {...})`
- `console.log('[discovery] Fan-out complete', {...})` -> `log.info('Fan-out complete', {...})`
- `console.log('[discovery] Starting scan', {...})` -> `log.info('Starting scan', {...})`
- `console.log('[discovery] Scanning account', {...})` -> `log.debug('Scanning account', {...})`  (high-frequency, demote to debug)
- `console.log('[discovery] Account scan complete', {...})` -> `log.info('Account scan complete', {...})`
- `console.error('[discovery] Account scan failed', {...})` -> `log.error('Account scan failed', {...})`
- `console.log('[discovery] Scan completed/failed', {...})` -> `log.info(...)` for completed, `log.error(...)` for failed
- `console.log('[discovery] Registered queues', {...})` -> `log.info('Registered queues', {...})`
- SECURITY: Do NOT log `account.roleArn`, `account.externalId`, or `credentials` object. Only log accountId and regions.

**discovery/services/scanner.ts** — `const log = createLogger('discovery/scanner');`
- `console.log('[discovery/scanner] ... scanned N pages')` -> `log.debug('Paginated scan', { service, function, region, pages, items })` (high-frequency, debug level)
- `console.warn('[discovery/scanner] Throttled ...')` -> `log.warn('Throttled, retrying', { service, function, region, attempt, delayMs })`
- `console.warn('[discovery/scanner] Enrichment ... failed')` -> `log.warn('Enrichment failed', { type, method, service, error: ... })`
- `console.warn('[discovery/scanner] Tag fetch failed')` -> `log.warn('Tag fetch failed', { key, error: ... })`
- `console.warn('[discovery/scanner] Batch tag enrichment failed')` -> `log.warn('Batch tag enrichment failed', { service, error: ... })`
- `console.warn('[discovery/scanner] Describe enrichment failed')` -> `log.warn('Describe enrichment failed', { service, method, error: ... })`
- `console.warn('[discovery/scanner] Detail enrichment failed')` -> `log.warn('Detail enrichment failed', { key, error: ... })`
- `console.error('[discovery/scanner] Error scanning')` -> `log.error('Scan error', { service, function, region, error: msg })`

**discovery/services/custom-scanners.ts** — `const log = createLogger('discovery/custom');`
- `console.error('[discovery/custom] Error describing ECS services')` -> `log.error('ECS describe failed', { clusterArn, error: ... })`
- `console.warn('[discovery/custom] WAFv2 ...')` -> `log.warn('WAFv2 list failed', { scope, region, error: ... })`

**discovery/services/pg-writer.ts** — `const log = createLogger('discovery/pg-writer');`
- `console.error('[discovery/pg-writer] Error writing resources:')` -> `log.error('Failed writing resources', { error: ... })`
- `console.error('[discovery/pg-writer] Error saving sync status:')` -> `log.error('Failed saving sync status', { scanId, error: ... })`
- SECURITY: Do NOT log the full `error` object from pg — it may contain connection strings. Log only `error instanceof Error ? error.message : String(error)`.

**discovery/services/vector-processor.ts** — `const log = createLogger('discovery/vectors');`
- `console.error('[vector-processor] Failed embedding ...')` -> `log.error('Embedding failed', { resourceId: resource.resourceId, error: err instanceof Error ? err.message : String(err) })`
- `console.log('[vector-processor] Updated ...')` -> `log.info('Embeddings updated', { updated, total: uniqueResources.length, accountId })`

Note: `workers/src/jobs/kb-sync/handlers/file-upload.ts` and `workers/src/jobs/kb-sync/lib/embedding.ts` have NO console calls — skip them.
`workers/src/jobs/kb-sync/lib/vector-store.ts` also has no console calls — skip it.
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration && npx tsc --noEmit --project workers/tsconfig.json 2>&1 | head -30 && echo "---" && grep -rn "console\.\(log\|warn\|error\)" workers/src/jobs/kb-sync/ workers/src/jobs/discovery/ 2>/dev/null | grep -v node_modules | grep -v ".test." || echo "NO_CONSOLE_CALLS_FOUND"</automated>
  </verify>
  <done>Zero raw console.log/warn/error calls remain in kb-sync and discovery job files (excluding test files). All logging goes through createLogger with appropriate levels. No sensitive data (tokens, passwords, connection strings, roleArn, externalId) appears in any log call.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit --project workers/tsconfig.json` passes with no errors
2. `grep -rn "console\.\(log\|warn\|error\)" workers/src/jobs/kb-sync/ workers/src/jobs/discovery/` returns zero matches (excluding test files)
3. Every file in kb-sync/handlers/ and discovery/services/ imports from `../../lib/logger.js` or `../../../lib/logger.js`
4. No log call contains: apiToken, email (from config), auth header, roleArn, externalId, DATABASE_URL, connection strings
</verification>

<success_criteria>
- Logger module at workers/src/lib/logger.ts with createLogger factory
- LOG_LEVEL env var documented in workers/.env.example
- All 9 target files migrated from console.* to structured logger
- Log levels correctly assigned: debug for high-frequency/verbose, info for operational milestones, warn for recoverable issues, error for failures
- No sensitive data in any log statement
- TypeScript compiles cleanly
</success_criteria>

<output>
After completion, create `.planning/quick/260407-dqr-refactor-logging-to-industry-standard-lo/260407-dqr-SUMMARY.md`
</output>
