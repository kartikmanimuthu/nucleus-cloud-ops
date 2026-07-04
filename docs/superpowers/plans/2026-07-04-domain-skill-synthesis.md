# Domain-Level Skill Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-rule skill promotion with one rich, re-synthesized system skill per procedural domain — distiller narrative + code-guaranteed rule ledger.

**Architecture:** New `skill-synthesis.ts` runs in `memorySaveNode`'s tail: one tenant-bound query finds the domain with the most unincorporated matured rules; a reflector call authors narrative sections; code appends a deterministic `## Learned rules & gotchas` ledger from every matured rule (monotonicity in code); create (`sys-<domain>`, system, enabled, read-only) or content+description update; pending rules stamped `synthesizedIntoSkill`. Disabled system skill = veto (stamp-only); user-owned slug = untouchable; one domain per run. `skill-autogen.ts` is deleted.

**Tech Stack:** TypeScript 5, existing MemoryService/ISkillRepository, Vitest.

## Global Constraints

- **`synthesizeDomainSkills` NEVER throws** — 0/warn on any failure; distiller failure → NO stamp (retry next run).
- **`tier: 'read-only'` hardcoded on create; `update` payload is ONLY `{ content, description }`** — `isEnabled`, `name`, `tier`, `slug` never touched on update.
- **User skills inviolable:** `getBySlug` hit with `source !== 'system'` → skip domain, stamp nothing, warn.
- **Disabled system skill = veto:** stamp pending rules, skip distill/update entirely.
- **Ledger completeness:** every matured rule appears in the assembled content, deterministic order (`accessCount` DESC, `key` ASC) — appended by code after the narrative.
- **Multi-tenant:** every raw query binds `tenantId` explicitly; skill writes via `getSkillRepository()` (tenant-scoped).
- **Flags:** `AUTO_SKILL_CREATION_ENABLED` (default true, gates everything), `AUTO_SKILL_MATURITY_THRESHOLD` (default 3), `SKILL_SYNTHESIS_MIN_RULES` (new, default 3) — process.env accessor pattern.
- **Domain safety:** namespaces without a second segment are excluded in SQL (`split_part(...) <> ''`); SQL `COUNT` cast `::int` (avoid BigInt).
- **Log prefix `🎯 [SKILL-SYNTH]`** exactly.
- Named exports, 4-space indent. Known tsc baselines unchanged (zero new errors).

---

## Interfaces (locked)

```typescript
// skill-synthesis.ts
export function autoSkillCreationEnabled(): boolean;      // moved from skill-autogen, same env var
export function autoSkillMaturityThreshold(): number;     // moved, same env var
export function skillSynthesisMinRules(): number;         // SKILL_SYNTHESIS_MIN_RULES, default 3
export async function synthesizeDomainSkills(params: {
    tenantId: string;
    threadId?: string;
    distillerModel: BaseChatModel;
}): Promise<number>;                                       // 0 or 1; never throws
```

---

## Task 1: skill-synthesis module

**Files:**
- Create: `apps/web-ui/lib/agent/memory/skill-synthesis.ts`
- Create: `apps/web-ui/lib/agent/memory/skill-synthesis.test.ts`

**Interfaces:**
- Consumes: `getPrismaClient` (`@/lib/db/pg-config`), `getSkillRepository` (`@/lib/db/repository-factory`), `getMemoryService` (`./memory-service`), `BaseChatModel`.
- Produces: the Interfaces block above.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/lib/agent/memory/skill-synthesis.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQueryRaw = vi.fn();
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => ({ $queryRaw: mockQueryRaw }) }));
vi.mock('@/lib/db/repository-factory', () => ({ getSkillRepository: vi.fn() }));
vi.mock('./memory-service', () => ({ getMemoryService: vi.fn() }));

import { getSkillRepository } from '@/lib/db/repository-factory';
import { getMemoryService } from './memory-service';
import {
    synthesizeDomainSkills, autoSkillCreationEnabled, autoSkillMaturityThreshold, skillSynthesisMinRules,
} from './skill-synthesis';

const mockRepo = { getBySlug: vi.fn(), create: vi.fn(), update: vi.fn() };
const mockSvc = { update: vi.fn() };

