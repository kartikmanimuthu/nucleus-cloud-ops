# Requirements Specification — Nucleus Cloud Shell

## Document Info

| Field | Value |
|-------|-------|
| Module | Cloud Shell |
| PRD Reference | `docs/prd-cloud-shell.md` |
| Version | 1.0 |
| Status | Draft |

---

## 1. Requirements Matrix

### 1.1 Terminal Core (TERM)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| TERM-01 | Web terminal emulator renders in browser using xterm.js | P0 | 1 | Terminal element mounts, accepts keyboard input, displays output with ANSI color support |
| TERM-02 | Server-side PTY process spawned per session via node-pty | P0 | 1 | `bash` process starts, stdin/stdout piped to WebSocket, `echo hello` returns `hello` |
| TERM-03 | WebSocket connection between browser xterm.js and server PTY | P0 | 1 | Bidirectional data flow with < 50ms latency; auto-reconnect on transient disconnect |
| TERM-04 | Terminal auto-resizes to fit container dimensions | P0 | 1 | Resize event propagates to PTY via `SIGWINCH`; no text clipping or overflow |
| TERM-05 | Copy/paste support (Ctrl+Shift+C/V, right-click context menu) | P1 | 1 | Selected text copies to clipboard; paste inserts at cursor position |
| TERM-06 | Scrollback buffer of 10,000 lines | P1 | 1 | User can scroll up to view previous output; buffer truncates at limit |
| TERM-07 | Search within terminal buffer (Ctrl+Shift+F) | P2 | 4 | Search overlay highlights matches; next/prev navigation works |
| TERM-08 | Clickable URLs in terminal output | P2 | 4 | URLs render as clickable links; open in new browser tab |

### 1.2 AWS Account Access (AWS)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| AWS-01 | Account selector dropdown in terminal toolbar | P0 | 1 | Dropdown lists all connected accounts for the tenant; shows account name + ID |
| AWS-02 | STS AssumeRole on account selection | P0 | 1 | Selecting an account calls STS; temporary credentials injected into PTY env vars within 2s |
| AWS-03 | AWS credentials injected as env vars (ACCESS_KEY_ID, SECRET, SESSION_TOKEN, REGION) | P0 | 1 | `aws sts get-caller-identity` returns the assumed role ARN for the selected account |
| AWS-04 | Credential auto-refresh before expiry | P0 | 2 | Credentials refresh at 12 min (of 15 min session); no interruption to running commands |
| AWS-05 | Visual indicator: active account name, ID, session timer | P0 | 1 | Status bar shows account name, masked account ID, countdown timer |
| AWS-06 | Multi-account tab support — each tab targets different account | P1 | 4 | Tab 1 on `prod`, Tab 2 on `staging`; `aws sts get-caller-identity` returns correct role per tab |
| AWS-07 | Region selector (default from account config, overridable) | P1 | 2 | Changing region updates `AWS_DEFAULT_REGION` in PTY; subsequent commands use new region |

### 1.3 Session Management (SESS)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| SESS-01 | Session creation with unique ID, linked to user + tenant | P0 | 1 | POST `/api/shell/sessions` returns session ID; session record created in DB |
| SESS-02 | Idle timeout (default 30 min, configurable) | P0 | 1 | No input for 30 min → session terminated; user sees "Session expired" message |
| SESS-03 | Max active session duration (default 4 hours) | P0 | 1 | Session auto-terminates at 4h regardless of activity; warning at 3h50m |
| SESS-04 | Graceful cleanup on disconnect/tab close | P0 | 1 | PTY process killed, session status updated to `terminated`, resources freed |
| SESS-05 | Reconnect on page refresh — reattach to existing PTY | P1 | 2 | Refresh page → terminal reconnects to same session; working directory preserved |
| SESS-06 | Multiple concurrent tabs (max 3 per user) | P1 | 4 | User opens 3 tabs successfully; 4th attempt shows "Max sessions reached" error |
| SESS-07 | Session list API for current user | P1 | 2 | GET `/api/shell/sessions` returns active sessions with metadata |
| SESS-08 | Admin can terminate other users' sessions | P2 | 4 | Admin calls DELETE on another user's session; PTY killed, audit logged |

