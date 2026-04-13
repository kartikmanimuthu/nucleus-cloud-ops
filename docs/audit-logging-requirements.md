# Audit Logging System — Requirements & Design

> Nucleus Cloud Ops — SaaS-Standard Audit Trail

## Problem Statement

The current audit system logs **~5% of mutations** (3 of 63 API routes). Background jobs are partially covered (1 of 4 workers). Agent tool executions that modify AWS resources have zero audit trail. Auth events (login/logout) are not tracked. There is no standardized event taxonomy or clear separation between platform (user) vs system events.

For a SaaS platform managing AWS infrastructure across multiple tenants, this is a compliance and operational risk.

---

## Industry Standards Reference

| Standard | Requirement |
|----------|-------------|
| SOC 2 Type II | Log all access to customer data, admin actions, system changes |
| ISO 27001 (A.12.4) | Event logging, protection of log information, admin/operator logs |
| GDPR Art. 30 | Records of processing activities, data access logging |
| NIST 800-53 (AU) | Audit events, content, storage, generation, review, analysis |
| CIS Controls v8 | Collect audit logs, ensure adequate storage, standardize time sync |
| FedRAMP | AU-2: auditable events, AU-3: content of audit records, AU-6: review/analysis |

### What SaaS Audit Logs Must Capture

Every audit event must answer: **Who** did **What**, to **Which resource**, **When**, from **Where**, and **Why** did it succeed or fail.

---

## Event Taxonomy

### Source Classification

| Source | Description | Actor |
|--------|-------------|-------|
| `platform` | User-initiated actions via Web Console or API | Authenticated user |
| `system` | Background jobs, cron tasks, automated processes | Service account / worker |
| `agent` | AI agent tool executions that modify resources | Agent on behalf of user |
| `external` | Inbound triggers (Slack, Jira, API webhooks) | External system |

### Event Type Convention

```
<domain>.<entity>.<action>
```

Examples: `auth.session.login`, `schedule.schedule.created`, `system.discovery.scan_started`

---

## Complete Event Catalog

### 1. Auth & Identity (`auth.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `auth.session.login` | User logged in | platform | low | NO |
| `auth.session.logout` | User logged out | platform | low | NO |
| `auth.session.login_failed` | Failed login attempt | platform | high | NO |
| `auth.signup.created` | New user registered | platform | medium | NO |
| `auth.password.reset_requested` | Password reset initiated | platform | medium | NO |
| `auth.password.changed` | Password changed | platform | medium | NO |
| `auth.mfa.enabled` | MFA enabled | platform | medium | NO |
| `auth.mfa.disabled` | MFA disabled | platform | high | NO |
| `auth.token.refreshed` | Session token refreshed | platform | low | NO |

### 2. Accounts (`account.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `account.account.created` | AWS account linked | platform | high | YES (service layer) |
| `account.account.updated` | Account details modified | platform | medium | YES (service layer) |
| `account.account.deleted` | Account removed | platform | high | YES (service layer) |
| `account.account.validated` | Account credentials validated | platform | low | YES (service layer) |

### 3. Schedules (`schedule.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `schedule.schedule.created` | Schedule created | platform | medium | YES (service layer) |
| `schedule.schedule.updated` | Schedule modified | platform | medium | YES (service layer) |
| `schedule.schedule.deleted` | Schedule removed | platform | high | YES (service layer) |
| `schedule.schedule.toggled` | Schedule enabled/disabled | platform | medium | NO |
| `schedule.schedule.executed` | Manual schedule execution triggered | platform | high | NO |
| `schedule.settings.updated` | Scheduler interval changed | platform | medium | YES (API route) |
| `schedule.resource.started` | Resource started by scheduler | system | medium | YES (worker) |
| `schedule.resource.stopped` | Resource stopped by scheduler | system | medium | YES (worker) |
| `schedule.resource.start_failed` | Resource start failed | system | high | YES (worker) |
| `schedule.resource.stop_failed` | Resource stop failed | system | high | YES (worker) |
| `schedule.execution.completed` | Scheduled run finished | system | low | YES (worker) |
| `schedule.execution.failed` | Scheduled run failed | system | high | YES (worker) |