const candidateRow = { domain: 'aws-cli', matured: 3, pending: 2 };
const rule = (id: string, key: string, marked = false) => ({
    id, key,
    value: {
        instruction: `instruction for ${key}`, trigger: `trigger for ${key}`, evidence: `evidence for ${key}`,
        confidence: 'high', ...(marked ? { synthesizedIntoSkill: 'sys-aws-cli' } : {}),
    },
    sourceThreadId: `th-${id}`, accessCount: 4,
});
const episodeRow = { key: 'thread-r1', value: { context: 'ctx', reasoning: 'rsn', action: 'act', outcome: 'SUCCEEDED' } };

const distillerReturning = (content: string) => ({ invoke: vi.fn().mockResolvedValue({ content }) }) as any;
const goodDistill = JSON.stringify({
    name: 'AWS CLI Operations', description: 'Reliable AWS CLI usage patterns.',
    narrative: '## Purpose\nUse the AWS CLI safely.\n\n## When to use\nAny CLI task.',
});
const base = { tenantId: 't1', threadId: 'th-run' };

function primeQueries(opts: { candidates?: unknown[]; rules?: unknown[]; episodes?: unknown[] } = {}) {
    mockQueryRaw.mockReset();
    mockQueryRaw
        .mockResolvedValueOnce(opts.candidates ?? [candidateRow])          // 1: candidate domains
        .mockResolvedValueOnce(opts.rules ?? [rule('r1', 'paginate-list-calls'), rule('r2', 'use-startdate-enddate'), rule('r3', 'check-region', true)]) // 2: domain rules
        .mockResolvedValueOnce(opts.episodes ?? [episodeRow]);            // 3: episodes
}

beforeEach(() => {
    vi.clearAllMocks();
    primeQueries();
    mockRepo.getBySlug.mockResolvedValue(null);
    mockRepo.create.mockResolvedValue({ id: 's1' });
    mockRepo.update.mockResolvedValue({ id: 's1' });
    mockSvc.update.mockResolvedValue(undefined);
    vi.mocked(getSkillRepository).mockReturnValue(mockRepo as any);
    vi.mocked(getMemoryService).mockReturnValue(mockSvc as any);
});
afterEach(() => {
    delete process.env.AUTO_SKILL_CREATION_ENABLED;
    delete process.env.AUTO_SKILL_MATURITY_THRESHOLD;
    delete process.env.SKILL_SYNTHESIS_MIN_RULES;
});

describe('flags', () => {
    it('defaults + env overrides', () => {
        expect(autoSkillCreationEnabled()).toBe(true);
        expect(autoSkillMaturityThreshold()).toBe(3);
        expect(skillSynthesisMinRules()).toBe(3);
        process.env.SKILL_SYNTHESIS_MIN_RULES = '5';
        expect(skillSynthesisMinRules()).toBe(5);
    });
});

