# Getting Started with Kiro Custom Agents

Quick start guide for using Gemini Antigravity agents in Nucleus Cloud Ops.

---

## 🚀 Quick Start (30 seconds)

```bash
# 1. Verify agents are installed
kiro chat --list-agents

# 2. Run tests
.kiro/agents/test-agents.sh

# 3. Start using an agent
kiro chat --agent "Gemini Antigravity Vibe"
```

---

## 📖 5-Minute Tutorial

### Example 1: Quick Feature (Vibe Mode)

**Task:** Add a new API endpoint to fetch schedule history

```bash
$ kiro chat --agent "Gemini Antigravity Vibe"

You: Add GET /api/schedules/:id/history endpoint that returns execution history from audit logs

Agent:
[INTENT]
Fetching schedule execution history from DynamoDB audit table
Assumption: Audit table has scheduleId in SK, using GSI for query

[CODE — web-ui/app/api/schedules/[id]/history/route.ts]
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { NextResponse } from 'next/server';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const client = new DynamoDBClient({ region: process.env.AWS_REGION });
  
  const command = new QueryCommand({
    TableName: process.env.DYNAMODB_AUDIT_TABLE_NAME,
    IndexName: 'ResourceIndex',
    KeyConditionExpression: 'resourceId = :scheduleId',
    ExpressionAttributeValues: {
      ':scheduleId': { S: params.id }
    },
    ScanIndexForward: false,
    Limit: 50
  });

  const result = await client.send(command);
  return NextResponse.json({ history: result.Items });
}

[DONE]
Built : Schedule history endpoint with DynamoDB query
Files : web-ui/app/api/schedules/[id]/history/route.ts
Test : curl http://localhost:3000/api/schedules/sch-123/history
Note : Returns last 50 executions, add pagination if needed
```

**Time:** ~2 minutes  
**Files changed:** 1  
**Approval needed:** No

---

### Example 2: Complex Feature (Planning Mode)

**Task:** Add multi-region failover for scheduler Lambda

```bash
$ kiro chat --agent "Gemini Antigravity Planning"

You: Add multi-region failover for scheduler Lambda with automatic failover to secondary region

Agent:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[PLAN ARTIFACT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task : Multi-region failover for scheduler Lambda
Goal : Deploy scheduler to primary + secondary region with automatic failover

Subtasks:
1. Create CDK stack for secondary region (ap-southeast-1)
2. Add Route 53 health check for primary Lambda
3. Add EventBridge rule in secondary region (disabled by default)
4. Add Lambda function to enable secondary EventBridge on failover
5. Update DynamoDB table to global table (multi-region replication)
6. Add CloudWatch alarm for failover trigger

Files to create:
- lib/schedulerFailoverStack.ts
- lambda/failover-manager/index.ts

Files to modify:
- lib/cdkStack.ts (add global table config)
- lambda/scheduler/index.ts (add region awareness)

Parallelizable: Yes — subtasks 1 and 5 can run concurrently

Approach:
- Use Route 53 health checks to monitor primary Lambda
- On failure, trigger SNS → Lambda → enable secondary EventBridge
- DynamoDB global table ensures data consistency
- Secondary region reads from same table, no data migration needed

Key decisions:
- Using Route 53 over custom health check for AWS-native monitoring
- EventBridge in secondary region stays disabled to prevent duplicate executions
- Failover Lambda in secondary region to avoid cross-region dependencies

Risks / side effects:
- DynamoDB global table increases costs (~2x write capacity)
- Failover time: ~2-3 minutes (Route 53 health check interval)
- Potential for duplicate executions during failover window

Assumptions:
- Primary region: ap-south-1 (existing)
- Secondary region: ap-southeast-1 (new)
- RPO: 0 (no data loss), RTO: 3 minutes

→ Awaiting your approval to proceed. Any changes before I start?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You: Looks good, but use ap-northeast-1 for secondary region instead

Agent:
Updated plan: Secondary region → ap-northeast-1
Proceeding with implementation...

[CODE ARTIFACT — Subtask 1/6]
File: lib/schedulerFailoverStack.ts
Action: create
...
```

**Time:** ~15-20 minutes  
**Files changed:** 4  
**Approval needed:** Yes (before coding)

---

## 🎯 Choosing the Right Agent

### Use **Vibe Mode** for:
- ✅ Adding a new API endpoint
- ✅ Fixing a bug in existing code
- ✅ Updating a UI component
- ✅ Adding a new utility function
- ✅ Modifying configuration files