### 1.4 AI Copilot (COP)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| COP-01 | Collapsible sidebar panel (right side, resizable) | P0 | 3 | Sidebar toggles open/closed; drag handle resizes; state persists in localStorage |
| COP-02 | Chat interface with streaming responses | P0 | 3 | User sends message; response streams token-by-token; markdown rendered |
| COP-03 | Copilot has visibility into terminal content (last 50 lines) | P0 | 3 | Copilot references current terminal state in responses accurately |
| COP-04 | Natural language → CLI command suggestions | P0 | 3 | "List all running EC2 instances" → copilot returns `aws ec2 describe-instances --filters Name=instance-state-name,Values=running` |
| COP-05 | "Insert to Terminal" button on suggested commands | P0 | 3 | Click inserts command text at terminal cursor; does NOT execute |
| COP-06 | "Run" button on suggested commands (subject to approval) | P1 | 3 | Click inserts AND executes; if approval required, triggers approval flow |
| COP-07 | "Explain this" on selected terminal output | P1 | 3 | User selects output → clicks explain → copilot provides plain-language explanation |
| COP-08 | Proactive error detection and fix suggestions | P1 | 3 | Failed command → copilot card appears with suggested correction |
| COP-09 | Command history awareness in conversation | P1 | 3 | "What did I run earlier?" → copilot lists recent commands from session |
| COP-10 | Proactive suggestions for large result sets | P2 | 3 | Command returns 500+ lines → copilot suggests `--query` or `| jq` filtering |
| COP-11 | Credential expiry warning via copilot | P2 | 3 | 2 min before expiry → copilot card: "Credentials expiring, refreshing..." |

### 1.5 Command Safety (SAFE)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| SAFE-01 | Command classification engine (read / modify / destructive / blocked) | P0 | 2 | `aws s3 ls` → read; `aws ec2 terminate-instances` → destructive; `aws iam create-user` → blocked |
| SAFE-02 | Manual approval mode — modify + destructive commands require approval | P0 | 2 | Modify command pauses terminal; approval dialog appears; approve → executes; deny → cancelled |
| SAFE-03 | Auto-approve read mode — read commands execute immediately | P0 | 2 | `ls`, `cat`, `aws s3 ls` execute without pause; `aws s3 rm` still requires approval |
| SAFE-04 | Auto-approve all mode (Admin only) — only destructive requires approval | P1 | 2 | Admin toggles mode; `aws s3 cp` executes immediately; `terminate-instances` still requires approval |
| SAFE-05 | Approval dialog with command text, risk level, affected resources | P0 | 2 | Dialog renders with all fields populated; approve/deny buttons functional |
| SAFE-06 | Approval timeout — auto-deny after 5 minutes | P1 | 2 | Unapproved command auto-denied at 5 min; terminal resumes with "Command denied (timeout)" |
| SAFE-07 | AI risk assessment (blast radius, reversibility, cost, security) | P1 | 3 | Approval dialog shows AI-generated risk assessment with severity badge |
| SAFE-08 | "Type to confirm" safeguard for high/critical risk commands | P1 | 2 | High-risk approval requires typing confirmation word; approve button disabled until match |
| SAFE-09 | Blocked command patterns (configurable deny-list per tenant) | P0 | 2 | `aws iam create-user` → blocked with message; pattern configurable in settings |
| SAFE-10 | Default blocked patterns: IAM mutation, org-level, billing | P0 | 2 | Out-of-box patterns block privilege escalation; cannot be removed (only extended) |
| SAFE-11 | Approval mode selector in session toolbar | P0 | 2 | Toggle between manual/auto-read/auto-all; persists for session duration |
| SAFE-12 | Tenant-level default approval mode in settings | P1 | 2 | Admin sets default in Settings → new sessions start with that mode |

