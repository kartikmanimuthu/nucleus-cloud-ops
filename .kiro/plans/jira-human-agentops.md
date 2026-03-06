Implementation Plan — Jira Human-in-the-Loop Approval Workflow

Problem Statement:
The Jira trigger route (/api/v1/trigger/jira) currently handles awaiting_input (clarification)
resume but has no support for awaiting_approval resume. When the agent pauses at approval_gate or
mutative_approval_gate and posts an approval request comment to Jira, there's no way for a user
to reply "APPROVE" or "REJECT" on the Jira issue and have the agent resume. Additionally, the
trigger doesn't support native Jira webhooks (comment_created events) — only Jira Automation rule
payloads with shared secret auth.

Requirements (from user answers):
1. Bot mention detection via ADF mention node — match accountId against a configured botAccountId
in JiraIntegrationConfig
2. Exact keyword match (case-insensitive, trimmed) for APPROVE/REJECT
3. Support both Jira Automation rules (current) and native Jira webhooks, detect based on payload
shape

Background — What Already Exists:
- approval_gate + mutative_approval_gate nodes in LangGraph graph with interruptBefore
- resumeApprovedRun() in agent-executor.ts — loads checkpoint, injects approvalStatus='approved',
resumes graph
- postApprovalRequestToJira() + postApprovalResponseToJira() in jira-notifier.ts
- agent-executor.ts already posts approval requests to Jira when source is 'jira'
- findAwaitingRunByJiraIssue() in agent-ops-service.ts — scans for awaiting_input runs by
issueKey
- findAwaitingApprovalRun() — finds awaiting_approval runs by runId (cross-tenant)
- /api/agent-ops/[runId]/approve/route.ts — source-agnostic approve/reject API (already handles
Jira notifications)

Proposed Solution:
Extend the existing Jira trigger route to:
1. Detect native Jira webhook payloads (have webhookEvent field) vs Automation rule payloads
2. Parse ADF mention nodes to detect bot mentions (new trigger) vs plain comments (potential
approval/clarification reply)
3. Add awaiting_approval lookup alongside existing awaiting_input lookup — when a comment on an
issue matches APPROVE/REJECT exactly, resume or cancel the run
4. Add botAccountId to JiraIntegrationConfig so the system knows which Jira account is the bot
5. Add a new findAwaitingApprovalRunByJiraIssue() service method

Task Breakdown:

Task 1: Add botAccountId to JiraIntegrationConfig and update settings API/UI
- Objective: Allow users to configure the Jira bot account ID used for mention detection
- Add botAccountId?: string to JiraIntegrationConfig in types.ts
- Add autoApprove?: boolean field to the Jira settings PUT handler (already in type, not in
settings route)
- Update web-ui/app/api/agent-ops/settings/jira/route.ts to persist botAccountId
- Update web-ui/app/agent-ops/jira-settings/page.tsx to show a botAccountId input field
- Demo: User can configure a Jira bot account ID in the settings page and see it persisted

Task 2: Add ADF mention node parser to jira-validator.ts
- Objective: Parse ADF document to detect @bot mentions and extract the comment text excluding
the mention
- Add extractMentionAccountIds(adfBody) function that walks ADF nodes and returns all mention
node id attributes
- Add isBotMention(comment, botAccountId) function that checks if any mention matches the
configured bot account ID
- Add extractCommentTextWithoutMention(adfBody) that returns the comment text with the mention
node stripped (so "@ bot run load test" becomes "run load test")
- Update JiraWebhookPayload to include the native webhook shape (webhookEvent, comment.body as
ADF object)
- Demo: Unit-testable functions — given an ADF body with a mention node, correctly identifies bot
mention and extracts clean text

Task 3: Add findAwaitingApprovalRunByJiraIssue() to agent-ops-service.ts
- Objective: Look up runs with awaiting_approval status for a given Jira issue key
- Add findAwaitingApprovalRunByJiraIssue(issueKey: string) — same pattern as
findAwaitingRunByJiraIssue() but filters on status === 'awaiting_approval'
- Export it on the agentOpsService object
- Demo: Given a Jira issue key with an awaiting_approval run, the function returns it

Task 4: Update Jira trigger route to handle approval resume and native webhooks
- Objective: The core logic — detect APPROVE/REJECT comments on issues with awaiting_approval
runs, and resume/cancel accordingly. Also support native Jira webhook payloads.
- In /api/v1/trigger/jira/route.ts:
  - Detect payload type: if payload.webhookEvent exists → native Jira webhook; else → Automation
rule
  - For native webhooks: extract issueKey from payload.issue.key, comment from payload.comment
  - After extracting comment text, before the existing awaiting_input check, add an
