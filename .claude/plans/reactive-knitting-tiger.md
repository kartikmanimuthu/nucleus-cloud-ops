# Refactoring Plan: Agent System Prompts & Skills

## Context

The Nucleus Cloud Ops AI agent is built for **DevOps/CloudOps engineers** doing day-to-day operational problem solving — not developers. The **planning-agent** and **fast-agent** are one logical unit (same UX, same functionality, different execution strategies). Currently they suffer from massive prompt duplication, overlapping skills, missing operational patterns (parallel execution, incident triage), and verbose prompts wasting context tokens.

**Scope:** planning-agent.ts + fast-agent.ts + skills. Deep-agent.ts is excluded (being eliminated).

---

## 1. Extract Shared Prompt Templates → `prompt-templates.ts`

**New file:** `web-ui/lib/agent/prompt-templates.ts`

Both [planning-agent.ts](web-ui/lib/agent/planning-agent.ts) and [fast-agent.ts](web-ui/lib/agent/fast-agent.ts) duplicate these blocks:

| Duplicated Block | planning-agent.ts | fast-agent.ts |
|---|---|---|
| Skill loading + effectiveSkillSection | L43-75 | L38-70 |
| Account context builder | L115-148 | L104-130 |
| Base identity string | L151-153 | L141-143 |
| AWS CLI standards | L295-307 | L149-156 |
| Tool description lists | L195-206, L311-322 | L146 |
| Model initialization | L78-94 | L73-89 |
| Tool assembly + MCP wiring | L96-112 | L92-102 |

### Functions to export:

```typescript
// Identity & context builders
buildBaseIdentity(selectedSkill?)                      → ops-focused identity string
buildEffectiveSkillSection(selectedSkill?)              → skill content or base mode fallback
buildAccountContext({ accounts?, accountId?, accountName? }) → credential workflow string
buildAwsCliStandards()                                 → CLI conventions (--output json, --profile, pagination, BSD date)
buildReportStrategy()                                  → report generation guidance (prefer S3)

// NEW prompt content
buildAutoApproveGuidance(autoApprove: boolean)         → parallel vs sequential execution mode
buildOperationalWorkflows()                            → incident triage, rollback, health check, capacity review
CORE_PRINCIPLES                                        → const with 5 core operating principles
```

### `buildBaseIdentity()` — sharpen the ops identity:

Currently defined with slightly different wording in 2 places. Consolidate to one version that emphasizes **operator, not advisor**:

```
"You are a senior DevOps and Cloud Operations engineer. You are the primary operator — not an
advisor. When asked to do something, you do it directly using tools. You have deep, hands-on
expertise across AWS (EC2, ECS, EKS, RDS, S3, Lambda, IAM, VPC, CloudWatch, SSM, Cost Explorer,
and more), Terraform, Ansible, Docker, Kubernetes, CI/CD pipelines, and shell scripting."
```

### `buildAutoApproveGuidance(autoApprove)` — NEW:

**When `autoApprove = true`:**
- Tool calls execute immediately — optimize for throughput
- Run independent queries in parallel (e.g., describe instances across multiple accounts simultaneously)
- Chain multi-step sequences without pausing — execute, verify, proceed
- Safety checks still apply (verify before mutate)

**When `autoApprove = false`:**
- Every tool call pauses for human approval — optimize for clarity
- Execute ONE tool call at a time so the user can review each action
- Before each call, explain what you're about to do and why
- For mutations, present the exact command + expected impact before requesting approval

### `CORE_PRINCIPLES` — NEW:

```
1. Use AWS CLI for everything — default to `aws` CLI for all AWS operations.
2. Verify before mutating — always describe/list current state before create/update/delete.
3. Be specific — include resource IDs, account names, regions, numeric values.
4. Fail forward — if a command fails, diagnose root cause and attempt correction.
5. Minimize prompt overhead — lead with action or finding, don't restate the question.
```

### `buildOperationalWorkflows()` — NEW:

Common ops patterns currently missing from all prompts:

- **Incident Triage** ("X is down"): identify service → get creds → check health → check CloudWatch metrics (1hr) → check logs (30min) → check stopped reasons → report severity (CRITICAL/HIGH/MEDIUM)
- **Deployment Rollback**: identify service → find previous task def/launch template → revert → verify health
- **Health Check / Status Review** ("how is X doing"): get creds → check service status → pull key metrics (CPU, memory, errors, latency) → check recent events → summarize healthy/degraded/critical
- **Capacity Review**: describe ASG/ECS config (desired, min, max, running) → pull 7-day utilization → identify peaks and headroom → recommend with specific numbers

---

## 2. Extract Model & Tool Factory → `model-factory.ts`

**New file:** `web-ui/lib/agent/model-factory.ts`

