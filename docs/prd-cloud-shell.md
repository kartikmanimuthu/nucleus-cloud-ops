# Product Requirement Document — Nucleus Cloud Shell

## 1. Overview

Nucleus Cloud Shell is a web-based terminal embedded in the Nucleus platform that gives operators direct CLI access to their connected AWS accounts — without leaving the browser. It pairs a full interactive shell with an AI Copilot sidebar that can suggest commands, explain output, auto-approve safe operations, and flag risky ones for manual confirmation.

Think AWS CloudShell, but multi-account, tenant-isolated, and with an AI copilot built in.

## 2. Problem Statement

Today, operators using Nucleus must context-switch to external terminals, manually configure AWS credentials, and remember CLI syntax for cross-account operations. This creates friction, increases error risk, and breaks the single-pane-of-glass experience the platform provides for scheduling, inventory, and AI Ops.

**Pain points:**
- Credential management across N accounts is manual and error-prone
- No audit trail when operators run ad-hoc CLI commands outside the platform
- Junior operators lack confidence with complex AWS CLI syntax
- No guardrails on destructive commands executed outside the platform

## 3. Goals & Objectives

| Goal | Measure |
|------|---------|
| Zero context-switch CLI access | Operator can run `aws s3 ls` against any connected account without leaving Nucleus |
| AI-assisted operations | Copilot suggests correct CLI syntax for 80%+ of common tasks |
| Safety guardrails | Destructive commands (delete, terminate, remove) require explicit approval |
| Full audit trail | Every command + output is logged to the audit system |
| Multi-account | Operator can switch target account mid-session without re-authenticating |

## 4. User Personas

| Persona | Usage |
|---------|-------|
| **Platform Engineer** | Daily CLI access for debugging, log tailing, resource inspection |
| **DevOps Lead** | Ad-hoc infrastructure changes with audit trail for compliance |
| **Junior Operator** | Learning AWS CLI with AI copilot guidance and safety net |
| **Security Auditor** | Reviewing command history and approval decisions |

## 5. Module Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloud Shell Page                       │
│  ┌──────────────────────────┬──────────────────────────┐ │
│  │                          │                          │ │
│  │     Terminal Panel       │    AI Copilot Sidebar    │ │
│  │                          │                          │ │
│  │  ┌────────────────────┐  │  ┌────────────────────┐  │ │
│  │  │  xterm.js Terminal  │  │  │  Chat Interface    │  │ │
│  │  │                    │  │  │                    │  │ │
│  │  │  $ aws ec2 desc... │  │  │  "That command     │  │ │
│  │  │                    │  │  │   will list all     │  │ │
│  │  │                    │  │  │   EC2 instances..." │  │ │
│  │  │                    │  │  │                    │  │ │
│  │  └────────────────────┘  │  │  [Suggestion]      │  │ │
│  │                          │  │  [Approve] [Deny]  │  │ │
│  │  Account: prod-us-east   │  └────────────────────┘  │ │
│  │  Region: us-east-1       │                          │ │
│  │  Session: 14:32 remaining│  Auto-approve: ☐ read    │ │
│  └──────────────────────────┴──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 6. Functional Requirements

### 6.1 Terminal (Core Shell)

#### FR-TERM-01: Web-Based Terminal Emulator
- Render a fully interactive terminal using xterm.js in the browser
- Support ANSI colors, cursor movement, scrollback buffer (10,000 lines)
- Handle terminal resize (responsive to panel width/height changes)
- Support copy/paste (Ctrl+Shift+C / Ctrl+Shift+V, right-click menu)

#### FR-TERM-02: Server-Side PTY Session
- Backend spawns a pseudo-terminal (PTY) process per session via `node-pty`
- Shell: `/bin/bash` with a restricted PATH
- Communication: WebSocket connection between browser xterm.js and server PTY
- Session timeout: configurable (default 30 minutes idle, max 4 hours active)
- Graceful cleanup on disconnect, tab close, or timeout

