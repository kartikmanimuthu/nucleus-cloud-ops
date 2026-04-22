# Cloud Shell Phase 1 — Foundation MVP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working web-based terminal in the Nucleus platform where a user can select an AWS account, open a shell session, and run AWS CLI commands — all from the browser.

**Architecture:** xterm.js renders the terminal in the browser. A lightweight shell server (Node.js + node-pty) runs as a sidecar container in the same ECS task. The browser connects to the shell server via WebSocket, proxied through a Next.js API route. STS AssumeRole injects temporary AWS credentials into the PTY environment. Sessions are tracked in PostgreSQL via Prisma.

**Tech Stack:** xterm.js, @xterm/addon-fit, node-pty, ws (WebSocket), Next.js 15 API routes, Prisma ORM, Pulumi (ECS Fargate), Tailwind CSS, Radix UI, lucide-react

**Requirements covered:** TERM-01 through TERM-06, AWS-01 through AWS-03, AWS-05, SESS-01 through SESS-04, RBAC-01 through RBAC-03, RBAC-06, INFRA-01 through INFRA-03, INFRA-05, INFRA-09, INFRA-10, CONF-01

---

## File Structure

```
prisma/
  schema.prisma                          # MODIFY — add ShellSession model

web-ui/
  app/app/cloud-shell/
    layout.tsx                           # CREATE — auth guard (requireAuth)
    page.tsx                             # CREATE — main Cloud Shell page
  app/api/shell/
    sessions/
      route.ts                           # CREATE — GET (list) + POST (create) sessions
      [id]/
        route.ts                         # CREATE — DELETE (terminate) session
    connect/
      route.ts                           # CREATE — WebSocket upgrade endpoint
  components/cloud-shell/
    terminal.tsx                         # CREATE — xterm.js terminal component
    terminal-toolbar.tsx                 # CREATE — account selector + status bar
    cloud-shell-page.tsx                 # CREATE — page layout (terminal + toolbar)
  lib/cloud-shell/
    shell-client.ts                      # CREATE — WebSocket client wrapper
    types.ts                             # CREATE — shared types (session, messages)
  lib/shell-session-service.ts           # CREATE — Prisma CRUD for ShellSession
  lib/rbac/types.ts                      # MODIFY — add CloudShell module
  lib/rbac/permissions.ts                # MODIFY — add CloudShell to role permissions
  components/sidebar.tsx                 # MODIFY — add Cloud Shell nav item

shell-server/
  Dockerfile                             # CREATE — shell server container image
  package.json                           # CREATE — node-pty + ws dependencies
  src/
    index.ts                             # CREATE — WebSocket server + PTY manager
    pty-manager.ts                       # CREATE — PTY lifecycle (spawn, resize, kill)
    credential-injector.ts               # CREATE — inject AWS creds into PTY env
    types.ts                             # CREATE — shared message types

infra/compute/index.ts                   # MODIFY — add sidecar container + EFS
```

---

## Task 1: Shared Types

**Files:**
- Create: `web-ui/lib/cloud-shell/types.ts`
- Create: `shell-server/src/types.ts`

- [ ] **Step 1: Create web-ui shared types**

```typescript
// web-ui/lib/cloud-shell/types.ts

export interface ShellSession {
  id: string;
  tenantId: string;
  userId: string;
  accountId: string | null;
  accountName: string | null;
  region: string;
  status: 'active' | 'disconnected' | 'terminated';
  approvalMode: 'manual' | 'auto_read' | 'auto_all';
  startedAt: string;
  lastActiveAt: string;
  terminatedAt: string | null;
}

export interface ShellSessionCreateRequest {
  accountId?: string;
  region?: string;
}

export interface ShellSessionResponse {
  success: boolean;
  data?: ShellSession;
  error?: string;
}

export interface ShellSessionListResponse {
  success: boolean;
  data?: ShellSession[];
  totalCount?: number;
  error?: string;
}

/** Messages sent over the WebSocket between browser and shell-server */
export type WsClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type WsServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'session_info'; sessionId: string; expiresAt: string };
```

- [ ] **Step 2: Create shell-server shared types**

```typescript
// shell-server/src/types.ts

export type WsClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type WsServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'session_info'; sessionId: string; expiresAt: string };

export interface PtySessionOptions {
  sessionId: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
  expiresAt: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/cloud-shell/types.ts shell-server/src/types.ts
git commit -m "feat(cloud-shell): add shared WebSocket and session types"
```

---

## Task 2: Prisma Schema + Session Service

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `web-ui/lib/shell-session-service.ts`
- Create: `web-ui/tests/cloud-shell/shell-session-service.test.ts`

- [ ] **Step 1: Write the failing test for ShellSessionService**

```typescript
// web-ui/tests/cloud-shell/shell-session-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma client
const mockPrisma = {
  shellSession: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
};

vi.mock('@/lib/db', () => ({
  getTenantClient: vi.fn(() => mockPrisma),
}));

import { ShellSessionService } from '@/lib/shell-session-service';

describe('ShellSessionService', () => {
  const tenantId = 'tenant-1';
  const userId = 'user-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createSession', () => {
    it('creates a session with defaults', async () => {
      const now = new Date();
      mockPrisma.shellSession.count.mockResolvedValue(0);
      mockPrisma.shellSession.create.mockResolvedValue({
        id: 'sess-1',
        tenantId,
        userId,
        accountId: null,
        accountName: null,
        region: 'us-east-1',
        status: 'active',
        approvalMode: 'manual',
        startedAt: now,
        lastActiveAt: now,
        terminatedAt: null,
      });

      const result = await ShellSessionService.createSession(tenantId, userId, {});
      expect(mockPrisma.shellSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId,
          userId,
          status: 'active',
          region: 'us-east-1',
        }),
      });
      expect(result.id).toBe('sess-1');
    });

    it('rejects when max sessions reached', async () => {
      mockPrisma.shellSession.count.mockResolvedValue(3);
      await expect(
        ShellSessionService.createSession(tenantId, userId, {})
      ).rejects.toThrow('Maximum concurrent sessions (3) reached');
    });
  });

  describe('listSessions', () => {
    it('returns active sessions for user', async () => {
      mockPrisma.shellSession.findMany.mockResolvedValue([
        { id: 'sess-1', status: 'active' },
      ]);
      const result = await ShellSessionService.listSessions(tenantId, userId);
      expect(mockPrisma.shellSession.findMany).toHaveBeenCalledWith({
        where: { tenantId, userId, status: 'active' },
        orderBy: { startedAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('terminateSession', () => {
    it('sets status to terminated', async () => {
      mockPrisma.shellSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        tenantId,
        userId,
        status: 'active',
      });
      mockPrisma.shellSession.update.mockResolvedValue({
        id: 'sess-1',
        status: 'terminated',
      });

      const result = await ShellSessionService.terminateSession(tenantId, userId, 'sess-1');
      expect(mockPrisma.shellSession.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: expect.objectContaining({ status: 'terminated' }),
      });
      expect(result.status).toBe('terminated');
    });

    it('throws if session not found or not owned', async () => {
      mockPrisma.shellSession.findFirst.mockResolvedValue(null);
      await expect(
        ShellSessionService.terminateSession(tenantId, userId, 'sess-999')
      ).rejects.toThrow('Session not found');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/cloud-shell/shell-session-service.test.ts`