### 1.6 Audit & Compliance (AUD)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| AUD-01 | Every executed command logged with full metadata | P0 | 2 | ShellCommand record created with: command, exit code, classification, approval status, user, account, timestamp |
| AUD-02 | Command output stored (10KB preview in DB, full in S3) | P1 | 2 | Output > 10KB → truncated preview in DB, full output in S3 with key reference |
| AUD-03 | Blocked and denied commands logged | P0 | 2 | Blocked/denied commands appear in audit with `approvalStatus: blocked/denied` |
| AUD-04 | Cloud Shell activity visible in Audit Logs module | P1 | 2 | Audit Logs page shows shell commands alongside existing audit entries |
| AUD-05 | Filterable command history: user, account, date, status, risk | P1 | 4 | Filter controls on audit page; results update on filter change |
| AUD-06 | Export command history to CSV/JSON | P2 | 4 | Export button generates downloadable file with filtered results |
| AUD-07 | Session recording (asciinema-compatible format) | P2 | 4 | Toggle in settings; recorded sessions playable in audit UI |
| AUD-08 | Session recording retention (configurable, default 90 days) | P2 | 4 | Recordings auto-deleted after retention period via scheduled cleanup |
| AUD-09 | Summary metrics: commands run, approval rate, top users | P2 | 4 | Dashboard widget or report page with aggregated shell metrics |

### 1.7 RBAC (RBAC)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| RBAC-01 | `CloudShell` added as RBAC module with CRUD actions | P0 | 1 | Module appears in role configuration; permissions enforceable |
| RBAC-02 | `read` permission: view Cloud Shell page, view audit logs | P0 | 1 | Viewer role can navigate to Cloud Shell page; cannot create sessions |
| RBAC-03 | `create` permission: open new terminal sessions | P0 | 1 | Member role can create sessions; viewer gets 403 |
| RBAC-04 | `update` permission: change approval mode, configure patterns | P1 | 2 | Admin can toggle approval mode and edit blocked patterns |
| RBAC-05 | `delete` permission: terminate other users' sessions | P2 | 4 | Owner/Admin can kill another user's session from admin view |
| RBAC-06 | Role defaults: Owner=full, Admin=CRU, Member=CR, Viewer=R | P0 | 1 | Default roles have correct CloudShell permissions out of box |

### 1.8 Infrastructure (INFRA)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| INFRA-01 | Shell server container image with AWS CLI v2, jq, git, python3, node | P0 | 1 | Container starts; `aws --version`, `jq --version`, `git --version` all succeed |
| INFRA-02 | ECS task definition with sidecar container for shell server | P0 | 1 | Pulumi deploys task with 2 containers; both healthy; ALB routes correctly |
| INFRA-03 | WebSocket routing through ALB (upgrade support) | P0 | 1 | Browser WebSocket connects through ALB; bidirectional data flows |
| INFRA-04 | CloudFront WebSocket passthrough (or direct ALB path) | P1 | 2 | WebSocket works through CloudFront; or dedicated ALB endpoint configured |
| INFRA-05 | PTY process sandboxed — no access to app secrets or DB | P0 | 1 | Shell user cannot read env vars from Next.js container; cannot reach RDS |
| INFRA-06 | Network egress restricted to AWS API endpoints | P1 | 2 | Outbound traffic limited to AWS service endpoints + configured allowlist |
| INFRA-07 | EFS volume for persistent user home directories | P2 | 4 | User files persist across sessions; 1GB quota enforced |
| INFRA-08 | S3 bucket for command output storage and session recordings | P1 | 2 | Bucket created with lifecycle rules; outputs written and retrievable |
| INFRA-09 | CloudWatch log group for shell server | P0 | 1 | Shell server logs stream to CloudWatch; searchable |
| INFRA-10 | Resource limits: 0.25 vCPU, 512 MiB per session | P0 | 1 | Container resource limits set in task definition; enforced by Fargate |

### 1.9 Settings & Configuration (CONF)

