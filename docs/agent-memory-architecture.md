# Agent Memory & Autonomy Architecture

**Status:** Implemented — Phases 0–4 merged via [PR #55](https://github.com/kartikmanimuthu/nucleus-cloud-ops/pull/55); autonomy layer + domain skill synthesis on [PR #56](https://github.com/kartikmanimuthu/nucleus-cloud-ops/pull/56)
**Scope:** AI Ops (chat: fast/planning agents) and Agent Ops (autonomous executor graphs)
**Stack:** Native TypeScript · PostgreSQL + pgvector (HNSW) · LangGraph JS · provider-only LLM · strict multi-tenant

---

## 1. Why this exists

Long-running autonomous agents need more than a context window. Before this work, the platform's agents had a single flat semantic store: long chats overflowed the context window, learned facts went stale or duplicated forever, every run started from zero experience, and the agent never improved its own behavior.

This architecture implements the full cognitive-memory stack described in agent research (CoALA's three long-term pillars plus working memory), with the autonomous-maturation loop popularized by the **Hermes agent** (self-authored skills) and **OpenClaw** (accuracy-over-time via memory reconciliation) — built natively in TypeScript on the existing Postgres/pgvector foundation. No LangMem (Python-only), no Mem0 dependency, no new services.

**The maturation loop, end to end:**

```
        run executes ──► rules & facts extracted ──► reconcile judge
             ▲                                            │
             │                                   (dedupe / supersede /
             │                                    reinforce with TTL)
             │                                            │
   auto-selected skill                          rules mature (accessCount ≥ 3)
             ▲                                            │
             │                                            ▼
        skill catalog ◄── enabled system skill ◄── domain skill synthesis
                              (sys-<domain>)      (distiller + rule ledger)
```

Humans steer by **veto** (disable/delete a skill, flip a flag), not by approval gates — except where autonomy would grant the agent new *privileges*, which stays human-only (see §7).

---

## 2. The four memory layers

| Layer | Question | Module | Storage |
|---|---|---|---|
| **Working** | What's happening in *this* run? | `lib/agent/memory/working-memory.ts` | checkpointed graph state + `agent_working_memory` mirror |
| **Semantic** | What do I *know*? | `lib/agent/memory/reconcile.ts` (+ `memory-service.ts`) | `agent_memories` (`kind='SEMANTIC'`) |
| **Episodic** | What have I *experienced*? | `lib/agent/memory/episode.ts` | `agent_memories` (`kind='EPISODIC'`) |
| **Procedural** | How should I *behave*? | `lib/agent/memory/procedural.ts` + `skill-synthesis.ts` | `agent_memories` (`kind='PROCEDURAL'`) → `Skill` rows |

### 2.1 Working memory — surviving long runs

Before each model call, `prepareContext(state, deps, fallbackWindow)` estimates the conversation's token size. Over budget (`WORKING_MEMORY_TOKEN_BUDGET`, default 60k), older turns are **folded** into a rolling `runningSummary` plus a structured scratchpad (`openGoals`, `keyFindings`, `resourceIds`, `pendingSteps`) by the reflector model, and oversized tool outputs are head/tail-compressed. The agent then sees `## Working Memory` + the recent verbatim turns — a compact, faithful view at any run length.

- **Monotonicity is enforced in code, not by the LLM**: the scratchpad is *merged* (union + dedupe) with the prior one, so a recorded goal can never be silently dropped by a summarization call.
- Live state rides the LangGraph checkpoint; each compaction mirrors a durable snapshot to `agent_working_memory`.

### 2.2 Semantic memory — facts that stay accurate

At run end, an extractor LLM pulls facts (`{fact, source, confidence}`) from the transcript. Each fact then passes the **reconcile judge** instead of being blindly upserted:

```
extracted fact ──► top-5 similar live memories (pgvector, distance ≤ 0.55)
                        │
        none near ──► ADD (fast path, no LLM)
                        │
                        ▼
             ONE batched judge call per run
   ┌─────────┬─────────┬────────────┬────────────┬───────┐
   │   ADD   │ UPDATE  │ SUPERSEDE  │ REINFORCE  │ NOOP  │
   │ novel   │ merge   │ contradic- │ duplicate: │ drop  │
   │ insert  │ in place│ tion: new  │ TTL +90d,  │       │
   │         │ re-embed│ row wins,  │ accessCount│       │
   │         │         │ old marked │ ++         │       │
   └─────────┴─────────┴────────────┴────────────┴───────┘
```

- **SUPERSEDE requires explicit contradiction** (mutually exclusive claims), never mere similarity; when uncertain the judge keeps both (ADD).
- Superseded rows are never deleted — `supersededById`/`supersededAt` form an audit trail; recall and the Memory-module UI filter them out.
- A **partial unique index** (`(tenantId, namespace, key) WHERE supersededById IS NULL`) lets a superseded fact and its same-key successor coexist — the common case, since a corrected fact usually re-extracts under the same key.
- **REINFORCE refreshes the 90-day TTL**, so persistently-true facts stop expiring, and `accessCount` becomes the maturity signal used downstream.
- Failure containment at every level: judge error, bad JSON, invalid target → degrade to plain ADD; one bad fact never blocks siblings; `reconcileMemories` never throws.

### 2.3 Episodic memory — experience replay

After each **tool-using** run, a distiller condenses the run into one cognitive snapshot — `{context, reasoning, action, outcome}` — or returns `SKIP` for routine work. **Failures are captured deliberately**: "what didn't work and why" is the most valuable experience. One episode per thread, refreshed in place (bounded store).

On a new task, the 1–2 most similar past episodes (distance ≤ 0.65, no extra LLM call) replay as a structured few-shot block:

```
### Past experience (similar previous sessions)
**Situation:** … **Approach:** … **Actions taken:** … **Outcome:** …
```

### 2.4 Procedural memory — learned operating rules

The same extraction call captures **operating rules** (`{instruction, trigger, evidence, confidence}`) — but *only* from corrections, recovered failures, or explicit behavioral preferences. Rules ride the same reconcile judge (a changed rule SUPERSEDEs; a re-proven rule REINFORCEs), so `accessCount` naturally measures rule maturity. The top-3 similar rules inject at task start:

```
### Operating rules (learned)
- When <trigger>: <instruction>
```

### 2.5 Composition — zero agent wiring

All three long-term layers compose into the **single existing `memoryContext` channel** (facts → rules → episodes), so episodic and procedural recall required *no changes* to the agent graph files. Facts-only output is byte-identical to the pre-refactor format.

---

## 3. The autonomy layer (Hermes loop)

### 3.1 Auto skill selection in chat (progressive disclosure)

When a chat message arrives with **no skill selected**, the route makes one cheap reflector call matching the message against the skill catalog (`getSkillSummaries`) and activates the best skill's full content — metadata-match → load-body, the Hermes disclosure pattern. Guards: returned slugs are validated against the *enabled* catalog (hallucinated/disabled slugs rejected); manual selection always wins; deep mode excluded; failure never breaks the request. When nothing matches, the agent still sees the catalog so it knows what skills exist.

### 3.2 Domain-level skill synthesis (autonomous skill authoring)

Replaces naive per-rule promotion (retired after live feedback showed one-line "skills" that crowded the single active-skill slot). The unit of promotion is a **domain** (`procedures/<domain>`):

```
domain reaches ≥ SKILL_SYNTHESIS_MIN_RULES matured rules (accessCount ≥ threshold)
        │
        ▼  (at most ONE domain per run — the one with most unincorporated rules)
ownership guard ── user-owned slug? ──► skip forever (user skills inviolable)
        │          disabled system skill? ──► durable veto: acknowledge rules, touch nothing
        ▼
gather ALL matured rules + episode evidence (provenance join: episodes from
the runs that taught the rules)
        │
        ▼
distiller LLM ──► { name, description, narrative }   (Purpose / When to use /
        │                                              Workflow guidance / Safety notes)
        ▼
CODE appends the ledger ──► "## Learned rules & gotchas" — EVERY matured rule,
        │                    deterministic order (can't be lost to LLM omission)
        ▼
create sys-<domain> (source:'system', isEnabled:true, tier:'read-only' LOCKED)
   or update existing — payload strictly { content, description }
        │
        ▼
stamp rules `synthesizedIntoSkill` (idempotence; deletion never resurrects
knowledge silently — re-creation only when genuinely NEW rules mature)
```

The skill **grows** as the domain matures — re-synthesis is total, folding old and new rules into one refreshed playbook.

### 3.3 Both execution paths learn

- **AI Ops (chat)**: fast + planning agents run `memory_recall → … → memory_save` plus per-call `prepareContext` compaction.
- **Agent Ops (autonomous)**: the executor graphs originally had *no* automatic memory; they now wire the same shared nodes (`START → memory_recall → evaluator`, `final → memory_save → END`) via a minimal structural `MemoryNodeState` typing, with recalled context injected into planner/executor/reviser prompts. Autonomous runs recall, learn, and trigger synthesis — interrupted or clarify-terminated runs deliberately skip the save (only completed runs teach).

---

## 4. Data model

```
agent_memories                          agent_working_memory
├── id, tenantId, userId               ├── id, tenantId, threadId (unique pair)
├── namespace  (e.g. procedures/aws-cli)├── runningSummary (text)
├── key        (unique among LIVE rows │├── scratchpad (json)
│               per tenant+namespace)  ├── tokenCount, turnCount
├── value      (json, shape per kind)  └── expiresAt (TTL)
├── kind       SEMANTIC|EPISODIC|PROCEDURAL
├── embedding  vector(1024), HNSW cosine index
├── sourceThreadId                     Skill (existing model, consumed here)
├── supersededById / supersededAt      ├── source: 'user' | 'system'
├── lastAccessedAt / accessCount       ├── tier: read-only|mutation|approval-gated
└── createdAt / updatedAt / expiresAt  └── isEnabled, sourceRunId, slug unique/tenant
```

Key index decisions:
- **HNSW (`vector_cosine_ops`)** on `embedding` — similarity search stays fast at scale.
- **Partial unique** `(tenantId, namespace, key) WHERE supersededById IS NULL` — uniqueness applies to live rows only, enabling the same-key supersede audit trail. All upsert sites use the matching `ON CONFLICT … WHERE` form.
- Value shapes by kind: semantic `{fact, source, confidence}` · episodic `{context, reasoning, action, outcome}` · procedural `{instruction, trigger, evidence, confidence, synthesizedIntoSkill?}`.

`MemoryService` (`lib/agent/memory/memory-service.ts`) is the single tenant-scoped gateway: `recall` (kind-filtered vector search returning ids + distances, updates access stats), `remember` (embed + live-row upsert, returns id), `update`, `supersede`, `reinforce`, and working-memory get/put. Embedding failures are always non-fatal (store without vector; recall degrades to recency).

---

## 5. Runtime walkthrough (one chat run)

```
POST /api/chat  (no skill selected)
 1. 🎯 auto-select: reflector matches message → activates 'sys-aws-cli' (or none + catalog)
 2. graph created; skill content + catalog resolved once
 3. memory_recall:
      🧠 [RECALL:facts]    8 hits (d=…) → LLM filter kept 3
      🧠 [RECALL:rules]    paginate-list-calls d=0.31 kept
      🧠 [RECALL:episodes] thread-abc d=0.42 replayed
      🧠 [RECALL]          memoryContext assembled: facts+rules+episodes
 4. agent loop: prepareContext folds old turns when over token budget
      (## Working Memory + recent turns; reflection cycles as usual)
 5. memory_save:
      🧠 [SAVE]  extracted 3 SEMANTIC + 1 PROCEDURAL (confidence-gated)
      🧠 [JUDGE] per-fact verdicts (ADD / UPDATE / SUPERSEDE→id / REINFORCE / NOOP)
      🧠 [EPISODE] distilled & saved (or SKIP)
      🎯 [SKILL-SYNTH] domain matured? → synthesize/refresh sys-<domain>
```

Agent Ops runs follow the same recall/save shape around their evaluator → plan/execute → final pipeline.

---

## 6. Module map

| Module (`apps/web-ui/lib/agent/…`) | Responsibility |
|---|---|
| `memory/memory-service.ts` | tenant-scoped data gateway (recall/remember/update/supersede/reinforce + WM get/put) |
| `memory/working-memory.ts` | token budgeting, tool-log compression, `prepareContext`, monotonic summary folding |
| `memory/reconcile.ts` | save-time conflict resolution (batched judge, per-fact verdicts, never throws) |
| `memory/episode.ts` | episode capture (distiller + SKIP veto) & replay formatting; `composeMemoryContext` |
| `memory/procedural.ts` | rule formatting, extraction-item validation, recall constants |
| `memory/skill-synthesis.ts` | domain-level autonomous skill authoring (narrative + code-guaranteed ledger) |
| `memory/log.ts` | `MEMORY_LOG_VERBOSE` gate for full-content dumps |
| `memory/types.ts` | `MemoryKind`, per-kind value shapes, `MemoryHit`, `MemoryNodeState`, … |
| `memory-nodes.ts` | shared `memory_recall` / `memory_save` graph nodes (both execution paths) |
| `auto-skill-select.ts` | chat-time skill auto-selection (reflector catalog match) |
| `agent-memory/promote.ts` + Memory-module UI | human-reviewed per-rule Promote-to-skill (manual path, kept) |

---

## 7. Safety model

| Invariant | Enforcement |
|---|---|
| Auto-created skills are **always `tier: 'read-only'`** | string literal in code; re-synthesis payload allowlist `{content, description}` — the agent can never grant itself mutation privileges; a human raises tiers |
| User-authored skills are **inviolable** | ownership guard on slug (including the create-race path, test-pinned) |
| Disabling a system skill is a **durable veto** | rules get acknowledged, the skill is never touched while disabled |
| Tenant isolation | every raw query binds `tenantId` explicitly (the Prisma tenant extension does not intercept `$queryRaw`); all repo/service calls tenant-scoped |
| Nothing autonomous can break a run | every autonomy/memory step is non-fatal by contract (warn + degrade to legacy behavior) |
| Full rollback | every layer has a flag; flag-off is byte-identical legacy behavior |

## 8. Feature flags & tuning

| Env var | Default | Controls |
|---|---|---|
| `WORKING_MEMORY_ENABLED` / `_TOKEN_BUDGET` / `_KEEP_RECENT` | true / 60000 / 8 | in-session compaction |
| `MEMORY_RECONCILE_ENABLED` | true | save-time judge (off = blind upserts) |
| `EPISODIC_MEMORY_ENABLED` | true | episode capture + replay |
| `PROCEDURAL_MEMORY_ENABLED` | true | rule extraction + injection (+ gates synthesis) |
| `AUTO_SKILL_SELECTION_ENABLED` | true | chat auto-selection + catalog injection |
| `AUTO_SKILL_CREATION_ENABLED` | true | domain skill synthesis |
| `AUTO_SKILL_MATURITY_THRESHOLD` / `SKILL_SYNTHESIS_MIN_RULES` | 3 / 3 | rule maturity / domain qualification |
| `MEMORY_LOG_VERBOSE` | true | full memoryContext dumps (summary lines always on) |

Similarity gates (module constants): reconcile 0.55 · episodes/rules 0.65 — tune from the `🧠 [RECALL:*] d=…` logs.

## 9. Observability quick reference

All memory activity is narrated on the server console:

- `🧠 [RECALL:facts|rules|episodes]` — per-hit keys, distances, kept/dropped verdicts
- `🧠 [RECALL]` — injection summary + (verbose) the full injected block
- `🧠 [SAVE]` — extraction results by kind · `🧠 [JUDGE]` — per-fact reconcile verdicts
- `🧠 [EPISODE]` — capture/SKIP · `🎯 [SKILL AUTO-SELECT]` — match + reasoning
- `🎯 [SKILL-SYNTH]` — domain qualification, create/refresh/veto outcomes
- `LLM_AUDIT=1` additionally prints full prompts (pre-existing facility)

## 10. Verification

- **180 unit tests** across the memory/skill suites: fast-check invariants (window budget, suffix ordering), summary-folding monotonicity, every judge action and failure-containment path, capture/replay edge cases, synthesis security invariants (tier lock, update allowlist, all three stamp behaviors, P2002 races), migration coexistence verified against a live database.
- Zero new TypeScript errors across the entire effort (pre-existing baseline independently re-verified at each phase).
- Every phase built task-by-task with per-task spec+quality reviews and a final whole-phase review — **six clean final verdicts**, including a dedicated security pass on the autonomy surface.
- Full specs and implementation plans per phase live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## 11. Known limitations / future work

- Deep-agent keeps its separate MongoDB store (explicitly descoped — not in the current use case).
- Re-enabled synthesized skills refresh on the next *new* matured rule, not immediately.
- Distiller-refresh of skill *names*, delta (incremental) synthesis for very large domains, and smarter episode selection are deferred.
- Minor deferrals tracked on PR #56 (e.g. superseded-row filter on recall's access-stat bump, `RunnableConfig` typing).
