# deepagents (JS) API research — for the agent rewrite

Source: https://docs.langchain.com/oss/javascript/deepagents/overview (+ subpages)
Ground truth for exact types: `node_modules/deepagents/dist/agent-DURA4_mf.d.ts`

Installed: **1.10.5** · Latest on npm: **1.12.2** (dist-tags: latest 1.12.2, rc 1.12.0-rc.1)

---

## 1. `createDeepAgent(params)` — full option surface

From `CreateDeepAgentParams` (d.ts line ~2518):

| Option | Type | Notes |
|---|---|---|
| `model` | `BaseLanguageModel \| string` | `"provider:model"` string or instance. Defaults to `claude-sonnet-4-5-20250929` |
| `tools` | `StructuredTool[]` | Plain LangChain `tool()` objects — our existing tools drop in unchanged |
| `systemPrompt` | `string \| SystemMessage` | **Combined with** the base agent prompt, not replacing it |
| `stateSchema` | `StateSchema \| ZodObject` | Custom persisted state beyond `messages`/`todos`/`files` |
| `middleware` | `AgentMiddleware[]` | Applied **after** standard middleware |
| `subagents` | `(SubAgent \| CompiledSubAgent \| AsyncSubAgent)[]` | Mixed array; async ones split out by `graphId` |
| `responseFormat` | Zod schema / toolStrategy / providerStrategy | Structured output |
| `contextSchema` | `ZodObject` | Per-invocation context, **not** persisted |
| `checkpointer` | `BaseCheckpointSaver \| boolean` | |
| `store` | `BaseStore` | Long-term memory store |
| `backend` | `AnyBackendProtocol \| (cfg:{state,store}) => Backend` | Filesystem backend or factory |
| `interruptOn` | `Record<string, boolean \| InterruptOnConfig>` | HITL per tool name |
| `name` | `string` | |
| `memory` | `string[]` | AGENTS.md paths loaded into system prompt at startup |
| `skills` | `string[]` | Skill source dirs, POSIX paths relative to backend root |
| `permissions` | `FilesystemPermission[]` | Declaration order, first match wins, permissive default |
| `streamTransformers` | `(() => StreamTransformer)[]` | Custom projections on `run.extensions` |

**Important:** `systemPrompt` is *appended to* the framework's base prompt — it does not replace it. Our current prompts assume full control of the system message.

---

## 2. Built-in tools (registered by FilesystemMiddleware)

`FILESYSTEM_TOOL_NAMES = ["ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute"]`

`createDeepAgent` **detects collisions** with user-supplied tools at construction time. Our `tools.ts` exports tools with exactly these names (`readFileTool`, `writeFileTool`, `lsTool`, `editFileTool`, `globTool`, `grepTool`, `executeCommandTool`) — hence they are commented out in the current `deep-agent.ts`. Any rewrite must decide: use the built-ins, or rename ours.

Plus `write_todos` (todo middleware) and `task` (subagent middleware).

### FilesystemMiddlewareOptions
- `backend`, `systemPrompt` (override), `customToolDescriptions`
- `toolTokenLimitBeforeEvict` (default 20 000 tokens ≈ 80 KB) — large tool results are auto-evicted to the filesystem
- `humanMessageTokenLimitBeforeEvict` (default 50 000 tokens ≈ 200 KB)
- `permissions`

Eviction exclusions: `ls`, `glob`, `grep` (self-truncating), `read_file` (re-read loop hazard), `edit_file`/`write_file` (tiny output).

---

## 3. Backends

| Backend | Storage | Use |
|---|---|---|
| `StateBackend` (default) | LangGraph state per thread | scratch pad, survives via checkpointer, not cross-thread |
| `FilesystemBackend` | real disk under `rootDir`, optional `virtualMode` | local dev / CI |
| `StoreBackend` | `BaseStore` (Postgres etc.), `namespace: (rt) => [...]` | durable cross-thread |
| `CompositeBackend` | routes path prefixes to different backends | e.g. `/memories/` → StoreBackend, rest → StateBackend |
| `ContextHubBackend` | LangSmith Context Hub repo | |

Custom backend = implement `BackendProtocolV2`:
`ls(path)`, `read(filePath, offset?, limit?)`, `readRaw(filePath)`, `write(filePath, content)`,
`edit(filePath, oldString, newString, replaceAll?)`, `glob(pattern, path?)`, `grep(pattern, path?, glob?)`.

**All methods return Result objects with optional `error` fields — they never throw.**
Binary support is native (`Uint8Array` + mimeType).

```typescript
new CompositeBackend(
  new StateBackend(),
  { "/memories/": new StoreBackend({ namespace: () => ["memories"] }) },
)
```

