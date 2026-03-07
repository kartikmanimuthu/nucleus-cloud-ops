# Nucleus Cloud Ops — Kiro Custom Agents

This directory contains custom Kiro agents modeled after **Gemini Antigravity** workflows, optimized for AWS development on the Nucleus Cloud Ops platform.

---

## 🤖 Available Agents

### 1. **Gemini Antigravity Planning** (`antigravity-planning.json`)

**When to use:**
- Complex multi-step tasks (4+ files)
- Breaking changes to APIs or database schemas
- Infrastructure changes (CDK stacks, Lambda, ECS)
- Architecturally significant work (new services, data models, auth)
- Cross-team dependencies

**Workflow:**
1. **[PLAN ARTIFACT]** — Decomposed subtasks, file list, approach, risks
2. **Approval gate** — Wait for explicit "go ahead"
3. **[CODE ARTIFACT]** — Implementation with full file paths
4. **[VALIDATION ARTIFACT]** — Test commands, expected output, pass/fail
5. **[SUMMARY ARTIFACT]** — What was built, files changed, follow-ups

**Key features:**
- Thorough upfront planning with approval gates
- Artifact-driven workflow (plan → code → validate → summarize)
- Parallelism awareness (flags independent subtasks)
- Transparent decision-making (annotates trade-offs)
- End-to-end validation pass with bug self-correction

**Invoke with:**
```bash
kiro chat --agent "Gemini Antigravity Planning"
```

---

### 2. **Gemini Antigravity Vibe** (`antigravity-vibe.json`)

**When to use:**
- Quick feature additions (< 4 files)
- Single-purpose tasks (add endpoint, fix bug, update UI)
- Well-scoped work with clear requirements
- Iterative development in flow state

**Workflow:**
1. **[INTENT]** — One sentence: what you're building and approach
2. **[CODE]** — Implementation (no approval gate)
3. **[DONE]** — 2–3 line summary: what was built, files changed, how to test

**Key features:**
- Bias toward action (state assumption and proceed)
- Minimal ceremony (no lengthy planning docs)
- Self-correct silently (fix bugs during implementation)
- Keep user unblocked (do 80%, flag 20% if unsure)
- Auto-escalate to planning mode for complex tasks

**Invoke with:**
```bash
kiro chat --agent "Gemini Antigravity Vibe"
```

---

## 🏗️ AWS Best Practices (Built-in)

Both agents automatically follow AWS best practices for Nucleus Cloud Ops:

### Security & IAM
- ✅ Always use `sts:AssumeRole` for cross-account operations
- ✅ Least-privilege IAM policies
- ✅ Session tags for audit trail
- ✅ Secrets in AWS Secrets Manager / SSM Parameter Store

### DynamoDB
- ✅ Single-table design (consult `docs/schema-design.md`)
- ✅ Composite keys (PK + SK)
- ✅ Query optimization (`KeyConditionExpression` over `FilterExpression`)
- ✅ Audit logging to `DYNAMODB_AUDIT_TABLE_NAME`

### Lambda
- ✅ 5 min timeout max, 512 MB memory minimum
- ✅ AWS SDK v3 only (`@aws-sdk/client-*`)
- ✅ Lambda layers for shared dependencies
- ✅ Exponential backoff for retries

### AI Agent (LangGraph + Bedrock)
- ✅ Model: `anthropic.claude-3-5-sonnet-20241022-v2:0`
- ✅ Streaming enabled for chat UI
- ✅ Checkpoint management in DynamoDB (7-day TTL)
- ✅ Tool execution timeout: 30s per call

### CDK Infrastructure
- ✅ Run `cdk diff` before modifying stacks
- ✅ Tag all resources: `Project: nucleus-ops`, `Environment: prod|dev`
- ✅ Blue-green deployments for ECS services
- ✅ CloudWatch alarms for critical metrics

See `.kiro/steering/aws-best-practices.md` for comprehensive guidelines.

---

## 📂 Steering Files

Agents reference these steering files for context:

| File | Purpose |
|------|---------|
| `aws-best-practices.md` | AWS-specific patterns (IAM, DynamoDB, Lambda, Bedrock) |
| `antigravity-planning-workflow.md` | Planning mode lifecycle and artifact templates |
| `antigravity-vibe-workflow.md` | Vibe mode principles and escalation rules |
| `structure.md` | Project directory structure |
| `tech.md` | Technology stack and coding conventions |
| `product.md` | Product overview and agent architecture |

---

## 🎯 Quick Decision Guide

**Use Planning Mode when:**
- Task touches 4+ files
- Breaking changes to APIs or schemas
- Infrastructure changes (CDK, Lambda, ECS)
- Architecturally significant work
- Cross-team dependencies

**Use Vibe Mode when:**
- Task touches < 4 files
- Single-purpose feature or bug fix
- Well-scoped requirements
- Iterative development

**Vibe Mode auto-escalates to Planning Mode** when it detects complexity.

---

## 🚀 Usage Examples

### Planning Mode Example
```bash
# Complex task: Add multi-region support to scheduler
kiro chat --agent "Gemini Antigravity Planning"

User: "Add multi-region support to the scheduler Lambda with failover"
Agent: [PLAN ARTIFACT] → Awaiting approval...
User: "Looks good, proceed"
Agent: [CODE ARTIFACT — Subtask 1/4] → ...
```

### Vibe Mode Example
```bash
# Quick task: Add new API endpoint
kiro chat --agent "Gemini Antigravity Vibe"

User: "Add GET /api/schedules/:id/history endpoint"
Agent: [INTENT] Fetching schedule execution history from DynamoDB audit table
       [CODE — web-ui/app/api/schedules/[id]/history/route.ts] → ...
       [DONE] Built: Schedule history endpoint. Test: curl localhost:3000/api/schedules/sch-123/history
```

---

## 🔧 Customization

To modify agent behavior:

1. **Edit agent config** (`.kiro/agents/*.json`):
   - Change model: `"model": "claude-3-5-sonnet-latest"`
   - Add resources: `"resources": ["file://path/to/doc.md"]`
   - Toggle MCP: `"includeMcpJson": true|false`

2. **Edit steering files** (`.kiro/steering/*.md`):
   - Update workflows, best practices, or tech stack defaults
   - Changes apply to all agents referencing the file

3. **Test changes**:
   ```bash
   kiro chat --agent "Gemini Antigravity Vibe"
   ```

---

## 📚 Additional Resources

- [Kiro CLI Documentation](https://docs.kiro.ai)
- [Nucleus Cloud Ops Architecture](../../docs/ARCHITECTURE.md)
- [DynamoDB Schema Design](../../docs/schema-design.md)
- [AWS CDK Best Practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)

---

<p align="center">Built for fast, flow-oriented AWS development ⚡</p>
