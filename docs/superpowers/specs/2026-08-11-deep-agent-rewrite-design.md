# Deep Agent Rewrite — Design

Branch: `feature/deep-agent-rewrite`
Date: 2026-08-11

---

## MANDATORY WORKING RULE

**Before asking the user any question, check the docs first.**

The deepagents documentation and the installed type definitions are the source of truth.
A question is only allowed after confirming the docs do not already answer it.

- Docs: https://docs.langchain.com/oss/javascript/deepagents/overview (and all subpages)
- Extracted reference: `docs/research/deepagents-js-api.md`
- Ground-truth types: `node_modules/deepagents/dist/agent-DURA4_mf.d.ts`
- Ground-truth runtime: `node_modules/deepagents/dist/langsmith-wdF8zG42.js`

**No invented code.** Use what the framework and docs provide. Do not hand-roll abstractions
(custom backends, custom middleware, custom protocols) when a documented option exists.
Glue at the API-route boundary is the only place new code is acceptable, and only where no
documented mechanism covers it.

Two questions in this session were answered by the docs, not by the user, after this rule
was applied retroactively:
- *Is summarization opt-in?* → No. `createSummarizationMiddleware` is unconditional in the
  bare stack (`langsmith-wdF8zG42.js`), triggers at 85% of `max_input_tokens`.
- *How should todos render?* → Docs prescribe `stream.values?.todos`. The existing plan rail
  already is that component; mapping is a field rename.

---

## Scope

Rewrite `apps/web-ui/lib/agent/deep-agent.ts` against the current deepagents API.

**Explicitly out of scope — do not touch:**
- `lib/agent/fast-agent.ts` — Fast mode keeps its current graph
- `lib/agent/planning-agent.ts` — Plan & Execute keeps its current graph
- `lib/agent/decisions.ts`, `lib/agent/guard.ts` — still consumed by fast/plan; the deep path
  simply stops calling parts of them
- `lib/agent/memory/working-memory.ts` — fast/plan compaction unchanged

**One exception:** `lib/agent/tools.ts` gets a single **additive** change — a
`createExecuteCommandTool({ cwd })` factory (see Finding 1). The existing
`executeCommandTool` singleton export is left exactly as-is so fast/plan behaviour is
unaffected.

Changes to `app/api/chat/route.ts` are confined to the `mode === 'deep'` branch.

Rationale (user): move to deep agents everywhere eventually, but only once users gain
confidence in the new implementation. Fast and Plan & Execute must not be disturbed now.

## Baseline correction

`deepagents` was already a dependency and `deep-agent.ts:254` already called `createDeepAgent`
on **v1.10.5** (latest 1.12.2). The file used ~10% of the API surface: model, tools,
systemPrompt, subagents, checkpointer, store, interruptOn.

The outdated code is the hand-written LangGraph plumbing in `planning-agent.ts` (1242 lines)
and `fast-agent.ts` (372 lines) — which this rewrite deliberately leaves alone for now.

## Design

### 1. Backend

```typescript
new FilesystemBackend({ rootDir: path.join(AGENT_WORKDIR, tenantId) })
```

Real disk, so the built-in file tools and `execute_command` see one filesystem. A
`StateBackend` would put files in the LangGraph checkpoint where the shell cannot reach them —
the agent would write `main.tf` and `terraform plan` would not find it.

**Tenant scoping.** `tools.ts:25` resolves a single module-level `AGENT_WORKDIR`
(`$TMPDIR/nucleus-agent`) shared by every tenant on the container. This is a pre-existing
cross-tenant **filesystem** leak, not introduced here, but this design roots the deep agent at
`<AGENT_WORKDIR>/<tenantId>` rather than building on the shared path.

Scope note: AWS *credentials* are already tenant-isolated — `configurable.tenant_id` flows to
`buildCommandEnv`, which points `AWS_SHARED_CREDENTIALS_FILE` / `AWS_CONFIG_FILE` at
per-tenant paths (`tools.ts:138,165,98-99`). Only the working directory lacks scoping.