This is the hook for backing the agent filesystem with our Postgres store, tenant-namespaced.

---

## 4. Permissions

```typescript
interface FilesystemPermission {
  operations: readonly ("read" | "write")[];
  paths: string[];        // absolute globs, must start with "/", no ".." or "~"
  mode?: "allow" | "deny"; // default "allow"
}
```
Declaration order, first match wins, **permissive default** (no match = allowed).
Applies to `ls/read_file/write_file/edit_file/glob/grep` — **NOT** `execute`.
Combining `permissions` with an execution-capable (sandbox) backend throws `ConfigurationError`
unless the backend is a `CompositeBackend` and every permission path is scoped to a route prefix.

Subagent `permissions` **replace** the parent's entirely (not a merge).

---

## 5. Subagents

```typescript
interface SubAgent {
  name: string;
  description: string;      // shown to the model for selection
  systemPrompt: string;     // does NOT inherit from parent
  tools?: StructuredTool[]; // OVERRIDES inherited tools entirely
  model?: LanguageModelLike | string;
  middleware?: AgentMiddleware[];
  interruptOn?: Record<string, boolean | InterruptOnConfig>; // requires checkpointer
  skills?: string[];        // custom subagents do NOT inherit main-agent skills
  responseFormat?: ...;     // structured output, JSON-serialised into the ToolMessage
  permissions?: FilesystemPermission[]; // full replacement
}
```

- `CompiledSubAgent` = `{ name, description, runnable }` — wraps an **existing compiled LangGraph**.
  This is the escape hatch for reusing our current planning/reflection graph as a subagent.
- `AsyncSubAgent` — identified by `graphId`, runs on a remote Agent Protocol server.
- A `general-purpose` subagent is auto-included unless disabled. It **does** inherit main-agent tools + skills.
  Override by passing your own subagent named `general-purpose`, or via harness profile
  `general_purpose_subagent.enabled = false`.
- Runtime context propagates to all subagents automatically.
- Subagent runs are tagged with `lc_agent_name` metadata (LangSmith filtering, and useful for our
  `isSubagentModelEvent` stream filter).
- `interruptOn` is **per-subagent** and is NOT propagated from the top level — confirmed in d.ts and
  already documented as a footgun in our `deep-agent.ts` comment.

---

## 6. Human-in-the-loop

Config:
```typescript
interruptOn: {
  remove_file: true,                                          // all decisions allowed
  safe_tool: false,                                           // never interrupt
  write_file: { allowedDecisions: ["approve", "edit", "reject"] },
}
```

Interrupt surfaces on the result as `result.__interrupt__[0].value.actionRequests`.

Resume:
```typescript
import { Command } from "@langchain/langgraph";

const decisions = [{ type: "reject", message: "User rejected …. Do not retry." }];
result = await agent.invoke(new Command({ resume: { decisions } }), config);
```

Decision `type` values: `"approve" | "edit" | "reject" | "respond"`.
`"edit"` requires `editedAction: { name, args }` matching the original tool schema.

> **This is the single biggest breaking change for us.** Our chat route resumes via
> `graph.updateState(config, { messages: toolMessages })` against a custom `approval_gate`
> node and hand-built `ToolMessage`s (`app/api/chat/decisions.ts`). deepagents owns that
> translation itself. Our UI-side per-tool decision contract
> (`{ toolCallId, approved, reason?, answer? }`) maps cleanly onto
> approve/reject/respond, so the **client contract can survive**; the server-side
> translation layer is what gets rewritten.

---

## 7. Skills

`SKILL.md` with YAML frontmatter, one directory per skill:

```yaml
---
name: skill-name          # lowercase alphanumeric + hyphens, 1-64 chars, must match dir name
description: What it does and when to activate it   # max 1024 chars
---

# skill-name
Instructions…
```
Optional frontmatter: `license`, `compatibility` (max 500 chars), `metadata` (k/v), `allowed-tools` (space-separated).

Limits: `MAX_SKILL_NAME_LENGTH = 64`, `MAX_SKILL_DESCRIPTION_LENGTH = 1024`, `MAX_SKILL_FILE_SIZE`.

**Progressive disclosure, three layers:**
1. startup → only `name` + `description` in the system prompt
2. activation → full `SKILL.md` body read
3. as-needed → `scripts/`, `references/`, `assets/` read when the instructions point at them

`skills: ["/skills/"]` — a parent dir is scanned for subdirs containing `SKILL.md`;
a direct skill path (dir containing `SKILL.md` at its root) is auto-detected. Both forms mix.
Later sources win on name collision.