### 4. Inventory & Discovery (`inventory.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `inventory.sync.triggered` | Manual sync triggered | platform | medium | YES (API route) |
| `inventory.discovery.scan_started` | Discovery scan began | system | low | YES (worker) |
| `inventory.discovery.scan_completed` | Discovery scan finished | system | low | YES (worker) |
| `inventory.discovery.scan_failed` | Discovery scan failed | system | high | YES (worker) |

### 5. Tenant & Organization (`tenant.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `tenant.organization.created` | New organization created | platform | high | NO |
| `tenant.settings.updated` | Org settings changed (name, timezone) | platform | medium | NO |
| `tenant.logo.updated` | Org logo changed | platform | low | NO |
| `tenant.invitation.created` | Member invited | platform | medium | NO |
| `tenant.invitation.resent` | Invitation resent | platform | low | NO |
| `tenant.invitation.revoked` | Invitation revoked | platform | medium | NO |
| `tenant.invitation.accepted` | Invitation accepted | platform | medium | NO |
| `tenant.invitation.declined` | Invitation declined | platform | low | NO |
| `tenant.member.role_changed` | Member role updated | platform | high | NO |
| `tenant.member.removed` | Member removed from org | platform | high | NO |

### 6. RBAC & Roles (`rbac.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `rbac.role.created` | Custom role created | platform | high | NO |
| `rbac.role.updated` | Role permissions modified | platform | high | NO |
| `rbac.role.deleted` | Role deleted | platform | high | NO |
| `rbac.permission.denied` | Authorization check failed (403) | platform | medium | NO |

### 7. Knowledge Base (`kb.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `kb.knowledgebase.created` | Knowledge base created | platform | medium | NO |
| `kb.knowledgebase.updated` | Knowledge base modified | platform | medium | NO |
| `kb.knowledgebase.deleted` | Knowledge base deleted | platform | high | NO |
| `kb.datasource.created` | Data source added | platform | medium | NO |
| `kb.datasource.updated` | Data source modified | platform | medium | NO |
| `kb.datasource.deleted` | Data source removed | platform | medium | NO |
| `kb.datasource.sync_triggered` | Manual sync triggered | platform | low | NO |
| `kb.file.uploaded` | File uploaded to KB | platform | low | NO |
| `kb.sync.started` | KB sync job started | system | low | NO |
| `kb.sync.completed` | KB sync job finished | system | low | NO |
| `kb.sync.failed` | KB sync job failed | system | high | NO |

### 8. Agent Operations (`agent.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `agent.task.created` | Scheduled task created | platform | medium | NO |
| `agent.task.updated` | Scheduled task modified | platform | medium | NO |
| `agent.task.deleted` | Scheduled task deleted | platform | medium | NO |
| `agent.task.paused` | Scheduled task paused | platform | medium | NO |
| `agent.task.resumed` | Scheduled task resumed | platform | medium | NO |
| `agent.task.triggered` | Scheduled task manually triggered | platform | medium | NO |
| `agent.run.approved` | Agent run approved | platform | high | NO |
| `agent.run.rejected` | Agent run rejected | platform | medium | NO |
| `agent.run.cancelled` | Agent run cancelled | platform | medium | NO |
| `agent.tool.executed` | Agent executed a tool (AWS mutation) | agent | high | NO |
| `agent.tool.failed` | Agent tool execution failed | agent | high | NO |
| `agent.settings.slack_updated` | Slack integration configured | platform | medium | NO |
| `agent.settings.jira_updated` | Jira integration configured | platform | medium | NO |
| `agent.settings.mcp_updated` | MCP server config changed | platform | medium | NO |

### 9. Providers & Integrations (`integration.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `integration.provider.created` | Auth provider created | platform | high | NO |
| `integration.provider.updated` | Auth provider modified | platform | high | NO |
| `integration.provider.deleted` | Auth provider removed | platform | high | NO |
| `integration.mcp.updated` | MCP server config saved | platform | medium | NO |
| `integration.mcp.reset` | MCP server config reset | platform | medium | NO |

### 10. External Triggers (`trigger.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `trigger.slack.received` | Slack slash command received | external | low | NO |
| `trigger.api.received` | API trigger received | external | low | NO |
| `trigger.jira.received` | Jira webhook received | external | low | NO |
| `trigger.slack.interaction` | Slack button interaction | external | low | NO |

### 11. Threads & Chat (`chat.*`)

