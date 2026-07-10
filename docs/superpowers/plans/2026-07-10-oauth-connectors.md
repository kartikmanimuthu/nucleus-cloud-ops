# OAuth Connectors (Jira · Slack · Google) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-click OAuth "Connect" (bring-your-own OAuth app) for Jira, Slack, and Google with encrypted per-tenant token storage, a manual fallback, and wiring of the existing Jira/Slack outbound adapters to prefer OAuth tokens.

**Architecture:** Three tenant-scoped layers per connector — `ConnectorApp` (the tenant's OAuth app client id/secret), `ConnectorConnection` (encrypted OAuth grants), and (Slack) a workspace-bot install. New `/api/connections/*` routes run the authorize→callback exchange; a provider registry describes each provider. Existing gateway adapters read an active connection and fall back to today's manual creds.

**Tech Stack:** Next.js 15 App Router, Prisma (dual client), AES-256-GCM (`lib/crypto`), TanStack Query, sonner, RHF+Zod, Vitest.

## Global Constraints

- Multi-tenant safety: all DB access via `getTenantClient(tenantId)` or manual `tenantId` scoping; never `getPrismaClient()` in business logic without a tenant filter.
- Repository pattern: no Prisma calls from routes/services — go through `lib/db/repositories/connectors/`.
- Encryption reuses the key derived from `NEXTAUTH_SECRET` (`lib/crypto/provider-credentials.ts`); all `*Enc` columns encrypted; secrets never returned by GETs (masked).
- RBAC: `authorize('update', 'AgentOps')` on every mutating route; `authorize('read', 'AgentOps')` on reads. (`AgentOps` subject already governs the channels module.)
- Audit: `AuditService.logUserAction(...)` on every mutation (app-cred change, connect, disconnect, bot install).
- API responses: `NextResponse.json(...)`; success `{ success: true, ... }`, error `{ success: false, error }`.
- Providers: `provider ∈ { 'jira', 'slack', 'google' }` — validate and 400 on anything else.
- Indentation: 4 spaces in `lib/`/route files; 2 spaces in components (match surrounding files).
- Prisma dual-generate after schema change: `cd apps/web-ui && bun run db:generate` and `cd apps/workers && bun run db:generate`.

---

### Task 1: Generic secret encryption helpers

**Files:**
- Modify: `apps/web-ui/lib/crypto/provider-credentials.ts`
- Test: `apps/web-ui/tests/crypto/secret-box.test.ts`

**Interfaces:**
- Produces: `encryptJson<T>(value: T): string`, `decryptJson<T>(payload: string): T` (same wire format `base64(iv).base64(tag).base64(ct)` and key as `encryptCredentials`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/crypto/secret-box.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 'test-secret-for-crypto' } }));

import { encryptJson, decryptJson } from '@/lib/crypto/provider-credentials';

