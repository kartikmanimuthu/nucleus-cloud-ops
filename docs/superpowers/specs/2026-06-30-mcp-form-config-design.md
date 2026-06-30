# MCP Form-Driven Config with Form↔JSON Toggle + Remote Transports

**Date:** 2026-06-30
**Branch:** `mcp-revamp`
**Status:** Approved design — ready for implementation plan

## Summary

The MCP (Model Context Protocol) server settings UI currently offers **only** a Monaco
JSON editor. This adds a **form-driven configuration** view alongside it, with a live
**Form ↔ JSON toggle** (both views edit the same data). It also extends the config to
support **remote transports** (SSE and streamable HTTP) in addition to the existing
stdio (command-based) servers, including the runtime work in `mcp-manager.ts` to actually
connect to them. A per-server **Test Connection** action is included.

Reference: the `chatbot` project (`/Users/kartik/Documents/git-repo/chatbot`) has a
form-driven MCP UI with multiple transports; this design adapts that pattern to nucleus
conventions (RHF + Zod, sonner, TanStack Query) while preserving nucleus's existing
single-blob storage.

## Decisions (confirmed with user)

1. **Architecture:** Form is a second view over the **same `MCPConfigJson` blob**. No new
   DB table, no migration. Existing GET/PUT/DELETE contract on both routes preserved.
2. **Transports:** stdio **+ remote** (SSE / streamable HTTP). Real runtime work in
   `mcp-manager.ts`.
3. **Surfaces:** Both MCP settings screens — main AI Ops (`/api/mcp-servers`) and Agent Ops
   (`/api/agent-ops/mcp-settings`). They share the `MCPSettings` component, so the toggle
   lands on both.
4. **Test connection:** Included — endpoint + per-server button on both surfaces.
5. **Form library:** React Hook Form + Zod (`@hookform/resolvers/zod`), per nucleus
   conventions (not TanStack Form).

## Current State (for reference)

- **Storage:** single JSON blob per config key in `TenantConfig` (`tenant_configs` table).
  Keys: `mcp-servers` and `agent-ops-mcp-servers`. Shape:
  `{ mcpServers: { "<id>": { command, args, env?, disabled?, requiresAwsCredentials? } } }`.
- **UI:** `apps/web-ui/components/settings/mcp-settings.tsx` — Monaco JSON editor only,
  raw `fetch`, inline status. Mounted by both surfaces with an `apiPath` prop.
- **Types/helpers:** `apps/web-ui/lib/agent/mcp-config.ts` — `MCPServerJsonEntry`,
  `MCPConfigJson`, `MCPServerConfig`, `DEFAULT_MCP_SERVERS`, `defaultsToJson`,
  `jsonToServerConfigs`, `mergeConfigs`, Monaco JSON schema.
- **Runtime:** `apps/web-ui/lib/agent/mcp-manager.ts` — `MCPServerManager` singleton,
  stdio-only via `StdioClientTransport`. Consumers: `lib/agent/agent-shared.ts`,
  `lib/agent-ops/agent-executor.ts` (all via `connectServers(ids, allConfigs)`);
  `connectServerWithAwsCredentials` is stdio-specific.
- **API:** `app/api/mcp-servers/route.ts` and `app/api/agent-ops/mcp-settings/route.ts` —
  identical shape; validate `entry.command && Array.isArray(entry.args)`.
- **SDK:** `@modelcontextprotocol/sdk@^1.26.0` — ships `client/sse.js` and
  `client/streamableHttp.js` (verified present in `node_modules`).

## Architecture

```
                ┌─────────────────────────────────────────┐
   UI surface   │  MCPSettings (shared component)          │
                │   ┌──────── Form | JSON ToggleGroup ──┐  │
                │   │ Form view: McpServerForm (RHF+Zod) │  │
                │   │ JSON view: Monaco editor           │  │
                │   └────── canonical state: MCPConfigJson┘ │
                │   Save / Reset / Test (per server)        │
                └──────────────┬────────────────────────────┘
                               │ TanStack Query hooks (lib/queries/mcp-servers.ts)
                               ▼
   API          GET/PUT/DELETE /api/mcp-servers
                GET/PUT/DELETE /api/agent-ops/mcp-settings
                POST           /api/mcp-servers/test
                POST           /api/agent-ops/mcp-settings/test
                               │  validateMcpConfig() (shared, transport-aware)
                               ▼
   Storage      TenantConfig blob  ── unchanged shape (+ optional remote entries)
                               │
                               ▼
   Runtime      MCPServerManager._doConnect() branches on transport:
                  stdio → StdioClientTransport (existing path)
                  sse   → SSEClientTransport
                  http  → StreamableHTTPClientTransport
```

