# Deep agent — parked items

Things that need a decision or follow-up, deliberately deferred. Nothing here blocks the v3
rewrite, which is wired and verified.

## 1. `ask_user` does not pause when auto-approve is ON

With auto-approve on, `interruptOn` is `undefined`, so `ask_user` executes like any other tool.
The agent asks a question and immediately answers it itself ("I'll proceed with the most likely
interpretation"). With auto-approve OFF it correctly surfaces a clarification card.

**Recommendation:** make `ask_user` always interrupt. It is not a risky action needing approval —
it is a question for the human, and auto-approve should not silence it. Behaviour change, so it
needs a decision.

## 2. Sub-agents — verified in the browser (closed)

Exercised twice on real runs:

- **4 parallel `aws-ops`** on an EC2/ECS/RDS audit — each with its own card, tool counts ticking
  up, all reaching `done`, sub-agent runs persisted to `agent_subagent_runs`.
- **1 `research`** on a delegated question — `task -> card opened`, `research -> running`,
  `research -> done`, and the card reported **6.4k tokens**, confirming the fix that made
  sub-agent token counts real (they were hardcoded to 0 before).

The misleading `Sub-agents: on/off` line is gone for deep (see item 5) — it belonged to the old
`dispatch_agent` system and never governed the framework's `task` tool.

## 3. `lib/deep-agent/` audited — not affected (closed)

The chat agent's `FilesystemBackend` was missing `virtualMode: true`, exposing every host path
including other tenants' AWS credentials under `/tmp/nucleus-aws-creds/<tenantId>/credentials`.
Fixed there, with a regression test.

`lib/deep-agent/` (the separate `/app/deep-agent` page, its own routes and UI) was listed as
unchecked. Now checked: **it does not use `FilesystemBackend` at all.**

```ts
new CompositeBackend(
    new StateBackend(cfg),                      // in-memory, per run
    { '/memories/': new StoreBackend(cfg) },    // store-backed
)
```

No filesystem access anywhere, so there is no path to escape. Immune by construction, not by
configuration. No change needed.

## 4. Upstream bugs — filed

Both patches in `patches/` exist because of defects in langchain itself. Both are now reported:

| Patch | Issue | What to watch for |
|---|---|---|
| `@langchain%2Fcore@1.2.1.patch` | [langchainjs#11355](https://github.com/langchain-ai/langchainjs/issues/11355) | `JSON.parse("")` on a zero-argument tool call under the v3 protocol |
| `langchain@1.5.2.patch` | [langchainjs#11356](https://github.com/langchain-ai/langchainjs/issues/11356) | `respond` is documented for ask_user-style tools but not implemented |

Delete each patch once the corresponding fix ships, and re-run the deep HITL and zero-arg tool
checks after removing it.

Reminder: **after any `bun patch`, `rm -rf apps/web-ui/.next`** — webpack caches the pre-patch
module and the server keeps running old code while the file on disk looks correct.

## 5. UI now shows what deep actually does (done)

Deep no longer borrows fast/plan's vocabulary. Three indicators described controls that were not
wired to a deep run, so they are hidden for `mode === 'deep'` only — fast and plan are untouched:

- **Plan · Execute · Reflect · Revise stepper** — those are the planning agent's four graph nodes
  (`planner`, `generate`, `reflect`, `revise`). Deep has only model turns and tool turns, so
  Reflect and Revise could never light up.
- **`guard: active`** — deep never runs the guard (`deep-stream.ts` sends `guard: null`). Its real
  safety is `interruptOn`. The badge was a light wired to nothing.
- **`Sub-agents: on/off`** — that setting governs the OLD `dispatch_agent` tool that plan mode
  uses. Deep's subagents come from the framework's `task` tool, which the setting does not reach:
  the panel read "off" while four subagents ran.

Deep's status is now plain — working / awaiting you / idle — and everything else on screen is
something deep actually emits: todos, tool calls, subagent cards, approvals, tokens.

**Deliberately not built:** an on/off toggle or a per-run cap for deep's subagents. Per the
deepagents docs the model decides delegation ("it can issue several in a single turn to run them
in parallel") and there is no documented option to limit the quantity. The only off switch is
passing no subagents at all. Inventing a dial the framework does not have is how workarounds
start.

## 6. A tool error used to kill the whole run

`ToolNode` re-raises errors that arrive through `wrapToolCall` middleware unless
`handleToolErrors === true` — and deepagents wraps every tool call for LangSmith, so *all*
tool failures looked like middleware errors. One malformed `--group-by` aborted a 7-step audit
and took 12 in-flight sibling calls with it; the model never saw the error it was told to fix.

`handleToolErrors` is not exposed by `createDeepAgent`, so the fix is the documented
`wrapToolCall` middleware from the tools docs, wired via `middleware: [handleToolErrors]`.
It re-raises graph interrupts and aborts — swallowing an interrupt there would silently break
every approval, which is verified by test.

**Subagent case — checked, not affected.** A tool failing inside a subagent does not abort
anything: the subagent reached `done`, the run emitted no error part, the main agent still
answered, and there were zero unhandled rejections. Measured with real credential failures
("The security token...") inside an `aws-ops` subagent.

Caveat on that check: it exercised a *returned* error string, not a *thrown* one (bad tool
arguments). The thrown case is still only proven by the original Cost Explorer run.

## 7. `respond` decision type — docs ahead of the package

See the HITL section of `2026-08-12-deep-stream-v3.md`. The JS docs document a `respond` decision
for `ask_user`-style tools; no published `langchain` release implements it.

## 8. Deep's vector memory has never been read successfully (parked)

Measured on the live tenant, not inferred:

- `agent_memories` holds **205 rows** — `infra/970547372609` (91), `episodes` (52),
  `procedures/aws-cli` (8), `errors/ecs`, `patterns/cost-optimization`, and more.
- Deep called `search_memory` five times today. **All five returned "No memories found."**
- It searched `["aws","infra"]` and `["aws","stx"]`. Nothing lives under `aws/` — the prefix
  filter (`namespace LIKE 'aws/infra%'`) matched zero rows every time.
- `save_memory` was never called, and `/memories/AGENTS.md` was never written by any run in the
  chat history. A store that answers "empty" five times running is not one the model will
  contribute to.

The cause is structural, not prompt wording: `save_memory` asks the model to invent a namespace
path, a key and a structured value, and `search_memory` asks it to guess the same namespace back
in a later session — with no way to see what namespaces exist.

**What the docs say.** deepagents has no vector memory. Memory is files: *"the agent reads and
writes memory as files, and you control where those files are stored using backends"*, and
*"when the agent learns new information, it can use its built-in `edit_file` tool to update
memory files"*. Isolation comes from the backend's namespace function, never from something the
model types. That part already works here — `AGENTS.md` lives in `agent_files`, loads on every
run, and the agent has both read and written it.

So `search_memory` / `save_memory` are ours, sitting alongside a framework feature that does the
same job without the guessing.

**Decision: parked, no change.** The file memory works; the vector tools stay wired but unused by
deep. The pgvector corpus is left alone — other features write to it. Revisit after the browser
test sweep. Note the same tools are shared with fast/plan, which are presumably searching into
the void too — unverified.

## 9. Sub-agent cards from an earlier run keep spinning (cosmetic)

Stop a run: its cards correctly go to failed and the rail reads `0 running`. Send the next
message and those same dead cards flip back to spinning — timers counting up — for the whole of
the new run, correcting themselves only when it ends.

Display only. The stored state was right throughout: `agent_subagent_runs` held `failed` before
the next turn even began, and the run-scoped ids mean the two runs no longer overwrite each other.

The rail reconciles a stale card against the store, but the check is gated on `!isStreaming`:

```ts
const hasStaleRunning = !isStreaming && runState.subagents.some(s => s.status === "running");
```

A card from an earlier run can never receive another live event, so during a new stream nothing
corrects it. Removing the gate was tried and reverted — it breaks the deliberate behaviour asserted
by "prefers live sub-agent state over a persisted fetch while streaming", which keeps the client
from polling the store throughout every run. Comparing run stamps does not work either: when a new
turn begins the old cards are briefly the only cards, so there is no newer stamp to compare with —
which is exactly the window where the spinners appear.

The real fix belongs in `deriveRunState`: a card from a previous turn should not be carried into a
new one as `running`. That is shared run-state code used by fast and plan, so it needs those
re-checked. Left alone deliberately.

## 10. A sub-agent can burn its whole recursion budget on a failing tool

Measured: an `aws-ops` subagent asked to fetch credentials and list EC2 retried against expired
credentials roughly forty times, then died with

```
Error: Recursion limit of 60 reached without hitting a stop condition
```

Nothing broke — the main agent handled it ("The subagent hit a recursion/iteration limit... let me
run this directly instead") and reported the real cause. But a subagent that cannot get credentials
should stop after a couple of attempts, not forty. In production a genuinely broken credential path
would silently burn a full recursion budget per subagent, and with several in parallel that is a
large token cost for zero information.

Worth a retry/abort rule in the `aws-ops` prompt, or a lower `recursionLimit` for subagents if the
framework exposes one — unchecked.

## 11. Deep can read skills but cannot write them (framework supports it)

Deep consumes skills — 19 are materialised per run and it reads the relevant `SKILL.md` before
starting — but it can neither author one nor feed the pipeline that produces them.

**Our pipeline does not include deep.** `memory-nodes.ts:335` runs
`synthesizeDomainSkills()`, which turns matured procedural rules into a `sys-<domain>` skill.
It is called from `fast-agent.ts`, `planning-agent.ts` and `agent-ops/executor-graphs.ts` —
**zero references in `deep-agent.ts`**. The hook lived on the memory middleware the rewrite
deleted. So the `sys-aws-cli` and `sys-agent-workflow` skills deep reads on every run were
produced by the other agents, never by deep.

**The framework does support self-authoring**, per the deepagents skills docs:

> "You can also ask your agent to write a skill for a task you worked on with the agent."
>
> "To let agents create or refine skills without touching shared libraries: Route a writable
> path such as `/skills/personal/` to a user-scoped `StoreBackend`."
>
> "The agent uses `write_file` and `edit_file` to create or update `SKILL.md` and supporting
> files under the writable path."

No special API — the file tools it already has, pointed at a writable path. The same shape as
`/memories/`, which is already routed to a `StoreBackend` in `deep-agent.ts`:

```ts
new CompositeBackend(
    new FilesystemBackend({ rootDir: root, virtualMode: true }),
    { '/memories/': new StoreBackend({ namespace: () => ['deep-agent'] }) },
)
```

Today `/skills/` is the temp workdir, rewritten from the `Skill` table every run, so anything
deep wrote there would be erased on the next run. That is why it cannot create skills in
practice — not a missing capability.

**Two things to settle before wiring it:**

- A skill written to a `StoreBackend` lands in a store, **not the `Skill` table**, so it would
  not appear on the Skills page or honour the enable/disable toggle. Routing it to the table
  instead is the useful version.
- The existing path has a human gate — matured rules are promoted through `SkillFormDialog`
  with someone approving. Self-authoring bypasses that review, and a skill changes how the
  agent behaves on every later run.

So the open question is not capability but governance: should a single deep run be able to
write a skill nobody approved? Either answer is defensible; it should be chosen, not defaulted.