describe('encryptJson/decryptJson', () => {
    it('round-trips an object', () => {
        const value = { accessToken: 'xoxb-123', scopes: ['a', 'b'] };
        const enc = encryptJson(value);
        expect(enc).not.toContain('xoxb-123');
        expect(enc.split('.')).toHaveLength(3);
        expect(decryptJson<typeof value>(enc)).toEqual(value);
    });

    it('round-trips a bare string', () => {
        const enc = encryptJson('secret-string');
        expect(decryptJson<string>(enc)).toBe('secret-string');
    });

    it('rejects a tampered payload', () => {
        const enc = encryptJson({ a: 1 });
        const [iv, tag, ct] = enc.split('.');
        const tampered = [iv, tag, Buffer.from('zzzz').toString('base64')].join('.');
        expect(() => decryptJson(tampered)).toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run tests/crypto/secret-box.test.ts`
Expected: FAIL — `encryptJson is not a function`.

- [ ] **Step 3: Add the helpers**

Append to `apps/web-ui/lib/crypto/provider-credentials.ts` (reuses the existing private `getKey`, `ALGORITHM`, `IV_LENGTH`):

```typescript
/** Encrypts any JSON-serializable value into the wire format string. */
export function encryptJson<T>(value: T): string {
    const key = getKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** Decrypts a wire-format string produced by encryptJson back into a value. */
export function decryptJson<T>(payload: string): T {
    const key = getKey();
    const parts = payload.split('.');
    if (parts.length !== 3) throw new Error('Malformed encrypted payload');
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/crypto/secret-box.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/crypto/provider-credentials.ts apps/web-ui/tests/crypto/secret-box.test.ts
git commit -m "feat(connectors): generic encryptJson/decryptJson helpers"
```

---

### Task 2: Prisma models + migration

**Files:**
- Modify: `libs/prisma/schema.prisma`
- Create: migration via `db:migrate`

**Interfaces:**
- Produces: Prisma models `ConnectorApp`, `ConnectorConnection` (fields exactly as in the spec's Data model section), tables `connector_apps`, `connector_connections`.

- [ ] **Step 1: Add models to schema**

Append to `libs/prisma/schema.prisma`:

```prisma
model ConnectorApp {
  id               String   @id @default(cuid())
  tenantId         String
  provider         String   // jira | slack | google
  clientId         String
  clientSecretEnc  String
  signingSecretEnc String?
  botTokenEnc      String?
  botAccountLabel  String?
  status           String   @default("configured")
  createdBy        String   @default("system")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([tenantId, provider])
  @@index([tenantId])
  @@map("connector_apps")
}

model ConnectorConnection {
  id                String    @id @default(cuid())
  tenantId          String
  provider          String
  accountLabel      String
  externalAccountId String
  accessTokenEnc    String
  refreshTokenEnc   String?
  expiresAt         DateTime?
  scopes            String[]  @default([])
  tokenType         String    @default("user") // user | bot
  metadata          Json      @default("{}")
  status            String    @default("active") // active | expired | revoked
  createdBy         String    @default("system")
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@index([tenantId, provider])
  @@index([tenantId, provider, status])
  @@map("connector_connections")
}
```

- [ ] **Step 2: Create + apply the migration**

Run: `cd apps/web-ui && bun run db:migrate` — name it `add_connector_oauth`.
Expected: migration SQL created under `libs/prisma/migrations/`, applied to local Postgres, no errors.

- [ ] **Step 3: Regenerate both clients**

Run: `cd apps/web-ui && bun run db:generate && cd ../workers && bun run db:generate`
Expected: both clients regenerate; `ConnectorApp`/`ConnectorConnection` available.

- [ ] **Step 4: Verify typecheck sees the models**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -i connector || echo "no connector type errors"`
Expected: `no connector type errors`.

- [ ] **Step 5: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations
git commit -m "feat(connectors): ConnectorApp + ConnectorConnection models + migration"
```

---

### Task 3: Connectors repository

**Files:**
- Create: `apps/web-ui/lib/db/repositories/connectors/interface.ts`
- Create: `apps/web-ui/lib/db/repositories/connectors/postgres.ts`
- Modify: `apps/web-ui/lib/db/repository-factory.ts`
- Test: `apps/web-ui/tests/db/connectors-repository.test.ts`

**Interfaces:**
- Consumes: `getTenantClient(tenantId)` from `@/lib/db/pg-config`.
- Produces:
  - Types `ConnectorProvider = 'jira'|'slack'|'google'`, `ConnectorAppRecord`, `ConnectorConnectionRecord` (mirror the Prisma rows).
  - `IConnectorRepository`:
    - `getApp(provider, tenantId): Promise<ConnectorAppRecord | null>`
    - `upsertApp(input, tenantId, updatedBy): Promise<void>` where `input = { provider, clientId, clientSecretEnc, signingSecretEnc?, botTokenEnc?, botAccountLabel? }` (undefined fields are left unchanged on update)
    - `deleteApp(provider, tenantId): Promise<void>`
    - `listConnections(provider, tenantId): Promise<ConnectorConnectionRecord[]>`
    - `getActiveConnection(provider, tenantId): Promise<ConnectorConnectionRecord | null>` (most-recently-updated `status='active'`)
    - `upsertConnection(input, tenantId, createdBy): Promise<ConnectorConnectionRecord>` (match on `(tenantId, provider, externalAccountId)`)
    - `updateConnectionTokens(id, tenantId, patch): Promise<void>` where `patch = { accessTokenEnc, refreshTokenEnc?, expiresAt?, status? }`
    - `deleteConnection(id, tenantId): Promise<void>`
  - `getConnectorRepository(): IConnectorRepository`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/db/connectors-repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = { apps: [] as any[], conns: [] as any[] };
const tx = {
    connectorApp: {
        findFirst: vi.fn(async ({ where }: any) => store.apps.find(a => a.tenantId === where.tenantId && a.provider === where.provider) ?? null),
        upsert: vi.fn(async ({ where, create, update }: any) => {
            const existing = store.apps.find(a => a.tenantId === where.tenantId_provider.tenantId && a.provider === where.tenantId_provider.provider);
            if (existing) Object.assign(existing, update);
            else store.apps.push({ id: 'app1', ...create });
        }),
        deleteMany: vi.fn(async ({ where }: any) => { store.apps = store.apps.filter(a => !(a.tenantId === where.tenantId && a.provider === where.provider)); }),
    },
    connectorConnection: {
        findMany: vi.fn(async ({ where }: any) => store.conns.filter(c => c.tenantId === where.tenantId && c.provider === where.provider && (!where.status || c.status === where.status))),
        findFirst: vi.fn(async ({ where }: any) => store.conns.find(c => c.tenantId === where.tenantId && c.provider === where.provider && (!where.status || c.status === where.status)) ?? null),
        upsert: vi.fn(async ({ create }: any) => { const rec = { id: 'c' + (store.conns.length + 1), ...create }; store.conns.push(rec); return rec; }),
        updateMany: vi.fn(async ({ where, data }: any) => { const c = store.conns.find(x => x.id === where.id && x.tenantId === where.tenantId); if (c) Object.assign(c, data); return { count: c ? 1 : 0 }; }),
        deleteMany: vi.fn(async ({ where }: any) => { store.conns = store.conns.filter(c => !(c.id === where.id && c.tenantId === where.tenantId)); }),
    },
};
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: () => tx }));

import { getConnectorRepository } from '@/lib/db/repositories/connectors/postgres';

beforeEach(() => { store.apps = []; store.conns = []; });

describe('ConnectorRepository', () => {
    it('upserts and reads app credentials', async () => {
        const repo = getConnectorRepository();
        await repo.upsertApp({ provider: 'jira', clientId: 'cid', clientSecretEnc: 'enc' }, 'tenantA', 'user1');
        const app = await repo.getApp('jira', 'tenantA');
        expect(app?.clientId).toBe('cid');
    });

    it('lists and deletes connections scoped by tenant', async () => {
        const repo = getConnectorRepository();
        await repo.upsertConnection({ provider: 'jira', accountLabel: 'Acme', externalAccountId: 'cloud1', accessTokenEnc: 'a', scopes: ['x'], tokenType: 'user', metadata: {} }, 'tenantA', 'user1');
        expect(await repo.listConnections('jira', 'tenantA')).toHaveLength(1);
        expect(await repo.listConnections('jira', 'tenantB')).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run tests/db/connectors-repository.test.ts`
Expected: FAIL — cannot find `connectors/postgres`.

- [ ] **Step 3: Write the interface**

```typescript
// apps/web-ui/lib/db/repositories/connectors/interface.ts
export type ConnectorProvider = 'jira' | 'slack' | 'google';

export interface ConnectorAppRecord {
    id: string;
    tenantId: string;
    provider: string;
    clientId: string;
    clientSecretEnc: string;
    signingSecretEnc: string | null;
    botTokenEnc: string | null;
    botAccountLabel: string | null;
    status: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface ConnectorConnectionRecord {
    id: string;
    tenantId: string;
    provider: string;
    accountLabel: string;
    externalAccountId: string;
    accessTokenEnc: string;
    refreshTokenEnc: string | null;
    expiresAt: Date | null;
    scopes: string[];
    tokenType: string;
    metadata: unknown;
    status: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface UpsertAppInput {
    provider: ConnectorProvider;
    clientId?: string;
    clientSecretEnc?: string;
    signingSecretEnc?: string;
    botTokenEnc?: string;
    botAccountLabel?: string;
}

export interface UpsertConnectionInput {
    provider: ConnectorProvider;
    accountLabel: string;
    externalAccountId: string;
    accessTokenEnc: string;
    refreshTokenEnc?: string;
    expiresAt?: Date | null;
    scopes: string[];
    tokenType: 'user' | 'bot';
    metadata: Record<string, unknown>;
}

export interface ConnectionTokenPatch {
    accessTokenEnc: string;
    refreshTokenEnc?: string;
    expiresAt?: Date | null;
    status?: string;
}

export interface IConnectorRepository {
    getApp(provider: ConnectorProvider, tenantId: string): Promise<ConnectorAppRecord | null>;
    upsertApp(input: UpsertAppInput, tenantId: string, updatedBy: string): Promise<void>;
    deleteApp(provider: ConnectorProvider, tenantId: string): Promise<void>;
    listConnections(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord[]>;
    getActiveConnection(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord | null>;
    upsertConnection(input: UpsertConnectionInput, tenantId: string, createdBy: string): Promise<ConnectorConnectionRecord>;
    updateConnectionTokens(id: string, tenantId: string, patch: ConnectionTokenPatch): Promise<void>;
    deleteConnection(id: string, tenantId: string): Promise<void>;
}
```

- [ ] **Step 4: Write the postgres implementation**

```typescript
// apps/web-ui/lib/db/repositories/connectors/postgres.ts
import { getTenantClient } from '@/lib/db/pg-config';
import type {
    IConnectorRepository, ConnectorProvider, ConnectorAppRecord,
    ConnectorConnectionRecord, UpsertAppInput, UpsertConnectionInput, ConnectionTokenPatch,
} from './interface';

class ConnectorPostgresRepository implements IConnectorRepository {
    async getApp(provider: ConnectorProvider, tenantId: string): Promise<ConnectorAppRecord | null> {
        const db = getTenantClient(tenantId);
        return (await db.connectorApp.findFirst({ where: { tenantId, provider } })) as ConnectorAppRecord | null;
    }

    async upsertApp(input: UpsertAppInput, tenantId: string, updatedBy: string): Promise<void> {
        const db = getTenantClient(tenantId);
        const update: Record<string, unknown> = { updatedBy };
        for (const k of ['clientId', 'clientSecretEnc', 'signingSecretEnc', 'botTokenEnc', 'botAccountLabel'] as const) {
            if (input[k] !== undefined) update[k] = input[k];
        }
        await db.connectorApp.upsert({
            where: { tenantId_provider: { tenantId, provider: input.provider } },
            update,
            create: {
                tenantId,
                provider: input.provider,
                clientId: input.clientId ?? '',
                clientSecretEnc: input.clientSecretEnc ?? '',
                signingSecretEnc: input.signingSecretEnc ?? null,
                botTokenEnc: input.botTokenEnc ?? null,
                botAccountLabel: input.botAccountLabel ?? null,
                createdBy: updatedBy,
            },
        });
    }

    async deleteApp(provider: ConnectorProvider, tenantId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.connectorApp.deleteMany({ where: { tenantId, provider } });
    }

    async listConnections(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord[]> {
        const db = getTenantClient(tenantId);
        return (await db.connectorConnection.findMany({
            where: { tenantId, provider },
            orderBy: { updatedAt: 'desc' },
        })) as ConnectorConnectionRecord[];
    }

    async getActiveConnection(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord | null> {
        const db = getTenantClient(tenantId);
        return (await db.connectorConnection.findFirst({
            where: { tenantId, provider, status: 'active' },
            orderBy: { updatedAt: 'desc' },
        })) as ConnectorConnectionRecord | null;
    }

    async upsertConnection(input: UpsertConnectionInput, tenantId: string, createdBy: string): Promise<ConnectorConnectionRecord> {
        const db = getTenantClient(tenantId);
        const existing = await db.connectorConnection.findFirst({
            where: { tenantId, provider: input.provider, externalAccountId: input.externalAccountId },
        });
        if (existing) {
            await db.connectorConnection.updateMany({
                where: { id: existing.id, tenantId },
                data: {
                    accountLabel: input.accountLabel,
                    accessTokenEnc: input.accessTokenEnc,
                    refreshTokenEnc: input.refreshTokenEnc ?? existing.refreshTokenEnc,
                    expiresAt: input.expiresAt ?? null,
                    scopes: input.scopes,
                    tokenType: input.tokenType,
                    metadata: input.metadata as object,
                    status: 'active',
                },
            });
            return (await db.connectorConnection.findFirst({ where: { id: existing.id, tenantId } })) as ConnectorConnectionRecord;
        }
        return (await db.connectorConnection.create({
            data: {
                tenantId,
                provider: input.provider,
                accountLabel: input.accountLabel,
                externalAccountId: input.externalAccountId,
                accessTokenEnc: input.accessTokenEnc,
                refreshTokenEnc: input.refreshTokenEnc ?? null,
                expiresAt: input.expiresAt ?? null,
                scopes: input.scopes,
                tokenType: input.tokenType,
                metadata: input.metadata as object,
                createdBy,
            },
        })) as ConnectorConnectionRecord;
    }

    async updateConnectionTokens(id: string, tenantId: string, patch: ConnectionTokenPatch): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.connectorConnection.updateMany({
            where: { id, tenantId },
            data: {
                accessTokenEnc: patch.accessTokenEnc,
                ...(patch.refreshTokenEnc !== undefined ? { refreshTokenEnc: patch.refreshTokenEnc } : {}),
                ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
                ...(patch.status !== undefined ? { status: patch.status } : {}),
            },
        });
    }

    async deleteConnection(id: string, tenantId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.connectorConnection.deleteMany({ where: { id, tenantId } });
    }
}

let instance: ConnectorPostgresRepository | null = null;
export function getConnectorRepository(): IConnectorRepository {
    if (!instance) instance = new ConnectorPostgresRepository();
    return instance;
}
```

Note: the test's mock uses `upsert` for connections; the real impl uses `findFirst`+`create`/`updateMany`. Update the test mock's `connectorConnection` to also expose `create: vi.fn(async ({ data }) => { const rec = { id: 'c'+(store.conns.length+1), ...data }; store.conns.push(rec); return rec; })` so both paths are covered.

- [ ] **Step 5: Register in the factory**

Add to `apps/web-ui/lib/db/repository-factory.ts` (follow the existing `require`-based lazy pattern):

```typescript
import type { IConnectorRepository } from './repositories/connectors/interface';

export function getConnectorRepository(): IConnectorRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConnectorRepository: get } = require('./repositories/connectors/postgres');
    return get();
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/db/connectors-repository.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/db/repositories/connectors apps/web-ui/lib/db/repository-factory.ts apps/web-ui/tests/db/connectors-repository.test.ts
git commit -m "feat(connectors): tenant-scoped connectors repository + factory"
```

---

### Task 4: Provider registry + OAuth state signing

**Files:**
- Create: `apps/web-ui/lib/connectors/providers.ts`
- Create: `apps/web-ui/lib/connectors/oauth-state.ts`
- Test: `apps/web-ui/tests/connectors/oauth-state.test.ts`
- Test: `apps/web-ui/tests/connectors/providers.test.ts`

**Interfaces:**
- Produces:
  - `providers.ts`: `PROVIDERS: Record<ConnectorProvider, ProviderConfig>` and `getProviderConfig(p): ProviderConfig`. `ProviderConfig = { id, displayName, authorizeUrl, tokenUrl, scopes: string[], extraAuthorizeParams?: Record<string,string>, callbackPath: (origin)=>string }`.
  - `oauth-state.ts`: `signState(payload: { tenantId: string; provider: string; nonce: string }): string`, `verifyState(token: string): { tenantId: string; provider: string; nonce: string }` (throws on bad signature).

- [ ] **Step 1: Write the failing state test**

```typescript
// apps/web-ui/tests/connectors/oauth-state.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 'state-secret' } }));
import { signState, verifyState } from '@/lib/connectors/oauth-state';

describe('oauth-state', () => {
    it('round-trips signed state', () => {
        const p = { tenantId: 't1', provider: 'jira', nonce: 'n1' };
        expect(verifyState(signState(p))).toEqual(p);
    });
    it('rejects tampered state', () => {
        const token = signState({ tenantId: 't1', provider: 'jira', nonce: 'n1' });
        const [body] = token.split('.');
        expect(() => verifyState(`${body}.deadbeef`)).toThrow();
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/oauth-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement oauth-state**

```typescript
// apps/web-ui/lib/connectors/oauth-state.ts
import { createHmac } from 'crypto';
import { env } from '@/env';

export interface OAuthStatePayload { tenantId: string; provider: string; nonce: string; }

function sign(body: string): string {
    return createHmac('sha256', String(env.NEXTAUTH_SECRET)).update(body).digest('base64url');
}

export function signState(payload: OAuthStatePayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body)}`;
}

export function verifyState(token: string): OAuthStatePayload {
    const [body, sig] = token.split('.');
    if (!body || !sig || sign(body) !== sig) throw new Error('Invalid OAuth state');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
}
```

- [ ] **Step 4: Write the failing providers test**

```typescript
// apps/web-ui/tests/connectors/providers.test.ts
import { describe, it, expect } from 'vitest';
import { getProviderConfig } from '@/lib/connectors/providers';

describe('providers', () => {
    it('exposes jira/slack/google configs', () => {
        expect(getProviderConfig('jira').authorizeUrl).toContain('auth.atlassian.com');
        expect(getProviderConfig('google').authorizeUrl).toContain('accounts.google.com');
        expect(getProviderConfig('slack').authorizeUrl).toContain('slack.com');
        expect(getProviderConfig('google').scopes).toContain('https://www.googleapis.com/auth/calendar');
    });
    it('throws on unknown provider', () => {
        // @ts-expect-error invalid provider
        expect(() => getProviderConfig('bad')).toThrow();
    });
});
```

- [ ] **Step 5: Implement providers**

```typescript
// apps/web-ui/lib/connectors/providers.ts
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

export interface ProviderConfig {
    id: ConnectorProvider;
    displayName: string;
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    extraAuthorizeParams?: Record<string, string>;
}

export const PROVIDERS: Record<ConnectorProvider, ProviderConfig> = {
    jira: {
        id: 'jira',
        displayName: 'Jira',
        authorizeUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'],
        extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    },
    slack: {
        id: 'slack',
        displayName: 'Slack',
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        // user-token scopes for "connect as you"; bot scopes handled by install route
        scopes: ['channels:read', 'chat:write', 'users:read'],
    },
    google: {
        id: 'google',
        displayName: 'Google',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: [
            'openid', 'email', 'profile',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/calendar',
        ],
        extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    },
};

export function getProviderConfig(provider: string): ProviderConfig {
    const cfg = PROVIDERS[provider as ConnectorProvider];
    if (!cfg) throw new Error(`Unknown connector provider: ${provider}`);
    return cfg;
}

export function isConnectorProvider(p: string): p is ConnectorProvider {
    return p === 'jira' || p === 'slack' || p === 'google';
}
```

- [ ] **Step 6: Run both tests**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/oauth-state.test.ts tests/connectors/providers.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/connectors apps/web-ui/tests/connectors
git commit -m "feat(connectors): provider registry + signed OAuth state"
```

---

### Task 5: Token exchange + identity service

**Files:**
- Create: `apps/web-ui/lib/connectors/token-exchange.ts`
- Test: `apps/web-ui/tests/connectors/token-exchange.test.ts`

**Interfaces:**
- Consumes: `getProviderConfig` (Task 4), `ConnectorAppRecord` (Task 3), `decryptJson` (Task 1).
- Produces:
  - `exchangeCode(provider, app, code, redirectUri): Promise<TokenResult>` where `TokenResult = { accessToken, refreshToken?, expiresInSec?, scopes: string[] }`.
  - `fetchIdentity(provider, accessToken): Promise<{ accountLabel: string; externalAccountId: string; metadata: Record<string, unknown> }>`.
  - `refreshAccessToken(provider, app, refreshToken): Promise<TokenResult>`.
  - Decrypt of `app.clientSecretEnc` happens inside these via `decryptJson<string>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/connectors/token-exchange.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { encryptJson } from '@/lib/crypto/provider-credentials';
import { exchangeCode, fetchIdentity } from '@/lib/connectors/token-exchange';

const app = { clientId: 'cid', clientSecretEnc: encryptJson('secret') } as any;

beforeEach(() => vi.restoreAllMocks());

describe('token-exchange', () => {
    it('exchanges a google code', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a b' }),
        })) as any);
        const res = await exchangeCode('google', app, 'code', 'https://x/cb');
        expect(res.accessToken).toBe('at');
        expect(res.refreshToken).toBe('rt');
        expect(res.scopes).toEqual(['a', 'b']);
    });

    it('reads jira identity from accessible-resources', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ([{ id: 'cloud1', name: 'Acme', url: 'https://acme.atlassian.net' }]),
        })) as any);
        const id = await fetchIdentity('jira', 'at');
        expect(id.externalAccountId).toBe('cloud1');
        expect(id.metadata.apiBaseUrl).toBe('https://api.atlassian.com/ex/jira/cloud1');
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/token-exchange.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement token-exchange**