### 1b. Finding 1 — the shared-filesystem premise did not hold

The original justification for choosing `FilesystemBackend` over `StateBackend` was that the
file tools and `execute_command` would then see one filesystem. **That was false of the
current code.** `execute_command` calls `execAsync` with **no `cwd`** (`tools.ts:161-166`), so
it runs in the Next process's working directory, while the file tools jail to `AGENT_WORKDIR`
(`tools.ts:25,41`). They are already two separate worlds today.

The goal remains correct; reaching it requires giving `execute_command` a `cwd`. Hence the one
additive change to `tools.ts`:

```typescript
export function createExecuteCommandTool(opts: { cwd: string }) { /* … */ }
```

The deep agent uses the factory rooted at `<AGENT_WORKDIR>/<tenantId>`; fast and plan keep
importing the untouched `executeCommandTool` singleton.

### 2. Tools

`createDeepAgent` throws `ConfigurationError` / `TOOL_NAME_COLLISION` when a top-level tool
name is in `BUILTIN_TOOL_NAMES` (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`,
`execute`, `task`, `write_todos`). This is why those tools sit commented out at
`deep-agent.ts:127-133` today, leaving the main loop with no file tools at all.

Use the built-ins. They also bring automatic eviction of tool results over 20 000 tokens to
the filesystem.

The built-in `execute` tool is **auto-filtered out** when the backend is not a sandbox backend
(`langsmith-*.js:2001`; `isSandboxBackend` at `:530` requires both an `execute` function and a
non-empty `id`). `FilesystemBackend` is not one, so `execute` never registers and our
`execute_command` is the only shell tool. Verified, not assumed.

**Deep gets every tool the platform has** (user decision: deep should outshine fast and plan).
Comparing against `assembleTools` (`model-factory.ts:247-286`), the deep list is:

| Tool | Source | New to deep? |
|---|---|---|
| `execute_command` | `createExecuteCommandTool({ cwd })` | tenant-scoped variant |
| `ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep` | framework built-ins | replaces the six commented-out ones |
| `get_aws_credentials`, `list_aws_accounts` | `tools.ts` | no |
| `ask_user` | `askUserTool` | **yes** — deep currently cannot ask clarifying questions, despite the UI already rendering `data-clarification` |
| `search_knowledge_base` | `kb-tool.ts` | **yes** (§2 above) |
| `get_right_sizing_recommendations` | `right-sizing-tool.ts` | **yes** |
| `web_search` | `tools.ts` | **yes at top level** — currently only inside the research subagent |
| S3 read/write | `writeFileToS3Tool`, `getFileFromS3Tool` | **yes** |
| memory tools | `createMemoryTools` | no |
| MCP tools | `getActiveMCPTools` | no |
| `write_todos`, `task` | framework middleware | replaces `dispatch_agent_tool` |
| skills catalogue | framework skills middleware | replaces `load_skill` for deep |

`createAwsReadTool(tenantId, userId)` (`aws-read-tool.ts`, the allow-listed read-only AWS CLI
wrapper currently used by planning-agent's subagents at `planning-agent.ts:422`) is added to the
**research** subagent so it can inspect live AWS state without mutation rights.

`ask_user` is the notable gap being closed: the clarification UI already exists
(`stream-parts.ts:320+` builds `data-clarification` parts) but deep never had the tool to
trigger it.

**MCP collision is a non-issue** — MCP tools are namespaced `mcp_<serverId>_<toolName>`
(`mcp-tools.ts:214-217`), so they cannot hit `BUILTIN_TOOL_NAMES`.

**Knowledge base: now enabled (Finding 5 — user decision).** `route.ts:224` currently skips KB
resolution when `mode === 'deep'`, and the deep tool list omits `kbTools`, so deep mode has no
company-docs search while fast/plan do. This rewrite **closes that gap**:

- drop the `&& mode !== 'deep'` guard at `route.ts:224` so KB ids resolve for deep too
- add `createSearchKnowledgeBaseTool(tenantId, effectiveKbIds)` to the deep tool list

This is a deliberate behaviour change, not a side effect. It means a deep-mode regression could
originate either from the framework swap or from the new tool — the KB tool addition should
therefore be a **separate commit** from the framework swap so the two can be bisected apart.

### 3. Skills

Materialize the tenant's DB skills to `<root>/skills/<slug>/SKILL.md` with documented
frontmatter (`name`, `description`) before constructing the agent, then:

```typescript
skills: ["/skills/"]
```

This is the docs' FilesystemBackend + skills pattern verbatim. Native three-layer progressive
disclosure: metadata at startup, body on activation, resources on demand.
`auto-skill-select.ts` continues to resolve the active skill.

An earlier draft proposed a custom `BackendProtocolV2` serving skills from Postgres. Rejected
under the no-invented-code rule — the documented path needs no protocol implementation.

**Finding 4 — only one skill mechanism may be active.** The app already has its own
progressive disclosure: `createLoadSkillTool` (`model-factory.ts:259`) plus
`auto-skill-select.ts`. Running that alongside the framework's skills middleware would present
the model two catalogues for the same skills.

Resolution (settled by the docs, not by the user): **deep mode uses the framework skills
middleware and does not receive `load_skill`.** Fast and Plan keep `load_skill` unchanged.

Note the current deep agent uses **neither** mechanism — its `allTools` omits `skillTools`,
so it only ever sees the single pre-selected skill pasted into its prompt and cannot discover
others. Either choice is therefore a capability gain.

### 4. Memory

**Correction — "keep ours, unchanged" was wrong.** An earlier draft of this spec claimed deep's
memory carries over untouched. It does not, and the gap runs the other way.

Fast and Plan run memory as **deterministic graph nodes** and deliberately switch the memory
*tools* off — `includeMemoryTools: false` with the comment "memory_recall and memory_save graph
nodes handle memory deterministically" (`fast-agent.ts:82,86-89`,
`planning-agent.ts:398-401,434-437`). The current deep agent has the exact inverse: the two
tools, no nodes.

Consequence: **deep today gets none of** semantic recall injection into the prompt, episodic
replay, procedural rules, save-time reconciliation, or `synthesizeDomainSkills` — the autonomous
skill creation feature — because every one of those hangs off the two nodes. Deep only has
`save_memory` / `search_memory`, which the model must choose to call.

`createDeepAgent` has no nodes, but it accepts `middleware`, and `AgentMiddleware` exposes
`beforeAgent` / `afterAgent`
(`node_modules/langchain/dist/agents/middleware/types.d.ts:151-215`). That is the documented
seam. `lib/agent/deep/memory-middleware.ts` wraps the **existing** node factories — no
reimplementation, `memory-nodes.ts` is not modified — so deep gains the full memory system
*including* autonomous skill synthesis, and reaches parity with fast/plan rather than lagging it.

The memory *tools* stay off for deep, matching fast/plan, now that the middleware handles it
deterministically.

The framework's `memory:` middleware stays **off** — it is AGENTS.md file loading only, far
weaker than what already exists.

**Finding 6 (corrected) — the *wrapper* is dead, the *store* is not.**

An earlier draft of this finding said to delete `getStore()` entirely. **That would silently
disable the whole memory system.** Both memory nodes hard-gate on the store being truthy —
`if (!store || !tenantId || !userId) return` (`memory-nodes.ts:41,176`) — and they fail with
nothing but a `console.log`. Dropping `getStore()` would make Task 6's middleware a no-op,
which is precisely the failure that task exists to prevent, and it would fail quietly.

Correct resolution:
- **Keep** `getStore()` and pass the raw store into the memory middleware deps.
- **Delete** the 20-line tenant-binding wrapper at `deep-agent.ts:37-52`. It existed only
  because deepagents itself called the config-less `store.put/get/search`, which would fall
  back to the shared `"default"` tenant pool. We no longer pass `store` to `createDeepAgent`
  (nothing reads it without `StoreBackend`), so deepagents never touches it and the wrapper
  has no purpose.
- **Do not** pass `store` to `createDeepAgent`.

The store is used by the nodes purely as an availability gate; the actual reads and writes go
through `getMemoryService()`.

### 5. Context management

Default summarization middleware, which is unconditional and already active. Triggers at 85%
of the model's `max_input_tokens`, keeps 10% as recent context, falls back to 170 000 tokens /
6 messages when the model profile is unknown. Offloaded history is written to the backend, so
with FilesystemBackend it becomes readable files the agent can `read_file` back.

`write_todos` is likewise on by default.

### 6. Human-in-the-loop

`interruptOn` on the top-level agent **and** on every subagent spec — the framework does not
propagate it downward, and the mutation tools live inside the subagents.

Resume moves from `graph.updateState(config, { messages: toolMessages })` against the custom
`approval_gate` node to the documented:

```typescript
await agent.invoke(new Command({ resume: { decisions } }), config)
```

Mapping the existing UI contract `{ toolCallId, approved, reason?, answer? }` onto the
documented decision types `approve` / `reject` / `respond`. **The client contract is
unchanged** — only the server-side translation is rewritten.

**Finding 3 — interrupt *detection* also has to change.** Resume was specified; detection was
not. `route.ts:343` gates the resume path on `nextNodes.includes('approval_gate')` and returns
409 otherwise. deepagents has no `approval_gate` node, so that guard would reject every valid
deep-mode resume. Deep must instead read pending interrupts from
`getState(config)` — `state.tasks[].interrupts` — and build the approval/clarification parts
from the interrupt payload's `actionRequests` rather than from `pendingToolCallsOf(values)`.

**`ActionRequest` carries no id.** Its only fields are `name`, `args`, `description?`
(`node_modules/langchain/dist/agents/middleware/hitl.d.ts:158-171`), and the documented example
maps decisions **positionally** (`actionRequests.map((action, i) => …)`, `:404`). Our UI
contract is keyed by `toolCallId`, so the translation must zip: take the last AI message's
`tool_calls`, keep those whose name appears in `interruptOn`, preserve order — that filtered
sequence aligns 1:1 with `actionRequests`. Getting this wrong silently applies the user's
decisions to the **wrong tools**, which is precisely why it is the first tested seam.

`decisions.ts` and `guard.ts` remain untouched and in use by fast/plan; deep simply stops
calling them. Note deep loses guard verdicts — the guard node does not run — so approval cards
render with `guard: null`.

### 7. Subagents

`aws-ops`, `research`, `code-iac` keep their current names, descriptions and system prompts.
`code-iac` drops its explicit filesystem tool list and inherits the built-ins.

**Finding 2 — subagent streaming stays on v2.** The original plan said streaming "moves to
`run.subagents`". That projection requires `streamEvents(..., { version: "v3" })`, but
`route.ts:545-548` uses **v2**, and the whole event loop is written against v2 event shapes.
Switching deep to v3 would mean rewriting that loop — far more work than the design implied.

Compounding it: the existing `onSubagentEvent` plumbing is fired by **our** `subagent.ts` /
`dispatch-agent-tool.ts`. The framework's `task` tool never calls it, so deep mode would
silently lose its subagent cards.

Resolution: stay on v2 and synthesize `SubagentEvent`s from the `task` tool's own lifecycle —
`on_tool_start` where `name === "task"` opens a card (task text from the tool args),
`on_tool_end` closes it with the returned summary. Same `SubagentEvent` shape, same persistence
via `getSubagentRunRepository()`, no client change, no v3 migration.

v3 and `run.subagents` remain the better long-term answer and should be revisited when fast and
plan are eventually migrated — at which point the whole loop moves at once.

### 8. Plan rail

Framework todos and the existing plan rail are the same shape:

```
framework:  { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
PlanStep:   { step:    string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }[]
```

`content` → `step`; the framework's status enum is a strict subset. `buildPlanPart` takes
`updatedBy` as its own argument. No frontend change, no new renderer.

### 9. Prompts

Carried over as-is: base DevOps identity, AWS CLI standards, the three account-context
variants (multi-account / single account / autonomous discovery), and the skill section.

One adjustment: `systemPrompt` is **appended to** the framework's base prompt rather than
replacing it, so the lines duplicating what the base prompt already states about `write_todos`
and the `task` tool are dropped.

## Verification

Vitest on the glue seams — the places that can break silently:

1. decisions → `Command({ resume: { decisions } })` mapping, including the ask_user →
   `respond` case and the rejection-reason passthrough
2. interrupt detection from `state.tasks[].interrupts` → approval/clarification parts
3. todos → `PlanStep` translation
4. `task` tool events → `SubagentEvent` synthesis
5. tenant workdir scoping and skill-file materialisation

## Docs-grounded rationale

Every design decision traced to the doc page or type/runtime source that justifies it. Nothing
here is inferred from the existing codebase — the codebase only tells us what we must *keep
working*, never what the new agent should *be*.

| # | Decision | Grounded in |
|---|---|---|
| 1 | Build on `createDeepAgent` rather than a hand-written `StateGraph` | Overview: deep agents give "built-in capabilities for file systems for context management, subagent-spawning, and long-term memory" |
| 2 | `FilesystemBackend({ rootDir })` for real-disk files | Backends: "Reads/writes real files under a configurable root directory" |
| 3 | Never pass our own `ls`/`read_file`/… | `createDeepAgent` throws `TOOL_NAME_COLLISION` on `BUILTIN_TOOL_NAMES` — `langsmith-*.js:5745` |
| 4 | Keep `execute_command`; no clash with built-in `execute` | `execute` is filtered out when the backend is not a sandbox — `langsmith-*.js:2001`, `isSandboxBackend` `:530` |
| 5 | Skills as `<root>/skills/<slug>/SKILL.md` + `skills: ["/skills/"]` | Skills page: FilesystemBackend example, frontmatter spec, 3-layer progressive disclosure |
| 6 | `name` ≤64 chars, `description` ≤1024, dir name must match `name` | Skills page frontmatter rules; `MAX_SKILL_NAME_LENGTH`/`MAX_SKILL_DESCRIPTION_LENGTH` |
| 7 | Checkpointer is mandatory | Customization: "Checkpointer is REQUIRED for human-in-the-loop", and also required for skills and memory |
| 8 | **Send only the new user message each turn** | Persistence + Customization: same `thread_id`, `{ messages: [{ role: "user", … }] }` per turn; the checkpointer supplies history |
| 9 | `interruptOn` repeated on every subagent spec | `SubAgent.interruptOn` is a per-subagent field (`agent-*.d.ts:1356`); not propagated from the top level |
| 10 | Resume with `new Command({ resume: { decisions } })` | HITL page, verbatim example |
| 11 | Decision types `approve` / `edit` / `reject` / `respond` | HITL page; `hitl.d.ts` decision unions |
| 12 | Decisions are **positional**, not keyed | `ActionRequest` has only `name`/`args`/`description?` (`hitl.d.ts:158-171`); doc example maps `actionRequests.map((action, i) => …)` (`:404`) |
| 13 | Drive the plan rail from `todos` | Frontend page: "Track progress with a real-time todo list", `stream.values?.todos` |
| 14 | Do not configure summarization | Context engineering: "Every `create_deep_agent` call includes `SummarizationMiddleware` in the bare stack"; 85% of `max_input_tokens`, keep 10%, fallback 170k/6 |
| 15 | Memory system attaches as **middleware** | `CreateDeepAgentParams.middleware`: "Custom middleware to apply after standard middleware"; `beforeAgent`/`afterAgent` hooks in `middleware/types.d.ts:151-215` |
| 16 | Subagent `tools` fully override, never merge | Subagents page: specifying tools "override the inherited tools entirely" |
| 17 | Custom subagents do **not** inherit main-agent skills | `SubAgent.skills` doc comment (`agent-*.d.ts:1364`); only `general-purpose` inherits |
| 18 | Subagent streaming stays on v2 for now | `run.subagents`/`run.extensions` are exposed "when using `streamEvents(..., { version: "v3" })`" — `CreateDeepAgentParams.streamTransformers` |
| 19 | `systemPrompt` trimmed of todo/task instructions | It is concatenated onto the base prompt (`:2004`), so framework-covered guidance would duplicate |
| 20 | No custom `BackendProtocolV2` for skills | Documented FilesystemBackend path needs none — no-invented-code rule |

## Finding 7 (reframed) — provider-agnostic by design; only the Bedrock path degrades

An earlier draft of this finding treated Bedrock as *the* model and called the gap
"consequential". That was wrong framing: **this platform is already multi-provider**, and
Bedrock is one of eight options — not even the schema default.

`ProviderModel.provider` (`libs/prisma/schema.prisma:104`) is
`bedrock | openai | anthropic | ollama | vllm | lmstudio | litellm | openai-compatible`,
defaulting to `openai-compatible`. `createAgentModels` routes them three ways
(`model-factory.ts:82-99`):

| App provider(s) | Class constructed | `getModelProvider` | Harness profile | Prompt caching |
|---|---|---|---|---|
| `openai`, `ollama`, `vllm`, `lmstudio`, `litellm`, `openai-compatible` | `ChatOpenAI` (+ `baseURL`) | `"openai"` ✅ | ✅ | n/a |
| `anthropic` | `ChatAnthropic` | `"anthropic"` ✅ | ✅ | ✅ |
| `bedrock` | `ChatBedrockConverse` | `undefined` ❌ | ❌ | ❌ |

So **seven of eight providers integrate with the framework fully**. Only the Bedrock path loses
the harness profile, prompt caching and model-derived summarization thresholds.

The design must therefore stay provider-agnostic: `createDeepAgent` takes
`model: BaseLanguageModel | string`, and we pass the already-resolved instance from
`createAgentModels(modelConfig).main`. That preserves each tenant's configured `baseUrl`,
`apiKey`, region and credentials, which a bare string spec **cannot** carry.

**Candidate improvement — route through `initChatModel`.** The docs' OpenAI-compatible pattern is:

```typescript
const model = await initChatModel("MODEL_NAME", {
  modelProvider: "openai",
  baseUrl: "https://your-compatible-endpoint.com/v1",
  apiKey: "YOUR_API_KEY",
});
```

This returns a `ConfigurableModel`, whose `_defaultConfig.modelProvider` **is** read by both
`getModelProvider` and `isAnthropicModel` (`langsmith-*.js:2677,2689`). Routing the deep
agent's model through `initChatModel` would therefore close the Bedrock gap *and* keep
per-tenant `baseUrl`/`apiKey` intact, giving every provider full framework integration.

Attractive, but unverified — particularly whether `modelProvider: "bedrock"` accepts our
region/credential shape. **Verify in the spike before adopting; do not refactor
`createAgentModels` on this hypothesis.**

For reference, the framework identifies models by **class name**:

```js
function getModelProvider(model) {
  if (model.getName() === "ConfigurableModel") return model._defaultConfig?.modelProvider;
  return { ChatAnthropic: "anthropic", ChatOpenAI: "openai", ChatGoogleGenerativeAI: "google" }[model.getName()];
}
function isAnthropicModel(model) { /* … */ return model.getName() === "ChatAnthropic"; }
```
(`langsmith-*.js:2672-2695`)

`ChatOpenAI` and `ChatAnthropic` both match. `ChatBedrockConverse` does not, so on the Bedrock
path only:

1. **No Anthropic prompt caching.** `isAnthropicModel` is false, so neither
   `anthropicPromptCachingMiddleware` nor `createCacheBreakpointMiddleware` is added
   (`langsmith-*.js:5753-5757`). The docs advertise caching "for Anthropic/Bedrock models",
   which holds for a string spec or `ConfigurableModel` — not for a `ChatBedrockConverse`
   **instance**. Tenants on `anthropic` get caching; tenants on `bedrock` do not.
2. **Empty harness profile.** `resolveHarnessProfile` finds nothing, so
   `toolDescriptionOverrides` and profile middleware are skipped.
3. **Crude summarization thresholds.** `computeSummarizationDefaults` derives trigger/keep from
   the model profile's `maxInputTokens`; with no profile it falls back to a fixed 170 000
   tokens / 6 messages instead of 85%-of-context / keep-10%.

None of this breaks the rewrite, and it affects one provider out of eight. Measure it in the
spike, then choose: adopt `initChatModel` for all providers (closes the gap everywhere), add the
caching middleware manually via `middleware:` for Bedrock, or accept it and document the cost.
**Decide with evidence, not by assumption.**

## Retracted risk — Bedrock orphaned `tool_call` ids

Every existing agent calls `sanitizeMessagesForBedrock` before each model call
(`fast-agent.ts:146`, `planning-agent.ts:641`, `agent-ops/executor-graphs.ts:362,594`) because
an orphaned `tool_call` without a matching `tool_result` raises a Bedrock
`ValidationException` — see CLAUDE.md. The obvious worry is that the summarization middleware
trims mid-tool-sequence and orphans a call.

**The framework already handles this.** `patchToolCallsMiddleware` is in the bare stack and runs
`patchDanglingToolCalls(messages)`, both as a hook and again inside `wrapModelCall` as an
explicit safety net — its own comment says "The model would otherwise receive dangling
tool_call_ids" (`langsmith-*.js:2584-2620`, registered at `:5808,5830`). No custom sanitization
middleware is needed.

One residual unknown: our `sanitizeMessagesForBedrock` deliberately **preserves reasoning
blocks** (`planning-agent.ts:144`). Whether `patchDanglingToolCalls` does the same matters only
if extended thinking is enabled on the deep model — verify empirically in Task 9 rather than
pre-emptively working around it.

## Verified facts (checked against dist source, not assumed)

| Claim | Status | Evidence |
|---|---|---|
| Built-in `execute` auto-filtered for non-sandbox backends | ✅ | `langsmith-*.js:2001`, `isSandboxBackend` `:530` |
| `systemPrompt` is concatenated, not replaced | ✅ | `:2004` `request.systemMessage.concat(...)` |
| Summarization is unconditional in the bare stack | ✅ | middleware array assembly, `:5760-5860` |
| MCP tools cannot collide with builtins | ✅ | `mcp-tools.ts:214-217` namespaces `mcp_*` |
| AWS credentials already tenant-isolated | ✅ | `tools.ts:138,165,98-99` |
| todos ↔ PlanStep is a field rename | ✅ | `agent-DURA4_mf.d.ts:3864`, `agent-shared.ts:56` |
| `createDeepAgent` is **synchronous** in 1.10.5 | ⚠️ | returns `createAgent({...})` directly; docs show `await`. May differ in 1.12.2 |
| `execute_command` shares a cwd with file tools | ❌ **false** | no `cwd` passed, `tools.ts:161-166` — drove Finding 1 |

## Risks

- **HITL resume + detection** is the highest-risk change — seams 1 and 2 exist for it.
- **`route.ts` is 1383 lines** welded to the custom graphs' node names and state. The deep
  branch must be isolated cleanly so fast/plan keep working.
- **Version drift**: installed 1.10.5 vs latest 1.12.2. Unresolved. The sync/async
  `createDeepAgent` difference is one concrete reason to settle it before building.
- **Two behaviour changes ride along** — KB access (§2) and skill discovery (§3). Both are
  deliberate and both should land as commits separate from the framework swap so a regression
  can be bisected to the right cause.
