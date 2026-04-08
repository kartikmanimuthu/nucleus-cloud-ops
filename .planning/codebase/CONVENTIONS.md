# Coding Conventions

**Analysis Date:** 2026-04-08

## Language & Style

**TypeScript — strict mode everywhere:**

Three distinct tsconfig profiles:

- Root `tsconfig.json`: `ES2020`, `commonjs`, `strict: true`, `noImplicitAny`, `strictNullChecks`, `noImplicitReturns`, `noImplicitThis`, `alwaysStrict`. `noUnusedLocals` and `noUnusedParameters` are both `false` (not enforced).
- `web-ui/tsconfig.json`: `ES6`, `esnext` modules, `bundler` moduleResolution, `strict: true`, `noEmit: true`, `isolatedModules: true`. Path alias `@/*` maps to `web-ui/` root.
- `workers/tsconfig.json`: `ES2022`, `ESNext` modules, `bundler` moduleResolution, `strict: true`, `noImplicitAny`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Outputs to `dist/`. Test files excluded from compilation via `exclude`.

**Linting:**

- `web-ui/.eslintrc.json` extends `next/core-web-vitals` and `next/typescript` — no additional custom rules
- ESLint run: `cd web-ui && npm run lint`
- `next.config.mjs` sets `eslint.ignoreDuringBuilds: true` and `typescript.ignoreBuildErrors: true` — neither ESLint nor TypeScript errors block production builds

**Formatting:**

- No Prettier, Biome, or other formatter configured — formatting not enforced by tooling
- Indentation: 4 spaces in service/lib files; 2 spaces in UI components (both patterns coexist)

## Naming Conventions

**Files:**
- React components: `kebab-case.tsx` — e.g., `web-ui/components/accounts/accounts-client-component.tsx`, `web-ui/components/accounts/account-details-dialog.tsx`
- Services: `kebab-case-service.ts` — e.g., `web-ui/lib/account-service.ts`, `web-ui/lib/audit-service.ts`, `web-ui/lib/schedule-service.ts`
- Hooks: `use-kebab-case.ts` — e.g., `web-ui/hooks/use-debounce.ts`, `web-ui/hooks/use-toast.ts`, `web-ui/hooks/use-mobile.tsx`
- API routes: directory-based with `route.ts` — e.g., `web-ui/app/api/accounts/route.ts`, `web-ui/app/api/schedules/[scheduleId]/route.ts`
- Test files: `<module>.test.ts` or `<module>.property.test.ts` — colocated with source or in `web-ui/tests/` subdirectory
- Repository implementations: `postgres.ts` with colocated `postgres.test.ts` and `interface.ts` — e.g., `web-ui/lib/db/repositories/account/postgres.ts`
- Lambda handlers: `src/index.ts`
- Workers jobs: `src/jobs/<job-name>/index.ts` — e.g., `workers/src/jobs/scheduler/index.ts`

**Functions & Exports:**
- React components: `PascalCase` named exports — e.g., `export function AccountsList(...)`
- Service classes: `PascalCase` class with static methods — e.g., `class AccountService { static async getAccounts(...) }`
- Utility functions: `camelCase` — e.g., `cn()`, `useDebounce()`, `handleDynamoDBError()`
- Hooks: `use` prefix + camelCase — e.g., `useDebounce`, `useDebouncedCallback`, `useToast`
- Factory functions: `get` prefix + `PascalCase` — e.g., `getAccountRepository()`, `getTenantClient()`, `getBoss()`

**Variables & Types:**
- Types/interfaces: `PascalCase` — e.g., `UIAccount`, `AccountMetadata`, `ReflectionState`, `PermissionSet`
- Repository interfaces: `I` prefix — e.g., `IAccountRepository`, `IScheduleRepository`, `IAuditLogRepository`
- Enum-style string constants: `SCREAMING_SNAKE_CASE` — e.g., `TENANT_SCOPED_MODELS`, `TTL_30_DAYS`, `MAX_REFLECT_ITERATIONS`
- camelCase for local variables and function parameters

## Import Patterns

**Path Alias:**
- `@/` maps to `web-ui/` root (`web-ui/tsconfig.json` paths: `"@/*": ["./*"]`)
- Always use `@/` for cross-directory imports in web-ui: `import { AccountService } from '@/lib/account-service'`
- Relative imports only within the same directory

