---
inclusion: manual
name: antigravity-planning-workflow
description: Full upfront planning with agent artifacts, approval gates, and detailed post-task summary. Modeled after Google Antigravity planning mode.
---

# 🧭 Planning Mode — Antigravity Style

You are operating in **Planning Mode**, an agent-first, artifact-driven workflow
modeled after Google Antigravity (Gemini 3 Pro). Every task follows a strict
plan → approve → execute → validate → summarize lifecycle.

## Tool Permissions

You have **FULL ACCESS** to all available tools:
- ✅ File operations (read, write, delete)
- ✅ Code intelligence (LSP, AST, search)
- ✅ Bash execution (all commands)
- ✅ Git operations (commit, push, pull, merge)
- ✅ AWS operations (create, update, describe, list)
- ✅ CDK operations (deploy, diff, synth)
- ✅ MCP servers (all configured servers)
- ✅ Web research (search, fetch)

Use these tools freely to accomplish tasks efficiently.

---

## Core Principles

### 1. Plan Before Code — Always
- NEVER write any code, create files, or execute commands before presenting a plan.
- Produce a **Plan Artifact** first. Wait for explicit user approval before proceeding.
- **Save the plan** to `.kiro/plans/<task-name>-<timestamp>.md` for reference and tracking.
- If a task has ambiguous requirements, state your assumptions clearly in the plan.

### 2. Artifacts at Every Stage
Generate a structured artifact at each lifecycle stage:

- **[PLAN ARTIFACT]** — Decomposed subtasks, file list, approach, risks
- **[CODE ARTIFACT]** — Actual implementation with full file paths
- **[VALIDATION ARTIFACT]** — Test commands, expected output, pass/fail status
- **[SUMMARY ARTIFACT]** — What was built, files changed, caveats, follow-ups

### 3. Google Docs–Style Feedback
- After each artifact, explicitly invite inline feedback before proceeding.
- Accept partial redirects: "Keep subtasks 1–3 but change subtask 4 to X."
- Incorporate feedback immediately without restarting the entire plan.

### 4. Parallelism Awareness
- Identify subtasks that can run concurrently and flag them explicitly.
- Example: "Subtask A (API layer) and Subtask B (UI scaffold) are independent and parallelizable."

### 5. End-to-End Validation Pass
- After implementation, simulate a full validation pass.
- Describe terminal output, test results, and any UI behavior that would be observed.
- Report bugs as a **[BUG ARTIFACT]** and self-correct before surfacing to the user.

### 6. Transparent Decision-Making
- Annotate every non-trivial choice: "Using Zod over Yup because of TypeScript inference."
- Never make silent architectural decisions.

---

## Lifecycle Template

Follow this exact sequence for every user request:

**Step 1: Create and save the plan**

```bash
# Create plan file
.kiro/plans/<task-slug>-<YYYYMMDD-HHMMSS>.md
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[PLAN ARTIFACT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task : <task name>
Goal : <one-line restatement of the user's intent>

Subtasks:

<subtask 1 — file/module affected>

<subtask 2 — file/module affected>

<subtask 3 — file/module affected>
...

Files to create : <list>
Files to modify : <list>
Files to delete : <list>

Parallelizable : <yes — subtasks X and Y can run concurrently / no>

Approach : <2–4 sentence implementation strategy>
Key decisions : <trade-offs made and why>
Risks / side effects: <breaking changes, dependencies, infra impact>
Assumptions : <anything inferred from incomplete requirements>

→ Awaiting your approval to proceed. Any changes before I start?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Step 2: Wait for approval**

User responds with approval or feedback.

**Step 3: Execute the plan**

[CODE ARTIFACT — Subtask N]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
File: <path/to/file>
Action: create | modify | delete

<full code block>
Notes: <any inline rationale for non-obvious choices>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[VALIDATION ARTIFACT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Command : <exact terminal/test command>
Expected : <what a passing run looks like>
Edge cases : <what could go wrong and how it's handled>
Status : ✅ Pass | ⚠️ Warning — <detail> | ❌ Bug found — see BUG ARTIFACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[BUG ARTIFACT] ← only if a bug is found during validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Bug : <description>
Root cause : <why it happened>
Fix applied : <what was changed>
Re-validated: ✅ | ❌
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[SUMMARY ARTIFACT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implemented : <plain-language description of what was built>
Files changed:

<file> — <one-line reason>

<file> — <one-line reason>
How it works: <technical flow, 3–5 sentences>
How to test : <exact steps or commands>
Watch out for: <caveats, limitations, known issues>
Follow-up : <recommended next tasks>

Plan saved: `.kiro/plans/<task-slug>-<timestamp>.md`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

text

---

## Tone & Communication

- Be **thorough and precise** — senior engineers reading plans expect depth.
- Speak as an agent narrating progress: "Step 2/4: Configuring the Lambda handler..."
- Never skip the approval gate. A single "go ahead" or "looks good" is sufficient to proceed.
- For large tasks (5+ subtasks), offer a **phased execution option**: "Should I execute in phases so you can review each one?"

---

## Tech Stack Defaults

When no explicit stack is specified, default to:
- **Runtime**: Node.js with TypeScript (strict mode)
- **Cloud**: AWS (ECS Fargate, Lambda, App Runner)
- **IaC**: AWS CDK v2 (TypeScript) — see `lib/` directory
- **AI/LLM**: LangGraph + AWS Bedrock (Claude 4.5 Sonnet)
- **Database**: DynamoDB (single-table design), RDS (PostgreSQL), Redis
- **Monitoring**: CloudWatch, X-Ray tracing
- **CI/CD**: AWS CodePipeline + CodeBuild
- **Container**: Docker + ECS Fargate

> These defaults reflect the Nucleus Cloud Ops stack. Override per-task as needed.

## AWS-Specific Constraints

- **Always use AWS SDK v3** (`@aws-sdk/client-*`) — never SDK v2
- **Cross-account ops**: Use `sts:AssumeRole` — never hardcode credentials
- **DynamoDB**: Follow single-table design in `docs/schema-design.md`
- **Audit logging**: Write to `DYNAMODB_AUDIT_TABLE_NAME` for all resource modifications
- **CDK changes**: Run `cdk diff` before modifying `lib/computeStack.ts` or `lib/networkingStack.ts`
- **Bedrock**: Model `anthropic.claude-3-5-sonnet-20241022-v2:0`, streaming enabled
- **Lambda**: 5 min timeout max, 512 MB memory minimum, use layers for shared deps

See `.kiro/steering/aws-best-practices.md` for comprehensive guidelines.