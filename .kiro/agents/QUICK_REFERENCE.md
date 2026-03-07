# Kiro Agent Quick Reference

## 🚀 Invoke Agents

```bash
# Planning Mode (thorough, artifact-driven)
kiro chat --agent "Gemini Antigravity Planning"

# Vibe Mode (fast, minimal ceremony)
kiro chat --agent "Gemini Antigravity Vibe"

# List all agents
kiro chat --list-agents
```

---

## 🎯 When to Use Which

| Scenario | Agent | Why |
|----------|-------|-----|
| Add new API endpoint | **Vibe** | Single file, clear scope |
| Fix bug in Lambda | **Vibe** | Isolated change |
| Update UI component | **Vibe** | < 4 files |
| Add multi-region support | **Planning** | Infrastructure change |
| Refactor DynamoDB schema | **Planning** | Breaking change |
| New authentication system | **Planning** | Architecturally significant |
| Add CDK stack | **Planning** | Infrastructure as code |

---

## ⚡ Vibe Mode Cheat Sheet

**Workflow:**
```
[INTENT] → [CODE] → [DONE]
```

**Principles:**
- State assumption and proceed (don't ask for clarification)
- One-liner intent, full implementation, 2-line summary
- Self-correct bugs silently
- Auto-escalate to Planning Mode if complex (4+ files)

**Example:**
```
User: "Add rate limiting to Bedrock API calls"

[INTENT]
Token bucket rate limiter (10 req/sec) using Redis
Assumption: ElastiCache Redis already configured

[CODE — web-ui/lib/rate-limiter.ts]
<implementation>

[DONE]
Built : Rate limiter with Redis backend
Files : web-ui/lib/rate-limiter.ts, web-ui/app/api/agent/route.ts
Test : curl -X POST localhost:3000/api/agent (should 429 after 10 req/sec)
```

---

## 🧭 Planning Mode Cheat Sheet

**Workflow:**
```
[PLAN] → Approval → [CODE] → [VALIDATION] → [SUMMARY]
```

**Principles:**
- Never code before plan approval
- Artifact at every stage
- Flag parallelizable subtasks
- Transparent decision-making
- End-to-end validation pass

**Example:**
```
User: "Add multi-account cost reporting dashboard"

[PLAN ARTIFACT]
Task : Multi-account cost reporting dashboard
Goal : Aggregate cost data from N accounts and display in UI

Subtasks:
1. Lambda function to fetch Cost Explorer data via AssumeRole
2. DynamoDB table for cost cache (TTL 24h)
3. API endpoint GET /api/costs/summary
4. React dashboard component with charts

Files to create:
- lambda/cost-reporter/index.ts
- web-ui/app/api/costs/summary/route.ts
- web-ui/components/dashboard/CostReportingCard.tsx

Parallelizable: Yes — subtasks 1 and 4 can run concurrently

Approach: Use AWS Cost Explorer API with 7-day lookback...
Key decisions: Caching in DynamoDB to avoid Cost Explorer rate limits...
Risks: Cost Explorer API has 5 req/sec limit per account...

→ Awaiting your approval to proceed. Any changes before I start?

User: "Looks good, go ahead"

[CODE ARTIFACT — Subtask 1/4]
...
```

---

## 🔍 AWS Quick Checks (Both Agents)

Before coding, agents verify:
- ✅ Using AWS SDK v3 (`@aws-sdk/client-*`)
- ✅ Cross-account = `sts:AssumeRole`
- ✅ DynamoDB schema matches `docs/schema-design.md`
- ✅ Audit log for resource modifications
- ✅ CDK changes? Run `cdk diff` first

---

## 📋 Common Commands

```bash
# Start chat with agent
kiro chat --agent "Gemini Antigravity Vibe"

# Continue previous conversation
kiro chat --continue

# List all agents
kiro chat --list-agents

# View agent config
cat .kiro/agents/antigravity-vibe.json

# Edit steering files
vim .kiro/steering/aws-best-practices.md
```

---

## 🛠️ Troubleshooting

**Agent not following AWS best practices?**
- Check `.kiro/steering/aws-best-practices.md` is present
- Verify agent config includes `"resources": ["file://.kiro/steering/**/*.md"]`

**Vibe Mode not escalating to Planning Mode?**
- Explicitly request: "Use planning mode for this"
- Or invoke Planning Mode agent directly

**Agent missing project context?**
- Add to agent config: `"resources": ["file://docs/ARCHITECTURE.md"]`
- Ensure steering files are up to date

---

## 📚 Learn More

- [Full Agent Documentation](.kiro/agents/README.md)
- [AWS Best Practices](.kiro/steering/aws-best-practices.md)
- [Project Architecture](docs/ARCHITECTURE.md)
- [Kiro CLI Docs](https://docs.kiro.ai)