awaiting_approval check:
    - Call findAwaitingApprovalRunByJiraIssue(issueKey)
    - If found and comment text (trimmed, case-insensitive) is exactly "approve" or "approved":
call resumeApprovedRun() fire-and-forget, post approval response to Jira, return 200
    - If found and comment text is exactly "reject" or "rejected": update run status to cancelled
, post rejection response to Jira, return 200
  - For bot mention detection (new run trigger): if
isBotMention(comment, jiraConfig.botAccountId), extract the task text and create a new run (
existing flow)
  - If no bot mention and no awaiting run match, return 200 (ignore the comment)
  - Skip bot's own comments: if comment.author.accountId === jiraConfig.botAccountId, return 200
immediately (prevent infinite loops)
- Demo: Post a comment "APPROVE" on a Jira issue with an awaiting_approval run → run resumes.
Post "@bot run load test" → new run created. Post "REJECT" → run cancelled.

Task 5: Wire up result posting after approved run completes
- Objective: After resumeApprovedRun() completes, post the result back to the Jira issue
- In the Jira trigger route's approval resume block: after resumeApprovedRun() resolves, fetch
the fresh run and call postResultToJira() (or postErrorToJira() on failure)
- This mirrors the existing pattern in the Slack interactions route
- Demo: Full end-to-end flow — comment triggers agent → plan posted → "APPROVE" comment → agent
resumes → result posted back to Jira issue

Task 6: Handle native Jira webhook auth (dual auth support)
- Objective: Support both shared-secret auth (Automation rules) and native Jira webhook
validation
- For Automation rules: existing verifyJiraSecret() with Authorization / x-webhook-secret header
- For native webhooks: add optional webhookSecret validation via query param or header (Jira
Cloud webhooks can include a secret in the URL). If no auth header present but
payload.webhookEvent exists, check for ?secret= query param
- Add autoApprove field passthrough from jiraConfig to run creation (already in type, wire it
through)
- Demo: Both Automation rule payloads (with Bearer token) and native Jira webhook payloads (with
query param secret) are accepted and processed correctly

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Files to Modify:
- web-ui/lib/agent-ops/types.ts — add botAccountId to JiraIntegrationConfig
- web-ui/lib/agent-ops/jira-validator.ts — add ADF mention parser, bot detection, text extraction
- web-ui/lib/agent-ops/agent-ops-service.ts — add findAwaitingApprovalRunByJiraIssue()
- web-ui/app/api/v1/trigger/jira/route.ts — approval resume logic, native webhook support, bot
mention detection
- web-ui/app/api/agent-ops/settings/jira/route.ts — persist botAccountId
- web-ui/app/agent-ops/jira-settings/page.tsx — botAccountId input field

Files to Create:
- None

Files to Delete:
- None

Architecture Flow (End-to-End):

Jira Issue OPS-123
┌─ User adds comment: "@cloud-ops run load test on staging"
│
│   [1] Jira webhook → POST /api/v1/trigger/jira
│       → Auth verify (shared secret OR query param)
│       → Skip if comment author === botAccountId (prevent loops)
│       → Parse ADF → detect mention node → match botAccountId ✅
│       → Extract task text: "run load test on staging"
│       → Create run (source: jira, trigger: {issueKey: OPS-123, ...})
│       → executeAgentRun() fire-and-forget
│       → Return 200
│
│   [2] LangGraph: evaluator → requiresApproval=true
│       → planner → generates plan
│       → approval_gate → INTERRUPT (checkpoint saved)
│
│   [3] agent-executor detects awaiting_approval
│       → DynamoDB: status='awaiting_approval'
│       → postApprovalRequestToJira():
│
│   └─ 🤖 Bot comment on OPS-123:
│       "🤖 Agent Ops — Approval Required
│        Plan:
│        1. Get credentials for staging
│        2. Run load test via k6
│        3. Collect metrics
│        Reply with "APPROVE" or "REJECT""
│
│   [4] User comments: "APPROVE"
│       → Jira webhook fires → POST /api/v1/trigger/jira
│       → Skip bot mention check (no mention node)
│       → findAwaitingApprovalRunByJiraIssue("OPS-123") → found!
│       → Comment text trimmed = "APPROVE" → exact match ✅
│       → postApprovalResponseToJira(true, ...)
│       → resumeApprovedRun() fire-and-forget
│       → Return 200
│
│   [5] Graph resumes → tools → reflect → final
│       → postResultToJira():
│
│   └─ 🤖 Bot comment on OPS-123:
│       "✅ Agent Ops Run Completed
│        Duration: 47s
│        Tools used: get_aws_credentials, bash
│        Load test complete. P99 latency: 230ms..."


