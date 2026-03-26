# Coding Conventions

**Analysis Date:** 2026-03-26

## Language & Style

**TypeScript — strict mode everywhere:**

- `web-ui/tsconfig.json`: `"strict": true`, `"noEmit": true`, `"moduleResolution": "bundler"`, `"isolatedModules": true`
- Root `tsconfig.json` (CDK): `"strict": true`, `"noImplicitAny": true`, `"strictNullChecks": true`, `"noImplicitReturns": true`
- CDK tsconfig also sets `"noImplicitThis": true`, `"alwaysStrict": true`
- `noUnusedLocals` and `noUnusedParameters` are both `false` (not enforced)

**Linting:**

- `web-ui/.eslintrc.json` extends `next/core-web-vitals` and `next/typescript` — no additional custom rules
- ESLint run: `cd web-ui && npm run lint`
- Lambda scheduler has its own ESLint: `cd lambda/scheduler && npm run lint`

**Formatting:**

- No Prettier config detected — formatting not enforced by tooling
- Indentation: 4 spaces in service/lib files; 2 spaces in UI components (both patterns coexist)

## Naming Conventions

**Files:**
- React components: `kebab-case.tsx` (e.g., `accounts-client-component.tsx`, `account-details-dialog.tsx`)
- Services: `kebab-case-service.ts` (e.g., `account-service.ts`, `audit-service.ts`, `client-account-service.ts`)
- Hooks: `use-kebab-case.ts` (e.g., `use-debounce.ts`, `use-mobile.tsx`)
- API routes: directory-based with `route.ts` (e.g., `web-ui/app/api/accounts/route.ts`)
- Test files: `<module>.test.ts` or `<module>.property.test.ts`
- Lambda handlers: `src/index.ts`

**Functions & Exports:**
- React components: `PascalCase` named exports (e.g., `export function AccountsList(...)`)
- Service classes: `PascalCase` class with static methods (e.g., `class AccountService { static async getAccounts(...) }`)
- Utility functions: `camelCase` (e.g., `cn()`, `useDebounce()`, `handleDynamoDBError()`)
- Hooks: `use` prefix + camelCase (e.g., `useDebounce`, `useDebouncedCallback`)

**Variables & Types:**
- Types/interfaces: `PascalCase` (e.g., `UIAccount`, `AccountMetadata`, `ReflectionState`)
- Enum-style string constants: `SCREAMING_SNAKE_CASE` (e.g., `AGENT_OPS_TABLE_NAME`, `TTL_30_DAYS`, `MAX_REFLECT_ITERATIONS`)
- camelCase for local variables and function parameters

## Import Patterns

**Path Alias:**
- `@/` maps to `web-ui/` root (`tsconfig.json` paths: `"@/*": ["./*"]`)
- Always use `@/` for cross-directory imports in web-ui: `import { AccountService } from '@/lib/account-service'`
- Relative imports only within the same directory

**Import Order (observed pattern):**
1. Next.js / React core (`next/server`, `react`, `next-auth`)
2. Third-party packages (`@langchain/...`, `@aws-sdk/...`, `zod`)
3. Internal `@/lib/...` services and utilities
4. Internal `@/components/...` UI
5. Types (`@/lib/types`)

**Module Organization:**
- Services barrel: individual files per domain in `web-ui/lib/` (no barrel index)
- UI primitives: `web-ui/components/ui/` — Radix-based shadcn/ui components (do not modify)
- Feature components: `web-ui/components/<domain>/` (e.g., `accounts/`, `agent/`, `inventory/`)

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

**Auth & RBAC (required on every mutating route):**
```typescript
import { authorize } from '@/lib/rbac/authorize';

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Account');
    if (authError) return authError;
    // ...
}
```

**Response Format:**
- Always `NextResponse.json(data, { status: N })`
- Success: `{ success: true, data: ..., totalCount?: ... }`
- Error: `{ success: false, error: string }`
- Default status 200 for success, 500 for server errors, 403 for auth errors

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
- No structured logging library — raw console

**AWS Clients:**
- Always `getDynamoDBDocumentClient()` from `@/lib/aws-config` — never instantiate DynamoDB directly
- Always `@aws-sdk/lib-dynamodb` (DocumentClient) — never raw DynamoDB client
- Cross-account calls via `STSClient + AssumeRoleCommand` — never hardcode credentials

**RBAC Authorization:**
- `authorize(action, Subject)` from `@/lib/rbac/authorize` — returns `null` (OK) or `NextResponse` (403)
- Actions: `'read' | 'create' | 'update' | 'delete'`
- Subjects: `'Account' | 'Schedule' | ...` (defined in `web-ui/lib/rbac/types.ts`)

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

*Convention analysis: 2026-03-26*