Consolidates model initialization and tool assembly duplicated in planning-agent.ts and fast-agent.ts:

```typescript
interface AgentModels {
  main: ChatBedrockConverse;     // maxTokens 4096, streaming, temp 0
  reflector: ChatBedrockConverse; // maxTokens 1024, non-streaming, temp 0
}

createAgentModels(modelId: string): AgentModels
assembleTools(mcpServerIds?: string[], opts?: { includeS3Tools?: boolean }): Promise<DynamicStructuredTool[]>
```

- planning-agent includes S3 tools (writeFileToS3, getFileFromS3); fast-agent does not → controlled via `includeS3Tools` option
- MCP tool discovery happens once in `assembleTools()` instead of duplicated in each factory

---

## 3. Refactor Planning Agent

**File:** [planning-agent.ts](web-ui/lib/agent/planning-agent.ts)

### Replace with imports:
- L43-75 (skill loading) → `buildEffectiveSkillSection(selectedSkill)`
- L78-94 (model init) → `createAgentModels(modelId)`
- L96-112 (tool assembly + MCP) → `assembleTools(mcpServerIds, { includeS3Tools: true })`
- L115-148 (account context) → `buildAccountContext({ accounts, accountId, accountName })`
- L151-153 (baseIdentity) → `buildBaseIdentity(selectedSkill)`

### Remove redundant content:
- **Planner prompt L195-206** (tool description list) — LangChain `bindTools()` already provides tool schemas to the model. Replace with: `"You have access to the tools described in your tool schemas."`
- **Executor prompt L311-322** (tool description list) — same reason, remove
- **Reviser prompt L628** (tool list) — same reason, remove
- **L107-109** (`getMCPToolsDescription` usage) — redundant with `bindTools()`, remove