| ID | Requirement | Priority | Phase | Acceptance Criteria |
|----|-------------|----------|-------|---------------------|
| CONF-01 | Tenant-level Cloud Shell enable/disable toggle | P0 | 1 | Disabled tenant → Cloud Shell nav item hidden; API returns 403 |
| CONF-02 | Default approval mode setting | P1 | 2 | Admin sets default; new sessions inherit it |
| CONF-03 | Max sessions per user setting (default 3) | P1 | 2 | Exceeding limit returns 429 with clear message |
| CONF-04 | Max session duration setting (default 240 min) | P1 | 2 | Session terminates at configured duration |
| CONF-05 | Idle timeout setting (default 30 min) | P1 | 2 | Session terminates after configured idle period |
| CONF-06 | Allowed regions list | P2 | 4 | Region selector only shows allowed regions |
| CONF-07 | Session recording toggle | P2 | 4 | Toggle on → sessions recorded; toggle off → no recording |
| CONF-08 | Custom blocked patterns management UI | P1 | 2 | Admin can add/remove regex patterns; changes take effect on new sessions |

---

## 2. Phase Breakdown

### Phase 1: Foundation (MVP)
**Goal**: Working terminal in the browser connected to a server-side shell with single-account AWS access.

**Requirements**: TERM-01 through TERM-06, AWS-01 through AWS-03, AWS-05, SESS-01 through SESS-04, RBAC-01 through RBAC-03, RBAC-06, INFRA-01 through INFRA-03, INFRA-05, INFRA-09, INFRA-10, CONF-01

**Deliverables**:
- `/web-ui/app/app/cloud-shell/page.tsx` — Cloud Shell page
- `/web-ui/components/cloud-shell/terminal.tsx` — xterm.js terminal component
- `/web-ui/components/cloud-shell/toolbar.tsx` — account selector, status bar
- `/web-ui/app/api/shell/` — session + WebSocket API routes
- Shell server container (Dockerfile + node-pty server)
- Pulumi updates for ECS sidecar + ALB routing
- Prisma migration for `ShellSession` model
- RBAC module registration
- Sidebar navigation entry

**Exit Criteria**: User can open Cloud Shell, select an account, run `aws s3 ls`, and see results.

---

### Phase 2: Safety & Multi-Account
**Goal**: Command classification, approval workflows, audit logging, credential refresh.

**Requirements**: AWS-04, AWS-07, SESS-05, SESS-07, SAFE-01 through SAFE-06, SAFE-08 through SAFE-12, AUD-01 through AUD-04, RBAC-04, INFRA-04, INFRA-06, INFRA-08, CONF-02 through CONF-05, CONF-08

**Deliverables**:
- Command classification engine (`/web-ui/lib/cloud-shell/classifier.ts`)
- Approval dialog component (`/web-ui/components/cloud-shell/approval-dialog.tsx`)
- Blocked patterns service + API
- Credential refresh mechanism
- Session reconnect logic
- Audit integration (ShellCommand model + logging)
- Tenant settings UI for Cloud Shell configuration

**Exit Criteria**: Destructive command triggers approval dialog; denied command is logged; blocked pattern prevents execution.

---

### Phase 3: AI Copilot
**Goal**: AI sidebar that suggests commands, explains output, and assesses risk.

**Requirements**: COP-01 through COP-11, SAFE-07

**Deliverables**:
- Copilot sidebar component (`/web-ui/components/cloud-shell/copilot-sidebar.tsx`)
- Shell copilot agent (`/web-ui/lib/agent/shell-copilot.ts`)
- Copilot tools: `suggest_command`, `explain_output`, `assess_risk`
- Terminal-to-copilot context bridge (scrollback sharing)
- "Insert to Terminal" / "Run" action buttons
- Risk assessment integration in approval dialog

**Exit Criteria**: User asks "how do I list EC2 instances" → copilot suggests command → user clicks Insert → command appears in terminal.

---

### Phase 4: Enterprise
**Goal**: Multi-tab, session recording, persistent storage, compliance reports.

**Requirements**: TERM-07, TERM-08, AWS-06, SESS-06, SESS-08, AUD-05 through AUD-09, RBAC-05, INFRA-07, CONF-06, CONF-07