**Import Order (observed pattern):**
1. Next.js / React core (`next/server`, `react`, `next-auth`)
2. Third-party packages (`@langchain/...`, `@aws-sdk/...`, `zod`, `pg-boss`)
3. Internal `@/lib/...` services and utilities
4. Internal `@/components/...` UI
5. Types (`@/lib/types`)

**Workers module system:**
- Workers use ESM (`"type": "module"` in `workers/package.json`)
- Imports use `.js` extension suffix — e.g., `import { createBoss } from './boss.js'`
- Web-ui does NOT use `.js` extensions (bundler moduleResolution handles it)

**Module Organization:**
- Services: individual files per domain in `web-ui/lib/` (no barrel index)
- Repository factory: `web-ui/lib/db/repository-factory.ts` — single entry point for all repository access
- UI primitives: `web-ui/components/ui/` (55 Radix-based shadcn/ui components — do not modify)
- Feature components: `web-ui/components/<domain>/` (e.g., `accounts/`, `agent/`, `inventory/`, `schedules/`, `settings/`)

## Component Patterns

**React:**
- Functional components only — no class components
- `"use client"` directive required for any component using hooks or browser APIs
- Props typed inline with object destructuring: `function Component({ prop }: { prop: Type })`
- Named exports (not default exports) for components

**State Management:**
- Local state: `useState` for component-level state
- Side effects: `useEffect` with explicit dependency arrays
- No global state library (no Redux/Zustand) — server state via API calls
- Forms: `react-hook-form` with `@hookform/resolvers` + `zod` schemas

**Styling:**
- Tailwind CSS utility classes — never raw CSS unless in `styles/`
- `cn()` utility from `@/lib/utils` for conditional class merging (`clsx` + `tailwind-merge`)
- Dark mode via `class` strategy (`web-ui/tailwind.config.ts`: `darkMode: ["class"]`)
- HSL CSS custom properties for theming: `hsl(var(--primary))`, `hsl(var(--background))`, etc.
- Radix UI primitives wrapped in `web-ui/components/ui/` — consume these, never rebuild

**Component Example:**
```typescript
"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function AccountsList({ accounts, loading }: { accounts: UIAccount[]; loading: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  // ...
}
```

## API Patterns

**Route Structure:**
- All routes in `web-ui/app/api/<domain>/route.ts`
- Named exports for HTTP methods: `export async function GET(...)`, `export async function POST(...)`
- Parameters: `NextRequest` as first arg; dynamic segments via `params` second arg
- 21 API domains: `accounts`, `agent-ops`, `ask-ai`, `audit`, `auth`, `chat`, `deep-agent`, `discovery`, `enhance-prompt`, `health`, `inventory`, `invitations`, `knowledge-base`, `mcp-servers`, `scheduler`, `schedules`, `settings`, `skills`, `tenants`, `threads`, `v1`

**Auth & RBAC (required on every mutating route):**
```typescript
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Account');
    if (authError) return authError;
    const tenantId = await getSessionTenantId();
    // ...
}
```

- `authorize(action, subject)` from `@/lib/rbac/authorize` — returns `null` (OK) or `NextResponse` (401/403)
- Actions: `'read' | 'create' | 'update' | 'delete'`
- Subjects: `'Account' | 'Schedule' | ...` (mapped to modules in `web-ui/lib/rbac/types.ts`)
- SuperAdmin bypasses all permission checks
- Custom roles resolved from DB via `getCustomRolePermissions(role, tenantId)`
- Tenant ID extracted via `getSessionTenantId()` from `@/lib/auth-session` — throws if no session

**Response Format:**
- Always `NextResponse.json(data, { status: N })`
- Success: `{ success: true, data: ..., totalCount?: ... }`
- Error: `{ success: false, error: string }`
- Default status 200 for success, 500 for server errors, 401/403 for auth errors

**Error Handling:**
```typescript
try {
    // operation
    return NextResponse.json({ success: true, data: result });
} catch (error) {
    console.error('API - Error description:', error);
    return NextResponse.json({
        success: false,
        error: error instanceof Error ? error.message : 'Fallback message'
    }, { status: 500 });
}
```

