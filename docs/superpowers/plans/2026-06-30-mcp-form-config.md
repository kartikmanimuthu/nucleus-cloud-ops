# MCP Form-Driven Config + Form↔JSON Toggle + Remote Transports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a form-driven MCP server configuration view alongside the existing JSON editor (live Form↔JSON toggle over the same data), extend the config + runtime to support remote transports (SSE / streamable HTTP) in addition to stdio, and add a per-server Test Connection action — on both MCP settings surfaces.

**Architecture:** The form and the Monaco JSON editor are two views of the same `MCPConfigJson` blob stored in `TenantConfig` (no DB migration, same GET/PUT/DELETE contract). Entries become a transport-tagged union (no `type` ⇒ stdio, fully backward compatible). `mcp-manager.ts` gains an SSE/HTTP branch in `_doConnect` via a pure `buildTransport()` helper. A shared `validateMcpConfig()` is the single validation source for both API routes; a shared test handler powers both Test endpoints.

**Tech Stack:** Next.js 15 App Router, React 19, React Hook Form + Zod 4, TanStack Query 5, sonner, shadcn/ui (Radix), `@modelcontextprotocol/sdk@^1.26.0`, Monaco editor, Vitest.

## Global Constraints

- Path alias `@/` → `apps/web-ui/`. All cross-dir imports use `@/`.
- Forms: React Hook Form + `@hookform/resolvers/zod` + Zod 4 (`err.issues`, two-arg `z.record(k, v)`). No manual `useState` forms.
- Server state: TanStack Query hooks in `lib/queries/<domain>.ts`, keys via `lib/queries/query-keys.ts`. No raw `useEffect`+`fetch` in new component code.
- Toasts: import `toast` from `"sonner"` directly in new code.
- UI primitives in `components/ui/` are consumed, never modified.
- Multi-tenant: all reads/writes go through `TenantConfigService` (tenant-scoped); every route guarded by `getSessionTenantId()`.
- API responses: `NextResponse.json(...)`; success `{ success: true, ... }`, error `{ success: false, error }` (existing MCP GET returns bare `{ servers, config, isCustom }` — preserve that exact shape).
- Tests: web-ui Vitest, run `cd apps/web-ui && bun run test`. Test files colocated as `*.test.ts` or under `tests/`.
- Backward compatibility: existing saved blobs (stdio entries with no `type`) must keep working with zero migration.
- 4-space indent in `lib/` files; 2-space in components (match each file's existing style).

---

### Task 1: Extend `mcp-config.ts` — union entry type, runtime fields, helpers, `validateMcpConfig`, JSON schema

**Files:**
- Modify: `apps/web-ui/lib/agent/mcp-config.ts`
- Test: `apps/web-ui/lib/agent/mcp-config.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface StdioJsonEntry { type?: 'stdio'; command: string; args: string[]; env?: Record<string,string>; disabled?: boolean; requiresAwsCredentials?: boolean }`
  - `interface RemoteJsonEntry { type: 'sse' | 'http'; url: string; headers?: Record<string,string>; disabled?: boolean }`
  - `type MCPServerJsonEntry = StdioJsonEntry | RemoteJsonEntry`
  - `MCPServerConfig` gains `transport?: 'stdio' | 'sse' | 'http'`, `url?: string`, `headers?: Record<string,string>` (command/args stay required; remote configs get `command:''`, `args:[]`).
  - `validateMcpConfig(config: unknown): { ok: true } | { ok: false; error: string }`
  - existing `defaultsToJson`, `jsonToServerConfigs`, `mergeConfigs` signatures unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/mcp-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
    jsonToServerConfigs,
    mergeConfigs,
    validateMcpConfig,
    type MCPConfigJson,
} from './mcp-config';