Expected: FAIL — `Cannot find module '@/lib/shell-session-service'`

- [ ] **Step 3: Add ShellSession model to Prisma schema**

Add to the end of `prisma/schema.prisma` (before the closing of the file):

```prisma
model ShellSession {
  id            String    @id @default(cuid())
  tenantId      String
  userId        String
  accountId     String?
  accountName   String?
  region        String    @default("us-east-1")
  status        String    @default("active") // active, disconnected, terminated
  approvalMode  String    @default("manual") // manual, auto_read, auto_all
  startedAt     DateTime  @default(now())
  lastActiveAt  DateTime  @default(now())
  terminatedAt  DateTime?

  @@index([tenantId, userId, status])
  @@index([tenantId, status])
  @@map("shell_sessions")
}
```

- [ ] **Step 4: Generate Prisma client**

Run: `cd web-ui && npx prisma generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 5: Implement ShellSessionService**

```typescript
// web-ui/lib/shell-session-service.ts
import { getTenantClient } from '@/lib/db';

const MAX_SESSIONS_PER_USER = 3;

export class ShellSessionService {
  static async createSession(
    tenantId: string,
    userId: string,
    options: { accountId?: string; accountName?: string; region?: string }
  ) {
    const db = getTenantClient(tenantId);

    const activeCount = await db.shellSession.count({
      where: { tenantId, userId, status: 'active' },
    });

    if (activeCount >= MAX_SESSIONS_PER_USER) {
      throw new Error(`Maximum concurrent sessions (${MAX_SESSIONS_PER_USER}) reached`);
    }

    return db.shellSession.create({
      data: {
        tenantId,
        userId,
        accountId: options.accountId ?? null,
        accountName: options.accountName ?? null,
        region: options.region ?? 'us-east-1',
        status: 'active',
        approvalMode: 'manual',
      },
    });
  }

  static async listSessions(tenantId: string, userId: string) {
    const db = getTenantClient(tenantId);
    return db.shellSession.findMany({
      where: { tenantId, userId, status: 'active' },
      orderBy: { startedAt: 'desc' },
    });
  }

  static async terminateSession(tenantId: string, userId: string, sessionId: string) {
    const db = getTenantClient(tenantId);

    const session = await db.shellSession.findFirst({
      where: { id: sessionId, tenantId, userId },
    });

    if (!session) {
      throw new Error('Session not found');
    }

    return db.shellSession.update({
      where: { id: sessionId },
      data: { status: 'terminated', terminatedAt: new Date() },
    });
  }