### Add new content:
- `CORE_PRINCIPLES` → inject into planner and executor system prompts
- `buildAutoApproveGuidance(autoApprove)` → inject into executor system prompt
- `buildOperationalWorkflows()` → inject into executor system prompt only (planner doesn't execute)

### Keep inline (node-specific):
- Planner: planning methodology (Phase 1/2/3), plan step rules, JSON array output format
- Executor: "execute exactly the current step", plan status display, execution discipline
- Reflector: 5-dimension review criteria, completion criteria, JSON output format
- Reviser: revision approach, issue addressing strategy
- Final: summary writing instructions

---

## 4. Refactor Fast Agent

**File:** [fast-agent.ts](web-ui/lib/agent/fast-agent.ts)

### Replace with imports:
- L38-70 (skill loading) → `buildEffectiveSkillSection(selectedSkill)`
- L73-89 (model init) → `createAgentModels(modelId)`
- L92-102 (tool assembly + MCP) → `assembleTools(mcpServerIds)`
- L104-130 (account context) → `buildAccountContext({ accounts, accountId, accountName })`
- L141-143 (baseIdentity inside agentNode) → `buildBaseIdentity(selectedSkill)`

### Remove redundant content:
- **Agent prompt L146** (inline tool list) — remove, covered by `bindTools()`
- **Agent prompt L149-156** (inline AWS CLI standards) — replace with `buildAwsCliStandards()`

### Add new content:
- `CORE_PRINCIPLES` → inject into agent system prompt
- `buildAutoApproveGuidance(autoApprove)` → inject into agent system prompt
- `buildOperationalWorkflows()` → inject into agent system prompt

### Keep inline (node-specific):
- Agent: conversation continuity, response discipline
- Reflector: 5-dimension critique, COMPLETE signal logic

---

## 5. Skill Consolidation

### 5a. Merge cost-optimization + finops → `cost-analysis`

**Create:** `web-ui/lib/agent/skills/cost-analysis/SKILL.md`

Content merged from:
- [cost-optimization/SKILL.md](web-ui/lib/agent/skills/cost-optimization/SKILL.md) — Cost Explorer workflows, EC2/RDS/EBS analysis, anomaly detection, report template, scheduler ROI
- [finops/SKILL.md](web-ui/lib/agent/skills/finops/SKILL.md) — RI/SP coverage analysis, budgeting & forecasting, cost allocation & tagging, unit economics

```yaml
---
name: Cost Analysis & FinOps
description: Analyze existing AWS spend, identify optimization opportunities, RI/SP coverage, budgeting, and forecasting.
tier: read-only
---
```

**Delete after merge:** `cost-optimization/` and `finops/` directories

### 5b. Merge swe into swe-devops

**Edit:** [swe-devops/SKILL.md](web-ui/lib/agent/skills/swe-devops/SKILL.md)

Absorb from [swe/SKILL.md](web-ui/lib/agent/skills/swe/SKILL.md):
- Feature implementation workflow (branch → code → test → commit → PR)
- Code review patterns
- Dependency management

Keep swe-devops's approval-gate safety model for all mutations.

**Delete after merge:** `swe/` directory

### 5c. Update devops skill

**Edit:** [devops/SKILL.md](web-ui/lib/agent/skills/devops/SKILL.md)

- Update display name to "Live Operations"
- Add scope clarification: "For direct, immediate infrastructure mutations. For IaC-based changes (Terraform apply, Ansible runs), use the SWE DevOps skill."

### 5d. Add `tier` frontmatter to all skills

Add `tier: read-only | mutation | approval-gated` to every SKILL.md:

| Skill | Tier |
|---|---|
| devops | `mutation` |
| cost-analysis | `read-only` |
| cost-estimator | `read-only` |
| debugging | `read-only` |
| swe-devops | `approval-gated` |
| security-analysis | `read-only` |
| network-ops | `read-only` |
| general-questionnaire | `read-only` |

### 5e. Fix GNU date syntax in skills

The `cost-optimization` SKILL.md (and its merged successor) uses `date -d '30 days ago'` which is GNU Linux syntax and fails on macOS. Update all CLI examples to BSD syntax:
- `date -v-30d +%Y-%m-%d` (30 days ago)
- `date -v-7d +%Y-%m-%d` (7 days ago)
- Or use python3 for portability

Also update `cost-optimization` L294: change "Use write_file tool" → "Use write_file_to_s3 tool"

### Final skill catalog (8 skills, down from 10):

| # | ID | Display Name | Tier |
|---|---|---|---|
| 1 | `devops` | Live Operations | mutation |
| 2 | `cost-analysis` | Cost Analysis & FinOps | read-only |
| 3 | `cost-estimator` | Cost Estimator | read-only |
| 4 | `debugging` | Debugging & Troubleshooting | read-only |
| 5 | `swe-devops` | Software & Infrastructure Engineering | approval-gated |
| 6 | `security-analysis` | Security Audit | read-only |
| 7 | `network-ops` | Network Operations | read-only |
| 8 | `general-questionnaire` | General Q&A | read-only |

---

## 6. Update Skill Loader

**File:** [skill-loader.ts](web-ui/lib/agent/skills/skill-loader.ts)

- Add `tier: 'read-only' | 'mutation' | 'approval-gated'` to `SkillMetadata` and `SkillFrontmatter`
- Parse `tier` from YAML frontmatter in `parseSkillFile()`
- Add backward-compat alias map:
  ```typescript
  const SKILL_ALIASES: Record<string, string> = {
    'cost-optimization': 'cost-analysis',
    'finops': 'cost-analysis',
    'swe': 'swe-devops',
  };
  ```
- Apply aliases in `getSkillContent()` and `getSkillById()` before path resolution
- Update `getSkillSummaries()` to include tier badge in output

---

## 7. Files Changed Summary

| File | Action |
|---|---|
| `web-ui/lib/agent/prompt-templates.ts` | **CREATE** — shared prompt builder functions |
| `web-ui/lib/agent/model-factory.ts` | **CREATE** — model init + tool assembly factory |
| `web-ui/lib/agent/planning-agent.ts` | **EDIT** — replace inline prompts with imports, add new guidance |
| `web-ui/lib/agent/fast-agent.ts` | **EDIT** — replace inline prompts with imports, add new guidance |
| `web-ui/lib/agent/skills/skill-loader.ts` | **EDIT** — add tier parsing, alias map |
| `web-ui/lib/agent/skills/cost-analysis/SKILL.md` | **CREATE** — merged from cost-optimization + finops |
| `web-ui/lib/agent/skills/cost-optimization/` | **DELETE** (merged) |
| `web-ui/lib/agent/skills/finops/` | **DELETE** (merged) |
| `web-ui/lib/agent/skills/swe/` | **DELETE** (merged into swe-devops) |
| `web-ui/lib/agent/skills/swe-devops/SKILL.md` | **EDIT** — absorb swe code workflows |
| `web-ui/lib/agent/skills/devops/SKILL.md` | **EDIT** — update display name + scope |
| All remaining SKILL.md files | **EDIT** — add `tier` frontmatter, fix date syntax |

**NOT touched:** `deep-agent.ts` (being eliminated), `agent-shared.ts` (unchanged)

---

## 8. Verification

- `cd web-ui && npm run build` — TypeScript compiles
- `cd web-ui && npm run lint` — no new errors
- `cd web-ui && npm run test` — all Vitest tests pass
- Manual: planning-agent + devops skill + autoApprove=true → verify parallel execution guidance in prompt
- Manual: fast-agent + no skill + autoApprove=false → verify sequential HITL guidance in prompt
- Manual: select deprecated skill ID `cost-optimization` → verify alias resolves to `cost-analysis`
- Grep for remaining inline account context / tool description blocks → should find none outside prompt-templates.ts