```typescript
// apps/web-ui/lib/connectors/token-exchange.ts
import { getProviderConfig } from './providers';
import { decryptJson } from '@/lib/crypto/provider-credentials';
import type { ConnectorProvider, ConnectorAppRecord } from '@/lib/db/repositories/connectors/interface';

export interface TokenResult { accessToken: string; refreshToken?: string; expiresInSec?: number; scopes: string[]; }
export interface Identity { accountLabel: string; externalAccountId: string; metadata: Record<string, unknown>; }

function clientSecret(app: Pick<ConnectorAppRecord, 'clientSecretEnc'>): string {
    return decryptJson<string>(app.clientSecretEnc);
}

function parseScopes(scope: unknown): string[] {
    if (typeof scope === 'string') return scope.split(/[ ,]+/).filter(Boolean);
    if (Array.isArray(scope)) return scope as string[];
    return [];
}

export async function exchangeCode(
    provider: ConnectorProvider, app: ConnectorAppRecord, code: string, redirectUri: string,
): Promise<TokenResult> {
    const cfg = getProviderConfig(provider);
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: app.clientId,
        client_secret: clientSecret(app),
    });
    const res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
    });
    const json: any = await res.json();
    if (!res.ok || json.error || json.ok === false) {
        throw new Error(`Token exchange failed: ${json.error || json.error_description || res.status}`);
    }
    // Slack nests the user token under authed_user
    if (provider === 'slack' && json.authed_user?.access_token) {
        return { accessToken: json.authed_user.access_token, scopes: parseScopes(json.authed_user.scope) };
    }
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresInSec: json.expires_in,
        scopes: parseScopes(json.scope),
    };
}

export async function refreshAccessToken(
    provider: ConnectorProvider, app: ConnectorAppRecord, refreshToken: string,
): Promise<TokenResult> {
    const cfg = getProviderConfig(provider);
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: app.clientId,
        client_secret: clientSecret(app),
    });
    const res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
    });
    const json: any = await res.json();
    if (!res.ok || json.error) throw new Error(`Token refresh failed: ${json.error || res.status}`);
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? refreshToken,
        expiresInSec: json.expires_in,
        scopes: parseScopes(json.scope),
    };
}

export async function fetchIdentity(provider: ConnectorProvider, accessToken: string): Promise<Identity> {
    if (provider === 'jira') {
        const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        const sites: any[] = await res.json();
        const site = sites?.[0];
        if (!site) throw new Error('No accessible Jira sites for this grant');
        return {
            accountLabel: site.name || site.url,
            externalAccountId: site.id,
            metadata: { cloudId: site.id, siteUrl: site.url, apiBaseUrl: `https://api.atlassian.com/ex/jira/${site.id}` },
        };
    }
    if (provider === 'google') {
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const info: any = await res.json();
        return { accountLabel: info.email || info.sub, externalAccountId: info.sub, metadata: { email: info.email } };
    }
    // slack: auth.test returns team + user identity
    const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info: any = await res.json();
    if (!info.ok) throw new Error(`Slack auth.test failed: ${info.error}`);
    return { accountLabel: `${info.team} / ${info.user}`, externalAccountId: info.user_id, metadata: { teamId: info.team_id, team: info.team } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/token-exchange.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/connectors/token-exchange.ts apps/web-ui/tests/connectors/token-exchange.test.ts
git commit -m "feat(connectors): OAuth token exchange + identity resolution"
```

---

### Task 6: App-credentials API routes

**Files:**
- Create: `apps/web-ui/app/api/connections/[provider]/app/route.ts`
- Test: `apps/web-ui/tests/connectors/app-route.test.ts`

**Interfaces:**
- Consumes: `getConnectorRepository` (factory), `encryptJson` (Task 1), `getProviderConfig`/`isConnectorProvider` (Task 4), `getSessionTenantId`/`getAuthSession` (`@/lib/auth-session`), `authorize` (`@/lib/rbac/authorize`), `AuditService`.
- Produces routes:
  - `GET` → `{ success, configured, status, provider, clientId, clientSecretHint, signingSecretConfigured, botConfigured, botAccountLabel, callbackUrl }` (secrets masked).
  - `PUT` body `{ clientId, clientSecret?, signingSecret? }` → encrypts + `upsertApp`.
  - `DELETE` → `deleteApp`.

- [ ] **Step 1: Write the failing test** (unit-tests the PUT handler with mocks)

```typescript
// apps/web-ui/tests/connectors/app-route.test.ts
import { describe, it, expect, vi } from 'vitest';

const upsertApp = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ upsertApp, getApp: vi.fn(), deleteApp: vi.fn() }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA', getAuthSession: async () => ({ user: { email: 'u@x.com' } }) }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn(async () => {}) } }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));

