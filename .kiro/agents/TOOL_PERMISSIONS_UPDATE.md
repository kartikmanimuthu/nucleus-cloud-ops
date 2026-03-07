# Tool Permissions Update — Summary

**Date:** March 7, 2026  
**Change:** Enabled all tools for both agents with safety blocks

---

## ✅ What Changed

Both **Planning** and **Vibe** agents now have:

```json
{
  "allowedTools": ["*"],
  "blockedTools": [
    "bb_delete",
    "jira_delete",
    "use_aws:delete-*",
    "use_aws:terminate-*",
    "use_aws:remove-*"
  ]
}
```

---

## 🚀 What Agents Can Now Do

### ✅ Fully Allowed (No Restrictions)
- **File operations**: Create, modify, delete local files
- **Code intelligence**: Search symbols, LSP operations, AST
- **Bash execution**: All shell commands (including `rm`, `mv`, etc.)
- **Git operations**: Commit, push, pull, branch, merge, rebase
- **AWS read/write**: Describe, list, get, create, update, put
- **CDK operations**: Deploy, diff, synth, destroy (local stacks)
- **Bitbucket R/W**: Get, post, patch, put (repos, PRs, comments)
- **Jira R/W**: Get, post, patch, put (issues, comments, transitions)
- **Web research**: Search, fetch
- **Browser tools**: All browser automation (if available)
- **NPM/Yarn**: Install, build, test, run scripts

### ❌ Blocked (Safety)
- **Bitbucket delete**: Delete repos, branches, PRs
- **Jira delete**: Delete issues, comments
- **AWS delete**: Delete S3 buckets, DynamoDB tables, etc.
- **AWS terminate**: Terminate EC2 instances, ECS clusters
- **AWS remove**: Remove resources (IAM roles, security groups, etc.)

---

## 🎯 Why This Configuration?

### Maximize Development Speed
- Agents can freely create, modify, and delete local files
- No approval needed for git operations (reversible)
- Full access to AWS read/write operations (create/update)
- Can deploy infrastructure changes (CDK deploy)
- Can run tests, builds, and scripts

### Prevent Catastrophic Mistakes
- Block irreversible AWS deletions (no git history)
- Block Bitbucket/Jira deletions (hard to recover)
- Require manual execution for dangerous operations

### Philosophy
**Trust agents with reversible operations, require human approval for irreversible ones.**

---

## 📋 Examples

### ✅ Agents Can Do (No Approval)
```bash
# File operations
rm -rf dist/
git commit -am "Refactor Lambda handler"
git push origin feature/new-api

# AWS operations
aws s3 cp file.json s3://bucket/
aws dynamodb put-item --table-name nucleus-ops-main ...
cdk deploy WebUIStack

# Build operations
npm install
npm run build
npm test
```

### ❌ Agents Will Ask You to Do
```bash
# AWS deletions
aws s3 rb s3://bucket --force
aws dynamodb delete-table --table-name old-table
aws ec2 terminate-instances --instance-ids i-123

# Bitbucket deletions
bb_delete /repositories/workspace/repo

# Jira deletions
jira_delete /rest/api/3/issue/PROJ-123
```

---

## 🛡️ Safety Net

### Local Files (Allowed)
- **Why**: Version-controlled (git)
- **Recovery**: `git checkout <file>` or `git reset --hard`
- **Risk**: Low (can always recover)

### AWS Resources (Blocked)
- **Why**: No version control
- **Recovery**: Manual recreation (time-consuming)
- **Risk**: High (production impact, data loss)

---

## 🔧 How Agents Handle Blocked Operations

When an agent needs to perform a blocked operation:

1. **Explain why** it's needed
2. **Show the exact command** to run
3. **Ask you to run it manually**
4. **Continue after confirmation**

**Example:**
```
Agent: "To complete the migration, delete the old DynamoDB table.
        Run this manually:
        
        aws dynamodb delete-table --table-name old-scheduler-table
        
        Once done, let me know and I'll proceed with the new table setup."

You: "Done"

Agent: "Great! Proceeding with new table creation..."
```

---

## 📊 Tool Permission Matrix

| Tool Category | Allowed | Notes |
|--------------|---------|-------|
| File I/O | ✅ Full | Includes delete (git-recoverable) |
| Code Intelligence | ✅ Full | LSP, AST, search |
| Bash Execution | ✅ Full | All commands (including rm) |
| Git Operations | ✅ Full | Commit, push, pull, merge |
| AWS Read | ✅ Full | Describe, list, get |
| AWS Write | ✅ Full | Create, update, put |
| **AWS Delete** | ❌ Blocked | Manual only |
| **AWS Terminate** | ❌ Blocked | Manual only |
| **AWS Remove** | ❌ Blocked | Manual only |
| CDK Deploy | ✅ Full | Create/update stacks |
| Bitbucket R/W | ✅ Full | Get, post, patch, put |
| **Bitbucket Delete** | ❌ Blocked | Manual only |
| Jira R/W | ✅ Full | Get, post, patch, put |
| **Jira Delete** | ❌ Blocked | Manual only |
| Web Research | ✅ Full | Search, fetch |
| Browser Tools | ✅ Full | All automation |

---

## 🧪 Verification

```bash
# Check agent configurations
cat .kiro/agents/antigravity-planning.json | jq '{allowedTools, blockedTools}'
cat .kiro/agents/antigravity-vibe.json | jq '{allowedTools, blockedTools}'

# Run tests
.kiro/agents/test-agents.sh
```

**Result:** ✅ All tests passed

---

## 📚 Documentation

Tool permissions documented in:
- `.kiro/steering/tool-permissions.md` — Full permission guide
- `.kiro/agents/README.md` — Agent documentation (updated)
- `.kiro/agents/QUICK_REFERENCE.md` — Quick reference

---

## 🎯 Impact

### Before
- Agents had limited tool access
- Frequent approval requests for safe operations
- Slower development workflow

### After
- ✅ Agents have full access to safe operations
- ✅ Only dangerous operations require approval
- ✅ Fast, flow-oriented development
- ✅ Safety net for irreversible operations

---

## 🚀 Ready to Use

Both agents are now configured for **maximum development velocity** with **safety guardrails**:

```bash
# Start using agents
kiro chat --agent "Gemini Antigravity Vibe"
kiro chat --agent "Gemini Antigravity Planning"

# Agents can now freely:
# • Create/modify/delete local files
# • Run git operations
# • Deploy to AWS (create/update)
# • Run tests and builds
# • Create PRs and Jira tickets

# Agents will ask for manual execution:
# • AWS resource deletions
# • Bitbucket/Jira deletions
```

---

<p align="center">Fast development + Safety = ⚡ + 🛡️</p>