Does this plan look good, or would you like me to adjust anything?

---


[DONE]

Built: Jira Human-in-the-Loop approval workflow — comment-driven APPROVE/REJECT resume, ADF bot
mention detection for new run triggers, native Jira webhook support, and bot loop prevention.

Files:
- web-ui/lib/agent-ops/types.ts — added botAccountId to both JiraIntegrationConfig interfaces
- web-ui/lib/agent-ops/jira-validator.ts — rewrote: added extractMentionAccountIds, isBotMention,
extractCommentTextWithoutMention; updated verifyJiraSecret to accept querySecret param; updated
JiraWebhookPayload with webhookEvent and ADF body type
- web-ui/lib/agent-ops/agent-ops-service.ts — added findAwaitingApprovalRunByJiraIssue() and
exported it
- web-ui/app/api/v1/trigger/jira/route.ts — full rewrite with 5-step comment routing: bot loop
guard → APPROVE/REJECT → clarification resume → @mention new run → automation rule new run; dual
auth (header + ?secret=); result posting after resume
- web-ui/app/api/agent-ops/settings/jira/route.ts — persist/return botAccountId and autoApprove
- web-ui/app/agent-ops/jira-settings/page.tsx — added Bot Account ID input field to form

Test: Post a comment "APPROVE" on a Jira issue that has an awaiting_approval run → run resumes
and posts result. Post "@bot run load test on staging" → new run created. Post "REJECT" → run
cancelled. Bot's own comments are silently ignored.

Note: For native Jira webhooks, configure the webhook URL as
POST /api/v1/trigger/jira?secret=<your-secret>. For Automation rules, keep using the
Authorization: Bearer <secret> header.

 ▸ Credits: 6.35 • Time: 3m 7s



 ### Step 1: Configure Agent Settings

Go to your Agent Ops dashboard → Jira Integration settings page and fill in:

1. Webhook Secret — Generate a random secret (e.g., openssl rand -hex 32)
2. Jira Base URL — e.g., https://your-org.atlassian.net
3. User Email — Your Atlassian account email
4. API Token — Generate at https://id.atlassian.com/manage-profile/security/api-tokens
5. Bot Account ID — Your bot's Jira account ID (find at Jira → Profile → Account ID)
6. Enable — Toggle on

Save settings.

### Step 2: Set Up Jira Automation Rule

In Jira, go to Project Settings → Automation and create a new rule:

Trigger: "Issue created" (or any event)

Action: "Send web request"
- **URL:** https://your-domain.com/api/v1/trigger/jira
- **Method:** POST
- **Headers:** Add custom header Authorization: Bearer <your-webhook-secret>
70% > share a sample request for the local testing ?



### Step 1: Configure Agent Settings

Go to your Agent Ops dashboard → Jira Integration settings page and fill in:

1. Webhook Secret — Generate a random secret (e.g., openssl rand -hex 32)
2. Jira Base URL — e.g., https://your-org.atlassian.net
3. User Email — Your Atlassian account email
4. API Token — Generate at https://id.atlassian.com/manage-profile/security/api-tokens
5. Bot Account ID — Your bot's Jira account ID (find at Jira → Profile → Account ID)
6. Enable — Toggle on

Save settings.

### Step 2: Set Up Jira Automation Rule

In Jira, go to Project Settings → Automation and create a new rule:

Trigger: "Issue created" (or any event)

Action: "Send web request"
- **URL:** https://your-domain.com/api/v1/trigger/jira
- **Method:** POST
- **Headers:** Add custom header Authorization: Bearer <your-webhook-secret>
- **Body (JSON):**
json
{
  "taskDescription": "{{issue.summary}} - {{issue.description}}",
  "issue": {
    "key": "{{issue.key}}",
    "fields": {
      "summary": "{{issue.summary}}",
      "project": {"key": "{{issue.project.key}}"},
      "reporter": {"displayName": "{{issue.reporter.displayName}}"},
      "issuetype": {"name": "{{issue.type}}"}
    }
  }
}


Save and test the rule.

### Step 3: Test Approval Workflow

Create a Jira issue → Agent runs → Posts approval request comment

Reply with "APPROVE" → Agent resumes → Posts result

Or reply with "REJECT" → Agent cancels

### Step 4: Test Bot Mention (Native Webhook)

If using native Jira webhooks (not Automation rules), configure the webhook URL as:
https://your-domain.com/api/v1/trigger/jira?secret=<your-webhook-secret>


Then comment on any issue: @bot run load test on staging → New run created.

Key: Bot must be mentioned via ADF mention node (use Jira's @ mention UI, not plain text).