## Components & Changes

### 1. `lib/agent/mcp-config.ts` — data model + helpers

Entry becomes a transport-tagged union. **Backward compatible: absence of `type` ⇒ stdio**,
so every existing saved blob keeps working untouched.

```ts
export interface StdioJsonEntry {
    type?: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
    disabled?: boolean;
    requiresAwsCredentials?: boolean;
}
export interface RemoteJsonEntry {
    type: 'sse' | 'http';
    url: string;
    headers?: Record<string, string>;
    disabled?: boolean;
}
export type MCPServerJsonEntry = StdioJsonEntry | RemoteJsonEntry;
export interface MCPConfigJson { mcpServers: Record<string, MCPServerJsonEntry>; }
```

Runtime `MCPServerConfig` gains:
```ts
transport: 'stdio' | 'sse' | 'http';   // default 'stdio'
url?: string;
headers?: Record<string, string>;
// command/args become optional (required only when transport === 'stdio')
```

Update:
- `defaultsToJson()` — emit `type: 'stdio'` is optional; keep defaults as-is (stdio).
- `jsonToServerConfigs()` / `mergeConfigs()` — resolve `transport` from `entry.type ?? 'stdio'`,
  carry `url`/`headers` for remote.
- Monaco JSON schema (in `mcp-config.ts` and the inline one in `mcp-settings.tsx`) — switch
  the per-entry schema to `oneOf: [stdioSchema, remoteSchema]` with `type` discriminator.
- **New** `validateMcpConfig(config): { ok: true } | { ok: false; error: string }` — the single
  source of truth for entry validation: stdio requires non-empty `command` + array `args`;
  remote requires `type ∈ {sse,http}` + a valid `url`. Used by both API routes.

### 2. `lib/agent/mcp-form-schema.ts` — new

Zod discriminated union mirroring the entry types, plus a row model for the form
(`{ id: string } & entry`). Conversion helpers:
- `configToFormRows(config: MCPConfigJson): McpFormRow[]`
- `formRowsToConfig(rows: McpFormRow[]): MCPConfigJson` (also surfaces duplicate-id errors)

These power the form and the Form↔JSON conversion. Pure functions → unit tested.

### 3. `lib/agent/mcp-manager.ts` — remote transport runtime

- Import `SSEClientTransport` (`@modelcontextprotocol/sdk/client/sse.js`) and
  `StreamableHTTPClientTransport` (`@modelcontextprotocol/sdk/client/streamableHttp.js`).
- Widen `transports: Map<string, Transport>` to the SDK `Transport` base type.
- Extract a small pure helper `buildTransport(config): Transport` (switch on
  `config.transport`) so the branch is unit-testable. stdio path keeps `adaptConfigForEnvironment`
  + command pre-flight; remote path builds a `URL` and passes `requestInit.headers` when present.
- `_doConnect()` calls `buildTransport()`; stdio-only steps (command check, adapt) guarded by
  `transport === 'stdio'`.
- `connectServerWithAwsCredentials()` stays stdio-only — if called for a non-stdio config, log
  and fall back to plain `connectServer` (remote servers never set `requiresAwsCredentials`).
- Consumers unchanged (`connectServers` signature identical).

### 4. API routes — validation + Test endpoints

- Both existing routes: replace the inline `command && args` check with `validateMcpConfig()`.
  Response shapes, audit events, storage all unchanged.
- **New** `POST /api/mcp-servers/test` and `POST /api/agent-ops/mcp-settings/test`:
  - Body: `{ id, entry }` (one server entry).
  - Validate the entry; build a **throwaway** connection via the manager using a unique
    ephemeral id (e.g. `__test__:<id>:<nonce>`), `listTools()`, then `disconnectServer()`.
  - Response: `{ success: boolean, toolCount?: number, tools?: string[], error?: string }`.
  - stdio entries with `requiresAwsCredentials: true` → respond `success:false` with a clear
    message that account-scoped servers can only be verified at run time (no account context here).
  - Auth: same `getSessionTenantId()` guard as the sibling routes. No persistence, no audit
    needed (read-only probe) — but wrap in try/finally to always disconnect.

### 5. UI — `components/settings/`

**New `mcp-server-form.tsx`** (RHF + Zod + `useFieldArray`):
- Renders a card per server over the `mcpServers` map.
- Card fields: server **id** (the map key; editable, validated unique/non-empty),
  **transport** `Select` (stdio / sse / http), **enabled** toggle (maps to `disabled`),
  conditional block:
  - stdio → **command** input, **args** list (add/remove rows), **env** key-value editor,
    **requiresAwsCredentials** toggle.
  - sse/http → **url** input, **headers** key-value editor.
  - **Test** button (calls the test hook for that single entry; shows spinner → result toast).
  - **Remove** button.