describe('synthesizeDomainSkills', () => {
    it('creates sys-<domain> with narrative + complete ledger and stamps pending rules only', async () => {
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(1);
        expect(mockRepo.create).toHaveBeenCalledWith('t1', expect.objectContaining({
            slug: 'sys-aws-cli', name: 'AWS CLI Operations', source: 'system',
            isEnabled: true, tier: 'read-only', sourceRunId: 'th-run',
        }));
        const content = mockRepo.create.mock.calls[0][1].content as string;
        expect(content).toContain('## Purpose');
        expect(content).toContain('## Learned rules & gotchas');
        // EVERY matured rule in the ledger — including the already-marked one
        expect(content).toContain('instruction for paginate-list-calls');
        expect(content).toContain('instruction for use-startdate-enddate');
        expect(content).toContain('instruction for check-region');
        // stamps ONLY the two pending rules
        expect(mockSvc.update).toHaveBeenCalledTimes(2);
        expect(mockSvc.update).toHaveBeenCalledWith('t1', 'r1', expect.objectContaining({ synthesizedIntoSkill: 'sys-aws-cli' }));
        expect(mockSvc.update).toHaveBeenCalledWith('t1', 'r2', expect.objectContaining({ synthesizedIntoSkill: 'sys-aws-cli' }));
    });

    it('existing ENABLED system skill → update content+description only', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-x', source: 'system', isEnabled: true, content: 'old' });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(1);
        expect(mockRepo.create).not.toHaveBeenCalled();
        const [tenant, id, patch] = mockRepo.update.mock.calls[0];
        expect(tenant).toBe('t1');
        expect(id).toBe('s-x');
        expect(Object.keys(patch).sort()).toEqual(['content', 'description']);
    });

    it('existing DISABLED system skill → veto: stamp pending, no distill, no update', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-x', source: 'system', isEnabled: false, content: 'old' });
        const distiller = distillerReturning(goodDistill);
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distiller });
        expect(n).toBe(0);
        expect(distiller.invoke).not.toHaveBeenCalled();
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockSvc.update).toHaveBeenCalledTimes(2); // pending rules stamped
    });

    it('user-owned slug → skip domain, stamp NOTHING, no writes', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-x', source: 'user', isEnabled: true, content: 'mine' });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('distiller garbage → no writes, no stamps (retry next run)', async () => {
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning('not json at all') });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('distiller output missing a field → treated as invalid', async () => {
        const bad = JSON.stringify({ name: 'X', narrative: '' });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(bad) });
        expect(n).toBe(0);
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('episode material is included in the distiller input', async () => {
        const distiller = distillerReturning(goodDistill);
        await synthesizeDomainSkills({ ...base, distillerModel: distiller });
        const messages = distiller.invoke.mock.calls[0][0];
        const human = String(messages[1].content);
        expect(human).toContain('SUCCEEDED');
    });

    it('no qualifying domain → 0, nothing else queried', async () => {
        primeQueries({ candidates: [] });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it('flag off → 0 without any query', async () => {
        process.env.AUTO_SKILL_CREATION_ENABLED = 'false';
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('candidate query throwing → 0, does not throw', async () => {
        mockQueryRaw.mockReset();
        mockQueryRaw.mockRejectedValue(new Error('db down'));
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
    });

    it('P2002 create race → re-fetches and updates instead', async () => {
        mockRepo.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
        mockRepo.getBySlug
            .mockResolvedValueOnce(null) // ownership check: absent
            .mockResolvedValueOnce({ id: 's-race', source: 'system', isEnabled: true, content: 'old' }); // re-fetch after P2002
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(1);
        expect(mockRepo.update).toHaveBeenCalledWith('t1', 's-race', expect.objectContaining({ content: expect.any(String) }));
        expect(mockSvc.update).toHaveBeenCalledTimes(2);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/skill-synthesis.test.ts`
Expected: FAIL — `Cannot find module './skill-synthesis'`.

- [ ] **Step 3: Implement `skill-synthesis.ts`**

```typescript
/**
 * skill-synthesis.ts — domain-level autonomous skill synthesis (Hermes v2).
 *
 * Replaces per-rule promotion: when a procedural domain accumulates enough
 * MATURED rules, a distiller authors a narrative playbook and code appends a
 * deterministic ledger of every matured rule (knowledge can never be lost to
 * distiller omission). One system skill per domain (`sys-<domain>`), content
 * re-synthesized as rules mature. Tier is LOCKED 'read-only'. Disabled system
 * skill = veto (stamp, don't touch). User-owned slugs are inviolable.
 * At most one domain per run. Never throws.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getPrismaClient } from '@/lib/db/pg-config';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { getMemoryService } from './memory-service';

export function autoSkillCreationEnabled(): boolean {
    const v = process.env.AUTO_SKILL_CREATION_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export function autoSkillMaturityThreshold(): number {
    const n = Number(process.env.AUTO_SKILL_MATURITY_THRESHOLD);
    return Number.isFinite(n) && n > 0 ? n : 3;
}

export function skillSynthesisMinRules(): number {
    const n = Number(process.env.SKILL_SYNTHESIS_MIN_RULES);
    return Number.isFinite(n) && n > 0 ? n : 3;
}

const MAX_EPISODES = 3;

interface RuleRow {
    id: string;
    key: string;
    value: Record<string, unknown>;
    sourceThreadId: string | null;
    accessCount: number;
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

const DISTILLER_SYSTEM = new SystemMessage(
    `You author an operational skill document for an AWS cloud-operations agent, distilled from
rules the agent learned across real sessions (with episode evidence where available).
Return ONLY a JSON object: {"name": "...", "description": "...", "narrative": "..."}
- name: concise Title Case skill name (max 6 words) for the domain.
- description: one sentence saying when to use this skill.
- narrative: markdown with exactly these sections: "## Purpose", "## When to use",
  "## Workflow guidance", "## Safety notes". Ground every claim in the provided rules and
  episodes — never invent capabilities. Do NOT include a rules list; it is appended separately.`,
);

export async function synthesizeDomainSkills(params: {
    tenantId: string;
    threadId?: string;
    distillerModel: BaseChatModel;
}): Promise<number> {
    if (!autoSkillCreationEnabled()) return 0;
    try {
        const prisma = getPrismaClient();
        const threshold = autoSkillMaturityThreshold();
        const minRules = skillSynthesisMinRules();

        // 1. Best candidate domain (tenant-bound; bare `procedures` namespaces excluded).
        const candidates = await prisma.$queryRaw<Array<{ domain: string; matured: number; pending: number }>>`
            SELECT split_part("namespace", '/', 2) AS domain,
                   COUNT(*)::int AS matured,
                   (COUNT(*) FILTER (WHERE ("value"->>'synthesizedIntoSkill') IS NULL))::int AS pending
            FROM agent_memories
            WHERE "tenantId" = ${params.tenantId}
              AND "kind" = 'PROCEDURAL'
              AND "supersededById" IS NULL
              AND "accessCount" >= ${threshold}
              AND split_part("namespace", '/', 2) <> ''
            GROUP BY 1
            HAVING COUNT(*) >= ${minRules}
               AND COUNT(*) FILTER (WHERE ("value"->>'synthesizedIntoSkill') IS NULL) >= 1
            ORDER BY 3 DESC
            LIMIT 1
        `;
        if (!candidates.length) return 0;
        const { domain, matured, pending } = candidates[0];
        const slug = `sys-${domain}`;
        console.log(`🎯 [SKILL-SYNTH] Domain '${domain}': ${matured} matured rule(s) (${pending} new) → synthesizing '${slug}'`);

        // 2. Ownership / veto guard.
        const repo = getSkillRepository();
        const svc = getMemoryService();
        const existing = await repo.getBySlug(params.tenantId, slug);
        if (existing && existing.source !== 'system') {
            console.warn(`🎯 [SKILL-SYNTH] Slug '${slug}' is user-owned — domain '${domain}' skipped (user skills are never modified)`);
            return 0;
        }

        // 3. Gather ALL matured rules for the domain (re-synthesis is total).
        const rules = await prisma.$queryRaw<RuleRow[]>`
            SELECT "id","key","value","sourceThreadId","accessCount"
            FROM agent_memories
            WHERE "tenantId" = ${params.tenantId}
              AND "kind" = 'PROCEDURAL'
              AND "supersededById" IS NULL
              AND "accessCount" >= ${threshold}
              AND split_part("namespace", '/', 2) = ${domain}
            ORDER BY "accessCount" DESC, "key" ASC
        `;
        if (!rules.length) return 0;
        const pendingRules = rules.filter((r) => !(r.value as Record<string, unknown>).synthesizedIntoSkill);
        const stampAll = async () => {
            for (const r of pendingRules) {
                try {
                    await svc.update(params.tenantId, r.id, { ...r.value, synthesizedIntoSkill: slug });
                } catch (err: any) {
                    console.warn(`🎯 [SKILL-SYNTH] Failed to stamp rule '${r.key}' (non-fatal): ${err?.message ?? err}`);
                }
            }
        };

        // Disabled system skill = standing veto: acknowledge the rules, touch nothing.
        if (existing && !existing.isEnabled) {
            console.log(`🎯 [SKILL-SYNTH] Skill '${slug}' is disabled (user veto) — stamping ${pendingRules.length} rule(s), skipping refresh`);
            await stampAll();
            return 0;
        }

        // 4. Episode evidence via provenance join (the runs that taught these rules).
        const threadKeys = Array.from(new Set(
            rules.map((r) => r.sourceThreadId).filter((t): t is string => !!t).map((t) => `thread-${t}`),
        ));
        let episodes: Array<{ key: string; value: Record<string, unknown> }> = [];
        if (threadKeys.length) {
            try {
                episodes = await prisma.$queryRaw<Array<{ key: string; value: Record<string, unknown> }>>`
                    SELECT DISTINCT "key","value"
                    FROM agent_memories
                    WHERE "tenantId" = ${params.tenantId}
                      AND "kind" = 'EPISODIC'
                      AND "supersededById" IS NULL
                      AND "key" = ANY(${threadKeys}::text[])
                    LIMIT ${MAX_EPISODES}
                `;
            } catch {
                // evidence is optional
            }
        }

        // 5. Distill the narrative.
        const rulesText = rules.map((r) => {
            const v = r.value as { instruction?: string; trigger?: string; evidence?: string };
            return `- [${r.key}] When ${v.trigger}: ${v.instruction} (evidence: ${v.evidence || 'n/a'}; reinforced ${r.accessCount}x)`;
        }).join('\n');
        const episodesText = episodes.map((e) => {
            const v = e.value as { context?: string; outcome?: string };
            return `- ${v.context ?? '(context n/a)'} → ${v.outcome ?? '(outcome n/a)'}`;
        }).join('\n') || '(none)';
        const input = new HumanMessage(
            `**Domain:** ${domain}\n\n**Matured rules:**\n${rulesText}\n\n` +
            `**Episode evidence:**\n${episodesText}\n\n` +
            `**Existing skill content:**\n${existing?.content ? existing.content.slice(0, 6000) : '(none — new skill)'}\n\n` +
            `Author the skill document now.`,
        );

        const resp = await params.distillerModel.invoke([DISTILLER_SYSTEM, input]);
        const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) {
            console.warn(`🎯 [SKILL-SYNTH] Distiller returned no JSON for '${domain}' — will retry next run`);
            return 0;
        }
        const parsed = JSON.parse(match[0]) as { name?: string; description?: string; narrative?: string };
        if (!isNonEmptyString(parsed.name) || !isNonEmptyString(parsed.description) || !isNonEmptyString(parsed.narrative)) {
            console.warn(`🎯 [SKILL-SYNTH] Distiller output invalid for '${domain}' — will retry next run`);
            return 0;
        }

        // 6. Assemble: narrative + code-guaranteed rule ledger.
        const ledger = rules.map((r) => {
            const v = r.value as { instruction?: string; trigger?: string; evidence?: string };
            return `- When ${v.trigger}: ${v.instruction} — evidence: ${v.evidence || '(not recorded)'}`;
        }).join('\n');
        const skillContent =
            `${parsed.narrative.trim()}\n\n` +
            `## Learned rules & gotchas\n${ledger}\n\n` +
            `_Synthesized by the agent from ${rules.length} matured procedural rules. ` +
            `Managed automatically — content refreshes as new rules mature; disable this skill to stop updates._`;

        // 7. Create or update.
        if (!existing) {
            try {
                await repo.create(params.tenantId, {
                    slug,
                    name: parsed.name.trim(),
                    description: parsed.description.trim(),
                    tier: 'read-only',
                    content: skillContent,
                    source: 'system',
                    isEnabled: true,
                    createdBy: null,
                    sourceRunId: params.threadId ?? null,
                });
                console.log(`🎯 [SKILL-SYNTH] Domain '${domain}' → created skill '${slug}' (system, enabled, read-only, ${rules.length} rules)`);
            } catch (err) {
                if ((err as { code?: string })?.code !== 'P2002') throw err;
                const winner = await repo.getBySlug(params.tenantId, slug);
                if (!winner || winner.source !== 'system') {
                    console.warn(`🎯 [SKILL-SYNTH] '${slug}' created concurrently by another owner — skipping`);
                    return 0;
                }
                await repo.update(params.tenantId, winner.id, { content: skillContent, description: parsed.description.trim() });
                console.log(`🎯 [SKILL-SYNTH] Domain '${domain}' → refreshed '${slug}' after create race`);
            }
        } else {
            await repo.update(params.tenantId, existing.id, { content: skillContent, description: parsed.description.trim() });
            console.log(`🎯 [SKILL-SYNTH] Domain '${domain}' → refreshed skill '${slug}' content (${rules.length} rules)`);
        }

        // 8. Acknowledge incorporation.
        await stampAll();
        return 1;
    } catch (err: any) {
        console.warn(`🎯 [SKILL-SYNTH] Synthesis failed (non-fatal): ${err?.message ?? err}`);
        return 0;
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/skill-synthesis.test.ts`
Expected: PASS (12/12).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/memory/skill-synthesis.ts apps/web-ui/lib/agent/memory/skill-synthesis.test.ts
git commit -m "feat(skills): domain-level skill synthesis — narrative + code-guaranteed rule ledger"
```

---

## Task 2: Wire in, retire skill-autogen, env

**Files:**
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts` (import + tail-call swap)
- Delete: `apps/web-ui/lib/agent/memory/skill-autogen.ts`, `apps/web-ui/lib/agent/memory/skill-autogen.test.ts`
- Modify: `apps/web-ui/env.ts` (add `SKILL_SYNTHESIS_MIN_RULES`) + `.env.example`

**Interfaces:**
- Consumes: `synthesizeDomainSkills` from `./memory/skill-synthesis` (Task 1).

- [ ] **Step 1: memory-nodes swap**

Replace `import { autoCreateSkillsFromMaturedRules } from "./memory/skill-autogen";` with:

```typescript
import { synthesizeDomainSkills } from "./memory/skill-synthesis";
```

Replace the tail block

```typescript
        // Autonomous skill creation — matured rules become enabled system skills (full Hermes).
        if (proceduralMemoryEnabled()) {
            await autoCreateSkillsFromMaturedRules({ tenantId, threadId: threadIdForEpisode });
        }
```

with:

```typescript
        // Autonomous skill synthesis — matured domains become/refresh enabled system skills (full Hermes).
        if (proceduralMemoryEnabled()) {
            await synthesizeDomainSkills({ tenantId, threadId: threadIdForEpisode, distillerModel: reflectorModel });
        }
```

- [ ] **Step 2: Delete the old module**

```bash
git rm apps/web-ui/lib/agent/memory/skill-autogen.ts apps/web-ui/lib/agent/memory/skill-autogen.test.ts
```

Then verify no dangling references: `grep -rn "skill-autogen\|autoCreateSkillsFromMaturedRules" apps/web-ui/ --include="*.ts" --include="*.tsx"` → expect no matches.

- [ ] **Step 3: env plumbing**

`env.ts` — after `AUTO_SKILL_MATURITY_THRESHOLD` add:

```typescript
        SKILL_SYNTHESIS_MIN_RULES: z.string().optional(),
```

`.env.example` — replace the `AUTO_SKILL_CREATION_ENABLED` comment line with:

```
# AUTO_SKILL_CREATION_ENABLED: matured procedural domains auto-become/refresh enabled system skills (read-only tier).
```

and after `AUTO_SKILL_MATURITY_THRESHOLD=3` add:

```
# SKILL_SYNTHESIS_MIN_RULES: matured rules a domain needs before it earns a synthesized skill.
SKILL_SYNTHESIS_MIN_RULES=3
```

- [ ] **Step 4: Verify + commit**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^lib/agent/memory" || echo "clean"`
Expected: all PASS (the skill-autogen tests are gone; synthesis tests in); `clean`.

```bash
git add apps/web-ui/lib/agent/memory-nodes.ts apps/web-ui/env.ts .env.example
git commit -m "feat(skills): route autonomous skill creation through domain synthesis; retire per-rule promoter"
```

---

## Task 3: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (replace the skill-autogen row)

- [ ] **Step 1: Full suites**

Run: `cd apps/web-ui && bunx vitest run lib/agent/ lib/db/repositories/agent-memory/ lib/agent-memory/`
Expected: all PASS (~185).

- [ ] **Step 2: Exact-path typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(lib/agent/memory/|lib/agent/memory-nodes)" || echo "no new errors"`
Expected: `no new errors`.

- [ ] **Step 3: CLAUDE.md**

Replace the `memory/skill-autogen.ts` table row with:

```markdown
| `memory/skill-synthesis.ts` | Domain-level autonomous skill synthesis: when a procedural domain has ≥ `SKILL_SYNTHESIS_MIN_RULES` matured rules, a distiller authors `sys-<domain>` (system, enabled, read-only) with a code-guaranteed rule ledger, re-synthesized as rules mature. Disabled skill = veto. Gated by `AUTO_SKILL_CREATION_ENABLED`. |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document domain-level skill synthesis"
```

---

## Self-Review (completed against the spec)

- **Spec §1 candidate query (grouping, `::int` casts, empty-domain exclusion, HAVING, ORDER pending DESC, LIMIT 1):** Task 1 Step 3 pipeline step 1. ✅
- **Spec §2 total re-synthesis + episode provenance join (cap 3):** steps 3–4; episode-input test. ✅
- **Spec §3 ownership/veto guards (user-owned skip-stamp-nothing; disabled stamp-only):** steps 2 + disabled branch; both tested. ✅
- **Spec §4–5 distiller contract + validation-failure = no stamp:** step 5; garbage/missing-field tests. ✅
- **Spec §5 ledger completeness in code, deterministic order:** step 6; create-test asserts all three rules incl. the already-marked one. ✅
- **Spec §6 create/update semantics (tier lock, enabled-on-create, update = content+description only, P2002 → re-fetch/update):** step 7; three tests pin it (`Object.keys(patch)` assertion). ✅
- **Spec §7 stamping pending-only:** `stampAll` over `pendingRules`; asserted via `toHaveBeenCalledTimes(2)`. ✅
- **Old path retired + env:** Task 2. ✅
- **Type consistency:** `synthesizeDomainSkills(params) → Promise<number>`, flag accessors, `SkillUpdateInput` partial usage — consistent across tasks. ✅
- **No placeholders.** ✅