  static async touchSession(tenantId: string, sessionId: string) {
    const db = getTenantClient(tenantId);
    return db.shellSession.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() },
    });
  }

  static async getSession(tenantId: string, sessionId: string) {
    const db = getTenantClient(tenantId);
    return db.shellSession.findFirst({
      where: { id: sessionId, tenantId },
    });
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/cloud-shell/shell-session-service.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma web-ui/lib/shell-session-service.ts web-ui/tests/cloud-shell/shell-session-service.test.ts
git commit -m "feat(cloud-shell): add ShellSession prisma model and service layer"
```

---

## Task 3: RBAC — Add CloudShell Module

**Files:**
- Modify: `web-ui/lib/rbac/types.ts`
- Modify: `web-ui/lib/rbac/permissions.ts`
- Create: `web-ui/tests/cloud-shell/rbac-cloud-shell.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// web-ui/tests/cloud-shell/rbac-cloud-shell.test.ts
import { describe, it, expect } from 'vitest';
import { hasPermission } from '@/lib/rbac/permissions';
import { SUBJECT_TO_MODULE } from '@/lib/rbac/types';

describe('CloudShell RBAC', () => {
  it('maps CloudShell subject to CloudShell module', () => {
    expect(SUBJECT_TO_MODULE['CloudShell']).toBe('CloudShell');
  });

  it('Owner has full CRUD on CloudShell', () => {
    expect(hasPermission('Owner', 'create', 'CloudShell')).toBe(true);
    expect(hasPermission('Owner', 'read', 'CloudShell')).toBe(true);
    expect(hasPermission('Owner', 'update', 'CloudShell')).toBe(true);
    expect(hasPermission('Owner', 'delete', 'CloudShell')).toBe(true);
  });

  it('Admin has create, read, update on CloudShell', () => {
    expect(hasPermission('Admin', 'create', 'CloudShell')).toBe(true);
    expect(hasPermission('Admin', 'read', 'CloudShell')).toBe(true);
    expect(hasPermission('Admin', 'update', 'CloudShell')).toBe(true);
    expect(hasPermission('Admin', 'delete', 'CloudShell')).toBe(true);
  });

  it('Member has create and read on CloudShell', () => {
    expect(hasPermission('Member', 'create', 'CloudShell')).toBe(true);
    expect(hasPermission('Member', 'read', 'CloudShell')).toBe(true);
    expect(hasPermission('Member', 'update', 'CloudShell')).toBe(false);
    expect(hasPermission('Member', 'delete', 'CloudShell')).toBe(false);
  });

  it('Viewer has read only on CloudShell', () => {
    expect(hasPermission('Viewer', 'read', 'CloudShell')).toBe(true);
    expect(hasPermission('Viewer', 'create', 'CloudShell')).toBe(false);
    expect(hasPermission('Viewer', 'update', 'CloudShell')).toBe(false);
    expect(hasPermission('Viewer', 'delete', 'CloudShell')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/cloud-shell/rbac-cloud-shell.test.ts`
Expected: FAIL — `CloudShell` not in `SUBJECT_TO_MODULE` or `ROLE_PERMISSIONS`

- [ ] **Step 3: Add CloudShell to Module type in types.ts**

In `web-ui/lib/rbac/types.ts`, find the `Module` type and add `'CloudShell'`:

```typescript
export type Module = 'Accounts' | 'Schedules' | 'AIOps' | 'Inventory' | 'Settings' | 'CloudShell';
```

And add to `SUBJECT_TO_MODULE`:

```typescript
CloudShell: 'CloudShell',
```

- [ ] **Step 4: Add CloudShell permissions in permissions.ts**

In `web-ui/lib/rbac/permissions.ts`, add `CloudShell` to each role in `ROLE_PERMISSIONS`:

```typescript
// Owner:
CloudShell: ['create', 'read', 'update', 'delete'],

// Admin:
CloudShell: ['create', 'read', 'update', 'delete'],

// Member:
CloudShell: ['create', 'read'],

// Viewer:
CloudShell: ['read'],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/cloud-shell/rbac-cloud-shell.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 6: Commit**

```bash
git add web-ui/lib/rbac/types.ts web-ui/lib/rbac/permissions.ts web-ui/tests/cloud-shell/rbac-cloud-shell.test.ts
git commit -m "feat(cloud-shell): add CloudShell RBAC module with role permissions"
```

---

## Task 4: API Routes — Session CRUD

**Files:**
- Create: `web-ui/app/api/shell/sessions/route.ts`
- Create: `web-ui/app/api/shell/sessions/[id]/route.ts`

- [ ] **Step 1: Create session list + create route**

```typescript
// web-ui/app/api/shell/sessions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionUserId } from '@/lib/auth-session';
import { ShellSessionService } from '@/lib/shell-session-service';

export async function GET() {
  const authError = await authorize('read', 'CloudShell');
  if (authError) return authError;

  try {
    const { userId, tenantId } = await getSessionUserId();
    const sessions = await ShellSessionService.listSessions(tenantId, userId);
    return NextResponse.json({ success: true, data: sessions });
  } catch (error) {
    console.error('API - Error listing shell sessions:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to list sessions' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const authError = await authorize('create', 'CloudShell');
  if (authError) return authError;

  try {
    const { userId, tenantId } = await getSessionUserId();
    const body = await req.json();
    const session = await ShellSessionService.createSession(tenantId, userId, {
      accountId: body.accountId,
      accountName: body.accountName,
      region: body.region,
    });
    return NextResponse.json({ success: true, data: session }, { status: 201 });
  } catch (error: any) {
    console.error('API - Error creating shell session:', error);
    const status = error.message?.includes('Maximum concurrent') ? 429 : 500;
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to create session' },
      { status }
    );
  }
}
```

- [ ] **Step 2: Create session terminate route**

```typescript
// web-ui/app/api/shell/sessions/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionUserId } from '@/lib/auth-session';
import { ShellSessionService } from '@/lib/shell-session-service';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await authorize('create', 'CloudShell');
  if (authError) return authError;

  try {
    const { id } = await params;
    const { userId, tenantId } = await getSessionUserId();
    const session = await ShellSessionService.terminateSession(tenantId, userId, id);
    return NextResponse.json({ success: true, data: session });
  } catch (error: any) {
    console.error('API - Error terminating shell session:', error);
    const status = error.message === 'Session not found' ? 404 : 500;
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to terminate session' },
      { status }
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/app/api/shell/sessions/route.ts web-ui/app/api/shell/sessions/\[id\]/route.ts
git commit -m "feat(cloud-shell): add session CRUD API routes"
```

---

## Task 5: Shell Server — PTY Manager

**Files:**
- Create: `shell-server/package.json`
- Create: `shell-server/tsconfig.json`
- Create: `shell-server/src/pty-manager.ts`

- [ ] **Step 1: Initialize shell-server package**

```json
// shell-server/package.json
{
  "name": "nucleus-shell-server",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "node-pty": "^1.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

```json
// shell-server/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd shell-server && npm install`
Expected: `node-pty` and `ws` installed successfully

- [ ] **Step 3: Implement PTY manager**

```typescript
// shell-server/src/pty-manager.ts
import * as pty from 'node-pty';
import type { PtySessionOptions } from './types';

interface ManagedPty {
  process: pty.IPty;
  sessionId: string;
  createdAt: Date;
  lastActiveAt: Date;
}

const activeSessions = new Map<string, ManagedPty>();

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

export function spawnPty(options: PtySessionOptions): pty.IPty {
  if (activeSessions.has(options.sessionId)) {
    throw new Error(`Session ${options.sessionId} already exists`);
  }

  const shell = '/bin/bash';
  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: options.cols || 80,
    rows: options.rows || 24,
    cwd: process.env.HOME || '/home/shell',
    env: {
      ...getBaseEnv(),
      ...options.env,
      TERM: 'xterm-256color',
      SHELL: shell,
      NUCLEUS_SESSION_ID: options.sessionId,
    },
  });

  const managed: ManagedPty = {
    process: proc,
    sessionId: options.sessionId,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };

  activeSessions.set(options.sessionId, managed);

  proc.onExit(() => {
    activeSessions.delete(options.sessionId);
  });

  return proc;
}

export function getPty(sessionId: string): pty.IPty | undefined {
  const managed = activeSessions.get(sessionId);
  if (managed) {
    managed.lastActiveAt = new Date();
  }
  return managed?.process;
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  const managed = activeSessions.get(sessionId);
  if (managed) {
    managed.process.resize(cols, rows);
    managed.lastActiveAt = new Date();
  }
}

export function killPty(sessionId: string): void {
  const managed = activeSessions.get(sessionId);
  if (managed) {
    managed.process.kill();
    activeSessions.delete(sessionId);
  }
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

/** Reap idle and expired sessions. Call on an interval. */
export function reapSessions(): string[] {
  const now = Date.now();
  const reaped: string[] = [];

  for (const [id, session] of activeSessions) {
    const idle = now - session.lastActiveAt.getTime();
    const age = now - session.createdAt.getTime();

    if (idle > IDLE_TIMEOUT_MS || age > MAX_DURATION_MS) {
      session.process.kill();
      activeSessions.delete(id);
      reaped.push(id);
    }
  }

  return reaped;
}

function getBaseEnv(): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
    HOME: process.env.HOME || '/home/shell',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add shell-server/
git commit -m "feat(cloud-shell): add shell-server with PTY manager"
```

---

## Task 6: Shell Server — Credential Injector

**Files:**
- Create: `shell-server/src/credential-injector.ts`

- [ ] **Step 1: Implement credential injector**

```typescript
// shell-server/src/credential-injector.ts
import type { AwsCredentials } from './types';

/**
 * Build environment variables for AWS credential injection into a PTY session.
 * Credentials come from the web-ui API after STS AssumeRole.
 */
export function buildAwsEnv(creds: AwsCredentials): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    AWS_DEFAULT_REGION: creds.region,
    AWS_REGION: creds.region,
  };
}

/**
 * Write credentials into a running PTY by exporting env vars.
 * Used for credential refresh without restarting the session.
 */
export function buildCredentialExportCommand(creds: AwsCredentials): string {
  // Use single quotes to prevent shell expansion of special chars in tokens
  return [
    `export AWS_ACCESS_KEY_ID='${creds.accessKeyId}'`,
    `export AWS_SECRET_ACCESS_KEY='${creds.secretAccessKey}'`,
    `export AWS_SESSION_TOKEN='${creds.sessionToken}'`,
    `export AWS_DEFAULT_REGION='${creds.region}'`,
    `export AWS_REGION='${creds.region}'`,
  ].join(' && ');
}

/** Validate that credentials look structurally correct before injection. */
export function validateCredentials(creds: AwsCredentials): string | null {
  if (!creds.accessKeyId || !creds.accessKeyId.startsWith('ASIA')) {
    return 'Invalid access key ID — expected temporary credentials starting with ASIA';
  }
  if (!creds.secretAccessKey || creds.secretAccessKey.length < 20) {
    return 'Invalid secret access key';
  }
  if (!creds.sessionToken) {
    return 'Missing session token — only temporary credentials are supported';
  }
  if (!creds.region) {
    return 'Missing AWS region';
  }
  return null; // valid
}
```

- [ ] **Step 2: Commit**

```bash
git add shell-server/src/credential-injector.ts
git commit -m "feat(cloud-shell): add AWS credential injector for PTY sessions"
```

---

## Task 7: Shell Server — WebSocket Server Entry Point

**Files:**
- Create: `shell-server/src/index.ts`

- [ ] **Step 1: Implement WebSocket server**

```typescript
// shell-server/src/index.ts
import { WebSocketServer, WebSocket } from 'ws';
import { spawnPty, getPty, resizePty, killPty, reapSessions } from './pty-manager';
import { buildAwsEnv, validateCredentials } from './credential-injector';
import type { WsClientMessage, WsServerMessage, AwsCredentials } from './types';

const PORT = parseInt(process.env.SHELL_SERVER_PORT || '3001', 10);
const HEARTBEAT_INTERVAL_MS = 30_000;
const REAP_INTERVAL_MS = 60_000;

const wss = new WebSocketServer({ port: PORT });

console.log(`[ShellServer] Listening on port ${PORT}`);

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');
  const credsParam = url.searchParams.get('credentials');

  if (!sessionId) {
    sendMessage(ws, { type: 'error', message: 'Missing sessionId parameter' });
    ws.close(1008, 'Missing sessionId');
    return;
  }

  console.log(`[ShellServer] New connection for session: ${sessionId}`);

  // Parse and validate credentials
  let awsEnv: Record<string, string> = {};
  if (credsParam) {
    try {
      const creds: AwsCredentials = JSON.parse(decodeURIComponent(credsParam));
      const validationError = validateCredentials(creds);
      if (validationError) {
        sendMessage(ws, { type: 'error', message: validationError });
        ws.close(1008, validationError);
        return;
      }
      awsEnv = buildAwsEnv(creds);
    } catch {
      sendMessage(ws, { type: 'error', message: 'Invalid credentials format' });
      ws.close(1008, 'Invalid credentials');
      return;
    }
  }

  // Check if session already exists (reconnect case)
  let ptyProcess = getPty(sessionId);

  if (!ptyProcess) {
    // Spawn new PTY
    try {
      ptyProcess = spawnPty({
        sessionId,
        cols: 80,
        rows: 24,
        env: awsEnv,
      });
    } catch (err: any) {
      sendMessage(ws, { type: 'error', message: err.message });
      ws.close(1011, 'Failed to spawn PTY');
      return;
    }
  }

  // Pipe PTY output → WebSocket
  const dataHandler = ptyProcess.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      sendMessage(ws, { type: 'output', data });
    }
  });

  // Handle PTY exit
  const exitHandler = ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN) {
      sendMessage(ws, { type: 'exit', code: exitCode });
      ws.close(1000, 'PTY exited');
    }
  });

  // Send session info
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  sendMessage(ws, { type: 'session_info', sessionId, expiresAt });

  // Handle incoming messages from browser
  ws.on('message', (raw: Buffer) => {
    try {
      const msg: WsClientMessage = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'input':
          getPty(sessionId)?.write(msg.data);
          break;
        case 'resize':
          resizePty(sessionId, msg.cols, msg.rows);
          break;
        case 'ping':
          sendMessage(ws, { type: 'pong' });
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  });

  // Cleanup on disconnect
  ws.on('close', () => {
    console.log(`[ShellServer] Connection closed for session: ${sessionId}`);
    dataHandler.dispose();
    exitHandler.dispose();
    // Don't kill PTY on disconnect — allow reconnect
  });

  // Heartbeat
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('close', () => clearInterval(heartbeat));
});

// Periodic session reaper
setInterval(() => {
  const reaped = reapSessions();
  if (reaped.length > 0) {
    console.log(`[ShellServer] Reaped ${reaped.length} idle/expired sessions: ${reaped.join(', ')}`);
  }
}, REAP_INTERVAL_MS);

function sendMessage(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[ShellServer] SIGTERM received, shutting down...');
  wss.close(() => {
    console.log('[ShellServer] WebSocket server closed');
    process.exit(0);
  });
});
```

- [ ] **Step 2: Verify it compiles**

Run: `cd shell-server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add shell-server/src/index.ts
git commit -m "feat(cloud-shell): add WebSocket server entry point with PTY lifecycle"
```

---

## Task 8: Shell Server — Dockerfile

**Files:**
- Create: `shell-server/Dockerfile`

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
# shell-server/Dockerfile
FROM public.ecr.aws/docker/library/node:20.9.0-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# --- Production stage ---
FROM public.ecr.aws/docker/library/node:20.9.0-slim

# Install AWS CLI v2, common tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    unzip \
    git \
    jq \
    less \
    groff \
    python3 \
    python3-pip \
    vim-tiny \
    procps \
    && curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root shell user
RUN useradd -m -s /bin/bash -d /home/shell shell

# Set up shell environment
RUN echo 'alias ll="ls -la"' >> /home/shell/.bashrc && \
    echo 'alias la="ls -A"' >> /home/shell/.bashrc && \
    echo 'export PS1="\\[\\033[1;32m\\]nucleus\\[\\033[0m\\]@\\[\\033[1;34m\\]\\h\\[\\033[0m\\]:\\w\\$ "' >> /home/shell/.bashrc

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

ENV SHELL_SERVER_PORT=3001
ENV HOME=/home/shell
EXPOSE 3001

# Run as root so node-pty can spawn shells as the shell user
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Build locally to verify**

Run: `cd shell-server && docker build --platform linux/arm64 -t nucleus-shell-server:dev .`
Expected: Build completes. Final image has `aws`, `jq`, `git`, `python3` available.

- [ ] **Step 3: Commit**

```bash
git add shell-server/Dockerfile
git commit -m "feat(cloud-shell): add shell-server Dockerfile with AWS CLI and tools"
```

---

## Task 9: WebSocket Proxy API Route

**Files:**
- Create: `web-ui/app/api/shell/connect/route.ts`

The Next.js API route authenticates the user, calls STS AssumeRole for the target account, then returns connection details for the shell server. The browser uses these details to open a direct WebSocket to the sidecar.

Note: Next.js App Router does not natively support WebSocket upgrade. Instead, this route returns the shell server's internal WebSocket URL + a signed session token. In production, the ALB routes `/ws/shell/*` directly to the shell server container on port 3001.

- [ ] **Step 1: Create the connect route**

```typescript
// web-ui/app/api/shell/connect/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionUserId } from '@/lib/auth-session';
import { ShellSessionService } from '@/lib/shell-session-service';
import { assumeRoleForAccount } from '@/lib/agent/aws-credentials-tool';
import { AccountService } from '@/lib/account-service';

export async function POST(req: NextRequest) {
  const authError = await authorize('create', 'CloudShell');
  if (authError) return authError;

  try {
    const { userId, tenantId } = await getSessionUserId();
    const { sessionId, accountId } = await req.json();

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'Missing sessionId' },
        { status: 400 }
      );
    }

    // Verify session exists and belongs to user
    const session = await ShellSessionService.getSession(tenantId, sessionId);
    if (!session || session.userId !== userId) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 }
      );
    }

    // Get AWS credentials if account selected
    let credentials = null;
    if (accountId) {
      const account = await AccountService.getAccount(tenantId, accountId);
      if (!account || !account.roleArn) {
        return NextResponse.json(
          { success: false, error: 'Account not found or missing role ARN' },
          { status: 400 }
        );
      }

      const assumed = await assumeRoleForAccount(account.roleArn, 'NucleusCloudShellSession');
      credentials = {
        accessKeyId: assumed.AccessKeyId,
        secretAccessKey: assumed.SecretAccessKey,
        sessionToken: assumed.SessionToken,
        region: account.region || 'us-east-1',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
    }

    // Touch session activity
    await ShellSessionService.touchSession(tenantId, sessionId);

    // Return connection info — browser connects to shell server via ALB
    // In production: wss://<domain>/ws/shell?sessionId=xxx&credentials=yyy
    // In dev: ws://localhost:3001?sessionId=xxx&credentials=yyy
    const shellServerHost = process.env.SHELL_SERVER_HOST || 'localhost:3001';
    const protocol = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';

    const wsUrl = new URL(`${protocol}://${shellServerHost}`);
    wsUrl.searchParams.set('sessionId', sessionId);
    if (credentials) {
      wsUrl.searchParams.set('credentials', JSON.stringify(credentials));
    }

    return NextResponse.json({
      success: true,
      data: {
        wsUrl: wsUrl.toString(),
        sessionId,
        credentials: credentials ? {
          region: credentials.region,
          expiresAt: credentials.expiresAt,
        } : null,
      },
    });
  } catch (error: any) {
    console.error('API - Error connecting to shell:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to connect' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/api/shell/connect/route.ts
git commit -m "feat(cloud-shell): add WebSocket connect API route with STS AssumeRole"
```

---

## Task 10: WebSocket Client Wrapper

**Files:**
- Create: `web-ui/lib/cloud-shell/shell-client.ts`

- [ ] **Step 1: Implement the WebSocket client**

```typescript
// web-ui/lib/cloud-shell/shell-client.ts
import type { WsClientMessage, WsServerMessage } from './types';

export type ShellClientStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ShellClientCallbacks {
  onOutput: (data: string) => void;
  onStatusChange: (status: ShellClientStatus) => void;
  onSessionInfo: (sessionId: string, expiresAt: string) => void;
  onExit: (code: number) => void;
  onError: (message: string) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const PING_INTERVAL_MS = 30_000;

export class ShellClient {
  private ws: WebSocket | null = null;
  private callbacks: ShellClientCallbacks;
  private wsUrl: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;

  constructor(wsUrl: string, callbacks: ShellClientCallbacks) {
    this.wsUrl = wsUrl;
    this.callbacks = callbacks;
  }

  connect(): void {
    this.intentionalClose = false;
    this.callbacks.onStatusChange('connecting');

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.callbacks.onStatusChange('error');
      this.callbacks.onError('Failed to create WebSocket connection');
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.callbacks.onStatusChange('connected');
      this.startPing();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg: WsServerMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'output':
            this.callbacks.onOutput(msg.data);
            break;
          case 'session_info':
            this.callbacks.onSessionInfo(msg.sessionId, msg.expiresAt);
            break;
          case 'exit':
            this.callbacks.onExit(msg.code);
            break;
          case 'error':
            this.callbacks.onError(msg.message);
            break;
          case 'pong':
            // Heartbeat acknowledged
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (!this.intentionalClose) {
        this.callbacks.onStatusChange('disconnected');
        this.attemptReconnect();
      }
    };

    this.ws.onerror = () => {
      this.callbacks.onStatusChange('error');
    };
  }

  sendInput(data: string): void {
    this.send({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }
    this.callbacks.onStatusChange('disconnected');
  }

  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.onError('Connection lost. Max reconnect attempts reached.');
      return;
    }

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/cloud-shell/shell-client.ts
git commit -m "feat(cloud-shell): add WebSocket client wrapper with reconnect logic"
```

---

## Task 11: Terminal Component (xterm.js)

**Files:**
- Modify: `web-ui/package.json` (add xterm dependencies)
- Create: `web-ui/components/cloud-shell/terminal.tsx`

- [ ] **Step 1: Install xterm.js packages**

Run: `cd web-ui && npm install xterm @xterm/addon-fit @xterm/addon-web-links`
Expected: Packages added to `package.json`

- [ ] **Step 2: Create the terminal component**

```tsx
// web-ui/components/cloud-shell/terminal.tsx
'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import { ShellClient, ShellClientStatus } from '@/lib/cloud-shell/shell-client';

interface TerminalProps {
  wsUrl: string | null;
  onStatusChange: (status: ShellClientStatus) => void;
  onSessionInfo: (sessionId: string, expiresAt: string) => void;
  onError: (message: string) => void;
}

export function Terminal({ wsUrl, onStatusChange, onSessionInfo, onError }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const clientRef = useRef<ShellClient | null>(null);

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && xtermRef.current) {
      try {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        clientRef.current?.resize(cols, rows);
      } catch {
        // Terminal not yet attached
      }
    }
  }, []);

  useEffect(() => {
    if (!terminalRef.current || !wsUrl) return;

    let disposed = false;

    // Dynamic import to avoid SSR issues with xterm
    const initTerminal = async () => {
      const { Terminal: XTerm } = await import('xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');

      if (disposed) return;

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        theme: {
          background: '#1a1b26',
          foreground: '#a9b1d6',
          cursor: '#c0caf5',
          selectionBackground: '#33467c',
          black: '#15161e',
          red: '#f7768e',
          green: '#9ece6a',
          yellow: '#e0af68',
          blue: '#7aa2f7',
          magenta: '#bb9af7',
          cyan: '#7dcfff',
          white: '#a9b1d6',
        },
        scrollback: 10000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(terminalRef.current!);

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      // Initial fit
      setTimeout(() => fitAddon.fit(), 0);

      // Connect to shell server
      const client = new ShellClient(wsUrl, {
        onOutput: (data) => term.write(data),
        onStatusChange,
        onSessionInfo,
        onExit: (code) => {
          term.writeln(`\r\n\x1b[33mSession exited with code ${code}\x1b[0m`);
          onStatusChange('disconnected');
        },
        onError,
      });

      clientRef.current = client;
      client.connect();

      // Pipe terminal input → WebSocket
      term.onData((data: string) => {
        client.sendInput(data);
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        setTimeout(() => {
          fitAddon.fit();
          const { cols, rows } = term;
          client.resize(cols, rows);
        }, 0);
      });
      resizeObserver.observe(terminalRef.current!);

      // Cleanup
      return () => {
        resizeObserver.disconnect();
        client.disconnect();
        term.dispose();
      };
    };

    let cleanup: (() => void) | undefined;
    initTerminal().then((fn) => {
      cleanup = fn;
    });

    return () => {
      disposed = true;
      cleanup?.();
      xtermRef.current = null;
      fitAddonRef.current = null;
      clientRef.current = null;
    };
  }, [wsUrl, onStatusChange, onSessionInfo, onError]);

  // Window resize handler
  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  return (
    <div
      ref={terminalRef}
      className="h-full w-full bg-[#1a1b26] rounded-md overflow-hidden"
      style={{ padding: '4px' }}
    />
  );
}
```

- [ ] **Step 3: Add xterm CSS import**

The xterm CSS needs to be imported. Add to `web-ui/app/app/cloud-shell/page.tsx` (created in Task 13) or create a global import. For now, we'll handle it in the page component.

- [ ] **Step 4: Commit**

```bash
git add web-ui/package.json web-ui/package-lock.json web-ui/components/cloud-shell/terminal.tsx
git commit -m "feat(cloud-shell): add xterm.js terminal component with fit and web-links"
```

---

## Task 12: Terminal Toolbar Component

**Files:**
- Create: `web-ui/components/cloud-shell/terminal-toolbar.tsx`

- [ ] **Step 1: Create the toolbar**

```tsx
// web-ui/components/cloud-shell/terminal-toolbar.tsx
'use client';

import React, { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Wifi, WifiOff, Loader2, XCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ShellClientStatus } from '@/lib/cloud-shell/shell-client';

interface Account {
  id: string;
  name: string;
  accountId: string;
  region?: string;
}

interface TerminalToolbarProps {
  accounts: Account[];
  selectedAccountId: string | null;
  onAccountChange: (accountId: string) => void;
  status: ShellClientStatus;
  sessionExpiresAt: string | null;
  onDisconnect: () => void;
}

export function TerminalToolbar({
  accounts,
  selectedAccountId,
  onAccountChange,
  status,
  sessionExpiresAt,
  onDisconnect,
}: TerminalToolbarProps) {
  const [timeRemaining, setTimeRemaining] = useState<string>('');

  useEffect(() => {
    if (!sessionExpiresAt) return;

    const update = () => {
      const remaining = new Date(sessionExpiresAt).getTime() - Date.now();
      if (remaining <= 0) {
        setTimeRemaining('Expired');
        return;
      }
      const hours = Math.floor(remaining / 3_600_000);
      const minutes = Math.floor((remaining % 3_600_000) / 60_000);
      const seconds = Math.floor((remaining % 60_000) / 1_000);
      setTimeRemaining(
        hours > 0
          ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
          : `${minutes}:${String(seconds).padStart(2, '0')}`
      );
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [sessionExpiresAt]);

  const statusIcon = {
    connecting: <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-500" />,
    connected: <Wifi className="h-3.5 w-3.5 text-green-500" />,
    disconnected: <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />,
    error: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  };

  const statusLabel = {
    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Error',
  };

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  return (
    <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5 text-sm">
      <div className="flex items-center gap-3">
        {/* Account selector */}
        <Select value={selectedAccountId || ''} onValueChange={onAccountChange}>
          <SelectTrigger className="h-7 w-[220px] text-xs">
            <SelectValue placeholder="Select AWS Account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                <span className="font-medium">{account.name}</span>
                <span className="ml-1.5 text-muted-foreground">({account.accountId})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Region badge */}
        {selectedAccount?.region && (
          <Badge variant="outline" className="text-xs font-normal">
            {selectedAccount.region}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Session timer */}
        {sessionExpiresAt && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{timeRemaining}</span>
          </div>
        )}

        {/* Connection status */}
        <div className="flex items-center gap-1.5">
          {statusIcon[status]}
          <span
            className={cn(
              'text-xs',
              status === 'connected' && 'text-green-500',
              status === 'error' && 'text-red-500',
              status === 'disconnected' && 'text-muted-foreground'
            )}
          >
            {statusLabel[status]}
          </span>
        </div>

        {/* Disconnect button */}
        {status === 'connected' && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDisconnect}>
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/cloud-shell/terminal-toolbar.tsx
git commit -m "feat(cloud-shell): add terminal toolbar with account selector and status"
```

---

## Task 13: Cloud Shell Page Layout Component

**Files:**
- Create: `web-ui/components/cloud-shell/cloud-shell-page.tsx`

- [ ] **Step 1: Create the page layout component**

This component orchestrates the terminal, toolbar, and session lifecycle.

```tsx
// web-ui/components/cloud-shell/cloud-shell-page.tsx
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Terminal } from './terminal';
import { TerminalToolbar } from './terminal-toolbar';
import { TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ShellClientStatus } from '@/lib/cloud-shell/shell-client';

interface Account {
  id: string;
  name: string;
  accountId: string;
  region?: string;
}

export function CloudShellPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<ShellClientStatus>('disconnected');
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch available accounts on mount
  useEffect(() => {
    fetch('/api/accounts')
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.data) {
          setAccounts(
            data.data.map((a: any) => ({
              id: a.id,
              name: a.name,
              accountId: a.accountId,
              region: a.region || 'us-east-1',
            }))
          );
        }
      })
      .catch(() => setError('Failed to load accounts'));
  }, []);

  const startSession = useCallback(async (accountId?: string) => {
    setLoading(true);
    setError(null);

    try {
      // 1. Create session
      const sessionRes = await fetch('/api/shell/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: accountId || undefined,
          accountName: accounts.find((a) => a.id === accountId)?.name,
          region: accounts.find((a) => a.id === accountId)?.region || 'us-east-1',
        }),
      });
      const sessionData = await sessionRes.json();

      if (!sessionData.success) {
        setError(sessionData.error || 'Failed to create session');
        return;
      }

      const newSessionId = sessionData.data.id;
      setSessionId(newSessionId);

      // 2. Get WebSocket connection details
      const connectRes = await fetch('/api/shell/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: newSessionId, accountId }),
      });
      const connectData = await connectRes.json();

      if (!connectData.success) {
        setError(connectData.error || 'Failed to connect');
        return;
      }

      setWsUrl(connectData.data.wsUrl);
    } catch (err: any) {
      setError(err.message || 'Failed to start session');
    } finally {
      setLoading(false);
    }
  }, [accounts]);

  const handleAccountChange = useCallback(
    (accountId: string) => {
      setSelectedAccountId(accountId);
      // If already connected, start a new session with the new account
      if (sessionId) {
        handleDisconnect();
        startSession(accountId);
      }
    },
    [sessionId, startSession]
  );

  const handleDisconnect = useCallback(async () => {
    if (sessionId) {
      await fetch(`/api/shell/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    setWsUrl(null);
    setSessionId(null);
    setSessionExpiresAt(null);
    setStatus('disconnected');
  }, [sessionId]);

  const handleStatusChange = useCallback((newStatus: ShellClientStatus) => {
    setStatus(newStatus);
  }, []);

  const handleSessionInfo = useCallback((_sid: string, expiresAt: string) => {
    setSessionExpiresAt(expiresAt);
  }, []);

  const handleError = useCallback((message: string) => {
    setError(message);
  }, []);

  // Not connected — show start screen
  if (!wsUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="rounded-full bg-muted p-4">
          <TerminalSquare className="h-10 w-10 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Cloud Shell</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Open a terminal session to run AWS CLI commands against your connected accounts.
          </p>
        </div>

        {accounts.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              className="rounded-md border bg-background px-3 py-1.5 text-sm"
              value={selectedAccountId || ''}
              onChange={(e) => setSelectedAccountId(e.target.value || null)}
            >
              <option value="">No account (local shell)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.accountId})
                </option>
              ))}
            </select>
          </div>
        )}

        <Button
          onClick={() => startSession(selectedAccountId || undefined)}
          disabled={loading}
          className="mt-2"
        >
          {loading ? 'Starting...' : 'Open Terminal'}
        </Button>

        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
      </div>
    );
  }

  // Connected — show terminal
  return (
    <div className="flex h-full flex-col">
      <TerminalToolbar
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onAccountChange={handleAccountChange}
        status={status}
        sessionExpiresAt={sessionExpiresAt}
        onDisconnect={handleDisconnect}
      />
      <div className="flex-1 min-h-0">
        <Terminal
          wsUrl={wsUrl}
          onStatusChange={handleStatusChange}
          onSessionInfo={handleSessionInfo}
          onError={handleError}
        />
      </div>
      {error && (
        <div className="border-t bg-red-500/10 px-3 py-1.5 text-xs text-red-500">
          {error}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/cloud-shell/cloud-shell-page.tsx
git commit -m "feat(cloud-shell): add CloudShellPage layout with session lifecycle"
```

---

## Task 14: Next.js Page + Layout + Sidebar Nav

**Files:**
- Create: `web-ui/app/app/cloud-shell/layout.tsx`
- Create: `web-ui/app/app/cloud-shell/page.tsx`
- Modify: `web-ui/components/sidebar.tsx`

- [ ] **Step 1: Create the auth layout**

```tsx
// web-ui/app/app/cloud-shell/layout.tsx
import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function CloudShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth('read', 'CloudShell');
  return <>{children}</>;
}
```

- [ ] **Step 2: Create the page**

```tsx
// web-ui/app/app/cloud-shell/page.tsx
'use client';

import 'xterm/css/xterm.css';
import { CloudShellPage } from '@/components/cloud-shell/cloud-shell-page';

export default function CloudShellRoute() {
  return (
    <div className="h-[calc(100vh-64px)]">
      <CloudShellPage />
    </div>
  );
}
```

- [ ] **Step 3: Add Cloud Shell to sidebar navigation**

In `web-ui/components/sidebar.tsx`, add the `Terminal` icon import and the nav item.

Find the lucide-react import line and add `Terminal`:

```typescript
import { Terminal } from 'lucide-react';
```

Find the `navigation` array and add the Cloud Shell entry after "Audit Logs":

```typescript
{ name: "Cloud Shell", href: "/app/cloud-shell", icon: Terminal },
```

The full navigation array should look like:

```typescript
const navigation = [
  { name: "Dashboard", href: "/app/dashboard", icon: LayoutDashboard },
  { name: "AWS Accounts", href: "/app/accounts", icon: Server },
  { name: "AI Ops", href: "/app/agent", icon: Bot },
  { name: "Agent Ops", href: "/app/agent-ops", icon: Zap },
  { name: "Channels", href: "/app/channels", icon: Cable },
  { name: "Cost Scheduler", href: "/app/schedules", icon: Calendar },
  { name: "Inventory Discovery", href: "/app/inventory", icon: Database },
  { name: "Knowledge Base", href: "/app/knowledge-base", icon: BookOpen },
  { name: "Audit Logs", href: "/app/audit", icon: Activity },
  { name: "Cloud Shell", href: "/app/cloud-shell", icon: Terminal },
  { name: "Settings", href: "/app/settings", icon: Settings },
]
```

- [ ] **Step 4: Verify the page loads**

Run: `cd web-ui && npm run dev`
Navigate to: `http://localhost:3000/app/cloud-shell`
Expected: Cloud Shell start screen renders with account selector and "Open Terminal" button.

- [ ] **Step 5: Verify sidebar shows Cloud Shell**

Expected: "Cloud Shell" appears in the sidebar with a terminal icon, between "Audit Logs" and "Settings".

- [ ] **Step 6: Commit**

```bash
git add web-ui/app/app/cloud-shell/layout.tsx web-ui/app/app/cloud-shell/page.tsx web-ui/components/sidebar.tsx
git commit -m "feat(cloud-shell): add Cloud Shell page, layout, and sidebar navigation"
```

---

## Task 15: Pulumi Infrastructure — Shell Server Sidecar

**Files:**
- Modify: `infra/compute/index.ts`

This task adds the shell-server as a sidecar container in the existing ECS task definition, and configures ALB routing for WebSocket traffic on a separate target group.

- [ ] **Step 1: Add shell-server ECR repository**

In `infra/compute/index.ts`, after the existing `webUiRepo` ECR repository, add:

```typescript
// Shell server ECR repository
const shellServerRepo = new aws.ecr.Repository("shell-server-repo", {
    name: "nucleus-cloud-ops-shell-server",
    imageTagMutability: "MUTABLE",
    imageScanningConfiguration: { scanOnPush: true },
    forceDelete: true,
});

new aws.ecr.LifecyclePolicy("shell-server-lifecycle", {
    repository: shellServerRepo.name,
    policy: JSON.stringify({
        rules: [{
            rulePriority: 1,
            description: "Keep last 10 images",
            selection: {
                tagStatus: "any",
                countType: "imageCountMoreThan",
                countNumber: 10,
            },
            action: { type: "expire" },
        }],
    }),
});
```

- [ ] **Step 2: Build and push shell-server Docker image**

Add the shell-server image build after the existing web-ui image build:

```typescript
const shellServerImage = new awsx.ecr.Image("shell-server-image", {
    repositoryUrl: shellServerRepo.repositoryUrl,
    context: "../shell-server",
    dockerfile: "../shell-server/Dockerfile",
    platform: "linux/arm64",
});
```

- [ ] **Step 3: Add shell-server container to ECS task definition**

In the `containerDefinitions` array of the existing task definition, add a second container after the WebUI container:

```typescript
{
    name: "ShellServerContainer",
    image: shellServerImage.imageUri,
    essential: false,  // web-ui is essential, shell server is not
    portMappings: [{
        containerPort: 3001,
        hostPort: 3001,
        protocol: "tcp",
    }],
    environment: [
        { name: "SHELL_SERVER_PORT", value: "3001" },
        { name: "HOME", value: "/home/shell" },
    ],
    logConfiguration: {
        logDriver: "awslogs",
        options: {
            "awslogs-group": `/ecs/nucleus-cloud-ops-shell-server`,
            "awslogs-region": region,
            "awslogs-stream-prefix": "shell",
        },
    },
    cpu: 256,
    memory: 512,
},
```

- [ ] **Step 4: Add CloudWatch log group for shell server**

```typescript
new aws.cloudwatch.LogGroup("shell-server-logs", {
    name: "/ecs/nucleus-cloud-ops-shell-server",
    retentionInDays: 30,
});
```

- [ ] **Step 5: Add ALB target group and listener rule for WebSocket**

```typescript
// Shell server target group (WebSocket traffic)
const shellTargetGroup = new aws.lb.TargetGroup("shell-tg", {
    name: "nucleus-shell-tg",
    port: 3001,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: vpcId,
    healthCheck: {
        path: "/",  // ws server responds to HTTP with upgrade required
        interval: 30,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
        matcher: "200-499",  // WS server returns 426 on plain HTTP
    },
    deregistrationDelay: 10,
});

// Route /ws/shell/* to shell server
new aws.lb.ListenerRule("shell-ws-rule", {
    listenerArn: httpListener.arn,
    priority: 10,
    conditions: [{
        pathPattern: { values: ["/ws/shell/*"] },
    }],
    actions: [{
        type: "forward",
        targetGroupArn: shellTargetGroup.arn,
    }],
});
```

- [ ] **Step 6: Update ECS service to register shell container with target group**

Add a second `loadBalancers` entry to the ECS service:

```typescript
loadBalancers: [
    {
        targetGroupArn: webUiTargetGroup.arn,
        containerName: "WebUIContainer",
        containerPort: 3000,
    },
    {
        targetGroupArn: shellTargetGroup.arn,
        containerName: "ShellServerContainer",
        containerPort: 3001,
    },
],
```

- [ ] **Step 7: Add SHELL_SERVER_HOST env var to WebUI container**

In the WebUI container's environment variables, add:

```typescript
{ name: "SHELL_SERVER_HOST", value: "localhost:3001" },
```

This allows the Next.js connect API route to know where the shell server is (same task, localhost).

- [ ] **Step 8: Preview the infrastructure changes**

Run: `cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod`
Expected: Preview shows new resources (ECR repo, log group, target group, listener rule) and updated resources (task definition, ECS service).

- [ ] **Step 9: Commit**

```bash
git add infra/compute/index.ts
git commit -m "feat(cloud-shell): add shell-server sidecar to ECS task with ALB WebSocket routing"
```

---

## Task 16: Prisma Migration

**Files:**
- Generated: `prisma/migrations/<timestamp>_add_shell_sessions/migration.sql`

- [ ] **Step 1: Generate the migration**

Run: `cd web-ui && npx prisma migrate dev --name add_shell_sessions`
Expected: Migration file created with `CREATE TABLE "shell_sessions"` statement.

- [ ] **Step 2: Verify the migration SQL**

Read the generated migration file and confirm it contains:
- `CREATE TABLE "shell_sessions"` with all columns from the schema
- Indexes on `(tenantId, userId, status)` and `(tenantId, status)`

- [ ] **Step 3: Commit**

```bash
git add prisma/migrations/
git commit -m "feat(cloud-shell): add shell_sessions database migration"
```

---

## Task 17: Integration Test — Full Flow

**Files:**
- Create: `web-ui/tests/cloud-shell/integration.test.ts`

- [ ] **Step 1: Write integration test for session API**

```typescript
// web-ui/tests/cloud-shell/integration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
vi.mock('@/lib/auth-session', () => ({
  getSessionUserId: vi.fn(() => Promise.resolve({
    userId: 'user-1',
    tenantId: 'tenant-1',
  })),
}));

vi.mock('@/lib/rbac/authorize', () => ({
  authorize: vi.fn(() => Promise.resolve(null)),
}));

const mockShellSessionService = {
  createSession: vi.fn(),
  listSessions: vi.fn(),
  terminateSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
};

vi.mock('@/lib/shell-session-service', () => ({
  ShellSessionService: mockShellSessionService,
}));

describe('Shell Session API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/shell/sessions', () => {
    it('creates a session and returns 201', async () => {
      mockShellSessionService.createSession.mockResolvedValue({
        id: 'sess-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        status: 'active',
        region: 'us-east-1',
      });

      // Import the route handler
      const { POST } = await import('@/app/api/shell/sessions/route');
      const req = new Request('http://localhost/api/shell/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: 'us-east-1' }),
      });

      const res = await POST(req as any);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('sess-1');
    });

    it('returns 429 when max sessions reached', async () => {
      mockShellSessionService.createSession.mockRejectedValue(
        new Error('Maximum concurrent sessions (3) reached')
      );

      const { POST } = await import('@/app/api/shell/sessions/route');
      const req = new Request('http://localhost/api/shell/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await POST(req as any);
      const body = await res.json();

      expect(res.status).toBe(429);
      expect(body.success).toBe(false);
    });
  });

  describe('GET /api/shell/sessions', () => {
    it('lists active sessions', async () => {
      mockShellSessionService.listSessions.mockResolvedValue([
        { id: 'sess-1', status: 'active' },
      ]);

      const { GET } = await import('@/app/api/shell/sessions/route');
      const res = await GET();
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd web-ui && npx vitest run tests/cloud-shell/integration.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add web-ui/tests/cloud-shell/integration.test.ts
git commit -m "test(cloud-shell): add integration tests for session API routes"
```

---

## Task 18: Run All Tests + Lint

- [ ] **Step 1: Run all cloud-shell tests**

Run: `cd web-ui && npx vitest run tests/cloud-shell/`
Expected: All tests pass (service tests + RBAC tests + integration tests)

- [ ] **Step 2: Run full test suite to check for regressions**

Run: `cd web-ui && npm run test`
Expected: All existing tests still pass

- [ ] **Step 3: Run lint**

Run: `cd web-ui && npm run lint`
Expected: No new lint errors

- [ ] **Step 4: Run TypeScript type check**

Run: `cd web-ui && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(cloud-shell): address lint and type errors from Phase 1"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Shared types (WebSocket messages, session) | 2 created |
| 2 | Prisma schema + ShellSessionService | 3 created/modified |
| 3 | RBAC CloudShell module | 3 modified/created |
| 4 | Session CRUD API routes | 2 created |
| 5 | Shell server PTY manager | 3 created |
| 6 | Shell server credential injector | 1 created |
| 7 | Shell server WebSocket entry point | 1 created |
| 8 | Shell server Dockerfile | 1 created |
| 9 | WebSocket proxy API route | 1 created |
| 10 | WebSocket client wrapper | 1 created |
| 11 | xterm.js Terminal component | 1 created + deps |
| 12 | Terminal toolbar component | 1 created |
| 13 | CloudShellPage layout component | 1 created |
| 14 | Next.js page + layout + sidebar | 3 created/modified |
| 15 | Pulumi infra (sidecar + ALB routing) | 1 modified |
| 16 | Prisma migration | 1 generated |
| 17 | Integration tests | 1 created |
| 18 | Full test suite + lint | verification |

**Total: 18 tasks, ~25 files created/modified, ~18 commits**