#### FR-TERM-03: Multi-Account AWS Access
- Account selector dropdown in the terminal toolbar (populated from connected accounts)
- Switching accounts calls STS AssumeRole (reuses existing `session-manager.ts` pattern)
- AWS credentials injected as environment variables into the PTY session (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_DEFAULT_REGION`)
- Credential auto-refresh before expiry (15-min STS sessions, refresh at 12 min)
- Visual indicator showing active account name, ID, and session time remaining

#### FR-TERM-04: Pre-Installed Tooling
The shell environment must include:
- AWS CLI v2
- jq, yq
- curl, wget
- git
- python3, pip
- node, npm
- kubectl (optional, if EKS accounts connected)
- Session Manager plugin (for SSM tunneling)
- Common aliases: `ll`, `la`, `grep` with color

#### FR-TERM-05: File System
- Each user gets a persistent home directory (`/home/nucleus/<tenantId>/<userId>/`)
- 1 GB storage quota per user
- Files persist across sessions (backed by EFS or similar)
- `/tmp` is ephemeral per session
- No access to host filesystem outside home directory

#### FR-TERM-06: Session Management
- Support multiple concurrent terminal tabs (max 3 per user)
- Each tab can target a different AWS account
- Session state (working directory, env vars) preserved per tab
- "Reconnect" on page refresh — reattach to existing PTY if still alive

### 6.2 AI Copilot Sidebar

#### FR-COP-01: Contextual Chat Interface
- Collapsible sidebar panel (right side, 400px default width, resizable)
- Chat interface similar to existing AI Ops chat (reuse `ChatInterface` patterns)
- Copilot has real-time visibility into terminal content (last N lines of scrollback)
- Streaming responses via existing Vercel AI SDK infrastructure

#### FR-COP-02: Command Suggestions
- User can ask natural language questions: "How do I list all S3 buckets in us-east-1?"
- Copilot responds with the exact CLI command + explanation
- "Insert to Terminal" button pastes the command into the active terminal (does not execute)
- "Run" button inserts AND executes (subject to approval mode)

#### FR-COP-03: Output Explanation
- User can select terminal output and click "Explain this"
- Copilot analyzes the selected output and provides plain-language explanation
- Automatically detects errors and suggests fixes
- Supports JSON, table, and raw text output formats

#### FR-COP-04: Proactive Suggestions
- When the copilot detects a failed command, it proactively suggests corrections
- When a command returns a large result set, it suggests filtering/pagination
- When credentials expire, it suggests re-authentication
- Suggestions appear as dismissible cards in the sidebar

#### FR-COP-05: Command History Context
- Copilot maintains awareness of the current session's command history
- Can reference previous commands and outputs in conversation
- "What did I run 5 minutes ago?" type queries supported

### 6.3 Approval & Safety System

#### FR-SAFE-01: Command Classification
Every command entered in the terminal is classified before execution:

| Category | Examples | Default Behavior |
|----------|----------|-----------------|
| **Read-only** | `aws s3 ls`, `aws ec2 describe-*`, `cat`, `ls` | Auto-approve |
| **Modify** | `aws s3 cp`, `aws ec2 start-instances`, `aws ecs update-service` | Configurable (auto/manual) |
| **Destructive** | `aws ec2 terminate-instances`, `aws s3 rm`, `aws rds delete-*`, `rm -rf` | Always require manual approval |
| **Blocked** | `aws iam create-user`, `aws organizations *`, privilege escalation | Blocked entirely |

#### FR-SAFE-02: Approval Modes
- **Manual Approve (default)**: All modify + destructive commands show an approval dialog before execution
- **Auto-Approve Read**: Read-only commands execute immediately; modify/destructive require approval
- **Auto-Approve All**: All commands except destructive execute immediately (requires Admin role)
- Mode is selectable per session via toggle in the toolbar
- Tenant-level default configurable in Settings

#### FR-SAFE-03: Approval UX
- When a command requires approval, the terminal pauses with a visual indicator
- Approval dialog shows:
  - The exact command to be executed
  - AI-generated risk assessment (low/medium/high/critical)
  - Affected resources (if detectable from the command)
  - "Approve", "Deny", "Edit & Approve" buttons
- Copilot sidebar highlights the pending approval with context
- Timeout: unapproved commands auto-deny after 5 minutes

#### FR-SAFE-04: AI-Powered Risk Assessment
- Before execution, the copilot agent analyzes the command for:
  - Blast radius (how many resources affected)
  - Reversibility (can this be undone?)
  - Cost impact (will this incur charges?)
  - Security implications (IAM changes, public access, etc.)
- Risk score displayed in the approval dialog
- High/critical risk commands include a "Type to confirm" safeguard

#### FR-SAFE-05: Blocked Command Patterns
Configurable deny-list of command patterns that are never allowed:
- IAM user/role creation or policy attachment (prevent privilege escalation)
- Organization-level operations
- Account-level billing changes
- Custom patterns configurable per tenant in Settings

### 6.4 Audit & Compliance

#### FR-AUD-01: Command Logging
- Every command executed is logged to the audit system with:
  - Timestamp, user ID, tenant ID
  - Target AWS account ID
  - Full command text
  - Approval status (auto-approved, manually approved, denied, blocked)
  - Approver ID (if manually approved)
  - Command output (truncated to 10KB, full output in S3)
  - Exit code
  - Session ID

#### FR-AUD-02: Session Recording
- Full terminal session can be optionally recorded (configurable per tenant)
- Recording stored as asciinema-compatible format for playback
- Retention: 90 days (configurable)
- Accessible from Audit Logs module with playback UI

#### FR-AUD-03: Compliance Reports
- "Cloud Shell Activity" report in the Audit module
- Filterable by: user, account, date range, approval status, risk level
- Export to CSV/JSON
- Summary metrics: commands run, approval rate, blocked attempts, top users

### 6.5 RBAC Integration

#### FR-RBAC-01: New Permission Module
Add `CloudShell` as a new RBAC module with actions:

| Action | Description |
|--------|-------------|
| `read` | View Cloud Shell page, read-only terminal (commands blocked) |
| `create` | Open new terminal sessions |
| `update` | Change approval mode, configure blocked patterns |
| `delete` | Terminate other users' sessions (admin) |

#### FR-RBAC-02: Role Defaults
| Role | Permissions |
|------|------------|
| Owner | Full access, can configure tenant-level settings |
| Admin | Create + read + update, auto-approve all mode available |
| Member | Create + read, manual approve mode only |
| Viewer | Read only (can view audit logs, cannot open sessions) |

## 7. Non-Functional Requirements

### NFR-01: Latency
- Terminal keystroke-to-display: < 50ms (WebSocket round-trip)
- Command classification: < 200ms (local pattern matching + AI fallback)
- STS AssumeRole: < 2 seconds

### NFR-02: Scalability
- Support 50 concurrent shell sessions per tenant
- Support 200 concurrent sessions platform-wide
- PTY processes isolated per user (no cross-user access)

### NFR-03: Security
- PTY runs in a sandboxed container (not the main ECS task)
- No access to Nucleus application secrets or database
- Network egress restricted to AWS API endpoints + configured allowlist
- All WebSocket traffic encrypted (WSS)
- Session tokens are short-lived and non-transferable
- Container image scanned for vulnerabilities on build

### NFR-04: Availability
- Shell sessions are ephemeral — no HA requirement for individual sessions
- Session reconnect on transient disconnects (WebSocket auto-reconnect with backoff)
- Graceful degradation: if shell backend is unavailable, show clear error with retry

### NFR-05: Resource Limits
- Per-session: 0.25 vCPU, 512 MiB memory
- Per-user storage: 1 GB persistent, 500 MB /tmp
- Max session duration: 4 hours
- Max concurrent sessions per user: 3
- Command output buffer: 10 MB per command

## 8. Technical Architecture

### 8.1 Container Strategy

```
┌─────────────────────────────────────────────┐
│              ECS Fargate Cluster              │
│                                               │
│  ┌─────────────────┐  ┌──────────────────┐   │
│  │  Web UI Task     │  │  Shell Task      │   │
│  │  (Next.js)       │  │  (Shell Server)  │   │
│  │                  │  │                  │   │
│  │  Port 3000       │  │  Port 3001 (WS)  │   │
│  │  API routes      │  │  node-pty        │   │
│  │  AI streaming    │  │  PTY mgmt        │   │
│  │                  │  │  Sandboxed bash   │   │
│  └────────┬─────────┘  └────────┬─────────┘   │
│           │                     │              │
│           └──────────┬──────────┘              │
│                      │                         │
│              ┌───────┴────────┐                │
│              │  ALB / CloudFront│               │
│              │  /api/shell/* → WS│              │
│              │  /* → Next.js    │              │
│              └────────────────┘                │
└─────────────────────────────────────────────┘
```

**Option A (Recommended): Sidecar container in the same ECS task**
- Shell server runs as a sidecar container alongside the Next.js container
- Shares the same task networking (localhost:3001)
- Next.js API route proxies WebSocket upgrade to the sidecar
- Simpler networking, single task definition

**Option B: Separate ECS service**
- Dedicated ECS service for shell sessions
- Independent scaling (scale shell containers based on active sessions)
- Better isolation but more complex networking
- Service discovery via Cloud Map

### 8.2 WebSocket Flow

```
Browser (xterm.js)
    │
    │ WSS /api/shell/connect?accountId=xxx&sessionId=yyy
    │
    ▼
CloudFront → ALB → Next.js API Route
    │
    │ Authenticate + authorize
    │ STS AssumeRole for target account
    │
    ▼
Shell Server (sidecar)
    │
    │ Spawn PTY: /bin/bash
    │ Inject AWS credentials as env vars
    │ Set up command interceptor
    │
    ▼
PTY Process (sandboxed)
    │
    │ stdin/stdout piped through WebSocket
    │ Command classifier intercepts before execution
    │
    ▼
AWS APIs (via injected credentials)
```

### 8.3 Command Interception

Commands are intercepted at the shell level using a custom PROMPT_COMMAND + preexec hook:

1. User types command and presses Enter
2. Bash `preexec` trap captures the command text
3. Command sent to classification service via Unix socket
4. Classifier returns: `allow`, `require_approval`, or `block`
5. If `allow` → command executes normally
6. If `require_approval` → shell pauses, approval request sent to browser via WebSocket
7. If `block` → command is prevented, error message displayed
8. Result logged to audit system regardless of outcome

### 8.4 AI Copilot Integration

The copilot reuses the existing LangGraph agent infrastructure:

- New agent type: `shell-copilot` in `web-ui/lib/agent/`
- Lighter than the full planning agent — optimized for quick command suggestions
- Tools: `suggest_command`, `explain_output`, `assess_risk`, `search_docs`
- Context window includes: last 50 lines of terminal output, current account, command history
- Streaming via existing `/api/chat` route with `mode: 'cloud-shell'`

## 9. Data Model

### 9.1 New Prisma Models

```prisma
model ShellSession {
  id            String   @id @default(uuid())
  tenantId      String
  userId        String
  accountId     String?
  region        String   @default("us-east-1")
  status        String   @default("active")  // active, disconnected, terminated
  approvalMode  String   @default("manual")  // manual, auto_read, auto_all
  startedAt     DateTime @default(now())
  lastActiveAt  DateTime @default(now())
  terminatedAt  DateTime?
  metadata      Json?

  tenant        Tenant   @relation(fields: [tenantId], references: [id])
  user          AuthUser @relation(fields: [userId], references: [id])
  commands      ShellCommand[]

  @@index([tenantId, userId])
  @@index([tenantId, status])
}

model ShellCommand {
  id             String   @id @default(uuid())
  sessionId      String
  tenantId       String
  userId         String
  accountId      String?
  command        String
  exitCode       Int?
  outputPreview  String?  // first 10KB
  outputS3Key    String?  // full output in S3
  classification String   // read, modify, destructive, blocked
  riskLevel      String?  // low, medium, high, critical
  approvalStatus String   // auto_approved, manually_approved, denied, blocked
  approvedBy     String?
  executedAt     DateTime @default(now())
  durationMs     Int?

  session        ShellSession @relation(fields: [sessionId], references: [id])

  @@index([tenantId, executedAt])
  @@index([sessionId])
  @@index([tenantId, userId, executedAt])
}

model ShellBlockedPattern {
  id          String   @id @default(uuid())
  tenantId    String
  pattern     String   // regex pattern
  description String?
  category    String   // iam, billing, org, custom
  isDefault   Boolean  @default(false)
  createdBy   String?
  createdAt   DateTime @default(now())

  tenant      Tenant   @relation(fields: [tenantId], references: [id])

  @@unique([tenantId, pattern])
  @@index([tenantId])
}
```

### 9.2 Tenant Settings Extension

Add to existing tenant settings:

```json
{
  "cloudShell": {
    "enabled": true,
    "defaultApprovalMode": "manual",
    "maxSessionsPerUser": 3,
    "maxSessionDurationMinutes": 240,
    "idleTimeoutMinutes": 30,
    "sessionRecording": false,
    "sessionRecordingRetentionDays": 90,
    "storageQuotaMB": 1024,
    "allowedRegions": ["us-east-1", "us-west-2", "eu-west-1"],
    "customBlockedPatterns": []
  }
}
```

## 10. UI Wireframes

### 10.1 Cloud Shell Page Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ ☰ Nucleus    Cloud Shell                    [Account ▼] [⚙] [?] │
├──────────────────────────────────────────────────────────────────┤
│ [Tab 1: prod-us-east] [Tab 2: staging] [+]     │ 🤖 AI Copilot │
│─────────────────────────────────────────────────│────────────────│
│                                                 │                │
│  nucleus@prod-us-east:~$                        │  How can I     │
│  nucleus@prod-us-east:~$ aws s3 ls              │  help you?     │
│  2024-01-15 my-bucket-1                         │                │
│  2024-01-20 my-bucket-2                         │  ┌───────────┐ │
│  nucleus@prod-us-east:~$ █                      │  │ Suggestion│ │
│                                                 │  │ Try:      │ │
│                                                 │  │ aws s3 ls │ │
│                                                 │  │ s3://...  │ │
│                                                 │  │ [Insert]  │ │
│                                                 │  └───────────┘ │
│                                                 │                │
│                                                 │  [Ask...]      │
│─────────────────────────────────────────────────│────────────────│
│ Session: 28:32 remaining │ Region: us-east-1    │ Auto: ☐ Read   │
└──────────────────────────────────────────────────────────────────┘
```

### 10.2 Approval Dialog

```
┌─────────────────────────────────────────────┐
│  ⚠ Command Requires Approval                │
│─────────────────────────────────────────────│
│                                             │
│  Command:                                   │
│  ┌─────────────────────────────────────────┐│
│  │ aws ec2 terminate-instances             ││
│  │   --instance-ids i-0abc123def456        ││
│  └─────────────────────────────────────────┘│
│                                             │
│  Risk: 🔴 HIGH                              │
│  Blast Radius: 1 EC2 instance               │
│  Reversibility: ❌ Irreversible              │
│  Account: prod-us-east (123456789012)       │
│                                             │
│  AI Assessment:                             │
│  "This will permanently terminate a         │
│   production EC2 instance. The instance     │
│   and its instance store volumes will be    │
│   lost. EBS volumes will be preserved if    │
│   DeleteOnTermination is false."            │
│                                             │
│  Type "terminate" to confirm:               │
│  ┌─────────────────────────────────────────┐│
│  │                                         ││
│  └─────────────────────────────────────────┘│
│                                             │
│  [Cancel]                    [Approve]      │
└─────────────────────────────────────────────┘
```

## 11. API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/shell/sessions` | List active sessions for current user |
| POST | `/api/shell/sessions` | Create new shell session |
| DELETE | `/api/shell/sessions/[id]` | Terminate a session |
| WS | `/api/shell/connect` | WebSocket endpoint for terminal I/O |
| POST | `/api/shell/sessions/[id]/approve` | Approve a pending command |
| POST | `/api/shell/sessions/[id]/deny` | Deny a pending command |
| GET | `/api/shell/sessions/[id]/history` | Get command history for a session |
| GET | `/api/shell/commands` | Query command audit log (filterable) |
| GET | `/api/shell/blocked-patterns` | List blocked command patterns |
| PUT | `/api/shell/blocked-patterns` | Update blocked patterns |
| GET | `/api/shell/settings` | Get tenant shell settings |
| PUT | `/api/shell/settings` | Update tenant shell settings |

## 12. Dependencies

### New NPM Packages
| Package | Purpose |
|---------|---------|
| `xterm` | Terminal emulator for the browser |
| `@xterm/addon-fit` | Auto-resize terminal to container |
| `@xterm/addon-web-links` | Clickable URLs in terminal |
| `@xterm/addon-search` | Search within terminal buffer |
| `node-pty` | Server-side pseudo-terminal |
| `ws` | WebSocket server (or use Next.js built-in) |

### AWS Infrastructure
- ECS sidecar container (shell server image)
- EFS volume (persistent user home directories)
- S3 bucket (command output storage, session recordings)
- CloudWatch log group (shell server logs)
- ALB WebSocket support (already configured with 1200s idle timeout)

## 13. Rollout Plan

### Phase 1: Foundation (MVP)
- Terminal emulator (xterm.js + node-pty)
- WebSocket connectivity
- Single-account AWS credential injection
- Basic command execution (no classification)
- RBAC integration

### Phase 2: Safety & Multi-Account
- Command classification engine
- Approval workflow (manual + auto modes)
- Multi-account switching
- Blocked command patterns
- Audit logging

### Phase 3: AI Copilot
- Copilot sidebar chat interface
- Command suggestions from natural language
- Output explanation
- Risk assessment in approval dialogs
- Proactive error correction

### Phase 4: Enterprise
- Session recording & playback
- Persistent home directories (EFS)
- Multiple concurrent tabs
- Compliance reports
- Tenant-level configuration

## 14. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Adoption | 60% of active users open Cloud Shell within 30 days | Session creation events |
| Copilot usage | 40% of sessions have copilot interaction | Chat message count per session |
| Safety | 0 destructive commands executed without approval | Audit log analysis |
| Latency | p95 keystroke latency < 100ms | WebSocket round-trip timing |
| Session duration | Average 15+ minutes | Session metadata |

## 15. Open Questions

1. **Container strategy**: Sidecar (simpler) vs. separate service (better isolation/scaling)?
2. **WebSocket routing**: Can CloudFront handle WebSocket upgrade, or do we need a direct ALB path?
3. **Persistent storage**: EFS (simpler) vs. S3-backed FUSE mount (cheaper at scale)?
4. **Command interception**: Bash preexec hook (simpler) vs. custom shell wrapper (more reliable)?
5. **Copilot model**: Reuse existing Bedrock Claude, or use a lighter model for faster suggestions?
6. **Session recording**: Build custom or integrate asciinema?
