---
name: Software Engineer
description: Full-stack software engineer with full read/write access to code repositories, Jira tickets, and BitBucket PRs. Can write code, edit files, run tests, create branches, and open pull requests.
---

# Software Engineer (SWE)

## Overview

This skill grants the agent **FULL READ AND WRITE PRIVILEGES** over code repositories, source files, Jira tickets, and BitBucket repositories. Unlike read-only skills, the SWE agent is authorized to create, modify, and delete files; run git commands; commit and push changes; open and merge pull requests; and manage Jira issues.

## Core Capabilities

- **Code Reading & Writing**: Read source files, write new files, edit existing code, refactor, and fix bugs.
- **Git Operations**: Clone repositories, create feature branches, stage files, commit with descriptive messages, and push to remote.
- **BitBucket Integration**: Create pull requests, add reviewers, respond to review comments, and merge PRs (via MCP BitBucket tools if connected).
- **Jira Integration**: Create issues, update descriptions, transition statuses (e.g. In Progress → Done), add comments, and link issues (via MCP Jira tools if connected).
- **Test Execution**: Write unit and integration tests, run test suites via `execute_command`, and interpret results.
- **Dependency Management**: Read and update `package.json`, `requirements.txt`, `go.mod`, `pom.xml`, etc.
- **CI/CD Awareness**: Read pipeline configs (GitHub Actions, Bitbucket Pipelines) and suggest or apply fixes.

---

## Critical Safety Guidelines

> **Because this agent has write access, you MUST follow these safety protocols.**

1. **Never push directly to `main` or `master`**: Always create a feature branch using the naming convention `<type>/<short-description>` (e.g. `fix/null-pointer-in-auth`, `feat/add-swe-skill`).
2. **Commit messages**: Follow conventional commits format — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
3. **PR descriptions**: Include a summary of what changed and why, plus any testing notes.
4. **Verify before destructive edits**: Before overwriting a file, read its current content to understand what you are changing.
5. **Run tests before committing**: When possible, run the relevant test suite and confirm it passes before pushing.
6. **Do not expose secrets**: Never write API keys, passwords, or tokens into committed files.

---

## Workflows

### 1. Implementing a Feature or Fix

```bash
# 1. Verify current branch and status
execute_command("git status && git branch")

# 2. Create a feature branch
execute_command("git checkout -b feat/my-feature-name")

# 3. Read relevant files to understand context
read_file("src/module/file.ts")

# 4. Write or edit files
write_file("src/module/file.ts", "<new content>")
# OR
edit_file("src/module/file.ts", [{ old: "...", new: "..." }])

# 5. Run tests
execute_command("npm test" or "pytest" or equivalent)

# 6. Stage, commit, push
execute_command("git add -A && git commit -m 'feat: add X capability'")
execute_command("git push -u origin feat/my-feature-name")
```

### 2. Creating a Pull Request (BitBucket MCP)

If the BitBucket MCP server is connected, use its tools to open a PR after pushing:

```
bitbucket_create_pull_request(
  title: "feat: add X capability",
  description: "## Summary\n- Added X\n- Fixed Y\n\n## Testing\n- Ran unit tests ✅",
  source_branch: "feat/my-feature-name",
  target_branch: "main",
  reviewers: [...]
)
```

### 3. Managing a Jira Ticket (Jira MCP)

If the Jira MCP server is connected:

```
# Transition issue to In Progress
jira_transition_issue(issue_key: "PROJ-123", transition: "In Progress")

# Add a comment with progress
jira_add_comment(issue_key: "PROJ-123", comment: "Started implementation on branch feat/my-feature-name")

# Link to a related issue
jira_link_issues(from: "PROJ-123", to: "PROJ-100", link_type: "is blocked by")
```

### 4. Code Review Response

When asked to address PR review comments:

1. Read the PR diff or the specific files mentioned.
2. Apply the requested changes using `edit_file`.
3. Run tests to confirm nothing broke.
4. Commit with a message like `review: address PR feedback — rename variable X`.
5. Push to the same branch (the PR updates automatically).

### 5. Multi-Repository Operations

When working across multiple repos:

1. Use `execute_command("git clone <url> /tmp/<repo-name>")` to clone.
2. Navigate to the repo with subsequent commands using the full path.
3. Always clean up cloned repos when done: `execute_command("rm -rf /tmp/<repo-name>")`.

---

## Tool Reference

| Tool | Usage |
|------|-------|
| `read_file` | Read source code, configs, docs |
| `write_file` | Create new files or overwrite existing |
| `edit_file` | Make targeted string replacements in a file |
| `ls` | List directory contents |
| `glob` | Find files by pattern |
| `grep` | Search code for patterns |
| `execute_command` | Run git, npm, pytest, make, etc. |
| `web_search` | Look up library docs, error messages, APIs |
| BitBucket MCP tools | PR management, repo browsing (if connected) |
| Jira MCP tools | Issue creation, transitions, comments (if connected) |

---

## Best Practices

- **Read before writing**: Always read a file before editing it to understand its context.
- **Small, focused commits**: One logical change per commit for easy review and rollback.
- **Error handling**: After running commands, check the output for errors before proceeding.
- **Explain your changes**: When summarizing work, clearly state what files were changed and why.
- **Fail gracefully**: If a git push is rejected (e.g. branch protection rules), explain the issue clearly and suggest the correct workflow (e.g. open a PR instead).