| Event Type | Action | Source | Severity | Currently Logged |
|------------|--------|--------|----------|-----------------|
| `chat.thread.created` | Chat thread created | platform | low | NO |
| `chat.thread.updated` | Chat thread renamed | platform | low | NO |
| `chat.thread.deleted` | Chat thread deleted | platform | low | NO |

> Note: Individual chat messages are NOT audit events — they are conversation data. Only thread lifecycle events are audited.

---

## Schema Enhancements

The current `AuditLog` Prisma model is solid. Recommended additions:

```prisma
model AuditLog {
  // ... existing fields ...

  // NEW: Structured change tracking
  changeSet     Json?     // { before: {...}, after: {...} } for update events
  
  // NEW: Request context
  requestId     String?   // X-Request-Id header for request tracing
  apiRoute      String?   // e.g., "POST /api/accounts"
  httpMethod    String?   // GET, POST, PUT, DELETE, PATCH
  
  // NEW: Compliance
  dataClassification String? // "pii", "credentials", "infrastructure", "config"
  retentionDays      Int     @default(90) // Configurable per event type
  immutable          Boolean @default(true) // Prevent modification after write
}
```

### Key Changes

| Field | Purpose |
|-------|---------|
| `changeSet` | Before/after diff for update events — critical for SOC 2 "what changed" |
| `requestId` | Correlate audit event to specific HTTP request across services |
| `apiRoute` | Which endpoint was called — enables route-level analytics |
| `dataClassification` | Tag events involving PII or credentials for GDPR compliance |
| `retentionDays` | Different retention per event type (auth=365d, chat=30d, infra=90d) |

---

## Implementation Architecture

### Approach: Middleware + Service Layer Hybrid

```
┌─────────────────────────────────────────────────────────┐
│                    API Request                           │
├─────────────────────────────────────────────────────────┤
│  Next.js Middleware (auth events, request context)       │
│    ↓                                                    │
│  API Route Handler                                      │
│    ↓                                                    │
│  AuditService.log() ← called at mutation point          │
│    ↓                                                    │
│  Async Write (fire-and-forget to PostgreSQL)             │
│    ↓                                                    │
│  [Optional] Stream to external SIEM (future)            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    Worker Job                            │
├─────────────────────────────────────────────────────────┤
│  pg-boss Job Handler                                    │
│    ↓                                                    │
│  WorkerAuditService.log() ← called at mutation point    │
│    ↓                                                    │
│  Direct PostgreSQL insert (same as current discovery)    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    Agent Execution                       │
├─────────────────────────────────────────────────────────┤
│  LangGraph Tool Execution                               │
│    ↓                                                    │
│  Tool wrapper intercepts AWS-mutating calls              │
│    ↓                                                    │
│  AuditService.log() with source="agent"                 │
│    ↓                                                    │
│  Links to thread_id + run_id for traceability           │
└─────────────────────────────────────────────────────────┘
```

### Why NOT a global middleware-only approach?

A global audit middleware (intercept all POST/PUT/DELETE) sounds appealing but fails in practice:

1. **No semantic context** — middleware sees `POST /api/schedules` but doesn't know if it's "create schedule" or "toggle schedule"
2. **No before/after diff** — middleware can't capture what changed without reading the DB
3. **No resource context** — middleware doesn't know the resource type, ID, or affected entity
4. **False positives** — not every POST is a mutation (search endpoints, AI chat, etc.)

The right approach: **audit at the mutation point** (service layer or route handler) where you have full semantic context, then use a shared `auditLog()` helper to standardize the event shape.

---

## Standardized Audit Helper API

```typescript
// Proposed unified API for all audit logging

// Platform events (user-initiated via Web Console or API)
await AuditService.logPlatformEvent({
  tenantId,
  eventType: 'schedule.schedule.created',
  action: 'Created schedule',
  userId,                          // from session
  resource: 'Schedule',
  resourceId: schedule.id,
  status: 'success',
  severity: 'medium',
  changeSet: { before: null, after: scheduleData },
  ipAddress,                       // from request
  userAgent,                       // from request
  apiRoute: 'POST /api/schedules',
});

// System events (background jobs, workers)
await AuditService.logSystemEvent({
  tenantId,
  eventType: 'schedule.resource.started',
  action: 'Started EC2 instance',
  resource: 'EC2',
  resourceId: instanceId,
  accountId: awsAccountId,
  region: 'us-east-1',
  status: 'success',
  severity: 'medium',
  executionId: jobId,
  metadata: { scheduleId, desiredCount: 1 },
});

// Agent events (AI agent tool executions)
await AuditService.logAgentEvent({
  tenantId,
  eventType: 'agent.tool.executed',
  action: 'Executed AWS CLI command',
  userId,                          // user who owns the agent session
  resource: 'EC2',
  resourceId: instanceId,
  status: 'success',
  severity: 'high',
  correlationId: threadId,
  executionId: runId,
  metadata: { tool: 'execute_command', command: 'aws ec2 ...' },
});
```