import { PUT } from '@/app/api/connections/[provider]/app/route';

describe('PUT /api/connections/[provider]/app', () => {
    it('encrypts client secret before saving', async () => {
        const req = new Request('http://x/api/connections/jira/app', { method: 'PUT', body: JSON.stringify({ clientId: 'cid', clientSecret: 'shh' }) });
        const res = await PUT(req, { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(200);
        const saved = upsertApp.mock.calls[0][0];
        expect(saved.clientId).toBe('cid');
        expect(saved.clientSecretEnc).not.toContain('shh');
        expect(saved.clientSecretEnc.split('.')).toHaveLength(3);
    });

    it('400s on unknown provider', async () => {
        const req = new Request('http://x', { method: 'PUT', body: '{}' });
        const res = await PUT(req, { params: Promise.resolve({ provider: 'nope' }) } as any);
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/app-route.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

```typescript
// apps/web-ui/app/api/connections/[provider]/app/route.ts
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { encryptJson, decryptJson } from '@/lib/crypto/provider-credentials';
import { isConnectorProvider } from '@/lib/connectors/providers';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

function hint(enc: string | null): string | null {
    if (!enc) return null;
    try { const s = decryptJson<string>(enc); return s.length <= 8 ? '••••' : `${s.slice(0, 3)}…${s.slice(-4)}`; }
    catch { return '••••'; }
}

function callbackUrl(req: Request, provider: string): string {
    const origin = new URL(req.url).origin;
    return `${origin}/api/connections/${provider}/callback`;
}

export async function GET(req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('read', 'AgentOps'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const app = await getConnectorRepository().getApp(provider as ConnectorProvider, tenantId);
    return NextResponse.json({
        success: true,
        provider,
        configured: !!app,
        status: app ? 'configured' : 'not_set',
        clientId: app?.clientId ?? '',
        clientSecretHint: hint(app?.clientSecretEnc ?? null),
        signingSecretConfigured: !!app?.signingSecretEnc,
        botConfigured: !!app?.botTokenEnc,
        botAccountLabel: app?.botAccountLabel ?? null,
        callbackUrl: callbackUrl(req, provider),
        slackInstallCallbackUrl: provider === 'slack' ? `${new URL(req.url).origin}/api/slack/install/callback` : undefined,
    });
}

export async function PUT(req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'AgentOps'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const body = await req.json().catch(() => ({})) as { clientId?: string; clientSecret?: string; signingSecret?: string };
    if (!body.clientId?.trim()) return NextResponse.json({ success: false, error: 'clientId is required' }, { status: 400 });

    await getConnectorRepository().upsertApp({
        provider: provider as ConnectorProvider,
        clientId: body.clientId.trim(),
        clientSecretEnc: body.clientSecret?.trim() ? encryptJson(body.clientSecret.trim()) : undefined,
        signingSecretEnc: body.signingSecret?.trim() ? encryptJson(body.signingSecret.trim()) : undefined,
    }, tenantId, 'user');

    const session = await getAuthSession();
    AuditService.logUserAction({
        eventType: 'connector.app_updated', severity: 'medium',
        apiRoute: `PUT /api/connections/${provider}/app`, httpMethod: 'PUT',
        action: 'Updated Connector App Credentials', resourceType: 'agent',
        resourceId: `${provider}-app`, resourceName: `${provider} OAuth app`,
        user: session?.user?.email || 'unknown', userType: 'user', status: 'success',
        details: `Updated ${provider} OAuth app credentials`, metadata: { tenantId },
    }).catch(() => {});

    return NextResponse.json({ success: true, configured: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'AgentOps'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    await getConnectorRepository().deleteApp(provider as ConnectorProvider, tenantId);
    return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/app-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/connections apps/web-ui/tests/connectors/app-route.test.ts
git commit -m "feat(connectors): app-credentials API route (GET/PUT/DELETE)"
```

---

### Task 7: Authorize route

**Files:**
- Create: `apps/web-ui/app/api/connections/[provider]/authorize/route.ts`
- Test: `apps/web-ui/tests/connectors/authorize-route.test.ts`

**Interfaces:**
- Consumes: `getConnectorRepository`, `getProviderConfig`/`isConnectorProvider`, `signState` (Task 4), `getSessionTenantId`, `authorize`.
- Produces: `GET` → 302 to provider `authorizeUrl` with `client_id`, `redirect_uri`, `scope`, `state`, provider extra params; sets `connector_oauth_nonce` httpOnly cookie.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/connectors/authorize-route.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => ({ clientId: 'cid', clientSecretEnc: 'x.y.z' }) }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA' }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { GET } from '@/app/api/connections/[provider]/authorize/route';

describe('GET authorize', () => {
    it('redirects to provider consent with state', async () => {
        const res = await GET(new Request('http://x/api/connections/google/authorize'), { params: Promise.resolve({ provider: 'google' }) } as any);
        expect(res.status).toBe(307);
        const loc = res.headers.get('location')!;
        expect(loc).toContain('accounts.google.com');
        expect(loc).toContain('client_id=cid');
        expect(loc).toContain('state=');
        expect(res.headers.get('set-cookie')).toContain('connector_oauth_nonce');
    });

    it('400s when app not configured', async () => {
        vi.doMock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => null }) }));
        const mod = await import('@/app/api/connections/[provider]/authorize/route');
        const res = await mod.GET(new Request('http://x'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/authorize-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```typescript
// apps/web-ui/app/api/connections/[provider]/authorize/route.ts
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getProviderConfig, isConnectorProvider } from '@/lib/connectors/providers';
import { signState } from '@/lib/connectors/oauth-state';
import { randomBytes } from 'crypto';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

export async function GET(req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'AgentOps'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const app = await getConnectorRepository().getApp(provider as ConnectorProvider, tenantId);
    if (!app?.clientId) return NextResponse.json({ success: false, error: 'Connector app not configured' }, { status: 400 });

    const cfg = getProviderConfig(provider);
    const origin = new URL(req.url).origin;
    const nonce = randomBytes(16).toString('hex');
    const state = signState({ tenantId, provider, nonce });
    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('redirect_uri', `${origin}/api/connections/${provider}/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scopes.join(' '));
    url.searchParams.set('state', state);
    for (const [k, v] of Object.entries(cfg.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);
    if (provider === 'slack') url.searchParams.set('user_scope', cfg.scopes.join(','));

    const res = NextResponse.redirect(url.toString());
    res.cookies.set('connector_oauth_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https'), path: '/', maxAge: 600 });
    return res;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/authorize-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/connections/[provider]/authorize apps/web-ui/tests/connectors/authorize-route.test.ts
git commit -m "feat(connectors): OAuth authorize route with signed state + CSRF nonce"
```

---

### Task 8: Callback route

**Files:**
- Create: `apps/web-ui/app/api/connections/[provider]/callback/route.ts`
- Test: `apps/web-ui/tests/connectors/callback-route.test.ts`

**Interfaces:**
- Consumes: `verifyState` (Task 4), `exchangeCode`/`fetchIdentity` (Task 5), `getConnectorRepository`, `encryptJson`, `AuditService`.
- Produces: `GET` verifies state+nonce cookie, exchanges code, fetches identity, `upsertConnection` (tokens encrypted), 302 to `/app/channels/{provider}-settings?connected=1`. On error → 302 to same page `?error=...`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/connectors/callback-route.test.ts
import { describe, it, expect, vi } from 'vitest';
const upsertConnection = vi.fn(async () => ({ id: 'c1' }));
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => ({ clientId: 'cid', clientSecretEnc: 'x' }), upsertConnection }) }));
vi.mock('@/lib/connectors/token-exchange', () => ({
    exchangeCode: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresInSec: 3600, scopes: ['read:jira-work'] }),
    fetchIdentity: async () => ({ accountLabel: 'Acme', externalAccountId: 'cloud1', metadata: { cloudId: 'cloud1' } }),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn(async () => {}) } }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { signState } from '@/lib/connectors/oauth-state';
import { GET } from '@/app/api/connections/[provider]/callback/route';

function reqWith(state: string, nonce: string) {
    return new Request(`http://x/api/connections/jira/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: `connector_oauth_nonce=${nonce}` } });
}

describe('GET callback', () => {
    it('stores an encrypted connection and redirects with connected=1', async () => {
        const state = signState({ tenantId: 'tenantA', provider: 'jira', nonce: 'n1' });
        const res = await GET(reqWith(state, 'n1'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('connected=1');
        const saved = upsertConnection.mock.calls[0][0];
        expect(saved.accessTokenEnc).not.toContain('at');
        expect(saved.externalAccountId).toBe('cloud1');
    });

    it('rejects a nonce mismatch', async () => {
        const state = signState({ tenantId: 'tenantA', provider: 'jira', nonce: 'n1' });
        const res = await GET(reqWith(state, 'WRONG'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.headers.get('location')).toContain('error=');
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/callback-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```typescript
// apps/web-ui/app/api/connections/[provider]/callback/route.ts
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { verifyState } from '@/lib/connectors/oauth-state';
import { exchangeCode, fetchIdentity } from '@/lib/connectors/token-exchange';
import { encryptJson } from '@/lib/crypto/provider-credentials';
import { isConnectorProvider } from '@/lib/connectors/providers';
import { AuditService } from '@/lib/audit-service';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

function redirectPage(origin: string, provider: string, query: string) {
    return NextResponse.redirect(`${origin}/app/channels/${provider}-settings?${query}`);
}

export async function GET(req: Request, { params }: Ctx) {
    const { provider } = await params;
    const origin = new URL(req.url).origin;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });

    try {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const stateToken = url.searchParams.get('state');
        if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error') || 'consent_denied');
        if (!code || !stateToken) throw new Error('Missing code/state');

        const state = verifyState(stateToken);
        if (state.provider !== provider) throw new Error('State provider mismatch');
        const cookieNonce = req.headers.get('cookie')?.match(/connector_oauth_nonce=([^;]+)/)?.[1];
        if (!cookieNonce || cookieNonce !== state.nonce) throw new Error('CSRF nonce mismatch');

        const tenantId = state.tenantId;
        const repo = getConnectorRepository();
        const app = await repo.getApp(provider as ConnectorProvider, tenantId);
        if (!app) throw new Error('Connector app not configured');

        const redirectUri = `${origin}/api/connections/${provider}/callback`;
        const tokens = await exchangeCode(provider as ConnectorProvider, app, code, redirectUri);
        const identity = await fetchIdentity(provider as ConnectorProvider, tokens.accessToken);

        await repo.upsertConnection({
            provider: provider as ConnectorProvider,
            accountLabel: identity.accountLabel,
            externalAccountId: identity.externalAccountId,
            accessTokenEnc: encryptJson(tokens.accessToken),
            refreshTokenEnc: tokens.refreshToken ? encryptJson(tokens.refreshToken) : undefined,
            expiresAt: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null,
            scopes: tokens.scopes,
            tokenType: 'user',
            metadata: identity.metadata,
        }, tenantId, 'user');

        AuditService.logUserAction({
            eventType: 'connector.connected', severity: 'medium',
            apiRoute: `GET /api/connections/${provider}/callback`, httpMethod: 'GET',
            action: 'Connected Connector', resourceType: 'agent',
            resourceId: `${provider}-connection`, resourceName: `${provider}: ${identity.accountLabel}`,
            user: 'user', userType: 'user', status: 'success',
            details: `Connected ${provider} account ${identity.accountLabel}`, metadata: { tenantId },
        }).catch(() => {});

        const res = redirectPage(origin, provider, 'connected=1');
        res.cookies.delete('connector_oauth_nonce');
        return res;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'oauth_failed';
        console.error(`[connectors/callback/${provider}]`, msg);
        return redirectPage(origin, provider, `error=${encodeURIComponent(msg)}`);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/callback-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/connections/[provider]/callback apps/web-ui/tests/connectors/callback-route.test.ts
git commit -m "feat(connectors): OAuth callback route — exchange, identity, encrypted store"
```

---

### Task 9: Connections list + delete routes

**Files:**
- Create: `apps/web-ui/app/api/connections/[provider]/route.ts` (GET list)
- Create: `apps/web-ui/app/api/connections/[provider]/[id]/route.ts` (DELETE)
- Test: `apps/web-ui/tests/connectors/connections-route.test.ts`

**Interfaces:**
- Consumes: `getConnectorRepository`, `authorize`, `getSessionTenantId`, `AuditService`.
- Produces: `GET` → `{ success, connections: [{ id, accountLabel, scopes, status, tokenType, expiresAt, createdAt }] }` (no tokens). `DELETE` → `deleteConnection`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/connectors/connections-route.test.ts
import { describe, it, expect, vi } from 'vitest';
const listConnections = vi.fn(async () => [{ id: 'c1', accountLabel: 'Acme', scopes: ['a'], status: 'active', tokenType: 'user', accessTokenEnc: 'SECRET', expiresAt: null, createdAt: new Date() }]);
const deleteConnection = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ listConnections, deleteConnection }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA', getAuthSession: async () => ({ user: { email: 'u' } }) }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn(async () => {}) } }));

import { GET } from '@/app/api/connections/[provider]/route';
import { DELETE } from '@/app/api/connections/[provider]/[id]/route';

describe('connections routes', () => {
    it('lists connections without tokens', async () => {
        const res = await GET(new Request('http://x'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        const body = await res.json();
        expect(body.connections[0].id).toBe('c1');
        expect(JSON.stringify(body)).not.toContain('SECRET');
    });
    it('deletes a connection', async () => {
        const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ provider: 'jira', id: 'c1' }) } as any);
        expect(res.status).toBe(200);
        expect(deleteConnection).toHaveBeenCalledWith('c1', 'tenantA');
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/connections-route.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement list route**

```typescript
// apps/web-ui/app/api/connections/[provider]/route.ts
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { isConnectorProvider } from '@/lib/connectors/providers';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('read', 'AgentOps'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const rows = await getConnectorRepository().listConnections(provider as ConnectorProvider, tenantId);
    return NextResponse.json({
        success: true,
        connections: rows.map(r => ({
            id: r.id, accountLabel: r.accountLabel, scopes: r.scopes, status: r.status,
            tokenType: r.tokenType, expiresAt: r.expiresAt, createdAt: r.createdAt,
        })),
    });
}
```

- [ ] **Step 4: Implement delete route**

```typescript
// apps/web-ui/app/api/connections/[provider]/[id]/route.ts
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { isConnectorProvider } from '@/lib/connectors/providers';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string; id: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
    const { provider, id } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'AgentOps'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    await getConnectorRepository().deleteConnection(id, tenantId);
    const session = await getAuthSession();
    AuditService.logUserAction({
        eventType: 'connector.disconnected', severity: 'medium',
        apiRoute: `DELETE /api/connections/${provider}/${id}`, httpMethod: 'DELETE',
        action: 'Disconnected Connector', resourceType: 'agent',
        resourceId: `${provider}-connection`, resourceName: `${provider} connection`,
        user: session?.user?.email || 'unknown', userType: 'user', status: 'success',
        details: `Disconnected ${provider} connection ${id}`, metadata: { tenantId },
    }).catch(() => {});
    return NextResponse.json({ success: true });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/connections-route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/app/api/connections apps/web-ui/tests/connectors/connections-route.test.ts
git commit -m "feat(connectors): connections list + disconnect routes"
```

---

### Task 10: Slack workspace-bot install routes

**Files:**
- Create: `apps/web-ui/app/api/slack/install/route.ts`
- Create: `apps/web-ui/app/api/slack/install/callback/route.ts`
- Test: `apps/web-ui/tests/connectors/slack-install-route.test.ts`

**Interfaces:**
- Consumes: `getConnectorRepository`, `signState`/`verifyState`, `encryptJson`, `getProviderConfig`.
- Produces: `install GET` → 302 to Slack authorize with **bot** `scope` (`chat:write,commands,channels:read`) and `redirect_uri=<origin>/api/slack/install/callback`; `callback GET` → `oauth.v2.access`, store `botTokenEnc` + `botAccountLabel` via `upsertApp`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/connectors/slack-install-route.test.ts
import { describe, it, expect, vi } from 'vitest';
const upsertApp = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => ({ clientId: 'cid', clientSecretEnc: 'x' }), upsertApp }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA' }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/lib/connectors/token-exchange', () => ({ exchangeSlackBot: async () => ({ botToken: 'xoxb-1', teamName: 'Acme', teamId: 'T1' }) }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { signState } from '@/lib/connectors/oauth-state';
import { GET as install } from '@/app/api/slack/install/route';
import { GET as cb } from '@/app/api/slack/install/callback/route';

describe('slack install', () => {
    it('redirects with bot scope', async () => {
        const res = await install(new Request('http://x/api/slack/install'), {} as any);
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('scope=');
    });
    it('stores the bot token on callback', async () => {
        const state = signState({ tenantId: 'tenantA', provider: 'slack', nonce: 'n1' });
        const req = new Request(`http://x/api/slack/install/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: 'connector_oauth_nonce=n1' } });
        const res = await cb(req, {} as any);
        expect(res.status).toBe(307);
        const saved = upsertApp.mock.calls[0][0];
        expect(saved.botTokenEnc).not.toContain('xoxb-1');
        expect(saved.botAccountLabel).toBe('Acme');
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/slack-install-route.test.ts`
Expected: FAIL — modules + `exchangeSlackBot` not found.

- [ ] **Step 3: Add `exchangeSlackBot` to token-exchange.ts**

```typescript
// append to apps/web-ui/lib/connectors/token-exchange.ts
export interface SlackBotResult { botToken: string; teamName: string; teamId: string; botUserId: string; scopes: string[]; }

export async function exchangeSlackBot(app: ConnectorAppRecord, code: string, redirectUri: string): Promise<SlackBotResult> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: app.clientId, client_secret: clientSecret(app),
    });
    const res = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`Slack bot install failed: ${json.error}`);
    return {
        botToken: json.access_token, teamName: json.team?.name ?? 'workspace', teamId: json.team?.id ?? '',
        botUserId: json.bot_user_id ?? '', scopes: parseScopes(json.scope),
    };
}
```

- [ ] **Step 4: Implement install route**

```typescript
// apps/web-ui/app/api/slack/install/route.ts
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { signState } from '@/lib/connectors/oauth-state';
import { randomBytes } from 'crypto';

const BOT_SCOPES = ['chat:write', 'commands', 'channels:read'];

export async function GET(req: Request) {
    const forbidden = await authorize('update', 'AgentOps'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const app = await getConnectorRepository().getApp('slack', tenantId);
    if (!app?.clientId) return NextResponse.json({ success: false, error: 'Slack app not configured' }, { status: 400 });
    const origin = new URL(req.url).origin;
    const nonce = randomBytes(16).toString('hex');
    const state = signState({ tenantId, provider: 'slack', nonce });
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('scope', BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', `${origin}/api/slack/install/callback`);
    url.searchParams.set('state', state);
    const res = NextResponse.redirect(url.toString());
    res.cookies.set('connector_oauth_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https'), path: '/', maxAge: 600 });
    return res;
}
```

- [ ] **Step 5: Implement install callback route**

```typescript
// apps/web-ui/app/api/slack/install/callback/route.ts
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { verifyState } from '@/lib/connectors/oauth-state';
import { exchangeSlackBot } from '@/lib/connectors/token-exchange';
import { encryptJson } from '@/lib/crypto/provider-credentials';

export async function GET(req: Request) {
    const origin = new URL(req.url).origin;
    const back = (q: string) => NextResponse.redirect(`${origin}/app/channels/slack-settings?${q}`);
    try {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const stateToken = url.searchParams.get('state');
        if (!code || !stateToken) throw new Error('Missing code/state');
        const state = verifyState(stateToken);
        const cookieNonce = req.headers.get('cookie')?.match(/connector_oauth_nonce=([^;]+)/)?.[1];
        if (!cookieNonce || cookieNonce !== state.nonce) throw new Error('CSRF nonce mismatch');
        const repo = getConnectorRepository();
        const app = await repo.getApp('slack', state.tenantId);
        if (!app) throw new Error('Slack app not configured');
        const result = await exchangeSlackBot(app, code, `${origin}/api/slack/install/callback`);
        await repo.upsertApp({ provider: 'slack', botTokenEnc: encryptJson(result.botToken), botAccountLabel: result.teamName }, state.tenantId, 'user');
        const res = back('bot_installed=1');
        res.cookies.delete('connector_oauth_nonce');
        return res;
    } catch (err: unknown) {
        return back(`error=${encodeURIComponent(err instanceof Error ? err.message : 'install_failed')}`);
    }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/slack-install-route.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/app/api/slack/install apps/web-ui/lib/connectors/token-exchange.ts apps/web-ui/tests/connectors/slack-install-route.test.ts
git commit -m "feat(connectors): Slack workspace-bot install flow"
```

---

### Task 11: Connection resolver + refresh helper (consumption core)

**Files:**
- Create: `apps/web-ui/lib/connectors/connection-service.ts`
- Test: `apps/web-ui/tests/connectors/connection-service.test.ts`

**Interfaces:**
- Consumes: `getConnectorRepository`, `refreshAccessToken` (Task 5), `encryptJson`/`decryptJson`.
- Produces:
  - `getUsableAccessToken(provider, tenantId): Promise<{ accessToken: string; metadata: Record<string, unknown> } | null>` — returns the active connection's token, refreshing + persisting if expired (and a refresh token exists). Returns null if no active connection.
  - `getBotToken(tenantId): Promise<string | null>` — decrypts `ConnectorApp.botTokenEnc` for Slack.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/tests/connectors/connection-service.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { encryptJson } from '@/lib/crypto/provider-credentials';

const updateConnectionTokens = vi.fn();
let active: any;
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({
    getActiveConnection: async () => active,
    getApp: async () => ({ clientId: 'cid', clientSecretEnc: encryptJson('secret'), botTokenEnc: encryptJson('xoxb-9') }),
    updateConnectionTokens,
}) }));
vi.mock('@/lib/connectors/token-exchange', () => ({ refreshAccessToken: async () => ({ accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600, scopes: [] }) }));

import { getUsableAccessToken, getBotToken } from '@/lib/connectors/connection-service';

describe('connection-service', () => {
    it('returns a valid token as-is', async () => {
        active = { id: 'c1', accessTokenEnc: encryptJson('valid'), refreshTokenEnc: null, expiresAt: new Date(Date.now() + 60_000), metadata: { cloudId: 'x' } };
        const r = await getUsableAccessToken('jira', 't1');
        expect(r?.accessToken).toBe('valid');
    });
    it('refreshes an expired token', async () => {
        active = { id: 'c1', accessTokenEnc: encryptJson('stale'), refreshTokenEnc: encryptJson('rt'), expiresAt: new Date(Date.now() - 1000), metadata: {} };
        const r = await getUsableAccessToken('jira', 't1');
        expect(r?.accessToken).toBe('fresh');
        expect(updateConnectionTokens).toHaveBeenCalled();
    });
    it('decrypts the bot token', async () => {
        expect(await getBotToken('t1')).toBe('xoxb-9');
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/connection-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement connection-service**

```typescript
// apps/web-ui/lib/connectors/connection-service.ts
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { refreshAccessToken } from './token-exchange';
import { encryptJson, decryptJson } from '@/lib/crypto/provider-credentials';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

const EXPIRY_SKEW_MS = 60_000;

export async function getUsableAccessToken(
    provider: ConnectorProvider, tenantId: string,
): Promise<{ accessToken: string; metadata: Record<string, unknown> } | null> {
    const repo = getConnectorRepository();
    const conn = await repo.getActiveConnection(provider, tenantId);
    if (!conn) return null;
    const metadata = (conn.metadata ?? {}) as Record<string, unknown>;
    const expired = conn.expiresAt ? conn.expiresAt.getTime() - EXPIRY_SKEW_MS < Date.now() : false;

    if (expired && conn.refreshTokenEnc) {
        const app = await repo.getApp(provider, tenantId);
        if (app) {
            const refreshed = await refreshAccessToken(provider, app, decryptJson<string>(conn.refreshTokenEnc));
            await repo.updateConnectionTokens(conn.id, tenantId, {
                accessTokenEnc: encryptJson(refreshed.accessToken),
                refreshTokenEnc: refreshed.refreshToken ? encryptJson(refreshed.refreshToken) : undefined,
                expiresAt: refreshed.expiresInSec ? new Date(Date.now() + refreshed.expiresInSec * 1000) : null,
                status: 'active',
            });
            return { accessToken: refreshed.accessToken, metadata };
        }
    }
    return { accessToken: decryptJson<string>(conn.accessTokenEnc), metadata };
}

export async function getBotToken(tenantId: string): Promise<string | null> {
    const app = await getConnectorRepository().getApp('slack', tenantId);
    if (!app?.botTokenEnc) return null;
    try { return decryptJson<string>(app.botTokenEnc); } catch { return null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/connectors/connection-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/connectors/connection-service.ts apps/web-ui/tests/connectors/connection-service.test.ts
git commit -m "feat(connectors): connection resolver + token refresh helper"
```

---

### Task 12: Wire jira-adapter to prefer OAuth

**Files:**
- Modify: `apps/web-ui/lib/gateway/adapters/jira-adapter.ts` (comment-post path ~line 336-400)
- Test: `apps/web-ui/tests/gateway/adapters/jira-adapter.test.ts` (add a case)

**Interfaces:**
- Consumes: `getUsableAccessToken` (Task 11).
- Produces: comment posting uses OAuth Bearer + `metadata.apiBaseUrl` when a Jira connection exists; else the existing Basic-auth/env fallback (unchanged).

- [ ] **Step 1: Write the failing test** (add to the existing describe block)

```typescript
// add to apps/web-ui/tests/gateway/adapters/jira-adapter.test.ts
import { vi } from 'vitest';
vi.mock('@/lib/connectors/connection-service', () => ({
    getUsableAccessToken: vi.fn(async () => ({ accessToken: 'oauth-at', metadata: { apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud1' } })),
}));

it('posts comments via OAuth when a connection exists', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: '1' }) }));
    vi.stubGlobal('fetch', fetchMock as any);
    const adapter = new JiraAdapter(); // per the file's construction pattern
    await adapter.postComment('tenantA', 'OPS-1', 'hello'); // use the file's real method name
    const [calledUrl, opts] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain('api.atlassian.com/ex/jira/cloud1');
    expect((opts as any).headers.Authorization).toBe('Bearer oauth-at');
});
```

Note: adjust `new JiraAdapter()` / `postComment(...)` to the adapter's actual constructor + method signature (read the file first).

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/jira-adapter.test.ts`
Expected: FAIL — still using Basic auth / old URL.

- [ ] **Step 3: Modify the comment-post path**

In the comment-post method, before building the Basic-auth request, insert:

```typescript
import { getUsableAccessToken } from '@/lib/connectors/connection-service';

// inside postComment(tenantId, issueKey, body):
const oauth = await getUsableAccessToken('jira', tenantId);
if (oauth) {
    const base = (oauth.metadata.apiBaseUrl as string) || '';
    const url = `${base}/rest/api/3/issue/${issueKey}/comment`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${oauth.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ body: /* existing ADF/text builder */ this.buildCommentBody?.(body) ?? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] } }),
    });
    if (res.ok) return;
    if (res.status !== 401) throw new Error(`Jira OAuth comment failed: ${res.status}`);
    // 401 → fall through to manual/env auth below
}
// ...existing Basic-auth path unchanged...
```

Keep the existing Basic-auth block intact as the fallback. Match the method's real name/args and the existing comment-body builder.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/jira-adapter.test.ts`
Expected: PASS (new + existing cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/adapters/jira-adapter.ts apps/web-ui/tests/gateway/adapters/jira-adapter.test.ts
git commit -m "feat(connectors): jira-adapter prefers OAuth token, falls back to Basic"
```

---

### Task 13: Wire slack-adapter bot-token precedence

**Files:**
- Modify: `apps/web-ui/lib/gateway/adapters/slack-adapter.ts` (outbound `getConfig`/token resolution ~line 340-460)
- Test: `apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts` (add a case)

**Interfaces:**
- Consumes: `getBotToken` (Task 11).
- Produces: outbound Slack calls use `getBotToken(tenantId)` (workspace-bot install) first, then manual `botToken` from tenant config, then `env.SLACK_BOT_TOKEN`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts
vi.mock('@/lib/connectors/connection-service', () => ({ getBotToken: vi.fn(async () => 'xoxb-installed') }));

it('prefers the installed workspace-bot token for outbound', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock as any);
    const adapter = new SlackAdapter();
    await adapter.sendScheduledNotification('tenantA', /* args per the real signature */ { channel: 'C1', text: 'hi' } as any);
    const [, opts] = fetchMock.mock.calls[0];
    expect((opts as any).headers.Authorization).toBe('Bearer xoxb-installed');
});
```

Adjust `new SlackAdapter()` + method name/args to the file's real API (read first).

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/slack-adapter.test.ts`
Expected: FAIL — uses config.botToken, not installed token.

- [ ] **Step 3: Modify token resolution**

Add a helper used by every outbound path:

```typescript
import { getBotToken } from '@/lib/connectors/connection-service';

private async resolveBotToken(tenantId: string, config: { botToken?: string } | null): Promise<string | null> {
    return (await getBotToken(tenantId)) || config?.botToken || env.SLACK_BOT_TOKEN || null;
}
```

Replace each outbound `Authorization: Bearer ${config.botToken}` site (lines ~242, ~325, ~451) with a token from `resolveBotToken(tenantId, config)`, and update the `if (!config?.botToken)` guards to check the resolved token instead. Inbound signing verification is untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/slack-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/adapters/slack-adapter.ts apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts
git commit -m "feat(connectors): slack-adapter prefers installed workspace-bot token"
```

---

### Task 14: TanStack Query hooks

**Files:**
- Create: `apps/web-ui/lib/queries/connectors.ts`
- Modify: `apps/web-ui/lib/queries/query-keys.ts` (add `connectors` keys)
- Test: none (thin fetch wrappers; covered by e2e/manual)

**Interfaces:**
- Produces:
  - `useConnectorApp(provider)` → GET `/api/connections/{provider}/app`
  - `useSaveConnectorApp(provider)` → PUT
  - `useDeleteConnectorApp(provider)` → DELETE
  - `useConnections(provider)` → GET `/api/connections/{provider}`
  - `useDeleteConnection(provider)` → DELETE `/api/connections/{provider}/{id}`
  - Invalidate on mutation.

- [ ] **Step 1: Add query keys**

In `query-keys.ts`, add under the keys object:

```typescript
connectors: {
    all: ['connectors'] as const,
    app: (provider: string) => ['connectors', provider, 'app'] as const,
    connections: (provider: string) => ['connectors', provider, 'connections'] as const,
},
```

- [ ] **Step 2: Implement hooks**

```typescript
// apps/web-ui/lib/queries/connectors.ts
'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';

export interface ConnectorApp {
    configured: boolean; status: string; clientId: string; clientSecretHint: string | null;
    signingSecretConfigured: boolean; botConfigured: boolean; botAccountLabel: string | null;
    callbackUrl: string; slackInstallCallbackUrl?: string;
}
export interface Connection {
    id: string; accountLabel: string; scopes: string[]; status: string; tokenType: string;
    expiresAt: string | null; createdAt: string;
}

export function useConnectorApp(provider: string) {
    return useQuery({
        queryKey: queryKeys.connectors.app(provider),
        queryFn: async (): Promise<ConnectorApp> => {
            const res = await fetch(`/api/connections/${provider}/app`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load app credentials');
            return data;
        },
    });
}

export function useSaveConnectorApp(provider: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: { clientId: string; clientSecret?: string; signingSecret?: string }) => {
            const res = await fetch(`/api/connections/${provider}/app`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to save');
            return data;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connectors.app(provider) }),
    });
}

export function useDeleteConnectorApp(provider: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async () => { const res = await fetch(`/api/connections/${provider}/app`, { method: 'DELETE' }); if (!res.ok) throw new Error('Failed to remove'); },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connectors.app(provider) }),
    });
}

export function useConnections(provider: string) {
    return useQuery({
        queryKey: queryKeys.connectors.connections(provider),
        queryFn: async (): Promise<Connection[]> => {
            const res = await fetch(`/api/connections/${provider}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load connections');
            return data.connections ?? [];
        },
    });
}

export function useDeleteConnection(provider: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => { const res = await fetch(`/api/connections/${provider}/${id}`, { method: 'DELETE' }); if (!res.ok) throw new Error('Failed to disconnect'); },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connectors.connections(provider) }),
    });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -iE "connectors|query-keys" || echo ok`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/queries/connectors.ts apps/web-ui/lib/queries/query-keys.ts
git commit -m "feat(connectors): TanStack Query hooks for app creds + connections"
```

---

### Task 15: AppCredentialsCard + ConnectionsCard + WorkspaceBotCard components

**Files:**
- Create: `apps/web-ui/components/channels/app-credentials-card.tsx`
- Create: `apps/web-ui/components/channels/connections-card.tsx`
- Create: `apps/web-ui/components/channels/workspace-bot-card.tsx`

**Interfaces:**
- Consumes: hooks from Task 14; `toast` from `sonner`; UI primitives.
- Produces (props):
  - `AppCredentialsCard({ provider, displayName, showSigningSecret }: { provider: string; displayName: string; showSigningSecret?: boolean })`
  - `ConnectionsCard({ provider, displayName, description }: { provider: string; displayName: string; description: string })`
  - `WorkspaceBotCard({ botConfigured, botAccountLabel }: { botConfigured: boolean; botAccountLabel: string | null })`

- [ ] **Step 1: Implement AppCredentialsCard**

```tsx
// apps/web-ui/components/channels/app-credentials-card.tsx
'use client';
import { useState, useEffect } from 'react';
import { Copy, CheckCircle2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useConnectorApp, useSaveConnectorApp, useDeleteConnectorApp } from '@/lib/queries/connectors';

export function AppCredentialsCard({ provider, displayName, showSigningSecret = false }: { provider: string; displayName: string; showSigningSecret?: boolean }) {
    const { data } = useConnectorApp(provider);
    const save = useSaveConnectorApp(provider);
    const remove = useDeleteConnectorApp(provider);
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [signingSecret, setSigningSecret] = useState('');
    const [copied, setCopied] = useState(false);

    useEffect(() => { if (data?.clientId) setClientId(data.clientId); }, [data?.clientId]);

    const copy = (text: string) => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const onSave = async () => {
        try {
            await save.mutateAsync({ clientId, clientSecret: clientSecret || undefined, signingSecret: signingSecret || undefined });
            setClientSecret(''); setSigningSecret('');
            toast.success(`${displayName} app credentials saved`);
        } catch (e: any) { toast.error(e.message || 'Failed to save'); }
    };

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                        <KeyRound className="h-4 w-4 text-muted-foreground" />
                        <div>
                            <CardTitle className="text-base">Your {displayName} app credentials</CardTitle>
                            <CardDescription>Enter your own {displayName} OAuth app so you can connect your account.</CardDescription>
                        </div>
                    </div>
                    <Badge variant={data?.configured ? 'secondary' : 'outline'}>
                        {data?.configured ? <><CheckCircle2 className="h-3.5 w-3.5 text-green-500 mr-1" />Configured</> : 'Not set'}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Register this redirect/callback URL in your {displayName} app:</p>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={data?.callbackUrl ?? ''} className="font-mono text-xs" />
                        <Button variant="outline" size="icon" onClick={() => copy(data?.callbackUrl ?? '')}>{copied ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}</Button>
                    </div>
                    {data?.slackInstallCallbackUrl && (
                        <div className="flex items-center gap-2 pt-1">
                            <Input readOnly value={data.slackInstallCallbackUrl} className="font-mono text-xs" />
                            <Button variant="outline" size="icon" onClick={() => copy(data.slackInstallCallbackUrl!)}><Copy className="h-4 w-4" /></Button>
                        </div>
                    )}
                </div>
                <div className="space-y-2">
                    <Label>Client ID</Label>
                    <Input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Client ID" />
                </div>
                <div className="space-y-2">
                    <Label>Client Secret</Label>
                    <Input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder={data?.clientSecretHint ?? 'Client secret'} />
                </div>
                {showSigningSecret && (
                    <div className="space-y-2">
                        <Label>Signing Secret</Label>
                        <Input type="password" value={signingSecret} onChange={e => setSigningSecret(e.target.value)} placeholder={data?.signingSecretConfigured ? '••••••••' : 'Paste your signing secret'} />
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <Button onClick={onSave} disabled={save.isPending || !clientId}>Save credentials</Button>
                    {data?.configured && <Button variant="ghost" className="text-destructive" onClick={async () => { await remove.mutateAsync(); toast.success('Removed'); }}>Remove</Button>}
                </div>
            </CardContent>
        </Card>
    );
}
```

- [ ] **Step 2: Implement ConnectionsCard**

```tsx
// apps/web-ui/components/channels/connections-card.tsx
'use client';
import { Plug, Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConnections, useDeleteConnection, useConnectorApp } from '@/lib/queries/connectors';

export function ConnectionsCard({ provider, displayName, description }: { provider: string; displayName: string; description: string }) {
    const { data: app } = useConnectorApp(provider);
    const { data: connections = [] } = useConnections(provider);
    const del = useDeleteConnection(provider);
    const connect = () => { window.location.href = `/api/connections/${provider}/authorize`; };

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between">
                    <div>
                        <CardTitle className="text-base">{displayName}</CardTitle>
                        <CardDescription>{description}</CardDescription>
                    </div>
                    <Button onClick={connect} disabled={!app?.configured} className="gap-2">
                        {connections.length ? <RefreshCw className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
                        {connections.length ? 'Reconnect' : `Connect ${displayName}`}
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">{connections.length} account{connections.length === 1 ? '' : 's'} connected</p>
                {connections.map(c => (
                    <div key={c.id} className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                            <p className="text-sm font-medium">{c.accountLabel}</p>
                            <p className="text-xs text-muted-foreground">{c.scopes.length} scopes granted</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Badge variant="secondary">{c.status === 'active' ? 'Active' : c.status}</Badge>
                            <Button variant="ghost" size="icon" className="text-destructive" onClick={async () => { await del.mutateAsync(c.id); toast.success('Disconnected'); }}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                    </div>
                ))}
                {!connections.length && (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                        No {displayName} account connected. {app?.configured ? '' : 'Add app credentials first.'}
                    </div>
                )}
                <p className="text-xs text-muted-foreground">Tokens are encrypted at rest and used only when an agent acts on this org&apos;s behalf.</p>
            </CardContent>
        </Card>
    );
}
```

- [ ] **Step 3: Implement WorkspaceBotCard**

```tsx
// apps/web-ui/components/channels/workspace-bot-card.tsx
'use client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function WorkspaceBotCard({ botConfigured, botAccountLabel }: { botConfigured: boolean; botAccountLabel: string | null }) {
    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between">
                    <div>
                        <CardTitle className="text-base">Workspace bot</CardTitle>
                        <CardDescription>Install the Slack app in your workspace to enable slash commands and notifications.</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                        {botConfigured && <Badge variant="secondary">{botAccountLabel ?? 'Installed'}</Badge>}
                        <Button onClick={() => { window.location.href = '/api/slack/install'; }}>Add to Slack</Button>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <p className="text-xs text-muted-foreground">Installed once per workspace. Powers slash commands and the bot posting messages.</p>
            </CardContent>
        </Card>
    );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -iE "channels/(app-credentials|connections|workspace)" || echo ok`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/channels/app-credentials-card.tsx apps/web-ui/components/channels/connections-card.tsx apps/web-ui/components/channels/workspace-bot-card.tsx
git commit -m "feat(connectors): AppCredentials/Connections/WorkspaceBot cards"
```

---

### Task 16: Wire cards into Jira/Slack forms + new Google form/page + channels grid

**Files:**
- Modify: `apps/web-ui/components/channels/jira-settings-form.tsx` (add cards on top; wrap existing manual UI in a collapsible)
- Modify: `apps/web-ui/components/channels/slack-settings-form.tsx` (same + WorkspaceBotCard)
- Create: `apps/web-ui/components/channels/google-settings-form.tsx`
- Create: `apps/web-ui/app/app/channels/google-settings/page.tsx`
- Modify: `apps/web-ui/app/app/channels/page.tsx` (add Google tile + `connected/error` toast on query param)
- Modify: `apps/web-ui/lib/queries/channels.ts` (add `google` to the status fan-out)

**Interfaces:**
- Consumes: the three cards (Task 15); existing form components.
- Produces: `GoogleSettingsForm` component; `/app/channels/google-settings` page; Google tile in the grid.

- [ ] **Step 1: Add OAuth cards to the Jira form**

At the top of the returned JSX in `jira-settings-form.tsx` (above the existing "Webhook Endpoint" card), insert:

```tsx
import { AppCredentialsCard } from '@/components/channels/app-credentials-card';
import { ConnectionsCard } from '@/components/channels/connections-card';
// ...inside the returned layout, first children:
<AppCredentialsCard provider="jira" displayName="Jira" />
<ConnectionsCard provider="jira" displayName="Jira" description="Connect Jira (Atlassian Cloud) to read and update work items." />
```

Wrap the existing "Credentials" + webhook cards in a `<details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Manual / advanced (webhook trigger)</summary>...existing cards...</details>`.

- [ ] **Step 2: Add cards + WorkspaceBotCard to the Slack form**

In `slack-settings-form.tsx`, at the top insert:

```tsx
import { AppCredentialsCard } from '@/components/channels/app-credentials-card';
import { ConnectionsCard } from '@/components/channels/connections-card';
import { WorkspaceBotCard } from '@/components/channels/workspace-bot-card';
import { useConnectorApp } from '@/lib/queries/connectors';
// const { data: app } = useConnectorApp('slack');
<AppCredentialsCard provider="slack" displayName="Slack" showSigningSecret />
<WorkspaceBotCard botConfigured={!!app?.botConfigured} botAccountLabel={app?.botAccountLabel ?? null} />
<ConnectionsCard provider="slack" displayName="Slack" description="Connect your Slack account so the agent can read and act as you." />
```

Wrap the existing manual signing-secret/bot-token form in the same `<details>` "Manual / advanced".

- [ ] **Step 3: Create the Google form**

```tsx
// apps/web-ui/components/channels/google-settings-form.tsx
'use client';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppCredentialsCard } from '@/components/channels/app-credentials-card';
import { ConnectionsCard } from '@/components/channels/connections-card';

export function GoogleSettingsForm({ backHref = '/app/channels', backLabel = 'Back to Channels' }: { backHref?: string; backLabel?: string }) {
    const router = useRouter();
    return (
        <div className="flex-1 bg-background max-w-3xl mx-auto space-y-6">
            <Button variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground" onClick={() => router.push(backHref)}>
                <ArrowLeft className="h-4 w-4" />{backLabel}
            </Button>
            <div>
                <h1 className="text-2xl font-bold">Google Integration</h1>
                <p className="text-muted-foreground mt-1">Connect a Google account for Gmail and Calendar access.</p>
            </div>
            <AppCredentialsCard provider="google" displayName="Google" />
            <ConnectionsCard provider="google" displayName="Google" description="Connect your Google account for Gmail and Calendar access." />
        </div>
    );
}
```

- [ ] **Step 4: Create the Google page**

```tsx
// apps/web-ui/app/app/channels/google-settings/page.tsx
import { GoogleSettingsForm } from '@/components/channels/google-settings-form';
export default function Page() { return <GoogleSettingsForm />; }
```

- [ ] **Step 5: Add Google tile + connected/error toast to the channels overview**

In `apps/web-ui/app/app/channels/page.tsx`: add a Google entry to the tile list (link `/app/channels/google-settings`, Google brand SVG/icon). If the page is a client component, read `useSearchParams()` and on `connected=1` / `bot_installed=1` fire `toast.success(...)`, on `error` fire `toast.error(decodeURIComponent(error))`. If it is a server component, add a small client child `ConnectorCallbackToast` that does this. Add `google` to `useChannelStatus`'s fan-out in `lib/queries/channels.ts` (GET `/api/connections/google/app`, treat `configured` as status).

- [ ] **Step 6: Typecheck + lint**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -iE "channels" || echo ok; bun run lint 2>&1 | tail -3`
Expected: `ok`; lint clean for the touched files.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/components/channels apps/web-ui/app/app/channels apps/web-ui/lib/queries/channels.ts
git commit -m "feat(connectors): wire OAuth cards into Jira/Slack + add Google connector UI"
```

---

### Task 17: Full test + typecheck sweep + manual verification

**Files:** none (verification task)

- [ ] **Step 1: Run the connectors test suite**

Run: `cd apps/web-ui && bunx vitest run tests/connectors tests/crypto tests/db/connectors-repository.test.ts tests/gateway/adapters`
Expected: all PASS.

- [ ] **Step 2: Full web-ui typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | tail -20`
Expected: no NEW errors beyond the repo's known baseline (record the baseline count first with `git stash` off — compare against `master-v1`).

- [ ] **Step 3: Manual smoke via the `verify` skill / running app**

Start `bun run dev`, open `/app/channels/jira-settings`, confirm: callback URL renders, Save credentials persists (badge → Configured), "Connect Jira" is enabled and redirects to `auth.atlassian.com`. Repeat for Slack (incl. "Add to Slack") and Google. (Full OAuth round-trip needs a real provider app; verify the redirect + state cookie are set using browser devtools.)

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "test(connectors): full suite + typecheck sweep green"
```

---

## Self-review notes

- **Spec coverage:** app creds (T6), authorize (T7), callback+identity (T5,T8), connections list/delete (T9), Slack bot install (T10), encryption (T1), models/migration (T2), repo (T3), provider registry+state (T4), refresh/resolver (T11), adapter wiring (T12,T13), UI cards+forms+Google+grid (T14–T16), RBAC+audit (in each route), tests (per task + T17). Feature flag `CONNECTORS_OAUTH_ENABLED` from the spec is **optional** and omitted to reduce surface; add an `env` gate later if rollback control is needed.
- **Type consistency:** `ConnectorProvider`, `IConnectorRepository` methods, `TokenResult`, `getUsableAccessToken`/`getBotToken` names are used identically across tasks.
- **Adapter tasks (12,13)** require reading the real method signatures first — noted inline; the test stubs must match the actual method names.