Guidance: keep frontmatter + body under ~5 000 tokens combined; move detail into `references/`.

> Our skills live in Postgres (`skill-service.ts`, tenant-scoped) and we already do our own
> progressive disclosure (`auto-skill-select.ts`, `AUTO_SKILL_SELECTION_ENABLED`) plus
> autonomous synthesis (`memory/skill-synthesis.ts` → `sys-<domain>`). A custom
> `BackendProtocolV2` that projects DB skills as `/skills/<name>/SKILL.md` would let the
> native skills middleware drive them without moving storage.

---

## 8. Memory middleware

```typescript
interface MemoryMiddlewareOptions {
  backend: AnyBackendProtocol | BackendFactory;
  sources: string[];              // e.g. ["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"]
  addCacheControl?: boolean;      // Anthropic/Bedrock prompt-cache breakpoint on the memory block
}
```
Loads AGENTS.md-style files into the system prompt at startup; the agent updates them with `edit_file`.
Scoping via `StoreBackend({ namespace: (rt) => [...] })` — per user / per assistant / per org.

> This is **file-shaped procedural memory only**. It is much weaker than what we already have:
> pgvector semantic recall + typed `AgentMemory`, episodic memory, procedural rules,
> save-time LLM reconciliation (ADD/UPDATE/SUPERSEDE/REINFORCE/NOOP), working-memory compaction.
> Recommendation: **keep our memory system**, expose it as custom middleware / tools, and
> optionally *additionally* use `memory:` for a stable per-tenant AGENTS.md.

---

## 9. Summarization middleware (context engineering)

```typescript
createSummarizationMiddleware({
  model?,                       // defaults to active request model
  backend,                      // history is offloaded to backend storage
  trigger?: ContextSize | ContextSize[],
  keep?: ContextSize,           // default: last 20 messages
  summaryPrompt?, trimTokensToSummarize? /* default 4000 */,
  historyPathPrefix?,           // default "/conversation_history"
  truncateArgsSettings?,
})
```
`computeSummarizationDefaults(model)` derives trigger/keep/truncation from the model profile's
`maxInputTokens` when available.

> Direct overlap with our `memory/working-memory.ts` (`prepareContext`, `WORKING_MEMORY_ENABLED`).
> This is a strong candidate for **deletion in favour of the built-in**.

---

## 10. Other exports worth knowing

- `createFilesystemMiddleware`, `createSkillsMiddleware`, `createMemoryMiddleware`,
  `createSummarizationMiddleware`, `createSubAgentMiddleware`, `createAsyncSubAgentMiddleware`,
  `createAgentMemoryMiddleware`, `createCompletionCallbackMiddleware`, `createPatchToolCallsMiddleware`
- Harness profiles: `createHarnessProfile`, `registerHarnessProfile`, `getHarnessProfile`,
  `parseHarnessProfileConfig`, `REQUIRED_MIDDLEWARE_NAMES`, `EMPTY_HARNESS_PROFILE`
- Sandboxes: `BaseSandbox`, `LangSmithSandbox`, `LocalShellBackend`, `isSandboxBackend`,
  `adaptSandboxProtocol` — `execute` tool for shell
- Interpreters: `@langchain/quickjs` middleware adds an `eval` tool (QuickJS JS runtime);
  enables dispatching subagents from code (loops, parallel batches)
- Streaming: `DeepAgentRunStream` — `run.subagents` (typed per declared subagent, narrows on
  `sub.name === "…"`), `run.toolCalls`, `run.extensions` (custom stream transformers),
  via `streamEvents(..., { version: "v3" })`
- Prompt caching middleware is applied automatically for Anthropic/Bedrock models

---

## 11. Middleware order (from the Customization page)

Deliberate ordering: **Skills middleware runs before Filesystem on the main agent, but after
patching on subagents.** Stack also includes summarization, subagent coordination, and prompt
caching. Custom `middleware:` is appended after the standard stack.

---

## 11b. Verified by running code (not inferred) — 2026-08-12

| Question | Answer | How |
|---|---|---|
| Tools bound by a bare `createDeepAgent` | **8**: `edit_file, glob, grep, ls, read_file, task, write_file, write_todos` | recorded `bindTools` on a fake model |
| Is `write_todos` default? | **Yes** (despite the overview showing `middleware: [todoListMiddleware()]`) | same |
| Is `task` default? | **Yes** | same |
| Is `execute` present with `FilesystemBackend`? | **No** — filtered because it is not a sandbox backend | same |
| Does the middleware runtime expose `writer`? | **Yes**, a function | probe middleware |
| Does `streamEvents` **v2** surface writer data? | **No** — zero events | probe middleware |
| Does `streamEvents` **v3** surface writer data? | **Yes** — `{"type":"event","method":"custom","params":{"data":{"payload":…}}}` | probe middleware |
| `await streamEvents(input, {version:"v3"})` returns | `GraphRunStream` with `messages`, `subagents`, `toolCalls`, `values`, `extensions`, async-iterable | probe |
| Must v3 be awaited? | **Yes** — without `await` it is not async-iterable and has no projections | probe |

