# OAuth Connectors (Jira · Slack · Google) — Design

**Date:** 2026-07-10
**Branch:** `feat/oauth-connectors`
**Status:** Approved (brainstorming) → implementation

## Problem

Connectors (Jira, Slack) are configured today by manually pasting long-lived
API tokens into plaintext-stored forms. There is no OAuth "Connect" button, and
there is no Google connector at all. We want the standard SaaS connector
experience: a one-click **Connect** that runs the OAuth consent flow, retrieves
tokens, and stores them (encrypted) so agents can use them — with a manual
fallback preserved.

## Decisions (locked during brainstorming)

1. **Bring-Your-Own OAuth app.** Each tenant registers *their own* OAuth app
   with the provider and enters `client_id`/`client_secret` (+ Slack signing
   secret). The connector page shows the callback URL(s) to register. There is
   **no** platform-level shared OAuth app.
2. **Connection model = per-tenant shared.** OAuth tokens belong to the tenant
   (created by whichever user connected). All users in the tenant / the agent
   share them. (Diverges from the per-user look of the reference screenshots;
   chosen to match nucleus's tenant-shared philosophy.)
3. **Build scope = plumbing + wire existing adapters.** Full connect UI + OAuth
   + encrypted storage, AND update the existing Jira/Slack gateway adapters to
   use OAuth tokens for outbound. Google tokens are **stored only** in this
   slice (no Google adapter/agent tool yet).
4. **Keep existing manual config alongside OAuth.** Jira Automation webhook
   trigger config and Slack signing/bot config are preserved (collapsible
   "Manual / advanced"). No regression to inbound flows.
5. **Google scopes = Gmail + Calendar** (read & send Gmail; read & manage
   Calendar), stored for future consumption.

## Scope boundaries

- **In scope:** app-credential storage, OAuth authorize/callback, encrypted
  token storage, connections list/reconnect/delete, Slack workspace-bot install,
  connectors UI (Jira/Slack/Google), wiring Jira + Slack outbound adapters to
  prefer OAuth tokens, RBAC + audit + tests.
- **Out of scope (this slice):** new Google agent tools; Slack "act-as-you"
  user-token consumption (token is stored, not consumed); changing inbound
  trigger/verification flows.

## Architecture — three layers per connector (all tenant-scoped)

| Layer | Contents | Cardinality |
|---|---|---|
| **App credentials** (`ConnectorApp`) | tenant's OAuth app: `clientId`, `clientSecretEnc`, Slack `signingSecretEnc?`, Slack bot token (`botTokenEnc?`) | one per `(tenant, provider)` |
| **Connection** (`ConnectorConnection`) | OAuth grant: `accessTokenEnc`, `refreshTokenEnc?`, `expiresAt?`, `scopes[]`, `accountLabel`, `externalAccountId`, `tokenType`, `status` | many per `(tenant, provider)` |

Consumption: existing `jira-adapter` / `slack-adapter` upgraded to prefer an
active OAuth connection, falling back to today's manual creds / env vars.

## Data model (`libs/prisma/schema.prisma`)

```prisma
model ConnectorApp {
  id               String   @id @default(cuid())
  tenantId         String
  provider         String   // jira | slack | google
  clientId         String
  clientSecretEnc  String   // AES-256-GCM
  signingSecretEnc String?  // slack only
  botTokenEnc      String?  // slack workspace-bot install token
  botAccountLabel  String?  // slack workspace/team name
  status           String   @default("configured") // configured
  createdBy        String   @default("system")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@unique([tenantId, provider])
  @@index([tenantId])
  @@map("connector_apps")
}

model ConnectorConnection {
  id                String   @id @default(cuid())
  tenantId          String
  provider          String   // jira | slack | google
  accountLabel      String   // display name / email / workspace
  externalAccountId String   // provider account id / cloudId / team id
  accessTokenEnc    String
  refreshTokenEnc   String?
  expiresAt         DateTime?
  scopes            String[] @default([])
  tokenType         String   @default("user") // user | bot
  metadata          Json     @default("{}")   // e.g. { cloudId, teamId, apiBaseUrl }
  status            String   @default("active") // active | expired | revoked
  createdBy         String   @default("system")
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@index([tenantId, provider])
  @@index([tenantId, provider, status])
  @@map("connector_connections")
}
```

Repository pattern: `apps/web-ui/lib/db/repositories/connectors/{interface,postgres}.ts`,
registered in the repository factory, all queries via `getTenantClient`.

### Encryption

Extend `apps/web-ui/lib/crypto/provider-credentials.ts` with generic
`encryptJson(value): string` / `decryptJson(payload): T` (same AES-256-GCM key
material as provider credentials). All `*Enc` columns use it. GET responses
**mask** secrets (never return client secret / tokens); reuse the `maskSecret`
convention already in the settings routes.

## OAuth flows

Callback convention: `/api/connections/{provider}/callback`
(`provider ∈ jira|slack|google`). Redirect URI shown in the UI is
`<origin>/api/connections/{provider}/callback`.

**Authorize** — `GET /api/connections/{provider}/authorize`:
1. Load `ConnectorApp` for tenant; 400 if not configured.
2. Build a signed `state` (`{ tenantId, provider, nonce }`, HMAC with
   `NEXTAUTH_SECRET`) and set a matching short-lived httpOnly CSRF cookie.
3. 302 to the provider consent URL with `client_id`, `redirect_uri`,
   provider scopes, `state`, and provider-specific params
   (Google: `access_type=offline&prompt=consent`; Jira: `audience=api.atlassian.com&prompt=consent`).

**Callback** — `GET /api/connections/{provider}/callback`:
1. Verify `state` signature + CSRF cookie; clear cookie.
2. Exchange `code` → tokens using the tenant's `client_secret`.
3. Fetch identity + granted scopes:
   - Jira: `GET https://api.atlassian.com/oauth/token/accessible-resources` → `cloudId` + site; store `metadata.cloudId` + `metadata.apiBaseUrl = https://api.atlassian.com/ex/jira/{cloudId}`.
   - Google: `GET https://www.googleapis.com/oauth2/v3/userinfo` → email.
   - Slack (user connect): `oauth.v2.access` → `authed_user` + team.
4. Upsert `ConnectorConnection` (encrypt tokens), `status=active`.
5. 302 back to the connector page with a success flag.

**Slack workspace-bot install** — `GET /api/slack/install` → Slack authorize
(bot scopes) with `redirect_uri = <origin>/api/slack/install/callback`;
callback exchanges via `oauth.v2.access`, stores `botTokenEnc` +
`botAccountLabel` on `ConnectorApp`.

**Token refresh** — `refreshConnection(connection)` helper: when `expiresAt`
is past (or on a 401 from the provider), use `refreshToken` to obtain a new
access token, persist re-encrypted, and retry once. Jira & Google issue refresh
tokens; Slack bot tokens are long-lived (no refresh).

## Adapter wiring (consumption)

- **`jira-adapter.ts`** — `resolveApiConfig` / comment-post path: if an active
  Jira `ConnectorConnection` exists, use `Authorization: Bearer <accessToken>`
  against `metadata.apiBaseUrl` (`.../ex/jira/{cloudId}`) with
  `/rest/api/3/issue/{key}/comment`. Refresh-on-401. **Fallback** to today's
  Basic `userEmail:apiToken` / env when no connection.
- **`slack-adapter.ts`** — outbound already `Bearer`; token precedence:
  workspace-bot `botTokenEnc` → manual `botToken` (tenant config) → env
  `SLACK_BOT_TOKEN`. Inbound signing verification unchanged.
- **Google** — no adapter in this slice.

## UI (`apps/web-ui/app/app/channels/...`)

Rework `jira-settings-form.tsx`, `slack-settings-form.tsx`; add
`google-settings-form.tsx` + a `google-settings/` page; add a Google tile to the
channels overview grid + `useChannelStatus` fan-out.

Shared components (`components/channels/`):
- `app-credentials-card.tsx` — read-only callback URL(s) w/ copy, `client_id` +
  `client_secret` (+ Slack signing secret) inputs, `Configured/Not set` badge,
  Update/Remove, collapsible "How to get these credentials".
- `connections-card.tsx` — "Connect {Provider}" button (→ `/authorize`),
  "Connected Accounts" list (label, N scopes, Active badge, delete), Reconnect,
  empty state.
- `workspace-bot-card.tsx` (Slack only) — "Add to Slack" install button + status.

Existing manual/webhook config retained inside a collapsible "Manual /
advanced" section on each page.

Data hooks: `apps/web-ui/lib/queries/connectors.ts` (app-cred GET/PUT/DELETE,
connections list, delete) + keys in `query-keys.ts`.

## API routes

| Route | Methods | Purpose |
|---|---|---|
| `/api/connections/{provider}/app` | GET, PUT, DELETE | app credentials (masked GET) |
| `/api/connections/{provider}/authorize` | GET | start OAuth (302) |
| `/api/connections/{provider}/callback` | GET | token exchange (302 back) |
| `/api/connections/{provider}` | GET | list connections (masked) |
| `/api/connections/{provider}/[id]` | DELETE | disconnect |
| `/api/slack/install` | GET | start bot install (302) |
| `/api/slack/install/callback` | GET | bot token exchange (302 back) |

## Cross-cutting

- **RBAC:** `authorize('update', …)` on every mutating route (reuse the
  existing channels/AgentOps subject; add a `Connector` subject only if the
  existing one doesn't cover it).
- **Audit:** `AuditService.logUserAction` on app-cred change, connect,
  disconnect, bot install.
- **Secrets:** encrypted at rest; never returned; masked in GETs.
- **CSRF:** signed `state` + httpOnly cookie nonce on authorize/callback.

## Testing

- Unit: `encryptJson/decryptJson` round-trip; `state` sign/verify (tamper →
  reject); token-exchange per provider (fetch mocked); adapter token-precedence
  (OAuth > manual > env) + refresh-on-401.
- Update existing `jira-adapter.test.ts` / `slack-adapter.test.ts`.
- Repository tenant-scoping test for the new models.

## Rollout / config

- New env (optional platform defaults, all overridable per-tenant): none
  required — BYO app means creds live in `ConnectorApp`. Encryption key reuses
  the existing provider-credentials key/env.
- Prisma migration adds two tables; regenerate both clients.
- Feature flag `CONNECTORS_OAUTH_ENABLED` (default on) to gate the new UI/routes
  if a fast rollback is needed.