**Logging:**
- `console.log` for operation start: `'API - GET /api/accounts - Fetching accounts'`
- `console.error` for caught errors: `'API - Error fetching accounts:', error`
- Workers prefix: `'[workers] Starting pg-boss...'`
- No structured logging library — raw console throughout

## Database Patterns

**ORM & Client:**
- Prisma ORM (`@prisma/client` ^5.22.0) for all PostgreSQL access
- Schema at `prisma/schema.prisma` — generator outputs to `web-ui/node_modules/.prisma/client`
- PostgreSQL 16 with pgvector extension (Docker: `pgvector/pgvector:pg16`)
- pg-boss (`pg-boss` ^10.4.2) for job queue — web-ui is producer-only (`web-ui/lib/boss-client.ts`), workers container processes jobs (`workers/src/boss.ts`)

**Prisma Client Singleton:**
- `getPrismaClient()` from `web-ui/lib/db/pg-config.ts` — global singleton, survives Next.js hot reloads in dev
- Production: `log: ['error']` only
- Development: `log: ['query', 'error', 'warn']`

**Tenant-Scoped Client:**
- `getTenantClient(tenantId)` from `web-ui/lib/db/pg-config.ts` — wraps singleton via `$extends` with query middleware
- Automatically injects `tenantId` into WHERE, data, and create clauses for all 17 tenant-scoped models
- Models listed in `TENANT_SCOPED_MODELS` set in `web-ui/lib/db/pg-config.ts`
- Throws if `tenantId` is falsy — prevents accidental cross-tenant queries
- `$executeRaw` and `$queryRawUnsafe` are NOT intercepted — callers must manually scope raw SQL
- Created per-request, not cached

**Repository Pattern:**
- Interface + implementation per entity in `web-ui/lib/db/repositories/<entity>/`
- Each entity has: `interface.ts` (contract), `postgres.ts` (implementation), `postgres.test.ts` (unit tests)
- 12 repositories: account, agent-ops-event, agent-ops-run, audit-log, data-source, inventory, knowledge-base, rbac, schedule, schedule-execution, scheduled-task, tenant-config
- Factory at `web-ui/lib/db/repository-factory.ts` — one `get<Entity>Repository()` function per entity
- Factory uses `require()` (not import) to avoid circular dependency issues — each has `eslint-disable` comment
- `isUsingPostgres()` always returns `true` — DynamoDB implementations removed

**Service Layer:**
- Static class methods: `AccountService.getAccounts(filters)`, `ScheduleService.createSchedule(data, tenantId)`
- Services delegate to repositories via factory: `getAccountRepository().getAccounts(filters)`
- Every mutating service method emits an audit log via `AuditService.logUserAction()`
- Services live in `web-ui/lib/<domain>-service.ts`

**Migrations:**
- Prisma Migrate: `prisma migrate dev --schema=../prisma/schema.prisma` (from web-ui)
- Auto-run on dev/start via `predev` and `prestart` scripts: `prisma migrate deploy`
- Migration files in `prisma/migrations/`

**pg-boss Job Queue:**
- Producer: `web-ui/lib/boss-client.ts` — singleton, `noScheduling: true`, `noSupervisor: true`
- Consumer: `workers/src/boss.ts` — `retryLimit: 3`, `retryDelay: 30s`, `retryBackoff: true`, `expireInHours: 4`
- Three job domains: `scheduler`, `kb-sync`, `discovery` — each in `workers/src/jobs/<domain>/`
- Graceful shutdown on SIGTERM/SIGINT in `workers/src/index.ts`

## Agent Patterns

**Tool Definition:**
```typescript
import { tool } from '@langchain/core/tools';
export const myTool = tool(
  async ({ param }: { param: string }) => { ... },
  { name: 'my_tool', description: '...', schema: z.object({ param: z.string() }) }
);
```

**Critical:** Always call `sanitizeMessagesForBedrock()` from `web-ui/lib/agent/agent-shared.ts` before any Bedrock API call — orphaned `tool_call` IDs without matching `tool_result` cause `ValidationException`.

**Audit Logging:**
- Every action modifying AWS resources must be audit-logged via `AuditService` from `@/lib/audit-service`

---

*Convention analysis: 2026-04-08*