---

## Retention Policy

| Event Category | Retention | Rationale |
|----------------|-----------|-----------|
| Auth events (login, logout, failed) | 365 days | SOC 2 / compliance requirement |
| RBAC changes (roles, permissions) | 365 days | Security-critical, audit trail |
| Infrastructure mutations (accounts, schedules, resources) | 90 days | Operational troubleshooting |
| Agent tool executions | 90 days | AI accountability trail |
| Tenant/org changes | 180 days | Business-critical changes |
| KB and chat thread lifecycle | 30 days | Low-risk operational data |
| Discovery/sync events | 30 days | High-volume, low-risk |

---

## Implementation Priority

### Phase 1 — Auth & Security (HIGH)
- Auth events (login/logout/failed login)
- RBAC changes (role CRUD, permission denied)
- Member management (role changes, removals)
- Provider configuration changes

### Phase 2 — Core Platform Mutations (HIGH)
- Account CRUD (move from service-layer-only to standardized events)
- Schedule CRUD + toggle + manual execute
- Tenant settings, invitations
- Standardize existing events to new taxonomy

### Phase 3 — Agent & Integrations (MEDIUM)
- Agent tool execution auditing (wrap tool calls)
- Agent task lifecycle (create/pause/resume/delete)
- External trigger logging (Slack, Jira, API)
- MCP server config changes

### Phase 4 — Knowledge Base & Workers (MEDIUM)
- KB and data source CRUD
- KB sync worker audit logging
- File upload tracking

### Phase 5 — Enrichment & Compliance (LOW)
- `changeSet` before/after diffs on all update events
- Configurable retention per event type
- SIEM export integration (CloudWatch Logs, S3 archive)
- Audit log tamper detection (hash chain or checksum)

---

## Optimization Recommendations

### 1. Batch Writes for High-Volume Events
Discovery and scheduler workers can generate hundreds of events per run. Use batch inserts instead of individual writes:

```typescript
// Instead of N individual inserts
await AuditService.logBatch([
  { eventType: 'schedule.resource.started', ... },
  { eventType: 'schedule.resource.started', ... },
  // ...
]);
```

### 2. Async Queue for Non-Critical Events
Low-severity events (thread created, chat lifecycle) should go through an async queue to avoid adding latency to user-facing requests. The current fire-and-forget pattern is correct — keep it.

### 3. Structured Indexes
Current indexes are good. Add a composite index for the most common dashboard query:

```prisma
@@index([tenantId, source, timestamp]) // "show me all system events today"
@@index([tenantId, resourceType, resourceId]) // "show me all events for this schedule"
```

### 4. Partitioning Strategy (Future)
When audit volume grows past 10M rows, partition by `tenantId` + month. PostgreSQL native partitioning works well here since queries always include `tenantId`.

### 5. Immutability Enforcement
Audit logs must be append-only. The existing `DELETE /api/audit` endpoint should be removed or restricted to super-admin only. In production, consider a database trigger that prevents UPDATE/DELETE on the audit table.

---

## Summary

| Metric | Current | Target |
|--------|---------|--------|
| API routes with audit logging | 3 / 63 (5%) | 63 / 63 (100%) |
| Workers with audit logging | 1 / 4 (25%) | 4 / 4 (100%) |
| Agent tool execution auditing | 0% | 100% |
| Auth event logging | None | Full (login/logout/failed) |
| Event taxonomy | Ad-hoc strings | Standardized `domain.entity.action` |
| Source classification | Partial (`source` field exists) | Full (`platform` / `system` / `agent` / `external`) |
| Change tracking (before/after) | None | All update events |
| Retention policy | Flat 30 days | Tiered (30d–365d by category) |