describe('jsonToServerConfigs — transports', () => {
    it('treats an entry with no "type" as stdio (backward compat)', () => {
        const json: MCPConfigJson = { mcpServers: { legacy: { command: 'uvx', args: ['x@latest'] } } };
        const [s] = jsonToServerConfigs(json);
        expect(s.transport ?? 'stdio').toBe('stdio');
        expect(s.command).toBe('uvx');
        expect(s.args).toEqual(['x@latest']);
        expect(s.enabled).toBe(true);
    });

    it('maps an sse entry to a remote server config', () => {
        const json: MCPConfigJson = { mcpServers: { remote: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer t' } } } };
        const [s] = jsonToServerConfigs(json);
        expect(s.transport).toBe('sse');
        expect(s.url).toBe('https://h/sse');
        expect(s.headers).toEqual({ Authorization: 'Bearer t' });
        expect(s.command).toBe('');
    });

    it('maps an http entry to a remote server config', () => {
        const json: MCPConfigJson = { mcpServers: { remote: { type: 'http', url: 'https://h/mcp' } } };
        const [s] = jsonToServerConfigs(json);
        expect(s.transport).toBe('http');
        expect(s.url).toBe('https://h/mcp');
    });
});

describe('mergeConfigs — user overrides win, defaults preserved', () => {
    it('overlays a remote user entry on top of defaults', () => {
        const merged = mergeConfigs({ mcpServers: { remote: { type: 'sse', url: 'https://h/sse' } } });
        const remote = merged.find(s => s.id === 'remote');
        expect(remote?.transport).toBe('sse');
        // a default still present
        expect(merged.find(s => s.id === 'aws-documentation')).toBeTruthy();
    });
});

describe('validateMcpConfig', () => {
    it('accepts a valid stdio entry', () => {
        expect(validateMcpConfig({ mcpServers: { a: { command: 'npx', args: ['-y', 'pkg'] } } })).toEqual({ ok: true });
    });
    it('accepts a valid sse entry', () => {
        expect(validateMcpConfig({ mcpServers: { a: { type: 'sse', url: 'https://h/sse' } } })).toEqual({ ok: true });
    });
    it('rejects a missing mcpServers object', () => {
        expect(validateMcpConfig({}).ok).toBe(false);
    });
    it('rejects a stdio entry missing command', () => {
        const r = validateMcpConfig({ mcpServers: { a: { args: [] } } });
        expect(r.ok).toBe(false);
    });
    it('rejects a remote entry with a bad url', () => {
        const r = validateMcpConfig({ mcpServers: { a: { type: 'http', url: 'not a url' } } });
        expect(r.ok).toBe(false);
    });
    it('rejects an unknown transport type', () => {
        const r = validateMcpConfig({ mcpServers: { a: { type: 'ws', url: 'https://h' } } } as any);
        expect(r.ok).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bun run test -- mcp-config`
Expected: FAIL — `validateMcpConfig` not exported; remote fields undefined.

- [ ] **Step 3: Edit `mcp-config.ts` — types**

Replace the `MCPServerConfig` and `MCPServerJsonEntry`/`MCPConfigJson` declarations (lines ~19–46) with:

```ts
export interface MCPServerConfig {
    id: string;
    name: string;
    /** Transport kind. Absent ⇒ 'stdio' for backward compatibility. */
    transport?: 'stdio' | 'sse' | 'http';
    command: string;            // stdio only ('' for remote)
    args: string[];             // stdio only ([] for remote)
    env?: Record<string, string>;
    /** Remote (sse/http) only. */
    url?: string;
    headers?: Record<string, string>;
    enabled: boolean;
    description: string;
    /** When true, AWS credentials for the selected account are injected as env vars before spawning. stdio only. */
    requiresAwsCredentials?: boolean;
}

/** stdio entry — VS Code / Cursor convention. `type` optional ⇒ defaults to stdio. */
export interface StdioJsonEntry {
    type?: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
    disabled?: boolean;
    requiresAwsCredentials?: boolean;
}

/** Remote entry — SSE or streamable HTTP. */
export interface RemoteJsonEntry {
    type: 'sse' | 'http';
    url: string;
    headers?: Record<string, string>;
    disabled?: boolean;
}

export type MCPServerJsonEntry = StdioJsonEntry | RemoteJsonEntry;

export interface MCPConfigJson {
    mcpServers: Record<string, MCPServerJsonEntry>;
}
```

- [ ] **Step 4: Edit `mcp-config.ts` — JSON schema (oneOf)**

Replace the body of `MCP_CONFIG_JSON_SCHEMA`'s `additionalProperties` (the per-entry object schema) so the entry is a `oneOf`:

```ts
export const MCP_CONFIG_JSON_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['mcpServers'],
    properties: {
        mcpServers: {
            type: 'object',
            description: 'Map of MCP server configurations keyed by server ID',
            additionalProperties: {
                oneOf: [
                    {
                        type: 'object',
                        required: ['command', 'args'],
                        properties: {
                            type: { const: 'stdio' },
                            command: { type: 'string', description: 'Command to start the MCP server (e.g. "uvx", "npx", "node")' },
                            args: { type: 'array', items: { type: 'string' } },
                            env: { type: 'object', additionalProperties: { type: 'string' } },
                            disabled: { type: 'boolean' },
                            requiresAwsCredentials: { type: 'boolean' },
                        },
                        additionalProperties: false,
                    },
                    {
                        type: 'object',
                        required: ['type', 'url'],
                        properties: {
                            type: { enum: ['sse', 'http'] },
                            url: { type: 'string', description: 'Remote MCP endpoint URL' },
                            headers: { type: 'object', additionalProperties: { type: 'string' } },
                            disabled: { type: 'boolean' },
                        },
                        additionalProperties: false,
                    },
                ],
            },
        },
    },
    additionalProperties: false,
};
```

- [ ] **Step 5: Edit `mcp-config.ts` — shared `toServerConfig` + helpers + `validateMcpConfig`**

Replace `jsonToServerConfigs` and `mergeConfigs` (lines ~265–317) and add the new helpers:

```ts
function toServerConfig(id: string, entry: MCPServerJsonEntry): MCPServerConfig {
    const defaultServer = DEFAULT_MCP_SERVERS.find(s => s.id === id);
    const name = defaultServer?.name || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const description = defaultServer?.description || `MCP server: ${id}`;
    const enabled = entry.disabled !== true;

    if (entry.type === 'sse' || entry.type === 'http') {
        return {
            id, name, description, enabled,
            transport: entry.type,
            command: '',
            args: [],
            url: entry.url,
            headers: entry.headers || {},
        };
    }

    return {
        id, name, description, enabled,
        transport: 'stdio',
        command: entry.command,
        args: entry.args,
        env: entry.env || {},
        requiresAwsCredentials: entry.requiresAwsCredentials ?? defaultServer?.requiresAwsCredentials ?? false,
    };
}

export function jsonToServerConfigs(json: MCPConfigJson): MCPServerConfig[] {
    return Object.entries(json.mcpServers).map(([id, entry]) => toServerConfig(id, entry));
}

export function mergeConfigs(savedJson: MCPConfigJson | null): MCPServerConfig[] {
    if (!savedJson) {
        return DEFAULT_MCP_SERVERS;
    }
    const merged: Record<string, MCPServerConfig> = {};
    for (const server of DEFAULT_MCP_SERVERS) {
        merged[server.id] = { ...server };
    }
    for (const [id, entry] of Object.entries(savedJson.mcpServers)) {
        merged[id] = toServerConfig(id, entry);
    }
    return Object.values(merged);
}

function isValidHttpUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Single source of truth for MCP config validation (used by both API routes).
 * stdio entries require command + args; remote (sse/http) require a valid url.
 */
export function validateMcpConfig(config: unknown): { ok: true } | { ok: false; error: string } {
    const cfg = config as { mcpServers?: unknown };
    if (!cfg || typeof cfg !== 'object' || typeof cfg.mcpServers !== 'object' || cfg.mcpServers === null) {
        return { ok: false, error: 'Invalid config: must contain "mcpServers" object' };
    }
    for (const [id, raw] of Object.entries(cfg.mcpServers as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') {
            return { ok: false, error: `Invalid server "${id}": entry must be an object` };
        }
        const entry = raw as Record<string, unknown>;
        const type = (entry.type as string) ?? 'stdio';
        if (type === 'stdio') {
            if (typeof entry.command !== 'string' || !entry.command.trim()) {
                return { ok: false, error: `Invalid server "${id}": stdio servers require a non-empty "command"` };
            }
            if (!Array.isArray(entry.args)) {
                return { ok: false, error: `Invalid server "${id}": stdio servers require an "args" array` };
            }
        } else if (type === 'sse' || type === 'http') {
            if (!isValidHttpUrl(entry.url)) {
                return { ok: false, error: `Invalid server "${id}": ${type} servers require a valid http(s) "url"` };
            }
        } else {
            return { ok: false, error: `Invalid server "${id}": unknown transport type "${type}"` };
        }
    }
    return { ok: true };
}
```

> `defaultsToJson()` is unchanged — stdio defaults need no `type` field.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web-ui && bun run test -- mcp-config`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent/mcp-config.ts apps/web-ui/lib/agent/mcp-config.test.ts
git commit -m "feat(mcp): transport-tagged config entries + validateMcpConfig + remote-aware helpers"
```

---

### Task 2: `mcp-form-schema.ts` — Zod schema + form↔config conversion

**Files:**
- Create: `apps/web-ui/lib/agent/mcp-form-schema.ts`
- Test: `apps/web-ui/lib/agent/mcp-form-schema.test.ts`

**Interfaces:**
- Consumes: `MCPConfigJson`, `MCPServerJsonEntry` from `./mcp-config`.
- Produces:
  - `mcpFormSchema` (Zod) with `{ servers: McpFormRow[] }`
  - `type McpFormRow`, `type McpFormValues`
  - `configToFormRows(config: MCPConfigJson): McpFormRow[]`
  - `formRowsToConfig(rows: McpFormRow[]): { config: MCPConfigJson; error?: string }`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/mcp-form-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { configToFormRows, formRowsToConfig, mcpFormSchema, type McpFormRow } from './mcp-form-schema';
import type { MCPConfigJson } from './mcp-config';

describe('configToFormRows / formRowsToConfig round-trip', () => {
    it('round-trips a stdio entry with env', () => {
        const config: MCPConfigJson = { mcpServers: { a: { command: 'uvx', args: ['x'], env: { K: 'v' }, disabled: false, requiresAwsCredentials: true } } };
        const rows = configToFormRows(config);
        expect(rows[0]).toMatchObject({ id: 'a', type: 'stdio', command: 'uvx', args: ['x'], requiresAwsCredentials: true });
        expect(rows[0].type === 'stdio' && rows[0].env).toEqual([{ key: 'K', value: 'v' }]);
        const { config: out, error } = formRowsToConfig(rows);
        expect(error).toBeUndefined();
        expect(out.mcpServers.a).toMatchObject({ command: 'uvx', args: ['x'], env: { K: 'v' }, requiresAwsCredentials: true });
    });

    it('round-trips an sse entry with headers', () => {
        const config: MCPConfigJson = { mcpServers: { r: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer t' } } } };
        const rows = configToFormRows(config);
        const { config: out } = formRowsToConfig(rows);
        expect(out.mcpServers.r).toEqual({ type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer t' }, disabled: false });
    });

    it('flags duplicate ids', () => {
        const rows: McpFormRow[] = [
            { id: 'dup', type: 'stdio', command: 'a', args: [], env: [], requiresAwsCredentials: false, disabled: false },
            { id: 'dup', type: 'stdio', command: 'b', args: [], env: [], requiresAwsCredentials: false, disabled: false },
        ];
        expect(formRowsToConfig(rows).error).toMatch(/Duplicate/);
    });

    it('flags a blank id', () => {
        const rows: McpFormRow[] = [{ id: '   ', type: 'stdio', command: 'a', args: [], env: [], requiresAwsCredentials: false, disabled: false }];
        expect(formRowsToConfig(rows).error).toMatch(/ID/);
    });

    it('mcpFormSchema rejects a remote row with an invalid url', () => {
        const parsed = mcpFormSchema.safeParse({ servers: [{ id: 'r', type: 'http', url: 'nope', headers: [], disabled: false }] });
        expect(parsed.success).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bun run test -- mcp-form-schema`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `mcp-form-schema.ts`**

```ts
import { z } from 'zod';
import type { MCPConfigJson, MCPServerJsonEntry } from './mcp-config';

const kvPairSchema = z.object({ key: z.string(), value: z.string() });

export const stdioRowSchema = z.object({
    id: z.string().min(1, 'Server ID is required'),
    type: z.literal('stdio'),
    command: z.string().min(1, 'Command is required'),
    args: z.array(z.string()),
    env: z.array(kvPairSchema),
    requiresAwsCredentials: z.boolean(),
    disabled: z.boolean(),
});

export const remoteRowSchema = z.object({
    id: z.string().min(1, 'Server ID is required'),
    type: z.enum(['sse', 'http']),
    url: z.string().url('Must be a valid http(s) URL'),
    headers: z.array(kvPairSchema),
    disabled: z.boolean(),
});

export const mcpRowSchema = z.discriminatedUnion('type', [stdioRowSchema, remoteRowSchema]);
export const mcpFormSchema = z.object({ servers: z.array(mcpRowSchema) });

export type McpStdioRow = z.infer<typeof stdioRowSchema>;
export type McpRemoteRow = z.infer<typeof remoteRowSchema>;
export type McpFormRow = z.infer<typeof mcpRowSchema>;
export type McpFormValues = z.infer<typeof mcpFormSchema>;

function recordToPairs(rec?: Record<string, string>): { key: string; value: string }[] {
    return Object.entries(rec || {}).map(([key, value]) => ({ key, value }));
}

function pairsToRecord(pairs: { key: string; value: string }[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { key, value } of pairs) {
        const k = key.trim();
        if (k) out[k] = value;
    }
    return out;
}

export function configToFormRows(config: MCPConfigJson): McpFormRow[] {
    return Object.entries(config.mcpServers).map(([id, entry]) => {
        if (entry.type === 'sse' || entry.type === 'http') {
            return {
                id,
                type: entry.type,
                url: entry.url,
                headers: recordToPairs(entry.headers),
                disabled: entry.disabled === true,
            };
        }
        return {
            id,
            type: 'stdio',
            command: entry.command,
            args: [...entry.args],
            env: recordToPairs(entry.env),
            requiresAwsCredentials: entry.requiresAwsCredentials === true,
            disabled: entry.disabled === true,
        };
    });
}

export function formRowsToConfig(rows: McpFormRow[]): { config: MCPConfigJson; error?: string } {
    const mcpServers: Record<string, MCPServerJsonEntry> = {};
    for (const row of rows) {
        const id = row.id.trim();
        if (!id) return { config: { mcpServers }, error: 'Every server needs an ID' };
        if (mcpServers[id]) return { config: { mcpServers }, error: `Duplicate server ID "${id}"` };

        if (row.type === 'sse' || row.type === 'http') {
            const headers = pairsToRecord(row.headers);
            mcpServers[id] = {
                type: row.type,
                url: row.url,
                ...(Object.keys(headers).length ? { headers } : {}),
                disabled: row.disabled,
            };
        } else {
            const env = pairsToRecord(row.env);
            mcpServers[id] = {
                command: row.command,
                args: row.args,
                ...(Object.keys(env).length ? { env } : {}),
                ...(row.requiresAwsCredentials ? { requiresAwsCredentials: true } : {}),
                disabled: row.disabled,
            };
        }
    }
    return { config: { mcpServers } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bun run test -- mcp-form-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/mcp-form-schema.ts apps/web-ui/lib/agent/mcp-form-schema.test.ts
git commit -m "feat(mcp): zod form schema + form<->config conversion helpers"
```

---

### Task 3: `mcp-manager.ts` — remote transports via `buildTransport()`

**Files:**
- Modify: `apps/web-ui/lib/agent/mcp-manager.ts`
- Test: `apps/web-ui/lib/agent/mcp-manager.test.ts` (create)

**Interfaces:**
- Consumes: `MCPServerConfig` (now with `transport`/`url`/`headers`) from `./mcp-config`.
- Produces:
  - `export function buildTransport(config: MCPServerConfig): Transport`
  - `MCPServerManager.probeConnection(config: MCPServerConfig): Promise<{ toolCount: number; tools: string[] }>`
  - `connectServer` / `connectServers` signatures unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/mcp-manager.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const { StdioCtor, SseCtor, HttpCtor } = vi.hoisted(() => ({
    StdioCtor: vi.fn(function (this: any, opts: any) { this.kind = 'stdio'; this.opts = opts; }),
    SseCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'sse'; this.url = url; this.opts = opts; }),
    HttpCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'http'; this.url = url; this.opts = opts; }),
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: StdioCtor }));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: SseCtor }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: HttpCtor }));