## 11c. Tools page

- Tools accepted as plain functions, LangChain `tool()`, or tool dicts; schema inferred where possible.
- MCP: `@langchain/mcp-adapters` → `new MultiServerMCPClient({...})` → `await client.getTools()` → pass to `createDeepAgent`.
- Built-in harness tools listed as `ls, read_file, write_file, edit_file, glob, grep, execute, task`.

## 11d. Permissions page

- Rules apply to `ls, read_file, glob, grep, write_file, edit_file` — **not** custom tools, **not** MCP tools, **not** sandbox `execute`.
- `operations`: `"read"` (ls/read_file/glob/grep) or `"write"` (write_file/edit_file).
- First-match-wins; no match = **allowed** (permissive baseline).
- Paths absolute, no `..` or `~`; invalid paths throw at construction. Requires `deepagents >= 1.9.1`.
- Subagents inherit; setting `permissions` on a subagent **replaces** the parent's. `[]` grants unrestricted access.
- With `CompositeBackend`, all permission paths must scope under known route prefixes or construction throws.

## 11e. Bare stack order (customization page)

1. `FilesystemMiddleware`
2. `SubAgentMiddleware` (present because the general-purpose subagent is auto-added)
3. `SummarizationMiddleware`
4. `PatchToolCallsMiddleware`
5. prompt caching (supported providers)
6. harness profile extras + excluded-tool filtering

**Custom `middleware` is appended after `PatchToolCallsMiddleware`.**
The main agent also accepts a `SystemMessage` with structured content blocks, and Deep Agents preserves those blocks.

## 11f. Context engineering page

- Custom system prompt is **prepended to the built-in system prompt**, which already contains guidance for filesystem tools and subagents.
- **Memory (AGENTS.md) is *always* loaded** into the system prompt — keep it minimal, for universal conventions.
- Skills are on-demand/progressive by contrast.
- **Runtime context**: pass per-run config via the `context` field at invoke; shape it with `contextSchema` (Zod). Tools read it via `runtime.context`. **Propagates to all subagents.**
- **Offloading**: tool inputs/results over **20 000 tokens** are stored on the filesystem and replaced with a path + preview; triggers as context approaches 85% of the window.
- **Summarization**: at 85% of `max_input_tokens`, keeps 10% recent; originals preserved on the filesystem.
- **Long-term memory**: use `CompositeBackend` routing a path such as `/memories/` to a LangGraph Store so it persists across threads.

## 11g. Going to production page

- Requires **checkpointer**, **store**, and **thread management**.
- Invocation takes `thread_id` (conversation identity) **and** `context` (per-run data: userId, API keys, flags) — independent of each other:
  ```ts
  await agent.invoke({ messages: [...] }, { ...config, context: { userId: "user-123" } });
  ```
- Memory scoping by namespace: user / assistant / org.
  ⚠️ "Shared memory is a vector for prompt injection." Enforce read-only where appropriate and use permissions to deny writes to shared paths.
- Filesystem-only work: `StateBackend` (thread scratch), `StoreBackend` (cross-thread), or `CompositeBackend` to mix.
- Sandboxes only when running code beyond file I/O; thread-scoped or assistant-scoped.
- Use `beforeAgent`/`afterAgent` middleware to upload skills/memories before execution and sync results after.
- Increase `recursionLimit` for workflows with many subagents.
- Prefer async tools and async middleware hooks for throughput.

## 11h. Sandboxes page

- Sandboxes **are backends** that define where the agent operates; they add `execute`.
- "On every model call, the harness checks whether the backend implements `SandboxBackendProtocol`. If not, the tool is filtered out and the agent never sees it." (matches the runtime check verified above)

## 12. Docs subpages (all under /oss/javascript/deepagents/)

`overview`, `quickstart`, `customization`, `code/overview`, `cli/overview`, `acp`, `tools`,
`backends`, `permissions`, `sandboxes`, `interpreters`, `skills`, `memory`,
`context-engineering`, `event-streaming` (typed event projections), `human-in-the-loop`,
`subagents`, `frontend/overview`, going-to-production (LangSmith deployment),
comparison (Deep Agents vs Claude Agent SDK).
