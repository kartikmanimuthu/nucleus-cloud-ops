---
inclusion: always
name: tool-permissions
description: Tool permissions and safety guidelines for Kiro agents
---

# Tool Permissions & Safety Guidelines

## Allowed Tools (All Agents)

Both **Planning** and **Vibe** agents have access to **ALL tools** for fast local development:

### ✅ File Operations
- `fs_read` — Read files, directories, search
- `fs_write` — Create, modify, append files
- `glob` — Find files by pattern
- `grep` — Search text in files

### ✅ Code Intelligence
- `code` — Search symbols, lookup, AST operations
- All LSP operations (when initialized)

### ✅ Execution
- `execute_bash` — Run shell commands
- `use_aws` — AWS CLI operations (except delete/terminate)

### ✅ Git Operations
- All git commands via `execute_bash`
- Commit, push, pull, branch, merge

### ✅ API Operations
- `bb_get`, `bb_post`, `bb_patch`, `bb_put` — Bitbucket (read/write)
- `jira_get`, `jira_post`, `jira_patch`, `jira_put` — Jira (read/write)
- `web_search`, `web_fetch` — Web research

### ✅ Browser Operations (if available)
- All browser tools for testing and debugging

---

## 🚫 Blocked Tools (Safety)

The following operations are **blocked** to prevent accidental data loss:

### Bitbucket
- `bb_delete` — Delete repos, branches, PRs

### Jira
- `jira_delete` — Delete issues, comments

### AWS
- `use_aws:delete-*` — Delete resources (S3, DynamoDB, etc.)
- `use_aws:terminate-*` — Terminate instances, clusters
- `use_aws:remove-*` — Remove resources

---

## 🛡️ Safety Guidelines

### When Agents Need to Delete

If a task requires deletion, agents will:

1. **Explain the need** — Why deletion is necessary
2. **Show the command** — Exact command to run
3. **Ask for manual execution** — User runs it themselves

**Example:**
```
Agent: "To complete this task, you need to delete the old Lambda function.
        Run this command manually:
        
        aws lambda delete-function --function-name old-scheduler
        
        Once done, let me know and I'll proceed with the migration."
```

### File Deletions

File deletions via `fs_write` or `execute_bash rm` are **allowed** because:
- Local files are version-controlled (git)
- Easy to recover via `git checkout`
- Essential for refactoring workflows

### AWS Resource Deletions

AWS resource deletions are **blocked** because:
- Irreversible (no git history)
- Potential for production impact
- Requires explicit user intent

---

## 🚀 Development Speed Optimizations

### Agents Can Freely:
- ✅ Create/modify/delete local files
- ✅ Run tests and builds
- ✅ Deploy to AWS (create/update resources)
- ✅ Query AWS resources (describe, list, get)
- ✅ Commit and push to git
- ✅ Create PRs and Jira tickets
- ✅ Run CDK deploy/diff/synth
- ✅ Execute npm/yarn commands
- ✅ Modify infrastructure code

### Agents Will Ask Before:
- ⚠️ Deleting AWS resources
- ⚠️ Terminating running instances
- ⚠️ Removing production data

---

## 🔧 Customizing Permissions

To modify tool permissions, edit agent configs:

### Allow More Tools
```json
{
  "allowedTools": ["*"],
  "blockedTools": ["bb_delete", "jira_delete"]
}
```

### Restrict to Specific Tools
```json
{
  "allowedTools": ["fs_read", "fs_write", "execute_bash", "code"],
  "blockedTools": []
}
```

### Block Additional Tools
```json
{
  "allowedTools": ["*"],
  "blockedTools": [
    "bb_delete",
    "jira_delete",
    "use_aws:delete-*",
    "use_aws:terminate-*",
    "use_aws:remove-*",
    "execute_bash:rm -rf /"  // Example: block dangerous commands
  ]
}
```

---

## 📋 Tool Permission Matrix

| Tool Category | Planning Agent | Vibe Agent | Notes |
|--------------|----------------|------------|-------|
| File I/O | ✅ Full | ✅ Full | Includes delete |
| Code Intelligence | ✅ Full | ✅ Full | LSP, AST, search |
| Bash Execution | ✅ Full | ✅ Full | All commands |
| AWS Read | ✅ Full | ✅ Full | Describe, list, get |
| AWS Write | ✅ Full | ✅ Full | Create, update, put |
| AWS Delete | ❌ Blocked | ❌ Blocked | Manual only |
| Git Operations | ✅ Full | ✅ Full | All git commands |
| Bitbucket R/W | ✅ Full | ✅ Full | Get, post, patch, put |
| Bitbucket Delete | ❌ Blocked | ❌ Blocked | Manual only |
| Jira R/W | ✅ Full | ✅ Full | Get, post, patch, put |
| Jira Delete | ❌ Blocked | ❌ Blocked | Manual only |
| Web Research | ✅ Full | ✅ Full | Search, fetch |
| Browser Tools | ✅ Full | ✅ Full | If available |

---

## 🎯 Philosophy

**Maximize development velocity while preventing catastrophic mistakes.**

- **Trust agents** with reversible operations (files, git, create/update)
- **Require human approval** for irreversible operations (delete, terminate)
- **Optimize for flow** — agents should never be blocked on safe operations
- **Fail safe** — when in doubt, ask the user

---

## 🔍 Monitoring Tool Usage

Agents automatically log tool usage in audit trails. Review with:

```bash
# View recent agent actions
cat .kiro/chats/<chat-id>/messages.json | jq '.[] | select(.role == "assistant") | .tool_calls'

# Check for blocked tool attempts
grep "blocked_tool" .kiro/chats/<chat-id>/messages.json
```

---

## 🆘 Emergency Override

If you need an agent to perform a blocked operation:

1. **Temporarily allow the tool:**
   ```json
   // .kiro/agents/antigravity-vibe.json
   {
     "allowedTools": ["*"],
     "blockedTools": []  // Empty = allow all
   }
   ```

2. **Run the agent task**

3. **Restore safety blocks:**
   ```json
   {
     "allowedTools": ["*"],
     "blockedTools": ["bb_delete", "jira_delete", "use_aws:delete-*", ...]
   }
   ```

**Better approach:** Run the dangerous command manually and let the agent continue.

---

## 📚 Related Documentation

- [AWS Best Practices](.kiro/steering/aws-best-practices.md) — AWS-specific safety rules
- [Agent README](.kiro/agents/README.md) — Full agent documentation
- [Kiro CLI Docs](https://docs.kiro.ai) — Tool reference