import { buildTransport } from './mcp-manager';

describe('buildTransport', () => {
    it('builds a stdio transport for a stdio config', () => {
        const t: any = buildTransport({ id: 'a', name: 'A', description: '', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
        expect(t.kind).toBe('stdio');
        expect(t.opts.command).toBe('npx');
    });

    it('defaults to stdio when transport is absent', () => {
        const t: any = buildTransport({ id: 'a', name: 'A', description: '', enabled: true, command: 'uvx', args: [] });
        expect(t.kind).toBe('stdio');
    });

    it('builds an sse transport with headers', () => {
        const t: any = buildTransport({ id: 'r', name: 'R', description: '', enabled: true, transport: 'sse', command: '', args: [], url: 'https://h/sse', headers: { Authorization: 'Bearer t' } });
        expect(t.kind).toBe('sse');
        expect(t.url.toString()).toBe('https://h/sse');
        expect(t.opts.requestInit.headers).toEqual({ Authorization: 'Bearer t' });
    });

    it('builds an http transport without headers (no requestInit)', () => {
        const t: any = buildTransport({ id: 'r', name: 'R', description: '', enabled: true, transport: 'http', command: '', args: [], url: 'https://h/mcp' });
        expect(t.kind).toBe('http');
        expect(t.opts).toBeUndefined();
    });

    it('throws for a remote config missing a url', () => {
        expect(() => buildTransport({ id: 'r', name: 'R', description: '', enabled: true, transport: 'sse', command: '', args: [] }))
            .toThrow(/url/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bun run test -- mcp-manager`
Expected: FAIL — `buildTransport` not exported.

- [ ] **Step 3: Edit `mcp-manager.ts` — imports + `buildTransport`**

Add imports near the top (after the existing stdio import on line 12):

```ts
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
```

Add this exported function near the other module-level helpers (e.g. just before `export interface MCPToolInfo`):

```ts
/**
 * Build the MCP client transport for a server config.
 * Pure + side-effect free (constructs the transport object) — unit tested.
 */
export function buildTransport(config: MCPServerConfig): Transport {
    const transport = config.transport ?? 'stdio';

    if (transport === 'sse' || transport === 'http') {
        if (!config.url) {
            throw new Error(`MCP server "${config.name}" (${config.id}) uses ${transport} transport but has no "url"`);
        }
        const url = new URL(config.url);
        const headers = config.headers || {};
        const opts = Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined;
        return transport === 'sse'
            ? new SSEClientTransport(url, opts)
            : new StreamableHTTPClientTransport(url, opts);
    }

    return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
            ...process.env as Record<string, string>,
            ...(config.env || {}),
        },
    });
}
```

- [ ] **Step 4: Edit `mcp-manager.ts` — widen `transports` map + rework `_doConnect`**

Change the field declaration (line ~180):

```ts
    private transports: Map<string, Transport> = new Map();
```

Replace the body of `_doConnect` (lines ~212–264) with:

```ts
    private async _doConnect(config: MCPServerConfig): Promise<void> {
        const transportType = config.transport ?? 'stdio';
        let effectiveConfig = config;

        if (transportType === 'stdio') {
            // Adapt config for the current environment (e.g. docker → npx in ECS)
            effectiveConfig = adaptConfigForEnvironment(config);
            console.log(`[MCPManager] Connecting to stdio MCP server: "${effectiveConfig.name}" (${effectiveConfig.id})`);
            console.log(`[MCPManager]   Command: ${effectiveConfig.command} ${effectiveConfig.args.join(' ')}`);
            if (effectiveConfig.command !== config.command) {
                console.log(`[MCPManager]   (adapted from: ${config.command} ${config.args.join(' ')})`);
            }
            if (!isCommandAvailable(effectiveConfig.command)) {
                const errMsg = `Command "${effectiveConfig.command}" not found on PATH. ` +
                    `MCP server "${effectiveConfig.name}" requires "${effectiveConfig.command}" to be installed. ` +
                    `Current PATH: ${process.env.PATH || '(not set)'}`;
                console.error(`[MCPManager] ❌ ${errMsg}`);
                throw new Error(errMsg);
            }
            console.log(`[MCPManager] ✓ Command "${effectiveConfig.command}" found on PATH`);
        } else {
            console.log(`[MCPManager] Connecting to ${transportType} MCP server: "${config.name}" (${config.id}) at ${config.url}`);
        }

        try {
            const transport = buildTransport(effectiveConfig);

            const client = new Client({
                name: 'nucleus-cloud-ops-agent',
                version: '1.0.0',
            });

            await client.connect(transport);

            this.clients.set(config.id, client);
            this.transports.set(config.id, transport);

            // Pre-cache tools on connection
            await this._cacheTools(config.id, config.name);

            console.log(`[MCPManager] ✅ Connected to "${config.name}" (${config.id})`);
        } catch (error: any) {
            console.error(`[MCPManager] ❌ Failed to connect to "${config.name}" (${config.id}):`, error.message);
            this.clients.delete(config.id);
            this.transports.delete(config.id);
            this.toolCache.delete(config.id);
            throw error;
        }
    }
```

- [ ] **Step 5: Edit `mcp-manager.ts` — guard AWS-credential path + add `probeConnection`**

At the start of `connectServerWithAwsCredentials` (right after the method signature, before the `scopedId` line ~306), insert:

```ts
        // Remote transports never use AWS credential injection — connect normally.
        if ((config.transport ?? 'stdio') !== 'stdio') {
            await this.connectServer(config);
            return config.id;
        }
```

Add a new public method (e.g. just after `connectServerWithAwsCredentials`):

```ts
    /**
     * Connect a throwaway instance, list its tools, then disconnect.
     * Used by the "Test connection" endpoint — never persists state.
     */
    async probeConnection(config: MCPServerConfig): Promise<{ toolCount: number; tools: string[] }> {
        const ephemeralId = `__probe__:${config.id}:${Date.now()}`;
        try {
            await this._doConnect({ ...config, id: ephemeralId });
            const tools = this.toolCache.get(ephemeralId) || [];
            return { toolCount: tools.length, tools: tools.map(t => t.name) };
        } finally {
            await this.disconnectServer(ephemeralId);
        }
    }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/web-ui && bun run test -- mcp-manager`
Expected: PASS (buildTransport cases).
Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json`
Expected: no new errors in `mcp-manager.ts` / `mcp-config.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent/mcp-manager.ts apps/web-ui/lib/agent/mcp-manager.test.ts
git commit -m "feat(mcp): SSE + streamable-HTTP transports via buildTransport, probeConnection for tests"
```

---

### Task 4: Wire `validateMcpConfig` into both API routes

**Files:**
- Modify: `apps/web-ui/app/api/mcp-servers/route.ts:82-89`
- Modify: `apps/web-ui/app/api/agent-ops/mcp-settings/route.ts:66-73`

**Interfaces:**
- Consumes: `validateMcpConfig` from `@/lib/agent/mcp-config`.
- Produces: nothing new (validation behavior change only).

- [ ] **Step 1: Edit `app/api/mcp-servers/route.ts`**

Add `validateMcpConfig` to the existing import from `@/lib/agent/mcp-config`. Replace the validation block (the `if (!config ...)` and the `for (const [id, entry] ...)` loop, lines ~74–89) with:

```ts
        const validation = validateMcpConfig(config);
        if (!validation.ok) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }
```

- [ ] **Step 2: Edit `app/api/agent-ops/mcp-settings/route.ts`**

Add `validateMcpConfig` to its import from `@/lib/agent/mcp-config`. Replace the same validation block (lines ~59–73) with the identical three lines above.

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json`
Expected: no errors in either route file.

- [ ] **Step 4: Manual smoke (optional, if dev server running)**

`PUT /api/mcp-servers` with `{ config: { mcpServers: { r: { type: 'sse', url: 'https://example.com/sse' } } } }` → 200.
`PUT` with `{ config: { mcpServers: { r: { type: 'sse', url: 'bad' } } } }` → 400 with url error.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/mcp-servers/route.ts apps/web-ui/app/api/agent-ops/mcp-settings/route.ts
git commit -m "feat(mcp): transport-aware validation in both MCP config routes"
```

---

### Task 5: Test-connection endpoints (shared handler) on both surfaces

**Files:**
- Create: `apps/web-ui/lib/agent/mcp-test-handler.ts`
- Create: `apps/web-ui/app/api/mcp-servers/test/route.ts`
- Create: `apps/web-ui/app/api/agent-ops/mcp-settings/test/route.ts`

**Interfaces:**
- Consumes: `validateMcpConfig`, `jsonToServerConfigs`, `MCPConfigJson`, `MCPServerJsonEntry` from `@/lib/agent/mcp-config`; `getMCPManager` from `@/lib/agent/mcp-manager`; `getSessionTenantId` from `@/lib/auth-session`.
- Produces: `handleMcpTest(req: Request): Promise<NextResponse>`; two `POST` route exports delegating to it.

- [ ] **Step 1: Create the shared handler `lib/agent/mcp-test-handler.ts`**

```ts
import { NextResponse } from 'next/server';
import {
    validateMcpConfig,
    jsonToServerConfigs,
    type MCPConfigJson,
    type MCPServerJsonEntry,
} from '@/lib/agent/mcp-config';
import { getMCPManager } from '@/lib/agent/mcp-manager';
import { getSessionTenantId } from '@/lib/auth-session';

/**
 * Shared "Test connection" handler for both MCP settings surfaces.
 * Probes a single server entry (connect → listTools → disconnect). No persistence.
 */
export async function handleMcpTest(req: Request): Promise<NextResponse> {
    try {
        await getSessionTenantId();
    } catch {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await req.json();
        const id: string | undefined = body?.id;
        const entry: MCPServerJsonEntry | undefined = body?.entry;
        if (!id || !entry) {
            return NextResponse.json({ success: false, error: 'Request must include "id" and "entry"' }, { status: 400 });
        }

        const single: MCPConfigJson = { mcpServers: { [id]: entry } };
        const validation = validateMcpConfig(single);
        if (!validation.ok) {
            return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
        }

        const config = jsonToServerConfigs(single)[0];

        if ((config.transport ?? 'stdio') === 'stdio' && config.requiresAwsCredentials) {
            return NextResponse.json({
                success: false,
                error: 'This server injects AWS credentials and can only be verified at run time with an account selected.',
            });
        }

        const manager = getMCPManager();
        const result = await manager.probeConnection(config);
        return NextResponse.json({ success: true, toolCount: result.toolCount, tools: result.tools });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error?.message || 'Connection test failed' });
    }
}
```

- [ ] **Step 2: Create `app/api/mcp-servers/test/route.ts`**

```ts
import { handleMcpTest } from '@/lib/agent/mcp-test-handler';

export async function POST(req: Request) {
    return handleMcpTest(req);
}
```

- [ ] **Step 3: Create `app/api/agent-ops/mcp-settings/test/route.ts`**

```ts
import { handleMcpTest } from '@/lib/agent/mcp-test-handler';

export async function POST(req: Request) {
    return handleMcpTest(req);
}
```

- [ ] **Step 4: Verify typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json`
Expected: no errors in the three new files.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/mcp-test-handler.ts apps/web-ui/app/api/mcp-servers/test/route.ts apps/web-ui/app/api/agent-ops/mcp-settings/test/route.ts
git commit -m "feat(mcp): test-connection endpoints on both MCP surfaces"
```

---

### Task 6: TanStack Query hooks + query-keys entry

**Files:**
- Modify: `apps/web-ui/lib/queries/query-keys.ts`
- Create: `apps/web-ui/lib/queries/mcp-servers.ts`

**Interfaces:**
- Consumes: `MCPConfigJson`, `MCPServerJsonEntry` from `@/lib/agent/mcp-config`; `MCPServerConfig` for the `servers` field type.
- Produces:
  - `queryKeys.mcpServers.config(apiPath)`
  - `useMcpConfig(apiPath)`, `useSaveMcpConfig(apiPath)`, `useResetMcpConfig(apiPath)`, `useTestMcpServer(apiPath)`
  - `interface McpConfigResponse { servers: MCPServerConfig[]; config: MCPConfigJson; isCustom: boolean }`
  - `interface McpTestResult { success: boolean; toolCount?: number; tools?: string[]; error?: string }`

- [ ] **Step 1: Add the key factory entry**

In `query-keys.ts`, add inside the `queryKeys` object (e.g. after `kbChat`):

```ts
    mcpServers: {
        all: ['mcp-servers'] as const,
        config: (apiPath: string) => [...queryKeys.mcpServers.all, apiPath] as const,
    },
```

- [ ] **Step 2: Create `lib/queries/mcp-servers.ts`**

```ts
'use client';

/**
 * TanStack Query hooks for MCP server configuration.
 * Parameterized by `apiPath` so both surfaces reuse them:
 *   - '/api/mcp-servers'              (main AI Ops)
 *   - '/api/agent-ops/mcp-settings'   (Agent Ops)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import type { MCPConfigJson, MCPServerConfig, MCPServerJsonEntry } from '@/lib/agent/mcp-config';

export interface McpConfigResponse {
    servers: MCPServerConfig[];
    config: MCPConfigJson;
    isCustom: boolean;
}

export interface McpTestResult {
    success: boolean;
    toolCount?: number;
    tools?: string[];
    error?: string;
}

export function useMcpConfig(apiPath: string) {
    return useQuery({
        queryKey: queryKeys.mcpServers.config(apiPath),
        queryFn: async (): Promise<McpConfigResponse> => {
            const res = await fetch(apiPath);
            if (!res.ok) throw new Error('Failed to load MCP configuration');
            return res.json();
        },
    });
}

export function useSaveMcpConfig(apiPath: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (config: MCPConfigJson): Promise<McpConfigResponse> => {
            const res = await fetch(apiPath, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Failed to save MCP configuration');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.mcpServers.config(apiPath) }),
    });
}

export function useResetMcpConfig(apiPath: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (): Promise<McpConfigResponse> => {
            const res = await fetch(apiPath, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Failed to reset MCP configuration');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.mcpServers.config(apiPath) }),
    });
}

export function useTestMcpServer(apiPath: string) {
    return useMutation({
        mutationFn: async (vars: { id: string; entry: MCPServerJsonEntry }): Promise<McpTestResult> => {
            const res = await fetch(`${apiPath}/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(vars),
            });
            return res.json();
        },
    });
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/queries/query-keys.ts apps/web-ui/lib/queries/mcp-servers.ts
git commit -m "feat(mcp): TanStack Query hooks for MCP config get/save/reset/test"
```

---

### Task 7: `KeyValueEditor` + `mcp-server-form.tsx` (form view)

**Files:**
- Create: `apps/web-ui/components/settings/key-value-editor.tsx`
- Create: `apps/web-ui/components/settings/mcp-server-form.tsx`

**Interfaces:**
- Consumes: `McpFormValues`, `McpFormRow`, `mcpFormSchema` from `@/lib/agent/mcp-form-schema`; `MCPServerJsonEntry` from `@/lib/agent/mcp-config`; `useTestMcpServer` from `@/lib/queries/mcp-servers`; `formRowsToConfig` for building a single test entry.
- Produces:
  - `KeyValueEditor` (controlled `value: {key,value}[]`, `onChange`, `label`, `keyPlaceholder`, `valuePlaceholder`).
  - `McpServerForm` props:
    - `value: McpFormValues` (controlled)
    - `onChange: (value: McpFormValues) => void`
    - `apiPath: string` (for the per-server Test button)

- [ ] **Step 1: Create `components/settings/key-value-editor.tsx`**

```tsx
'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Plus, X } from 'lucide-react';