- **Add server** button (creates a blank stdio row); keep the existing quick-add templates
  (extend templates with one remote example, e.g. an SSE endpoint placeholder).
- Reuse `Input`, `Select`, `Switch`, `Button`, `Label`, `Card` primitives. A small reusable
  `KeyValueEditor` subcomponent for `env`/`headers`.

**`mcp-settings.tsx`** (rework):
- Canonical state: `MCPConfigJson` (parsed object), plus `editorValue` string for the JSON view.
- **Form | JSON `ToggleGroup`** in the toolbar. Switching:
  - Form → JSON: serialize current rows via `formRowsToConfig` → pretty JSON.
  - JSON → Form: parse + `validateMcpConfig`; if invalid, **block** the switch and show an inline
    message ("Fix JSON before switching to Form"). If valid, `configToFormRows`.
- Shared Save / Reset / server-count summary / `⌘S` across both modes.
- Save → PUT via TanStack Query mutation; Reset → DELETE. **sonner** toasts on success/error
  (per conventions), keeping the lightweight inline "Saved" affordance.

**`lib/queries/mcp-servers.ts`** (new) + `query-keys.ts` entry:
- `useMcpConfig(apiPath)`, `useSaveMcpConfig(apiPath)`, `useResetMcpConfig(apiPath)`,
  `useTestMcpServer(apiPath)`. Parameterized by `apiPath` so both surfaces reuse them.
  Replaces the raw `fetch` calls in `mcp-settings.tsx`.

### 6. Testing (Vitest, web-ui)

- `mcp-config.test.ts` — round-trip `defaultsToJson`/`jsonToServerConfigs`/`mergeConfigs`
  including: a remote (sse + http) entry; a stdio entry **without** `type` (backward compat);
  merge precedence (user over default).
- `validateMcpConfig` — accepts valid stdio + valid remote; rejects stdio missing
  command/args, remote with bad/missing url, unknown `type`.
- `mcp-form-schema.test.ts` — `configToFormRows` / `formRowsToConfig` round-trip; duplicate-id
  detection.
- `mcp-manager` — unit test `buildTransport()` returns the right transport class per
  `config.transport` (mock the transport constructors / assert instance type).
- Manual / optional E2E: toggle Form↔JSON, add a remote server, Test connection.

## Backward Compatibility & Safety

- Existing saved blobs (stdio, no `type`) are read as stdio — no migration.
- PUT still accepts the old shape; `validateMcpConfig` is a superset of the old check.
- Runtime consumers and the `connectServers` signature are unchanged.
- Multi-tenant: all reads/writes continue through `TenantConfigService` (tenant-scoped);
  test endpoint guarded by `getSessionTenantId()`.

## Out of Scope (YAGNI)

- No per-server DB table / version history (rejected architecture option).
- No OAuth flows for remote MCP auth — headers (static tokens) only.
- No changes to how tools are namespaced/wrapped (`mcp-tools.ts`) beyond what transport
  support requires (nothing expected — tool discovery is transport-agnostic post-connect).

## File Touch List

| File | Change |
| --- | --- |
| `apps/web-ui/lib/agent/mcp-config.ts` | union entry type, runtime transport fields, helper updates, `validateMcpConfig`, JSON schema oneOf |
| `apps/web-ui/lib/agent/mcp-form-schema.ts` | **new** — Zod schema + form↔config conversion |
| `apps/web-ui/lib/agent/mcp-manager.ts` | sse/http transports, `buildTransport`, branch in `_doConnect`, guard AWS-cred path |
| `apps/web-ui/app/api/mcp-servers/route.ts` | use `validateMcpConfig` |
| `apps/web-ui/app/api/agent-ops/mcp-settings/route.ts` | use `validateMcpConfig` |
| `apps/web-ui/app/api/mcp-servers/test/route.ts` | **new** — test connection |
| `apps/web-ui/app/api/agent-ops/mcp-settings/test/route.ts` | **new** — test connection |
| `apps/web-ui/components/settings/mcp-server-form.tsx` | **new** — form view + KeyValueEditor |
| `apps/web-ui/components/settings/mcp-settings.tsx` | Form|JSON toggle, TanStack Query, sonner |
| `apps/web-ui/lib/queries/mcp-servers.ts` | **new** — query/mutation hooks |
| `apps/web-ui/lib/queries/query-keys.ts` | add mcp-servers keys |
| `apps/web-ui/tests/**` | unit tests listed above |