### Use **Planning Mode** for:
- ✅ Adding multi-region support
- ✅ Refactoring database schema
- ✅ Implementing new authentication system
- ✅ Adding new CDK stack
- ✅ Breaking changes to APIs

---

## 🔧 Common Commands

```bash
# List available agents
kiro chat --list-agents

# Start chat with specific agent
kiro chat --agent "Gemini Antigravity Vibe"
kiro chat --agent "Gemini Antigravity Planning"

# Continue previous conversation
kiro chat --continue

# View agent configuration
cat .kiro/agents/antigravity-vibe.json

# Run agent tests
.kiro/agents/test-agents.sh

# View documentation
cat .kiro/agents/README.md
cat .kiro/agents/QUICK_REFERENCE.md
```

---

## 💡 Pro Tips

### 1. Let Vibe Mode Escalate
Don't overthink which agent to use. Start with Vibe Mode — it will auto-escalate to Planning Mode if needed.

```bash
You: "Add multi-region support"
Agent: "This one's bigger than a vibe — want me to switch to planning mode?"
```

### 2. Provide Context
Give agents context about your intent:

```bash
# ❌ Vague
"Add caching"

# ✅ Clear
"Add Redis caching to the Bedrock API calls with 5-minute TTL"
```

### 3. Review Plans Before Approval
In Planning Mode, always review the plan artifact:
- Check file list (are all necessary files included?)
- Review approach (does it align with your architecture?)
- Verify risks (are there any deal-breakers?)

### 4. Use Inline Feedback
You can modify plans without restarting:

```bash
Agent: [PLAN ARTIFACT] ...
You: "Keep subtasks 1-3 but change subtask 4 to use SQS instead of SNS"
Agent: Updated plan, proceeding...
```

### 5. Check AWS Best Practices
Agents automatically enforce AWS best practices, but you can review them:

```bash
cat .kiro/steering/aws-best-practices.md
```

---

## 🐛 Troubleshooting

### Agent not following AWS patterns?
```bash
# Verify steering files exist
ls -la .kiro/steering/

# Check agent config
cat .kiro/agents/antigravity-vibe.json

# Ensure resources include steering files
jq '.resources' .kiro/agents/antigravity-vibe.json
```

### Agent missing project context?
```bash
# Add architecture docs to agent config
jq '.resources += ["file://docs/ARCHITECTURE.md"]' \
  .kiro/agents/antigravity-vibe.json > tmp.json && \
  mv tmp.json .kiro/agents/antigravity-vibe.json
```

### Vibe Mode not escalating?
Explicitly request Planning Mode:
```bash
You: "Use planning mode for this task"
```

Or invoke Planning Mode agent directly:
```bash
kiro chat --agent "Gemini Antigravity Planning"
```

---

## 📚 Next Steps

1. **Read the full documentation**
   ```bash
   cat .kiro/agents/README.md
   ```

2. **Review AWS best practices**
   ```bash
   cat .kiro/steering/aws-best-practices.md
   ```

3. **Try a simple task with Vibe Mode**
   ```bash
   kiro chat --agent "Gemini Antigravity Vibe"
   ```

4. **Try a complex task with Planning Mode**
   ```bash
   kiro chat --agent "Gemini Antigravity Planning"
   ```

5. **Customize agents for your workflow**
   - Edit `.kiro/agents/*.json` for agent config
   - Edit `.kiro/steering/*.md` for best practices

---

## 🎓 Learning Resources

| Resource | Description |
|----------|-------------|
| `.kiro/agents/README.md` | Full agent documentation |
| `.kiro/agents/QUICK_REFERENCE.md` | Quick reference card |
| `.kiro/agents/WORKFLOW_DIAGRAM.md` | Visual workflow diagrams |
| `.kiro/steering/aws-best-practices.md` | AWS patterns and rules |
| `docs/ARCHITECTURE.md` | Project architecture |
| `docs/schema-design.md` | DynamoDB schema |

---

## 🤝 Getting Help

1. **Check documentation first**
   - `.kiro/agents/README.md` — comprehensive guide
   - `.kiro/agents/QUICK_REFERENCE.md` — quick answers

2. **Run tests to verify setup**
   ```bash
   .kiro/agents/test-agents.sh
   ```

3. **Review examples in this guide**
   - Vibe Mode example (simple task)
   - Planning Mode example (complex task)

4. **Experiment with simple tasks**
   - Start with Vibe Mode for quick iterations
   - Graduate to Planning Mode for complex work

---

<p align="center">Happy coding! ⚡</p>