interface Pair { key: string; value: string; }

interface KeyValueEditorProps {
  label: string;
  value: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueEditor({ label, value, onChange, keyPlaceholder = 'KEY', valuePlaceholder = 'value' }: KeyValueEditorProps) {
  const update = (i: number, patch: Partial<Pair>) => {
    onChange(value.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { key: '', value: '' }]);

  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="space-y-2">
        {value.map((pair, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input className="h-8 text-xs font-mono" value={pair.key} placeholder={keyPlaceholder} onChange={(e) => update(i, { key: e.target.value })} />
            <Input className="h-8 text-xs font-mono" value={pair.value} placeholder={valuePlaceholder} onChange={(e) => update(i, { value: e.target.value })} />
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" onClick={() => remove(i)} aria-label="Remove">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `components/settings/mcp-server-form.tsx`**

```tsx
'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { KeyValueEditor } from './key-value-editor';
import { useTestMcpServer } from '@/lib/queries/mcp-servers';
import { formRowsToConfig, type McpFormRow, type McpFormValues } from '@/lib/agent/mcp-form-schema';
import { Plus, Trash2, Plug, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

interface McpServerFormProps {
  value: McpFormValues;
  onChange: (value: McpFormValues) => void;
  apiPath: string;
}

function blankStdioRow(): McpFormRow {
  return { id: '', type: 'stdio', command: '', args: [], env: [], requiresAwsCredentials: false, disabled: false };
}

export function McpServerForm({ value, onChange, apiPath }: McpServerFormProps) {
  const rows = value.servers;
  const test = useTestMcpServer(apiPath);
  const [testingId, setTestingId] = useState<string | null>(null);

  const updateRow = (i: number, next: McpFormRow) => {
    onChange({ servers: rows.map((r, idx) => (idx === i ? next : r)) });
  };
  const removeRow = (i: number) => onChange({ servers: rows.filter((_, idx) => idx !== i) });
  const addRow = () => onChange({ servers: [...rows, blankStdioRow()] });

  const changeTransport = (i: number, t: 'stdio' | 'sse' | 'http') => {
    const r = rows[i];
    if (t === 'stdio') updateRow(i, { id: r.id, type: 'stdio', command: '', args: [], env: [], requiresAwsCredentials: false, disabled: r.disabled });
    else updateRow(i, { id: r.id, type: t, url: '', headers: [], disabled: r.disabled });
  };

  const runTest = async (row: McpFormRow) => {
    const { config, error } = formRowsToConfig([row]);
    if (error || !row.id.trim()) {
      toast.error(error || 'Give the server an ID before testing');
      return;
    }
    const entry = config.mcpServers[row.id.trim()];
    setTestingId(row.id);
    try {
      const result = await test.mutateAsync({ id: row.id.trim(), entry });
      if (result.success) toast.success(`Connected — ${result.toolCount ?? 0} tool(s) discovered`);
      else toast.error(result.error || 'Connection failed');
    } catch (e: any) {
      toast.error(e?.message || 'Connection test failed');
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">No MCP servers configured. Add one below.</p>
      )}

      {rows.map((row, i) => {
        const busy = testingId === row.id && test.isPending;
        return (
          <Card key={i}>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Plug className="h-4 w-4 text-primary" />
                </div>
                <div className="grid gap-1.5 flex-1">
                  <Label className="text-xs">Server ID</Label>
                  <Input className="h-8 text-sm" value={row.id} placeholder="my-server" onChange={(e) => updateRow(i, { ...row, id: e.target.value })} />
                </div>
                <div className="grid gap-1.5 w-40">
                  <Label className="text-xs">Transport</Label>
                  <Select value={row.type} onValueChange={(v) => changeTransport(i, v as 'stdio' | 'sse' | 'http')}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio (local)</SelectItem>
                      <SelectItem value="sse">SSE (remote)</SelectItem>
                      <SelectItem value="http">HTTP (remote)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" size="icon" variant="ghost" className="h-8 w-8 mt-5 flex-shrink-0 text-destructive" onClick={() => removeRow(i)} aria-label="Remove server">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {row.type === 'stdio' ? (
                <div className="space-y-3 pl-11">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Command</Label>
                    <Input className="h-8 text-sm font-mono" value={row.command} placeholder="uvx" onChange={(e) => updateRow(i, { ...row, command: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Arguments (one per line)</Label>
                    <textarea
                      className="min-h-[64px] rounded-md border bg-background px-3 py-2 text-xs font-mono"
                      value={row.args.join('\n')}
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                      onChange={(e) => updateRow(i, { ...row, args: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
                    />
                  </div>
                  <KeyValueEditor label="Environment variables" value={row.env} onChange={(env) => updateRow(i, { ...row, env })} keyPlaceholder="VAR_NAME" />
                  <div className="flex items-center gap-2">
                    <Switch checked={row.requiresAwsCredentials} onCheckedChange={(c) => updateRow(i, { ...row, requiresAwsCredentials: c })} id={`aws-${i}`} />
                    <Label htmlFor={`aws-${i}`} className="text-xs">Inject AWS credentials for the selected account</Label>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 pl-11">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Endpoint URL</Label>
                    <Input className="h-8 text-sm font-mono" value={row.url} placeholder="https://api.example.com/sse" onChange={(e) => updateRow(i, { ...row, url: e.target.value })} />
                  </div>
                  <KeyValueEditor label="Headers" value={row.headers} onChange={(headers) => updateRow(i, { ...row, headers })} keyPlaceholder="Authorization" valuePlaceholder="Bearer ..." />
                </div>
              )}

              <div className="flex items-center justify-between pl-11">
                <div className="flex items-center gap-2">
                  <Switch checked={!row.disabled} onCheckedChange={(c) => updateRow(i, { ...row, disabled: !c })} id={`enabled-${i}`} />
                  <Label htmlFor={`enabled-${i}`} className="text-xs">Enabled</Label>
                </div>
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5" disabled={busy} onClick={() => runTest(row)}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Test connection
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Button type="button" variant="outline" className="w-full gap-1.5" onClick={addRow}>
        <Plus className="h-4 w-4" /> Add MCP server
      </Button>
    </div>
  );
}
```

> Design note: `args` and key/value editors are controlled directly through `value`/`onChange` (the parent `mcp-settings.tsx` validates with `mcpFormSchema` / `formRowsToConfig` before save). This keeps RHF usage at the parent boundary and avoids nested `useFieldArray` complexity; per-row Zod validation still runs on save. `XCircle` import is reserved for an inline error affordance if added later — remove if unused to satisfy lint.

- [ ] **Step 3: Lint + typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json && bun run lint`
Expected: no errors. (If `XCircle` is unused, delete it from the import.)

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/settings/key-value-editor.tsx apps/web-ui/components/settings/mcp-server-form.tsx
git commit -m "feat(mcp): form-view component (per-server cards) + key-value editor"
```

---

### Task 8: Rework `mcp-settings.tsx` — Form|JSON toggle, query hooks, sonner

**Files:**
- Modify: `apps/web-ui/components/settings/mcp-settings.tsx` (full rework)

**Interfaces:**
- Consumes: `useMcpConfig`, `useSaveMcpConfig`, `useResetMcpConfig` from `@/lib/queries/mcp-servers`; `MCP_CONFIG_JSON_SCHEMA`, `validateMcpConfig`, `defaultsToJson`, `type MCPConfigJson` from `@/lib/agent/mcp-config`; `configToFormRows`, `formRowsToConfig`, `mcpFormSchema`, `type McpFormValues` from `@/lib/agent/mcp-form-schema`; `McpServerForm` from `./mcp-server-form`.
- Produces: unchanged public prop `apiPath?: string`.

- [ ] **Step 1: Replace `mcp-settings.tsx`**

```tsx
'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { Plug, Save, RotateCcw, Check, AlertCircle, Loader2, Info, Copy, Code2, ListChecks } from 'lucide-react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import {
  MCP_CONFIG_JSON_SCHEMA,
  validateMcpConfig,
  defaultsToJson,
  type MCPConfigJson,
} from '@/lib/agent/mcp-config';
import { configToFormRows, formRowsToConfig, mcpFormSchema, type McpFormValues } from '@/lib/agent/mcp-form-schema';
import { McpServerForm } from './mcp-server-form';
import { useMcpConfig, useSaveMcpConfig, useResetMcpConfig } from '@/lib/queries/mcp-servers';

const MONACO_SCHEMA = {
  uri: 'https://nucleus-platform/mcp-config.schema.json',
  fileMatch: ['*'],
  schema: MCP_CONFIG_JSON_SCHEMA,
};

interface MCPSettingsProps {
  apiPath?: string;
}

type Mode = 'form' | 'json';

export function MCPSettings({ apiPath = '/api/mcp-servers' }: MCPSettingsProps) {
  const { resolvedTheme } = useTheme();
  const { data, isLoading } = useMcpConfig(apiPath);
  const saveMutation = useSaveMcpConfig(apiPath);
  const resetMutation = useResetMcpConfig(apiPath);

  const [mode, setMode] = useState<Mode>('form');
  const [formValues, setFormValues] = useState<McpFormValues>({ servers: [] });
  const [editorValue, setEditorValue] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [isValidJson, setIsValidJson] = useState(true);
  const [savedFlash, setSavedFlash] = useState(false);
  const editorRef = useRef<any>(null);

  // Hydrate from server
  useEffect(() => {
    if (!data) return;
    const config = data.config ?? defaultsToJson();
    setFormValues({ servers: configToFormRows(config) });
    setEditorValue(JSON.stringify(config, null, 2));
    setIsCustom(data.isCustom);
  }, [data]);

  const summary = (() => {
    const rows = formValues.servers;
    return { total: rows.length, enabled: rows.filter((r) => !r.disabled).length };
  })();

  const handleEditorChange = useCallback((value: string | undefined) => {
    const val = value || '';
    setEditorValue(val);
    try {
      const parsed = JSON.parse(val);
      setIsValidJson(validateMcpConfig(parsed).ok);
    } catch {
      setIsValidJson(false);
    }
  }, []);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [MONACO_SCHEMA],
      allowComments: false,
      trailingCommas: 'error',
    });
    setTimeout(() => editor.getAction('editor.action.formatDocument')?.run(), 200);
  };

  // Build the canonical MCPConfigJson from the active view; returns null on error (after toasting).
  const buildConfig = (): MCPConfigJson | null => {
    if (mode === 'json') {
      try {
        const parsed = JSON.parse(editorValue);
        const v = validateMcpConfig(parsed);
        if (!v.ok) { toast.error(v.error); return null; }
        return parsed as MCPConfigJson;
      } catch {
        toast.error('Invalid JSON'); return null;
      }
    }
    const schemaCheck = mcpFormSchema.safeParse(formValues);
    if (!schemaCheck.success) {
      toast.error(schemaCheck.error.issues[0]?.message || 'Fix form errors before saving');
      return null;
    }
    const { config, error } = formRowsToConfig(formValues.servers);
    if (error) { toast.error(error); return null; }
    const v = validateMcpConfig(config);
    if (!v.ok) { toast.error(v.error); return null; }
    return config;
  };

  const switchMode = (next: Mode) => {
    if (!next || next === mode) return;
    if (next === 'json') {
      // form -> json: serialize current form rows
      const { config, error } = formRowsToConfig(formValues.servers);
      if (error) { toast.error(error); return; }
      setEditorValue(JSON.stringify(config, null, 2));
      setIsValidJson(true);
      setMode('json');
    } else {
      // json -> form: parse + validate, block on error
      try {
        const parsed = JSON.parse(editorValue);
        const v = validateMcpConfig(parsed);
        if (!v.ok) { toast.error(`Fix JSON before switching to Form: ${v.error}`); return; }
        setFormValues({ servers: configToFormRows(parsed as MCPConfigJson) });
        setMode('form');
      } catch {
        toast.error('Fix JSON before switching to Form');
      }
    }
  };

  const handleSave = async () => {
    const config = buildConfig();
    if (!config) return;
    try {
      const res = await saveMutation.mutateAsync(config);
      setFormValues({ servers: configToFormRows(res.config) });
      setEditorValue(JSON.stringify(res.config, null, 2));
      setIsCustom(true);
      setSavedFlash(true);
      toast.success('MCP configuration saved');
      setTimeout(() => setSavedFlash(false), 3000);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save');
    }
  };

  const handleReset = async () => {
    try {
      const res = await resetMutation.mutateAsync();
      setFormValues({ servers: configToFormRows(res.config) });
      setEditorValue(JSON.stringify(res.config, null, 2));
      setIsCustom(false);
      toast.success('Reset to defaults');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to reset');
    }
  };

  const saving = saveMutation.isPending || resetMutation.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center">
                <Plug className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <CardTitle className="text-lg">MCP Servers Configuration</CardTitle>
                <CardDescription>
                  Configure Model Context Protocol servers for the AI agent. Local (stdio) and remote (SSE / HTTP) transports are supported.
                </CardDescription>
              </div>
            </div>
            {isCustom && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium">
                CUSTOMIZED
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving || (mode === 'json' && !isValidJson)} className={cn('h-8 text-xs gap-1.5', savedFlash && 'bg-green-600 hover:bg-green-700')}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : savedFlash ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                {savedFlash ? 'Saved' : 'Save'}
              </Button>
              <Button size="sm" variant="outline" onClick={handleReset} disabled={!isCustom || saving} className="h-8 text-xs gap-1.5" title="Reset to defaults">
                <RotateCcw className="h-3.5 w-3.5" /> Reset to Defaults
              </Button>
              {mode === 'json' && (
                <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(editorValue)} className="h-8 text-xs gap-1.5" title="Copy">
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            <div className="flex items-center gap-3">
              {mode === 'json' && !isValidJson && (
                <span className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> Invalid JSON
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {summary.total} server{summary.total !== 1 ? 's' : ''},{' '}
                <span className={cn(summary.enabled > 0 && 'text-green-600 dark:text-green-400 font-medium')}>{summary.enabled} enabled</span>
              </span>
              <ToggleGroup type="single" value={mode} onValueChange={(v) => switchMode(v as Mode)} size="sm">
                <ToggleGroupItem value="form" className="h-8 px-2 text-xs gap-1.5" aria-label="Form view"><ListChecks className="h-3.5 w-3.5" /> Form</ToggleGroupItem>
                <ToggleGroupItem value="json" className="h-8 px-2 text-xs gap-1.5" aria-label="JSON view"><Code2 className="h-3.5 w-3.5" /> JSON</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {isLoading ? (
            <div className="h-[420px] flex items-center justify-center bg-muted/20 rounded-lg border">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mode === 'form' ? (
            <McpServerForm value={formValues} onChange={setFormValues} apiPath={apiPath} />
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <Editor
                height="420px"
                defaultLanguage="json"
                value={editorValue}
                onChange={handleEditorChange}
                onMount={handleEditorMount}
                theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
                options={{
                  minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', folding: true,
                  bracketPairColorization: { enabled: true }, formatOnPaste: true, automaticLayout: true,
                  scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'on', renderLineHighlight: 'line',
                  padding: { top: 12, bottom: 12 }, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                }}
              />
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <Info className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Toggle <strong>Form</strong>/<strong>JSON</strong> to edit the same configuration either way. Remote servers use <code className="px-1 py-0.5 rounded bg-muted text-[11px] font-mono">type: &quot;sse&quot;</code> or <code className="px-1 py-0.5 rounded bg-muted text-[11px] font-mono">&quot;http&quot;</code> with a URL.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Lint + typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json && bun run lint`
Expected: no errors. (Confirm `components/ui/toggle-group.tsx` exports `ToggleGroup`/`ToggleGroupItem`; it does in this repo.)

- [ ] **Step 3: Run the full web-ui test suite**

Run: `cd apps/web-ui && bun run test`
Expected: the new mcp tests pass; pre-existing failures (if any, per project memory ~mock-harness) unchanged.

- [ ] **Step 4: Manual verification (dev server) — both surfaces**

```bash
cd apps/web-ui && bun run dev   # http://localhost:3001
```
Use the Playwright MCP or browser to verify on `/app/channels/mcp-settings` (Agent Ops) and the main MCP settings surface:
1. Page loads in **Form** mode showing existing servers.
2. Toggle to **JSON** → same servers serialize; toggle back → form repopulates.
3. Add a stdio server (command + args + an env var), Save → toast "saved"; reload persists.
4. Add an SSE server with a URL + Authorization header, Save → persists; switch to JSON shows `type: "sse"`.
5. Introduce invalid JSON, try toggling to Form → blocked with a toast; Save disabled / errors.
6. "Test connection" on a reachable stdio server → success toast with tool count; on a bad command → error toast.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/settings/mcp-settings.tsx
git commit -m "feat(mcp): Form|JSON toggle in MCP settings via TanStack Query + sonner"
```

---

## Self-Review

**Spec coverage:**
- Data model union + backward compat → Task 1. ✅
- `validateMcpConfig` shared → Task 1, wired in Task 4. ✅
- Form schema + conversions → Task 2. ✅
- Runtime SSE/HTTP + `buildTransport` + AWS-cred guard + `probeConnection` → Task 3. ✅
- Test endpoints (both surfaces, shared handler) → Task 5. ✅
- Query hooks + keys → Task 6. ✅
- Form view (cards, KeyValueEditor, transport switch, Test button) → Task 7. ✅
- Form|JSON toggle, sonner, query wiring, both surfaces (shared component) → Task 8. ✅
- Tests: config round-trip/validate, form conversion, buildTransport → Tasks 1–3. ✅
- Monaco JSON schema oneOf → Task 1 (consumed in Task 8). ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code. The only conditional instruction is the optional removal of an unused `XCircle` import (explicit, not a placeholder).

**Type consistency:** `MCPConfigJson`/`MCPServerJsonEntry` (Task 1) consumed unchanged by Tasks 2,5,6. `McpFormValues`/`McpFormRow`/`configToFormRows`/`formRowsToConfig` (Task 2) consumed by Tasks 7,8. `buildTransport`/`probeConnection` (Task 3) consumed by Task 5. `useMcpConfig`/`useSaveMcpConfig`/`useResetMcpConfig`/`useTestMcpServer` + `queryKeys.mcpServers.config` (Task 6) consumed by Tasks 7,8. `McpServerForm({ value, onChange, apiPath })` (Task 7) consumed by Task 8. Names align across tasks.
