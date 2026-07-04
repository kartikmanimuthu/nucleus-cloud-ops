# Domain-Level Skill Synthesis (Auto-Skill Redesign, Option 1)

**Status:** Approved design (user selected Option 1 after reviewing live output of the per-rule promoter)
**Date:** 2026-07-04
**Branch:** `agent-memory` (continues PR #56)

---

## Problem

The shipped auto-skill creator (`skill-autogen.ts`, PR #56) promotes **one matured procedural rule into one skill**. Live usage proved the granularity wrong: a rule is a one-line operating instruction ("use `StartDate`/`EndDate` in `aws ce get-anomalies`"), while a Skill in this platform is a *playbook* (persona, workflow, safety). The result — e.g. the real "Ce Get Anomalies Correct Params" skill — is:

1. **Tiny** — a one-line tip wearing a skill costume, with a mechanical name and fragment description.
2. **Redundant** — the same rule already reaches the agent automatically via the `### Operating rules (learned)` recall injection.
3. **Actively harmful to selection** — exactly one skill is active per run; a tiny rule-skill chosen by the auto-selector crowds out a real playbook (e.g. Cost Analyser) from the only slot.

## Goal

Promote **domains, not rules**. When a procedural domain (`procedures/<domain>`) accumulates enough matured material, a distiller LLM synthesizes **one rich system skill per domain** — narrative playbook plus a code-guaranteed ledger of every matured rule — and **re-synthesizes it as more rules mature**, so the skill grows instead of spawning siblings.

### Decisions locked during design

- **Matured rules only** feed synthesis (`accessCount ≥ AUTO_SKILL_MATURITY_THRESHOLD`, default 3). Immature rules keep flowing through the Operating-rules injection until proven. A domain qualifies at `SKILL_SYNTHESIS_MIN_RULES` (new env, default 3) matured rules.
- **One skill per domain**, deterministic slug `sys-<domain>` (e.g. `sys-aws-cli`). Creation: `source:'system'`, `isEnabled:true` (standing Hermes directive), **`tier:'read-only'` locked** (unchanged invariant). Re-synthesis updates **content + description only** — `isEnabled` (user veto) and `name` (possible user edit) are preserved.
- **Rule-ledger monotonicity in code, not LLM:** the distiller writes the narrative sections; code appends a deterministic `## Learned rules & gotchas` section built from every matured rule — a rule can never be lost to distiller omission (same principle as working-memory folding).
- **Episode grounding via provenance join:** episodes whose key is `thread-<rule.sourceThreadId>` (the runs that taught the rules) are supplied to the distiller as outcome evidence (cap 3).
- **Veto semantics:** *disabled* system skill → full veto: rules are marked as incorporated but the skill is not touched (content not refreshed while disabled). *Deleted* system skill → holds until genuinely new knowledge (a new unmarked matured rule) triggers re-creation; users are guided to disable rather than delete for a permanent veto. A `sys-<domain>` slug owned by `source:'user'` → never touched, domain skipped with a warning (user skills are inviolable).
- **Cost bound:** at most **one domain synthesized per run** (the one with the most unincorporated matured rules); synthesis is one extra reflector call in the run tail.
- **Old path retired:** per-rule promotion (`skill-autogen.ts`) is deleted, its two env accessors move to the new module. Old `promotedSkillSlug` markers are ignored (rules carrying them but lacking the new marker are treated as unincorporated — so the live `ce get-anomalies` rule will be folded properly into `sys-aws-cli`). The user's disabled tiny skill is left alone (they can delete it). The *manual* Promote-to-skill button (human-reviewed, editable dialog) stays as-is — out of scope.
- Executed autonomously through spec → plan → build per the user's explicit directive.

### Non-goals

- Auto-editing user-authored skills (including user-edited *names* of system skills).
- Cross-domain skill merging, skill deletion/pruning, or auto-tier changes.
- Changing the Operating-rules injection, the auto-selector, or the manual promote flow.

---

## Current State (grounding — verified)

- `lib/agent/memory/skill-autogen.ts` — per-rule promoter: maturity `$queryRaw` (tenant-bound, `accessCount ≥ threshold`, `("value"->>'promotedSkillSlug') IS NULL`, LIMIT 5), `getBySlug` idempotence, P2002 handling, marker stamp via `MemoryService.update` (read-merge-write, re-embeds), `🎯 [AUTO-SKILL]` logs. Called in `memorySaveNode` tail: `if (proceduralMemoryEnabled()) await autoCreateSkillsFromMaturedRules({ tenantId, threadId: threadIdForEpisode });` with `reflectorModel` in scope.
- Procedural memories: `kind='PROCEDURAL'`, namespace `procedures/<domain>`, value `{instruction, trigger, evidence, confidence, [promotedSkillSlug]}`, `sourceThreadId`, `accessCount`.
- Episodes: `kind='EPISODIC'`, namespace `episodes`, key `thread-<threadId>`, value `{context, reasoning, action, outcome}`.
- `ISkillRepository`: `getBySlug`, `create(SkillCreateInput — all fields required)`, `update(tenantId, id, SkillUpdateInput — Partial<name|description|tier|content|isEnabled|slug>)`; duplicate slug → Prisma P2002; `slugify` exported from skill-service.
- Env accessors precedent; `MemoryService.update(tenantId, id, value)` full-value replace (marker stamping = read-merge-write).

---

## Design

### New `lib/agent/memory/skill-synthesis.ts` (replaces `skill-autogen.ts`)

```typescript
export function autoSkillCreationEnabled(): boolean;      // moved from skill-autogen (AUTO_SKILL_CREATION_ENABLED, default true)
export function autoSkillMaturityThreshold(): number;     // moved (AUTO_SKILL_MATURITY_THRESHOLD, default 3)
export function skillSynthesisMinRules(): number;         // NEW  (SKILL_SYNTHESIS_MIN_RULES, default 3)
export async function synthesizeDomainSkills(params: {
    tenantId: string;
    threadId?: string;                 // provenance → sourceRunId on create
    distillerModel: BaseChatModel;     // the node's reflector model
}): Promise<number>;                   // domains synthesized this run (0 or 1); never throws
```

Pipeline:

1. **Candidate domains** (one tenant-bound `$queryRaw`): live procedural memories grouped by domain — `split_part("namespace", '/', 2)` — with `accessCount >= maturityThreshold`, counting rules missing the new marker `("value"->>'synthesizedIntoSkill') IS NULL` as *pending*. Rows whose namespace lacks a domain segment (`split_part` returns `''`) are excluded (`AND split_part("namespace", '/', 2) <> ''`) — no `sys-` slug can ever be minted from a bare `procedures` namespace. A domain qualifies when `total matured ≥ skillSynthesisMinRules()` AND `pending ≥ 1`. Pick the single domain with the most pending rules.
2. **Gather material** for that domain: ALL matured rules (marked + pending — re-synthesis is total, not incremental), plus up to 3 episodes joined by `key IN ('thread-' || rule.sourceThreadId)` (distinct, non-null).
3. **Ownership guard:** `getBySlug(tenantId, 'sys-<domain>')`:
   - exists with `source:'user'` → warn, **stamp nothing, skip domain permanently** (it will be re-picked and re-skipped; log makes it visible — acceptable, costs one query).
   - exists with `source:'system'` and `isEnabled:false` → **veto**: stamp all pending rules, skip synthesis (no content refresh while disabled).
   - exists enabled system / or absent → proceed.
4. **Distill** (one reflector call): input = domain, every matured rule (instruction/trigger/evidence), episode evidence (context + outcome), and the existing skill content when updating (for continuity). Output strict JSON `{ "name": ..., "description": ..., "narrative": ... }` where `narrative` is markdown covering: Purpose, When to use this skill, Workflow guidance, Safety notes. Parse/validation failure → warn, **no stamp** (retry next run), return 0.
5. **Assemble content** (code, not LLM):
   ```
   <narrative>

   ## Learned rules & gotchas
   - When <trigger>: <instruction> — evidence: <evidence>
   ...one line per matured rule, deterministic order (accessCount desc, then key)...

   _Synthesized by the agent from <N> matured procedural rules. Managed automatically — content refreshes as new rules mature; disable this skill to stop updates._
   ```
6. **Create or update:**
   - absent → `create` with `{ slug: 'sys-<domain>', name, description, tier: 'read-only', content, source: 'system', isEnabled: true, createdBy: null, sourceRunId: threadId ?? null }`; P2002 race → re-fetch and fall through to update.
   - enabled system skill → `update(tenantId, skill.id, { content, description })` (name/isEnabled untouched).
7. **Stamp** all pending rules `{ ...value, synthesizedIntoSkill: 'sys-<domain>' }` via `MemoryService.update` (after successful create/update or on the disabled-veto path).
8. Logs: `🎯 [SKILL-SYNTH] Domain 'aws-cli': 4 matured rules (2 new) → synthesizing…`, `… → created skill 'sys-aws-cli' (system, enabled, read-only)` / `… → refreshed skill 'sys-aws-cli' content` / veto/skip reasons.

### Call-site swap (`memory-nodes.ts` tail)

```typescript
        if (proceduralMemoryEnabled()) {
            await synthesizeDomainSkills({ tenantId, threadId: threadIdForEpisode, distillerModel: reflectorModel });
        }
```

`skill-autogen.ts` + its test are **deleted**.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AUTO_SKILL_CREATION_ENABLED` | `true` | gates synthesis entirely (unchanged name — it's the same feature, better unit) |
| `AUTO_SKILL_MATURITY_THRESHOLD` | `3` | per-rule maturity (unchanged) |
| `SKILL_SYNTHESIS_MIN_RULES` | `3` | matured rules a domain needs before it earns a skill |

---

## Files Touched

| File | Change |
|---|---|
| `lib/agent/memory/skill-synthesis.ts` (+test) | **new** — the pipeline above |
| `lib/agent/memory/skill-autogen.ts` (+test) | **deleted** |
| `lib/agent/memory-nodes.ts` | import + tail-call swap |
| `env.ts` + `.env.example` | `SKILL_SYNTHESIS_MIN_RULES`; comment updates |
| `CLAUDE.md` | replace the skill-autogen row |

## Testing

- **skill-synthesis.ts (mocked prisma/repo/service/distiller):** domain qualifies (3 matured, 1 pending) → distill + create with exact shape (slug `sys-aws-cli`, tier read-only, enabled, ledger contains EVERY rule line) + all pending stamped; existing enabled system skill → `update` with content+description only; disabled system skill → stamp-only, no distill call; user-owned slug → skip, nothing stamped, warn; distiller garbage → no stamp, 0; episodes joined by sourceThreadId appear in distiller input; pending=0 → no work; below MIN_RULES → no work; flag off → no query; query throw → 0, no throw; LIMIT: two qualifying domains → only the one with more pending synthesized.
- **memory-nodes:** typecheck + existing suites green (call-site swap only).
- **Manual smoke:** with the live tenant, next tool-using run should log `🎯 [SKILL-SYNTH] Domain 'aws-cli' …` and produce `sys-aws-cli` containing the StartDate/EndDate rule inside a full playbook; the disabled tiny skill stays untouched.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Distiller writes a poor narrative | rule ledger is code-appended (knowledge never lost); content refreshes next maturation; human can edit/disable |
| Re-synthesis clobbers user edits to a system skill's content | documented behavior (footer says "managed automatically; disable to stop updates"); name + isEnabled preserved; user skills never touched |
| Repeated skip-loop on user-owned `sys-<domain>` slug | one query + one warn per run — visible and cheap; rules remain available via Operating-rules injection |
| Extra LLM call in run tail | at most one domain per run; only when a domain has pending matured rules |
| Old markers linger | `promotedSkillSlug` ignored by design; rules re-incorporated into proper domain skills |

## Open Questions

None blocking. Deferred: distiller-refresh of `name`; incremental (delta) synthesis if domains grow very large; episode selection smarter than provenance join.