**Deliverables**:
- Multi-tab terminal UI
- Session recording (asciinema format) + playback UI
- EFS integration for persistent home directories
- Compliance report page
- CSV/JSON export
- Admin session management view

**Exit Criteria**: User has 3 tabs on different accounts; session recording plays back in audit UI; compliance report exports to CSV.

---

## 3. Dependency Map

```
Phase 1 (Foundation)
  ├── TERM-01..06  (terminal core)
  ├── AWS-01..03, AWS-05  (account access)
  ├── SESS-01..04  (session lifecycle)
  ├── RBAC-01..03, RBAC-06  (permissions)
  ├── INFRA-01..03, INFRA-05, INFRA-09..10  (infrastructure)
  └── CONF-01  (enable/disable)
        │
        ▼
Phase 2 (Safety)
  ├── SAFE-01..06, SAFE-08..12  (classification + approval)
  ├── AUD-01..04  (audit logging)
  ├── AWS-04, AWS-07  (credential refresh, region)
  ├── SESS-05, SESS-07  (reconnect, session list)
  ├── INFRA-04, INFRA-06, INFRA-08  (CloudFront, egress, S3)
  └── CONF-02..05, CONF-08  (settings)
        │
        ▼
Phase 3 (AI Copilot)
  ├── COP-01..11  (copilot features)
  └── SAFE-07  (AI risk assessment)
        │
        ▼
Phase 4 (Enterprise)
  ├── TERM-07..08  (search, links)
  ├── AWS-06  (multi-account tabs)
  ├── SESS-06, SESS-08  (multi-tab, admin kill)
  ├── AUD-05..09  (reports, recording)
  ├── RBAC-05  (admin session mgmt)
  ├── INFRA-07  (EFS)
  └── CONF-06..07  (regions, recording)
```

## 4. Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| WebSocket through CloudFront may not work reliably | High | Medium | Phase 1 uses direct ALB path; CloudFront WS tested in Phase 2 |
| node-pty native module build issues on ARM64 | Medium | Medium | Pre-build in Docker; test on Fargate ARM64 early |
| Command classification false positives (safe command blocked) | Medium | High | Start with conservative allowlist; add AI fallback in Phase 3 |
| PTY escape / sandbox breakout | Critical | Low | Run shell container with minimal privileges; no host mounts; seccomp profile |
| Credential leakage via terminal output | High | Low | Scrub AWS credentials from terminal output before logging; never log SESSION_TOKEN |
| WebSocket connection drops on long-running commands | Medium | Medium | Heartbeat ping/pong every 30s; auto-reconnect with session reattach |
| High memory usage from many concurrent PTY sessions | Medium | Medium | Enforce per-session limits; monitor and alert; auto-terminate idle sessions aggressively |

## 5. Testing Strategy

| Layer | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | Command classifier, credential refresh logic, approval state machine |
| Integration | Vitest | API routes (session CRUD, approve/deny), WebSocket handshake |
| Component | Vitest + React Testing Library | Terminal component mount/resize, approval dialog, copilot sidebar |
| E2E | Playwright | Full flow: open shell → select account → run command → see output |
| Security | Manual + automated | Sandbox escape attempts, credential leakage, RBAC enforcement |
| Load | k6 or Artillery | 50 concurrent WebSocket sessions, keystroke latency under load |

## 6. Requirement Count Summary

| Category | P0 | P1 | P2 | Total |
|----------|----|----|-----|-------|
| Terminal (TERM) | 4 | 2 | 2 | 8 |
| AWS Access (AWS) | 4 | 2 | 1 | 7 |
| Session (SESS) | 4 | 3 | 1 | 8 |
| AI Copilot (COP) | 4 | 4 | 3 | 11 |
| Safety (SAFE) | 5 | 5 | 2 | 12 |
| Audit (AUD) | 2 | 3 | 4 | 9 |
| RBAC | 4 | 1 | 1 | 6 |
| Infrastructure (INFRA) | 5 | 3 | 2 | 10 |
| Configuration (CONF) | 1 | 4 | 3 | 8 |
| **Total** | **33** | **27** | **19** | **79** |
