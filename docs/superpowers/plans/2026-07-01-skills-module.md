# Skills Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the filesystem-based agent "skills" with a DB-backed, tenant-scoped Skills module: a console for users to create/edit skills (origin `user`), accommodation for future auto-generated skills (origin `system`), the same skills feeding both AI Ops chat and Agent Ops, and a "Save as skill" action that distills a chat into a skill.

**Architecture:** A new tenant-scoped `Skill` Prisma model + repository + `skill-service.ts` replaces `lib/agent/skills/skill-loader.ts`. The agent graphs pre-fetch skill content once at graph-creation (where `tenantId` is already on `GraphConfig`) and pass plain strings into the (now content-taking) `buildEffectiveSkillSection`. A new Skills console (nav + page + RHF/Zod/Monaco dialog) does CRUD via `/api/skills*`. Chat→skill posts the in-memory transcript to `/api/skills/distill`, which uses the tenant's configured LLM provider to draft a skill the user reviews before saving.

**Tech Stack:** Next.js 15 App Router, Prisma (PostgreSQL, dual generators), TanStack Query v5, React Hook Form + Zod v4, sonner, `@monaco-editor/react`, LangChain model factory, Vitest, Playwright.

## Global Constraints

- **Multi-tenant safety:** every query scoped via `getTenantClient(tenantId)`; never `getPrismaClient()` in business logic. `$executeRaw` is NOT used here.
- **Repository pattern:** API routes/services never call Prisma directly — go through `@/lib/db/repository-factory`.
- **RBAC:** module-based (5 fixed modules `Accounts|Schedules|AIOps|Inventory|Settings`). A new logical subject `Skill` maps to module `AIOps` via `SUBJECT_TO_MODULE`. Every mutating route calls `authorize(action, 'Skill')`.
- **Audit:** every create/update/delete calls `AuditService.logUserAction({...})`.
- **API responses:** `{ success: true, data }` / `{ success: false, error }`. (Exception: the existing `GET /api/skills` keeps a top-level `skills` array for the chat dropdown's current contract.)
- **LLM provider:** SaaS-style, NO Bedrock fallback. Resolve via `resolveDefaultModelConfig(tenantId)` / `resolveModelConfig(modelString, tenantId)`; translate `ProviderConfigError` to HTTP 400.
- **Skill identifier:** the stable `slug` is the value used as `selectedSkill` everywhere (chat request, `AgentOpsRun.selectedSkill`, evaluator). `SkillMetadata.id === slug` to preserve all existing consumers.
- **Indentation:** 4 spaces in `lib/`/service/API files; 2 spaces in UI components (match the file you edit).
- **Prisma clients:** dual generators — after schema change run `db:generate` in BOTH `apps/web-ui` and `apps/workers`.
- **Tests:** web-ui uses Vitest (`cd apps/web-ui && bun run test`, which runs `vitest run`). Run a single file with `bunx vitest run <path>`.

---

## File Structure

**Create:**
- `apps/web-ui/lib/db/repositories/skill/interface.ts` — `ISkillRepository` + DTO types
- `apps/web-ui/lib/db/repositories/skill/postgres.ts` — `SkillPostgresRepository`
- `apps/web-ui/lib/skill-service.ts` — async tenant-aware skill access (replaces skill-loader's public surface)
- `apps/web-ui/lib/skill-service.test.ts` — service tests
- `apps/web-ui/lib/db/repositories/skill/postgres.test.ts` — tenant-isolation repo tests
- `apps/web-ui/app/api/skills/[id]/route.ts` — GET/PATCH/DELETE one skill
- `apps/web-ui/app/api/skills/distill/route.ts` — POST transcript → draft skill
- `apps/web-ui/app/api/skills/route.test.ts` — route + RBAC tests
- `apps/web-ui/lib/queries/skills.ts` — TanStack hooks
- `apps/web-ui/lib/client-skill-service.ts` — client fetch wrappers
- `apps/web-ui/app/app/skills/page.tsx` — console page
- `apps/web-ui/components/skills/skills-client.tsx` — list/table
- `apps/web-ui/components/skills/skill-form-dialog.tsx` — create/edit dialog (Monaco)
- `apps/web-ui-e2e/skills.spec.ts` — E2E

**Modify:**
- `libs/prisma/schema.prisma` — add `Skill` model
- `apps/web-ui/lib/db/pg-config.ts` — add `Skill` to `TENANT_SCOPED_MODELS`
- `apps/web-ui/lib/db/repository-factory.ts` — add `getSkillRepository`
- `apps/web-ui/lib/rbac/types.ts` — add `Skill: 'AIOps'` to `SUBJECT_TO_MODULE`
- `apps/web-ui/lib/agent/prompt-templates.ts` — `buildEffectiveSkillSection(selectedSkill, skillContent)` (pure; drop skill-loader import)
- `apps/web-ui/lib/agent/fast-agent.ts` — pre-fetch content via skill-service
- `apps/web-ui/lib/agent/planning-agent.ts` — pre-fetch content via skill-service
- `apps/web-ui/lib/agent/deep-agent.ts` — pre-fetch content via skill-service
- `apps/web-ui/lib/agent-ops/executor-graphs.ts` — async `loadSkills(tenantId)` + pre-loaded content Map
- `apps/web-ui/app/api/skills/route.ts` — DB-backed GET + new POST
- `apps/web-ui/lib/queries/query-keys.ts` — add `skills` key group
- `apps/web-ui/lib/nav-config.ts` — add "Skills" nav entry
- `apps/web-ui/components/agent/chat-interface.tsx` — "Save as skill" action + dialog

**Delete (Task 7, after all consumers migrated):**
- `apps/web-ui/lib/agent/skills/skill-loader.ts`
- `apps/web-ui/lib/agent/skills/*/SKILL.md` (all 8 skill folders)

---

## Task 1: Prisma `Skill` model + tenant scoping + migration

**Files:**
- Modify: `libs/prisma/schema.prisma`
- Modify: `apps/web-ui/lib/db/pg-config.ts` (the `TENANT_SCOPED_MODELS` set, ~lines 62-87)

**Interfaces:**
- Produces: a `Skill` table and `getTenantClient(tenantId).skill` accessor used by every later task.

- [ ] **Step 1: Add the model to the schema**

Append to `libs/prisma/schema.prisma`:

```prisma
model Skill {
  id          String   @id @default(cuid())
  tenantId    String
  slug        String
  name        String
  description String
  tier        String   // 'read-only' | 'mutation' | 'approval-gated'
  content     String   @db.Text
  source      String   @default("user") // 'user' | 'system'
  isEnabled   Boolean  @default(true)
  createdBy   String?
  sourceRunId String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([tenantId, slug])
  @@index([tenantId])
}
```

- [ ] **Step 2: Register the model for tenant scoping**

Open `apps/web-ui/lib/db/pg-config.ts`, find the `TENANT_SCOPED_MODELS` Set (around lines 62-87). Add a `Skill` entry **matching the exact casing of the existing entries** (open the file and copy the style — if entries read `'Account'`, add `'Skill'`; if they read `'account'`, add `'skill'`). Example assuming PascalCase:

```typescript
const TENANT_SCOPED_MODELS = new Set([
    // ...existing entries...
    'Skill',
]);
```

- [ ] **Step 3: Create + apply the migration**

Run:
```bash
cd apps/web-ui && bun run db:migrate
```
When prompted for a migration name, enter: `add_skill_model`
Expected: migration created under `libs/prisma/migrations/`, applied to local Postgres without error.

- [ ] **Step 4: Regenerate both Prisma clients**

Run:
```bash
cd apps/web-ui && bun run db:generate
cd apps/workers && bun run db:generate
```
Expected: both succeed (dual-generator setup).

- [ ] **Step 5: Smoke-test the client accessor**

Create a temporary check (or run inline) and then delete it:
```bash
cd apps/web-ui && bunx tsx -e "import { getTenantClient } from './lib/db/pg-config'; console.log(typeof getTenantClient('t').skill.findMany)"
```
Expected: prints `function`. (If `tsx` isn't wired for this path, skip and rely on Task 2's tests to confirm.)

- [ ] **Step 6: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations apps/web-ui/lib/db/pg-config.ts
git commit -m "feat(skills): add tenant-scoped Skill model + migration"
```

---

## Task 2: Skill repository (interface + postgres + factory)

**Files:**
- Create: `apps/web-ui/lib/db/repositories/skill/interface.ts`
- Create: `apps/web-ui/lib/db/repositories/skill/postgres.ts`
- Create: `apps/web-ui/lib/db/repositories/skill/postgres.test.ts`
- Modify: `apps/web-ui/lib/db/repository-factory.ts`

**Interfaces:**
- Produces:
  - `interface ISkillRepository` with: `listByTenant(tenantId, opts?: { includeDisabled?: boolean }): Promise<SkillRecord[]>`, `getBySlug(tenantId, slug): Promise<SkillRecord | null>`, `getById(tenantId, id): Promise<SkillRecord | null>`, `create(tenantId, input: SkillCreateInput): Promise<SkillRecord>`, `update(tenantId, id, input: SkillUpdateInput): Promise<SkillRecord>`, `remove(tenantId, id): Promise<void>`
  - `type SkillRecord = { id, tenantId, slug, name, description, tier, content, source, isEnabled, createdBy, sourceRunId, createdAt, updatedAt }`
  - `getSkillRepository(): ISkillRepository`

- [ ] **Step 1: Write the failing tenant-isolation test**

Create `apps/web-ui/lib/db/repositories/skill/postgres.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SkillPostgresRepository } from './postgres';

// These tests require a local Postgres (docker compose up -d postgres) + migrations applied.
const repo = new SkillPostgresRepository();
const TENANT_A = 'test-tenant-a';
const TENANT_B = 'test-tenant-b';

async function cleanup() {
    for (const t of [TENANT_A, TENANT_B]) {
        const all = await repo.listByTenant(t, { includeDisabled: true });
        for (const s of all) await repo.remove(t, s.id);
    }
}

describe('SkillPostgresRepository', () => {
    beforeEach(cleanup);

    it('creates a skill and reads it back by slug', async () => {
        const created = await repo.create(TENANT_A, {
            slug: 'cost-analyser', name: 'Cost Analyser',
            description: 'Analyse AWS spend', tier: 'read-only',
            content: '# Cost Analyser\nSteps...', source: 'user', isEnabled: true,
            createdBy: 'user-1', sourceRunId: null,
        });
        expect(created.id).toBeTruthy();
        const fetched = await repo.getBySlug(TENANT_A, 'cost-analyser');
        expect(fetched?.name).toBe('Cost Analyser');
    });

    it('does NOT leak skills across tenants', async () => {
        await repo.create(TENANT_A, {
            slug: 'a-only', name: 'A', description: 'd', tier: 'read-only',
            content: 'x', source: 'user', isEnabled: true, createdBy: 'u', sourceRunId: null,
        });
        const fromB = await repo.getBySlug(TENANT_B, 'a-only');
        expect(fromB).toBeNull();
        const listB = await repo.listByTenant(TENANT_B);
        expect(listB.find(s => s.slug === 'a-only')).toBeUndefined();
    });

    it('listByTenant excludes disabled unless includeDisabled', async () => {
        await repo.create(TENANT_A, {
            slug: 'off', name: 'Off', description: 'd', tier: 'read-only',
            content: 'x', source: 'user', isEnabled: false, createdBy: 'u', sourceRunId: null,
        });
        expect((await repo.listByTenant(TENANT_A)).find(s => s.slug === 'off')).toBeUndefined();
        expect((await repo.listByTenant(TENANT_A, { includeDisabled: true })).find(s => s.slug === 'off')).toBeTruthy();
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/skill/postgres.test.ts`
Expected: FAIL — cannot import `./postgres` (module not found).

- [ ] **Step 3: Write the interface**

Create `apps/web-ui/lib/db/repositories/skill/interface.ts`:

```typescript
export type SkillTier = 'read-only' | 'mutation' | 'approval-gated';
export type SkillSource = 'user' | 'system';

export interface SkillRecord {
    id: string;
    tenantId: string;
    slug: string;
    name: string;
    description: string;
    tier: SkillTier;
    content: string;
    source: SkillSource;
    isEnabled: boolean;
    createdBy: string | null;
    sourceRunId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface SkillCreateInput {
    slug: string;
    name: string;
    description: string;
    tier: SkillTier;
    content: string;
    source: SkillSource;
    isEnabled: boolean;
    createdBy: string | null;
    sourceRunId: string | null;
}

export type SkillUpdateInput = Partial<
    Pick<SkillRecord, 'name' | 'description' | 'tier' | 'content' | 'isEnabled' | 'slug'>
>;

export interface ISkillRepository {
    listByTenant(tenantId: string, opts?: { includeDisabled?: boolean }): Promise<SkillRecord[]>;
    getBySlug(tenantId: string, slug: string): Promise<SkillRecord | null>;
    getById(tenantId: string, id: string): Promise<SkillRecord | null>;
    create(tenantId: string, input: SkillCreateInput): Promise<SkillRecord>;
    update(tenantId: string, id: string, input: SkillUpdateInput): Promise<SkillRecord>;
    remove(tenantId: string, id: string): Promise<void>;
}
```

- [ ] **Step 4: Write the Postgres implementation**

Create `apps/web-ui/lib/db/repositories/skill/postgres.ts`:

```typescript
import { getTenantClient } from '@/lib/db/pg-config';
import type {
    ISkillRepository, SkillRecord, SkillCreateInput, SkillUpdateInput, SkillTier, SkillSource,
} from './interface';

type Row = {
    id: string; tenantId: string; slug: string; name: string; description: string;
    tier: string; content: string; source: string; isEnabled: boolean;
    createdBy: string | null; sourceRunId: string | null; createdAt: Date; updatedAt: Date;
};

function toRecord(r: Row): SkillRecord {
    return { ...r, tier: r.tier as SkillTier, source: r.source as SkillSource };
}

export class SkillPostgresRepository implements ISkillRepository {
    async listByTenant(tenantId: string, opts?: { includeDisabled?: boolean }): Promise<SkillRecord[]> {
        const where: Record<string, unknown> = { tenantId };
        if (!opts?.includeDisabled) where.isEnabled = true;
        const rows = await getTenantClient(tenantId).skill.findMany({
            where, orderBy: { name: 'asc' },
        });
        return (rows as Row[]).map(toRecord);
    }

    async getBySlug(tenantId: string, slug: string): Promise<SkillRecord | null> {
        const row = await getTenantClient(tenantId).skill.findFirst({ where: { tenantId, slug } });
        return row ? toRecord(row as Row) : null;
    }

    async getById(tenantId: string, id: string): Promise<SkillRecord | null> {
        const row = await getTenantClient(tenantId).skill.findFirst({ where: { tenantId, id } });
        return row ? toRecord(row as Row) : null;
    }

    async create(tenantId: string, input: SkillCreateInput): Promise<SkillRecord> {
        const row = await getTenantClient(tenantId).skill.create({ data: { ...input, tenantId } });
        return toRecord(row as Row);
    }

    async update(tenantId: string, id: string, input: SkillUpdateInput): Promise<SkillRecord> {
        // updateMany keeps the tenant filter in the WHERE (update() targets unique id only).
        await getTenantClient(tenantId).skill.updateMany({ where: { tenantId, id }, data: input });
        const row = await getTenantClient(tenantId).skill.findFirst({ where: { tenantId, id } });
        if (!row) throw new Error(`Skill ${id} not found after update`);
        return toRecord(row as Row);
    }

    async remove(tenantId: string, id: string): Promise<void> {
        await getTenantClient(tenantId).skill.deleteMany({ where: { tenantId, id } });
    }
}
```

- [ ] **Step 5: Register in the factory**

In `apps/web-ui/lib/db/repository-factory.ts`, add the import near the other interface imports:
```typescript
import type { ISkillRepository } from './repositories/skill/interface';
```
And add the getter alongside `getAccountRepository`:
```typescript
export function getSkillRepository(): ISkillRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SkillPostgresRepository } = require('./repositories/skill/postgres');
    return new SkillPostgresRepository();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/skill/postgres.test.ts`
Expected: 3 passing. (Requires `docker compose up -d postgres` + Task 1 migration applied.)

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/db/repositories/skill apps/web-ui/lib/db/repository-factory.ts
git commit -m "feat(skills): add Skill repository with tenant isolation tests"
```

---

## Task 3: `skill-service.ts` — async tenant-aware skill access

**Files:**
- Create: `apps/web-ui/lib/skill-service.ts`
- Create: `apps/web-ui/lib/skill-service.test.ts`

**Interfaces:**
- Consumes: `getSkillRepository()` (Task 2).
- Produces (used by Tasks 4-6, 9):
  - `type SkillMetadata = { id: string; name: string; description: string; tier: SkillTier }` (`id === slug`)
  - `loadSkills(tenantId: string): Promise<SkillMetadata[]>` (enabled only)
  - `getSkillContent(tenantId: string, slug: string): Promise<string | null>`
  - `getSkillById(tenantId: string, slug: string): Promise<SkillMetadata | null>`
  - `getSkillSummaries(tenantId: string): Promise<string>`
  - `loadAllSkillContent(tenantId: string): Promise<Map<string, string>>` (slug → content, enabled only)
  - `slugify(name: string): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/skill-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listByTenant = vi.fn();
const getBySlug = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({
    getSkillRepository: () => ({ listByTenant, getBySlug }),
}));

import { loadSkills, getSkillContent, loadAllSkillContent, slugify, getSkillSummaries } from './skill-service';

const rec = (over: Record<string, unknown> = {}) => ({
    id: 'cuid', tenantId: 't', slug: 'cost-analyser', name: 'Cost Analyser',
    description: 'Analyse spend', tier: 'read-only', content: '# body',
    source: 'user', isEnabled: true, createdBy: null, sourceRunId: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('skill-service', () => {
    beforeEach(() => { listByTenant.mockReset(); getBySlug.mockReset(); });

    it('loadSkills maps records to {id:slug,name,description,tier}', async () => {
        listByTenant.mockResolvedValue([rec()]);
        const skills = await loadSkills('t');
        expect(skills).toEqual([{ id: 'cost-analyser', name: 'Cost Analyser', description: 'Analyse spend', tier: 'read-only' }]);
    });

    it('getSkillContent returns the markdown body or null', async () => {
        getBySlug.mockResolvedValueOnce(rec({ content: '# Hello' }));
        expect(await getSkillContent('t', 'cost-analyser')).toBe('# Hello');
        getBySlug.mockResolvedValueOnce(null);
        expect(await getSkillContent('t', 'missing')).toBeNull();
    });

    it('loadAllSkillContent returns a slug→content Map', async () => {
        listByTenant.mockResolvedValue([rec({ slug: 'a', content: 'A' }), rec({ slug: 'b', content: 'B' })]);
        const map = await loadAllSkillContent('t');
        expect(map.get('a')).toBe('A');
        expect(map.get('b')).toBe('B');
    });

    it('getSkillSummaries renders a bulleted list', async () => {
        listByTenant.mockResolvedValue([rec()]);
        expect(await getSkillSummaries('t')).toContain('- cost-analyser: Cost Analyser - Analyse spend');
    });

    it('slugify lowercases and hyphenates', () => {
        expect(slugify('Cost Analyser 2!')).toBe('cost-analyser-2');
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/web-ui && bunx vitest run lib/skill-service.test.ts`
Expected: FAIL — cannot import `./skill-service`.

- [ ] **Step 3: Implement the service**

Create `apps/web-ui/lib/skill-service.ts`:

```typescript
import { getSkillRepository } from '@/lib/db/repository-factory';
import type { SkillTier } from '@/lib/db/repositories/skill/interface';

export interface SkillMetadata {
    id: string; // == slug
    name: string;
    description: string;
    tier: SkillTier;
}

export function slugify(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export async function loadSkills(tenantId: string): Promise<SkillMetadata[]> {
    const rows = await getSkillRepository().listByTenant(tenantId);
    return rows.map((s) => ({ id: s.slug, name: s.name, description: s.description, tier: s.tier }));
}

export async function getSkillById(tenantId: string, slug: string): Promise<SkillMetadata | null> {
    const s = await getSkillRepository().getBySlug(tenantId, slug);
    return s ? { id: s.slug, name: s.name, description: s.description, tier: s.tier } : null;
}

export async function getSkillContent(tenantId: string, slug: string): Promise<string | null> {
    const s = await getSkillRepository().getBySlug(tenantId, slug);
    return s && s.isEnabled ? s.content : null;
}

export async function loadAllSkillContent(tenantId: string): Promise<Map<string, string>> {
    const rows = await getSkillRepository().listByTenant(tenantId);
    return new Map(rows.map((s) => [s.slug, s.content]));
}

export async function getSkillSummaries(tenantId: string): Promise<string> {
    const skills = await loadSkills(tenantId);
    if (skills.length === 0) return 'No specialized skills available.';
    const summaries = skills.map((s) => `- ${s.id}: ${s.name} - ${s.description}`).join('\n');
    return `Available Skills:\n${summaries}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/skill-service.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/skill-service.ts apps/web-ui/lib/skill-service.test.ts
git commit -m "feat(skills): add async tenant-aware skill-service"
```

---

## Task 4: Make `buildEffectiveSkillSection` content-taking (pure)

**Files:**
- Modify: `apps/web-ui/lib/agent/prompt-templates.ts`

**Interfaces:**
- Produces: `buildEffectiveSkillSection(selectedSkill?: string | null, skillContent?: string | null): string` — no longer reads the filesystem; callers pass pre-fetched content. `buildBaseIdentity(selectedSkill)` is UNCHANGED (it never read content).

- [ ] **Step 1: Remove the skill-loader import**

In `apps/web-ui/lib/agent/prompt-templates.ts`, delete line 18:
```typescript
import { getSkillContent } from "./skills/skill-loader";
```

- [ ] **Step 2: Change `buildEffectiveSkillSection` to take content**

Replace the function body (lines 73-90) with:

```typescript
export function buildEffectiveSkillSection(
    selectedSkill?: string | null,
    skillContent?: string | null,
): string {
    if (selectedSkill && skillContent) {
        return `\n\n=== ACTIVE SKILL: ${selectedSkill.toUpperCase()} ===\n${skillContent}\n\nYou MUST follow the above skill-specific instructions. They define your privileges, safety guidelines, and workflow for this conversation.\n=== END SKILL ===\n`;
    }
    if (selectedSkill && !skillContent) {
        console.warn(`[PromptTemplates] No content provided for skill: ${selectedSkill}`);
    }

    return `
## Operating Mode: Base DevOps Engineer
You are operating as a general-purpose DevOps engineer with full read and write access.

**Capabilities:** All AWS operations (describe, list, create, update, delete, start, stop, reboot, terminate across EC2, ECS, EKS, RDS, Lambda, S3, IAM, VPC, CloudWatch, SSM, and more), file and IaC operations (Terraform, Ansible, Dockerfiles, CI/CD configs), shell execution.

**Safety:** Verify state before mutation. Use --dry-run or terraform plan where supported. For irreversible actions (terminate, delete, drop), confirm intent is unambiguous before proceeding.
`;
}
```

Also update the doc comment above it (the line mentioning "Loads skill content") to: `Formats the supplied skill content into the standard section header. Falls back to a concise base DevOps operating mode when no skill/content is supplied.`

- [ ] **Step 3: Type-check this file's contract**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "prompt-templates|fast-agent|planning-agent|deep-agent|executor-graphs" || echo "no skill-related type errors"`
Expected: errors WILL appear in `fast-agent.ts`, `planning-agent.ts`, `deep-agent.ts`, `executor-graphs.ts` (they still call the old sync `getSkillContent` import and the old `buildEffectiveSkillSection` arity). Those are fixed in Tasks 5-6. This step just confirms `prompt-templates.ts` itself compiles — no errors should reference `prompt-templates.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/agent/prompt-templates.ts
git commit -m "refactor(skills): buildEffectiveSkillSection takes pre-fetched content"
```

---

## Task 5: Wire async skill content into fast/planning/deep agents

**Files:**
- Modify: `apps/web-ui/lib/agent/fast-agent.ts`
- Modify: `apps/web-ui/lib/agent/planning-agent.ts`
- Modify: `apps/web-ui/lib/agent/deep-agent.ts`

**Interfaces:**
- Consumes: `getSkillContent(tenantId, slug)` from `@/lib/skill-service` (Task 3); `buildEffectiveSkillSection(slug, content)` (Task 4). `tenantId` is destructured from `config` (already on `GraphConfig`).

- [ ] **Step 1: fast-agent.ts — swap the import**

Replace line 4:
```typescript
import { getSkillContent } from "./skills/skill-loader";
```
with:
```typescript
import { getSkillContent } from "@/lib/skill-service";
```

- [ ] **Step 2: fast-agent.ts — pre-fetch content once**

`tenantId` is already destructured at line 36. Replace the skill-logging block (lines 41-49) and the later content lines with a single pre-fetch. Specifically:

Replace lines 41-52 (the `if (selectedSkill) { const content = getSkillContent(selectedSkill) ... }` log block AND the `const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill);` line) with:

```typescript
    // Pre-fetch skill content once (tenant-scoped DB lookup). Used by the system
    // prompt and reused by the reflector below — no repeated queries.
    const skillContent = selectedSkill && tenantId ? (await getSkillContent(tenantId, selectedSkill)) || '' : '';
    if (selectedSkill) {
        console.log(skillContent ? `[FastAgent] Loaded skill: ${selectedSkill}` : `[FastAgent] No content for skill: ${selectedSkill}`);
    }
    const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill, skillContent || null);
```

Then DELETE the now-duplicate line 59 (`const skillContent = selectedSkill ? (getSkillContent(selectedSkill) || '') : '';`) — `skillContent` is already defined above. (`buildBaseIdentity(selectedSkill)` at line 86 stays unchanged.)

- [ ] **Step 3: planning-agent.ts — same treatment**

Replace line 4 import the same way (`from "@/lib/skill-service"`). `tenantId` is destructured at line 35. Replace the log block (lines 40-48) + the `const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill);` (line 52) with:

```typescript
    const skillContent = selectedSkill && tenantId ? (await getSkillContent(tenantId, selectedSkill)) || '' : '';
    if (selectedSkill) {
        console.log(skillContent ? `[PlanningAgent] Loaded skill: ${selectedSkill}` : `[PlanningAgent] No content for skill: ${selectedSkill}`);
    }
```

Keep `const baseIdentity = buildBaseIdentity(selectedSkill);` (line 51). Add the effective-section line where it was (after baseIdentity):
```typescript
    const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill, skillContent || null);
```
Then DELETE the duplicate line 60 (`const skillContent = selectedSkill ? (getSkillContent(selectedSkill) || '') : '';`).

- [ ] **Step 4: deep-agent.ts — same treatment**

Replace line 16 import (`from "@/lib/skill-service"`). `tenantId` is destructured at line 27. Replace the skill block (lines 33-45) with:

```typescript
    let skillSection = '';
    let skillContent = '';
    if (selectedSkill && tenantId) {
        const content = await getSkillContent(tenantId, selectedSkill);
        if (content) {
            skillContent = content;
            skillSection = `\n\n=== ACTIVE SKILL: ${selectedSkill.toUpperCase()} ===\n${skillContent}\n\nYou MUST follow the above skill-specific instructions. They define your privileges, safety guidelines, and workflow for this conversation.\n=== END SKILL ===\n`;
            console.log(`[DeepAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[DeepAgent] No content for skill: ${selectedSkill}`);
        }
    }
```

- [ ] **Step 5: Type-check the three files**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "fast-agent|planning-agent|deep-agent" || echo "clean"`
Expected: `clean` (no type errors in these three).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/fast-agent.ts apps/web-ui/lib/agent/planning-agent.ts apps/web-ui/lib/agent/deep-agent.ts
git commit -m "feat(skills): fast/planning/deep agents load skill content from DB"
```

---

## Task 6: Wire agent-ops executor to async skill-service

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/executor-graphs.ts`

**Interfaces:**
- Consumes: `loadSkills(tenantId)`, `loadAllSkillContent(tenantId)` from `@/lib/skill-service`; `buildEffectiveSkillSection(slug, content)` (Task 4). `tenantId` is destructured at line 57.

- [ ] **Step 1: Swap the import**

Replace line 45:
```typescript
import { getSkillContent, loadSkills } from "@/lib/agent/skills/skill-loader";
```
with:
```typescript
import { loadSkills, loadAllSkillContent } from "@/lib/skill-service";
```

- [ ] **Step 2: Pre-load all tenant skill content once at graph creation**

`tenantId` is destructured at line 57. Immediately after the model/tools setup (before `getDynamicContext` is defined, i.e. before line 85), add:

```typescript
    // Pre-load all enabled tenant skills' content once. The evaluator picks a skill
    // at runtime, so node closures read content synchronously from this Map.
    const skillContentMap: Map<string, string> = tenantId ? await loadAllSkillContent(tenantId) : new Map();
```

- [ ] **Step 3: Update `getDynamicContext` to read from the Map**

In `getDynamicContext` (lines 85-106), change the `skillSection` line (line 89) from:
```typescript
    const skillSection = buildEffectiveSkillSection(skillId);
```
to:
```typescript
    const skillSection = buildEffectiveSkillSection(skillId, skillId ? (skillContentMap.get(skillId) ?? null) : null);
```

- [ ] **Step 4: Make the evaluator's `loadSkills` tenant-scoped**

In `evaluatorNode`, change line 121 from:
```typescript
    const availableSkills = await loadSkills();
```
to:
```typescript
    const availableSkills = tenantId ? await loadSkills(tenantId) : [];
```

- [ ] **Step 5: Update the reflector node's skill content**

In `reflectNode` (line ~394), change:
```typescript
    const skillContent = skillId ? (getSkillContent(skillId) || '') : '';
```
to:
```typescript
    const skillContent = skillId ? (skillContentMap.get(skillId) ?? '') : '';
```

(The `buildBaseIdentity(evaluation?.skillId)` calls at lines 214/274/478 are unchanged.)

- [ ] **Step 6: Type-check**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "executor-graphs" || echo "clean"`
Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent-ops/executor-graphs.ts
git commit -m "feat(skills): agent-ops executor loads skills from DB (tenant-scoped)"
```

---

## Task 7: Delete the filesystem skill-loader + SKILL.md files

**Files:**
- Delete: `apps/web-ui/lib/agent/skills/skill-loader.ts`
- Delete: `apps/web-ui/lib/agent/skills/*/SKILL.md` (all skill folders)

**Interfaces:** none produced; this removes the legacy surface after all consumers migrated (Tasks 4-6) and the API route is migrated (Task 9 also imports it — do this AFTER Task 9, or confirm the grep below is clean).

- [ ] **Step 1: Confirm no remaining importers**

Run:
```bash
cd apps/web-ui && grep -rn "agent/skills/skill-loader" --include="*.ts" --include="*.tsx" . | grep -v node_modules || echo "no importers remain"
```
Expected: `no importers remain`. If anything prints, fix that importer first (it should be migrated to `@/lib/skill-service`).

- [ ] **Step 2: Delete the directory**

Run:
```bash
cd apps/web-ui && rm -rf lib/agent/skills
```

- [ ] **Step 3: Type-check + lint the whole app**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -iE "skill" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add -A apps/web-ui/lib/agent/skills
git commit -m "chore(skills): remove filesystem skill-loader and SKILL.md files"
```

---

## Task 8: RBAC — map `Skill` subject to `AIOps`

**Files:**
- Modify: `apps/web-ui/lib/rbac/types.ts`

**Interfaces:**
- Produces: `authorize(action, 'Skill')` resolves to the `AIOps` module permission.

- [ ] **Step 1: Add the mapping**

In `apps/web-ui/lib/rbac/types.ts`, add to the `SUBJECT_TO_MODULE` object (after the `Agent: 'AIOps'` line):
```typescript
    Skill: 'AIOps',
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-ui/lib/rbac/types.ts
git commit -m "feat(skills): add Skill RBAC subject mapped to AIOps module"
```

---

## Task 9: Skills API routes (DB-backed GET + POST, [id], distill)

**Files:**
- Modify: `apps/web-ui/app/api/skills/route.ts`
- Create: `apps/web-ui/app/api/skills/[id]/route.ts`
- Create: `apps/web-ui/app/api/skills/distill/route.ts`
- Create: `apps/web-ui/app/api/skills/route.test.ts`

**Interfaces:**
- Consumes: `getSkillRepository()`, `slugify`, `authorize`, `getSessionTenantId`, `getServerSession`/`authOptions`, `AuditService`, `resolveDefaultModelConfig`, `createAgentModels`, `isProviderConfigError`.
- Produces HTTP contracts:
  - `GET /api/skills?all=1` → `{ success, skills: SkillDTO[] }` where `SkillDTO = { id: slug, name, description, tier, source, isEnabled, createdBy, updatedAt }`. Without `all`, only `isEnabled` skills.
  - `POST /api/skills` body `{ name, description, tier, content, isEnabled?, slug?, source?, sourceRunId? }` → `{ success, data: SkillDTO }` (201) or 409 on duplicate slug.
  - `GET/PATCH/DELETE /api/skills/[id]` → `{ success, data }` / `{ success }`.
  - `POST /api/skills/distill` body `{ threadId, transcript }` → `{ success, data: { name, description, tier, content } }`.

- [ ] **Step 1: Write failing route tests (RBAC + shape)**

Create `apps/web-ui/app/api/skills/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const authorize = vi.fn();
const getSessionTenantId = vi.fn();
const listByTenant = vi.fn();
const getBySlug = vi.fn();
const create = vi.fn();
const logUserAction = vi.fn();

vi.mock('@/lib/rbac/authorize', () => ({ authorize }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId }));
vi.mock('@/lib/db/repository-factory', () => ({ getSkillRepository: () => ({ listByTenant, getBySlug, create }) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'a@b.co', tenantId: 't1' } }) }));
vi.mock('@/lib/auth-config', () => ({ authOptions: {} }), { virtual: true } as never);

import { GET, POST } from './route';

beforeEach(() => {
    authorize.mockReset(); getSessionTenantId.mockReset().mockResolvedValue('t1');
    listByTenant.mockReset(); getBySlug.mockReset(); create.mockReset(); logUserAction.mockReset();
});

describe('GET /api/skills', () => {
    it('returns enabled skills under `skills`', async () => {
        authorize.mockResolvedValue(null);
        listByTenant.mockResolvedValue([{ id: 'c', slug: 'cost', name: 'Cost', description: 'd', tier: 'read-only', source: 'user', isEnabled: true, createdBy: null, updatedAt: new Date() }]);
        const res = await GET(new Request('http://x/api/skills') as never);
        const body = await (res as NextResponse).json();
        expect(body.skills[0].id).toBe('cost');
    });
});

describe('POST /api/skills', () => {
    it('403s when authorize denies', async () => {
        authorize.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
        const res = await POST(new Request('http://x/api/skills', { method: 'POST', body: '{}' }) as never);
        expect((res as NextResponse).status).toBe(403);
    });

    it('409s on duplicate slug', async () => {
        authorize.mockResolvedValue(null);
        getBySlug.mockResolvedValue({ id: 'existing' });
        const res = await POST(new Request('http://x/api/skills', { method: 'POST', body: JSON.stringify({ name: 'Cost', description: 'd', tier: 'read-only', content: 'x' }) }) as never);
        expect((res as NextResponse).status).toBe(409);
    });

    it('creates + audits on success', async () => {
        authorize.mockResolvedValue(null);
        getBySlug.mockResolvedValue(null);
        create.mockResolvedValue({ id: 'new', slug: 'cost', name: 'Cost', description: 'd', tier: 'read-only', source: 'user', isEnabled: true, createdBy: 'u1', updatedAt: new Date() });
        const res = await POST(new Request('http://x/api/skills', { method: 'POST', body: JSON.stringify({ name: 'Cost', description: 'd', tier: 'read-only', content: 'x' }) }) as never);
        expect((res as NextResponse).status).toBe(201);
        expect(logUserAction).toHaveBeenCalledOnce();
    });
});
```

> Note: confirm the actual auth-options import path used elsewhere (grep `authOptions` in an existing route, e.g. `app/api/schedules/route.ts`) and match it in both the route and this mock. Adjust the `@/lib/auth-config` mock path accordingly.

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web-ui && bunx vitest run app/api/skills/route.test.ts`
Expected: FAIL — `GET`/`POST` not exported yet (route still filesystem-based, no POST).

- [ ] **Step 3: Rewrite `app/api/skills/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-config'; // adjust to the real path used by sibling routes
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { slugify } from '@/lib/skill-service';
import { AuditService } from '@/lib/audit-service';
import type { SkillRecord } from '@/lib/db/repositories/skill/interface';

function toDTO(s: SkillRecord) {
    return {
        id: s.slug, name: s.name, description: s.description, tier: s.tier,
        source: s.source, isEnabled: s.isEnabled, createdBy: s.createdBy, updatedAt: s.updatedAt,
    };
}

export async function GET(request: NextRequest) {
    try {
        const tenantId = await getSessionTenantId();
        const includeDisabled = new URL(request.url).searchParams.has('all');
        const skills = await getSkillRepository().listByTenant(tenantId, { includeDisabled });
        return NextResponse.json({ success: true, skills: skills.map(toDTO) });
    } catch (error) {
        console.error('[SkillsAPI] GET error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to load skills' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Skill');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const session = await getServerSession(authOptions);
        const body = await request.json();
        const { name, description, tier, content, isEnabled = true, source = 'user', sourceRunId = null } = body;
        if (!name || !description || !tier || !content) {
            return NextResponse.json({ success: false, error: 'Missing required fields: name, description, tier, content' }, { status: 400 });
        }
        const slug = (body.slug && String(body.slug).trim()) ? slugify(body.slug) : slugify(name);
        if (await getSkillRepository().getBySlug(tenantId, slug)) {
            return NextResponse.json({ success: false, error: `A skill with slug "${slug}" already exists` }, { status: 409 });
        }
        const created = await getSkillRepository().create(tenantId, {
            slug, name, description, tier, content, source,
            isEnabled, createdBy: session?.user?.id ?? null, sourceRunId,
        });
        await AuditService.logUserAction({
            action: 'create', resourceType: 'Skill', resourceId: created.id, resourceName: created.name,
            user: session?.user?.email || 'api-user', userType: 'user', status: 'success',
            details: `Skill "${created.name}" created`, tenantId, severity: 'info',
        });
        return NextResponse.json({ success: true, data: toDTO(created) }, { status: 201 });
    } catch (error) {
        console.error('[SkillsAPI] POST error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to create skill' }, { status: 500 });
    }
}
```

- [ ] **Step 4: Create `app/api/skills/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-config'; // adjust to the real path
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { slugify } from '@/lib/skill-service';
import { AuditService } from '@/lib/audit-service';
import type { SkillRecord, SkillUpdateInput } from '@/lib/db/repositories/skill/interface';

function toDTO(s: SkillRecord) {
    return { id: s.slug, name: s.name, description: s.description, tier: s.tier, source: s.source, isEnabled: s.isEnabled, createdBy: s.createdBy, content: s.content, updatedAt: s.updatedAt };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const tenantId = await getSessionTenantId();
        const skill = await getSkillRepository().getById(tenantId, id);
        if (!skill) return NextResponse.json({ success: false, error: 'Skill not found' }, { status: 404 });
        return NextResponse.json({ success: true, data: toDTO(skill) });
    } catch (error) {
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('update', 'Skill');
    if (authError) return authError;
    try {
        const { id } = await params;
        const tenantId = await getSessionTenantId();
        const session = await getServerSession(authOptions);
        const body = await request.json();
        const updates: SkillUpdateInput = {};
        for (const k of ['name', 'description', 'tier', 'content', 'isEnabled'] as const) {
            if (body[k] !== undefined) (updates as Record<string, unknown>)[k] = body[k];
        }
        if (body.slug !== undefined) updates.slug = slugify(body.slug);
        const updated = await getSkillRepository().update(tenantId, id, updates);
        await AuditService.logUserAction({
            action: 'update', resourceType: 'Skill', resourceId: id, resourceName: updated.name,
            user: session?.user?.email || 'api-user', userType: 'user', status: 'success',
            details: `Skill "${updated.name}" updated`, tenantId, severity: 'info',
        });
        return NextResponse.json({ success: true, data: toDTO(updated) });
    } catch (error) {
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
    }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('delete', 'Skill');
    if (authError) return authError;
    try {
        const { id } = await params;
        const tenantId = await getSessionTenantId();
        const session = await getServerSession(authOptions);
        const existing = await getSkillRepository().getById(tenantId, id);
        if (!existing) return NextResponse.json({ success: false, error: 'Skill not found' }, { status: 404 });
        await getSkillRepository().remove(tenantId, id);
        await AuditService.logUserAction({
            action: 'delete', resourceType: 'Skill', resourceId: id, resourceName: existing.name,
            user: session?.user?.email || 'api-user', userType: 'user', status: 'success',
            details: `Skill "${existing.name}" deleted`, tenantId, severity: 'medium',
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
    }
}
```

- [ ] **Step 5: Create `app/api/skills/distill/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';

const DISTILL_PROMPT = `You are distilling a CloudOps chat transcript into a reusable agent "skill".
Return ONLY a JSON object (no markdown fences) with keys:
- "name": short Title Case name (max 5 words)
- "description": one sentence describing when to use this skill
- "tier": one of "read-only" | "mutation" | "approval-gated" (pick based on whether the procedure only reads, or also creates/updates/deletes resources)
- "content": a markdown SKILL body with a one-line intro and a numbered, generalized step-by-step procedure (strip account-specific IDs; describe the repeatable method, not the one-off answer).

Transcript:
`;

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Skill');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const { transcript } = await request.json();
        if (!transcript || typeof transcript !== 'string') {
            return NextResponse.json({ success: false, error: 'Missing transcript' }, { status: 400 });
        }
        const modelConfig = await resolveDefaultModelConfig(tenantId);
        const { main } = createAgentModels(modelConfig);
        const resp = await main.invoke(`${DISTILL_PROMPT}\n${transcript.slice(0, 24000)}`);
        const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        let draft: { name?: string; description?: string; tier?: string; content?: string };
        try { draft = JSON.parse(jsonText); }
        catch { return NextResponse.json({ success: false, error: 'Model did not return valid JSON' }, { status: 502 }); }
        const tier = ['read-only', 'mutation', 'approval-gated'].includes(draft.tier ?? '') ? draft.tier : 'read-only';
        return NextResponse.json({
            success: true,
            data: { name: draft.name ?? 'Untitled Skill', description: draft.description ?? '', tier, content: draft.content ?? '' },
        });
    } catch (error) {
        if (isProviderConfigError(error)) {
            return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 });
        }
        console.error('[SkillsAPI] distill error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to distill' }, { status: 500 });
    }
}
```

- [ ] **Step 6: Run the route tests**

Run: `cd apps/web-ui && bunx vitest run app/api/skills/route.test.ts`
Expected: all passing. (Fix the `authOptions` mock path if the import resolves differently — see the note in Step 1.)

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/app/api/skills
git commit -m "feat(skills): DB-backed skills API (list/create/[id]/distill) with RBAC + audit"
```

---

## Task 10: Query keys + hooks + client service

**Files:**
- Modify: `apps/web-ui/lib/queries/query-keys.ts`
- Create: `apps/web-ui/lib/client-skill-service.ts`
- Create: `apps/web-ui/lib/queries/skills.ts`

**Interfaces:**
- Produces (used by Tasks 11-12):
  - `ClientSkillService.{ listSkills(all?), getSkill(id), createSkill(input), updateSkill(id, input), deleteSkill(id), distill(threadId, transcript) }`
  - hooks: `useSkills(all?)`, `useSkill(id)`, `useCreateSkill()`, `useUpdateSkill()`, `useDeleteSkill()`, `useDistillSkill()`
  - `type SkillDTO = { id: string; name: string; description: string; tier: string; source: string; isEnabled: boolean; createdBy: string | null; updatedAt: string; content?: string }`

- [ ] **Step 1: Add the query key group**

In `apps/web-ui/lib/queries/query-keys.ts`, add inside the `queryKeys` object:
```typescript
    skills: {
        all: ['skills'] as const,
        lists: () => [...queryKeys.skills.all, 'list'] as const,
        list: (all?: boolean) => [...queryKeys.skills.lists(), { all: !!all }] as const,
        details: () => [...queryKeys.skills.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.skills.details(), id] as const,
    },
```

- [ ] **Step 2: Create the client service**

Create `apps/web-ui/lib/client-skill-service.ts`:

```typescript
export interface SkillDTO {
    id: string; name: string; description: string; tier: string;
    source: string; isEnabled: boolean; createdBy: string | null; updatedAt: string; content?: string;
}
export interface SkillInput {
    name: string; description: string; tier: string; content: string;
    isEnabled?: boolean; slug?: string; source?: string; sourceRunId?: string | null;
}

async function jsonOrThrow(res: Response) {
    const body = await res.json();
    if (!res.ok || body.success === false) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
}

export const ClientSkillService = {
    async listSkills(all = true): Promise<SkillDTO[]> {
        const res = await fetch(`/api/skills${all ? '?all=1' : ''}`);
        const body = await jsonOrThrow(res);
        return body.skills as SkillDTO[];
    },
    async getSkill(id: string): Promise<SkillDTO> {
        return (await jsonOrThrow(await fetch(`/api/skills/${id}`))).data;
    },
    async createSkill(input: SkillInput): Promise<SkillDTO> {
        return (await jsonOrThrow(await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }))).data;
    },
    async updateSkill(id: string, input: Partial<SkillInput>): Promise<SkillDTO> {
        return (await jsonOrThrow(await fetch(`/api/skills/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }))).data;
    },
    async deleteSkill(id: string): Promise<void> {
        await jsonOrThrow(await fetch(`/api/skills/${id}`, { method: 'DELETE' }));
    },
    async distill(threadId: string, transcript: string): Promise<{ name: string; description: string; tier: string; content: string }> {
        return (await jsonOrThrow(await fetch('/api/skills/distill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, transcript }) }))).data;
    },
};
```

- [ ] **Step 3: Create the hooks**

Create `apps/web-ui/lib/queries/skills.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import { ClientSkillService, type SkillInput } from '@/lib/client-skill-service';

export function useSkills(all = true) {
    return useQuery({ queryKey: queryKeys.skills.list(all), queryFn: () => ClientSkillService.listSkills(all) });
}
export function useSkill(id: string | null) {
    return useQuery({ queryKey: queryKeys.skills.detail(id ?? ''), queryFn: () => ClientSkillService.getSkill(id as string), enabled: !!id });
}
export function useCreateSkill() {
    const qc = useQueryClient();
    return useMutation({ mutationFn: (input: SkillInput) => ClientSkillService.createSkill(input), onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all }) });
}
export function useUpdateSkill() {
    const qc = useQueryClient();
    return useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<SkillInput> }) => ClientSkillService.updateSkill(id, input), onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all }) });
}
export function useDeleteSkill() {
    const qc = useQueryClient();
    return useMutation({ mutationFn: (id: string) => ClientSkillService.deleteSkill(id), onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all }) });
}
export function useDistillSkill() {
    return useMutation({ mutationFn: ({ threadId, transcript }: { threadId: string; transcript: string }) => ClientSkillService.distill(threadId, transcript) });
}
```

- [ ] **Step 4: Type-check**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "queries/skills|client-skill-service|query-keys" || echo "clean"`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/queries/query-keys.ts apps/web-ui/lib/queries/skills.ts apps/web-ui/lib/client-skill-service.ts
git commit -m "feat(skills): TanStack query hooks + client service"
```

---

## Task 11: Skills console — nav + page + list + create/edit dialog

**Files:**
- Modify: `apps/web-ui/lib/nav-config.ts`
- Create: `apps/web-ui/app/app/skills/page.tsx`
- Create: `apps/web-ui/components/skills/skills-client.tsx`
- Create: `apps/web-ui/components/skills/skill-form-dialog.tsx`

**Interfaces:**
- Consumes: hooks from Task 10.
- Produces: `SkillFormDialog` reused by Task 12 — props `{ open, onOpenChange, skill?: SkillDTO | null, initialDraft?: { name; description; tier; content } | null, sourceRunId?: string | null }`.

- [ ] **Step 1: Add the nav entry**

In `apps/web-ui/lib/nav-config.ts`, inside the "Agentic Ops" menu's `items` array (after the `Knowledge Base` entry), add:
```typescript
      { title: "Skills", href: "/app/skills" },
```

- [ ] **Step 2: Create the create/edit dialog (Monaco)**

Create `apps/web-ui/components/skills/skill-form-dialog.tsx`:

```typescript
"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Editor from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateSkill, useUpdateSkill, useSkill } from "@/lib/queries/skills";
import type { SkillDTO } from "@/lib/client-skill-service";

const schema = z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().min(1, "Description is required"),
    tier: z.enum(["read-only", "mutation", "approval-gated"]),
    content: z.string().min(1, "Skill content is required"),
    isEnabled: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

interface Props {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    skill?: SkillDTO | null;
    initialDraft?: { name: string; description: string; tier: string; content: string } | null;
    sourceRunId?: string | null;
}

export function SkillFormDialog({ open, onOpenChange, skill, initialDraft, sourceRunId }: Props) {
    const { resolvedTheme } = useTheme();
    const createSkill = useCreateSkill();
    const updateSkill = useUpdateSkill();
    const isEdit = !!skill;
    // List DTOs omit `content`; fetch the full skill (incl. content) when editing.
    const { data: fullSkill } = useSkill(skill?.id ?? null);

    const form = useForm<FormValues>({
        resolver: zodResolver(schema),
        defaultValues: { name: "", description: "", tier: "read-only", content: "", isEnabled: true },
    });

    useEffect(() => {
        if (!open) return;
        if (skill) {
            const src = fullSkill ?? skill;
            form.reset({ name: src.name, description: src.description, tier: src.tier as FormValues["tier"], content: src.content ?? "", isEnabled: src.isEnabled });
        } else if (initialDraft) {
            form.reset({ name: initialDraft.name, description: initialDraft.description, tier: (["read-only", "mutation", "approval-gated"].includes(initialDraft.tier) ? initialDraft.tier : "read-only") as FormValues["tier"], content: initialDraft.content, isEnabled: true });
        } else {
            form.reset({ name: "", description: "", tier: "read-only", content: "", isEnabled: true });
        }
    }, [open, skill, fullSkill, initialDraft, form]);

    const onSubmit = async (values: FormValues) => {
        try {
            if (isEdit && skill) {
                await updateSkill.mutateAsync({ id: skill.id, input: values });
                toast.success("Skill updated", { description: values.name });
            } else {
                await createSkill.mutateAsync({ ...values, sourceRunId: sourceRunId ?? null });
                toast.success("Skill created", { description: values.name });
            }
            onOpenChange(false);
        } catch (e) {
            toast.error(isEdit ? "Update failed" : "Create failed", { description: e instanceof Error ? e.message : "Please try again" });
        }
    };

    const submitting = createSkill.isPending || updateSkill.isPending;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isEdit ? "Edit Skill" : "Create Skill"}</DialogTitle>
                    <DialogDescription>Skills are available to everyone in your organization in AI Ops and Agent Ops.</DialogDescription>
                </DialogHeader>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField control={form.control} name="name" render={({ field }) => (
                            <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Cost Analyser" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="description" render={({ field }) => (
                            <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea rows={2} placeholder="When should the agent use this skill?" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="tier" render={({ field }) => (
                            <FormItem><FormLabel>Tier</FormLabel>
                                <Select value={field.value} onValueChange={field.onChange}>
                                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                                    <SelectContent>
                                        <SelectItem value="read-only">Read-only</SelectItem>
                                        <SelectItem value="mutation">Mutation</SelectItem>
                                        <SelectItem value="approval-gated">Approval-gated</SelectItem>
                                    </SelectContent>
                                </Select><FormMessage />
                            </FormItem>
                        )} />
                        <FormField control={form.control} name="content" render={({ field }) => (
                            <FormItem><FormLabel>Skill content (Markdown)</FormLabel>
                                <FormControl>
                                    <div className="border rounded-md overflow-hidden">
                                        <Editor height="320px" defaultLanguage="markdown" value={field.value} onChange={(v) => field.onChange(v ?? "")}
                                            theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                                            options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 12, bottom: 12 } }} />
                                    </div>
                                </FormControl><FormMessage />
                            </FormItem>
                        )} />
                        <FormField control={form.control} name="isEnabled" render={({ field }) => (
                            <FormItem className="flex items-center justify-between rounded-md border p-3">
                                <FormLabel className="mb-0">Enabled (visible in AI Ops / Agent Ops)</FormLabel>
                                <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                            </FormItem>
                        )} />
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                            <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : isEdit ? "Save changes" : "Create skill"}</Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
```

> If any imported `@/components/ui/*` primitive (e.g. `textarea`, `switch`) does not exist, check `apps/web-ui/components/ui/` and substitute the existing equivalent (this is a shadcn/ui project; most primitives exist).

- [ ] **Step 3: Create the list/table client**

Create `apps/web-ui/components/skills/skills-client.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useSkills, useDeleteSkill } from "@/lib/queries/skills";
import { SkillFormDialog } from "./skill-form-dialog";
import type { SkillDTO } from "@/lib/client-skill-service";

export function SkillsClient() {
    const { data: skills, isLoading } = useSkills(true);
    const deleteSkill = useDeleteSkill();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<SkillDTO | null>(null);

    const openCreate = () => { setEditing(null); setDialogOpen(true); };
    const openEdit = (s: SkillDTO) => { setEditing(s); setDialogOpen(true); };
    const onDelete = async (s: SkillDTO) => {
        if (!confirm(`Delete skill "${s.name}"?`)) return;
        try { await deleteSkill.mutateAsync(s.id); toast.success("Skill deleted", { description: s.name }); }
        catch (e) { toast.error("Delete failed", { description: e instanceof Error ? e.message : "Try again" }); }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">Skills</h1>
                    <p className="text-sm text-muted-foreground">Reusable agent skills for AI Ops and Agent Ops.</p>
                </div>
                <Button onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> Create skill</Button>
            </div>

            {isLoading ? (
                <div className="flex justify-center py-12"><Spinner /></div>
            ) : !skills?.length ? (
                <div className="text-center py-12 text-muted-foreground">No skills yet. Create your first skill.</div>
            ) : (
                <div className="border rounded-lg divide-y">
                    {skills.map((s) => (
                        <div key={s.id} className="flex items-center justify-between p-4 gap-4">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium truncate">{s.name}</span>
                                    <Badge variant="outline">{s.tier}</Badge>
                                    <Badge variant={s.source === "system" ? "secondary" : "default"}>{s.source === "system" ? "System" : "User"}</Badge>
                                    {!s.isEnabled && <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>}
                                </div>
                                <p className="text-sm text-muted-foreground truncate">{s.description}</p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <Button variant="ghost" size="icon" onClick={() => openEdit(s)} title="Edit"><Pencil className="w-4 h-4" /></Button>
                                <Button variant="ghost" size="icon" onClick={() => onDelete(s)} title="Delete" className="hover:text-destructive"><Trash2 className="w-4 h-4" /></Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <SkillFormDialog open={dialogOpen} onOpenChange={setDialogOpen} skill={editing} />
        </div>
    );
}
```

> Note: the list DTO has no `content` — the dialog (Step 2) already fetches the full skill via `useSkill(skill.id)` when editing, so `openEdit` can pass the list DTO directly.

- [ ] **Step 4: Create the page**

Create `apps/web-ui/app/app/skills/page.tsx`:

```typescript
"use client";

import { SkillsClient } from "@/components/skills/skills-client";

export default function SkillsPage() {
    return <SkillsClient />;
}
```

- [ ] **Step 5: Verify manually**

Run `cd apps/web-ui && bun run dev`, log in, open `/app/skills`. Create a skill ("Cost Analyser", read-only, some markdown). Confirm it appears in the list with a "User" badge. Open AI Ops (`/app/agent`) → the skill dropdown should list it.

- [ ] **Step 6: Type-check + commit**

```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "skills/|skill-form" || echo "clean"
git add apps/web-ui/lib/nav-config.ts apps/web-ui/app/app/skills apps/web-ui/components/skills
git commit -m "feat(skills): skills console (nav, page, list, create/edit dialog)"
```

---

## Task 12: Chat → skill conversion

**Files:**
- Modify: `apps/web-ui/components/agent/chat-interface.tsx`

**Interfaces:**
- Consumes: `useDistillSkill()` (Task 10), `SkillFormDialog` (Task 11). `threadId` and `messages` already exist in the component.

- [ ] **Step 1: Add imports + state**

Near the other imports in `chat-interface.tsx`, add:
```typescript
import { Sparkles } from "lucide-react";
import { useDistillSkill } from "@/lib/queries/skills";
import { SkillFormDialog } from "@/components/skills/skill-form-dialog";
```
Inside the component body (near other `useState`), add:
```typescript
    const distillSkill = useDistillSkill();
    const [skillDialogOpen, setSkillDialogOpen] = useState(false);
    const [skillDraft, setSkillDraft] = useState<{ name: string; description: string; tier: string; content: string } | null>(null);
```

- [ ] **Step 2: Add a transcript builder + handler**

Add this helper inside the component (reuse the existing message-flattening style used by `copyToClipboard`; this builds a plain-text transcript):
```typescript
    const handleSaveAsSkill = async () => {
        if (messages.length === 0) return;
        const transcript = messages.map((m) => {
            const text = (m.parts ?? [])
                .filter((p: { type: string }) => p.type === "text")
                .map((p: { text?: string }) => p.text ?? "")
                .join("\n") || (typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "");
            return `${m.role.toUpperCase()}: ${text}`;
        }).join("\n\n");
        try {
            const draft = await distillSkill.mutateAsync({ threadId, transcript });
            setSkillDraft(draft);
            setSkillDialogOpen(true);
        } catch (e) {
            toast.error("Could not create skill from chat", { description: e instanceof Error ? e.message : "Try again" });
        }
    };
```
> Adjust the `parts`/`content` extraction to match the actual `messages` element shape in this file (it uses Vercel AI SDK `useChat`). Grep how `copyToClipboard(messages)` / the export functions already flatten messages and mirror that exactly.

Also ensure `toast` is imported from `"sonner"` (it likely already is; if not, add `import { toast } from "sonner";`).

- [ ] **Step 3: Add the "Save as skill" button**

In the chat action buttons `<div className="flex items-center gap-1">` (around line 1782, next to Copy/Export/Clear), add:
```typescript
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                    onClick={handleSaveAsSkill}
                    title="Save chat as a reusable skill"
                    disabled={messages.length === 0 || distillSkill.isPending}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                  </Button>
```

- [ ] **Step 4: Render the dialog**

Near the end of the component's returned JSX (alongside other dialogs/portals), add:
```typescript
            <SkillFormDialog
                open={skillDialogOpen}
                onOpenChange={setSkillDialogOpen}
                initialDraft={skillDraft}
                sourceRunId={threadId}
            />
```

- [ ] **Step 5: Verify manually**

Run the dev server, open AI Ops, have a short conversation, click the ✨ "Save as skill" button. Confirm: a draft is generated, the create dialog opens pre-filled, and saving creates a skill (source "User") that appears at `/app/skills` and in the dropdown. (Requires a configured LLM provider in Settings → Providers; otherwise expect the 400 "configure a provider" toast.)

- [ ] **Step 6: Type-check + commit**

```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "chat-interface" || echo "clean"
git add apps/web-ui/components/agent/chat-interface.tsx
git commit -m "feat(skills): save AI Ops chat as a skill (distill + prefilled dialog)"
```

---

## Task 13: E2E — create a skill, see it in AI Ops

**Files:**
- Create: `apps/web-ui-e2e/skills.spec.ts`

**Interfaces:**
- Consumes: the running app + authenticated session (`storageState` from `auth.setup.ts`).

- [ ] **Step 1: Write the E2E spec**

Create `apps/web-ui-e2e/skills.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test.describe("Skills module", () => {
    test("create a skill and see it in the AI Ops dropdown", async ({ page }) => {
        const name = `E2E Cost Skill ${Date.now()}`;
        await page.goto("/app/skills");
        await page.getByRole("button", { name: "Create skill" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();

        await page.getByLabel("Name").fill(name);
        await page.getByLabel("Description").fill("E2E created skill for cost analysis");
        // Monaco: focus the editor region and type
        await page.locator(".monaco-editor").first().click();
        await page.keyboard.type("# E2E Skill\n1. Do the thing.");

        await page.getByRole("button", { name: "Create skill" }).click();
        await expect(page.getByText(name)).toBeVisible();

        // Appears in AI Ops skill selector
        await page.goto("/app/agent");
        await page.getByText("Select Agent Skill").click();
        await expect(page.getByText(name)).toBeVisible();
    });
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/web-ui-e2e && bunx playwright test skills.spec.ts`
Expected: PASS. (If selectors differ — e.g. the skill trigger label — use Playwright MCP / `--headed` to inspect and adjust to the real accessible names.)

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui-e2e/skills.spec.ts
git commit -m "test(skills): e2e create skill -> visible in AI Ops dropdown"
```

---

## Final verification (run after all tasks)

- [ ] `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -iE "skill" || echo "no skill type errors"` → clean
- [ ] `cd apps/web-ui && bun run test` → skill service + repo + route tests pass (no new failures vs. the known pre-existing baseline)
- [ ] `cd apps/web-ui && bun run lint` → no new errors in touched files
- [ ] Manual: create skill in console → appears in AI Ops dropdown AND is auto-pickable by Agent Ops evaluator
- [ ] Manual: disable a skill → disappears from both dropdowns
- [ ] Manual: chat → "Save as skill" → distilled draft → save → new skill present
- [ ] `grep -rn "agent/skills/skill-loader"` → no results (legacy fully removed)

## Notes on sequencing / risk

- Tasks 4-7 are the risky refactor. Do them in order; **Task 7 (delete) only after Task 9** (the API route still imports the loader until rewritten). The grep gate in Task 7 Step 1 enforces this.
- `tenantId` is already present on `GraphConfig` and is destructured in every graph file — no new plumbing through call chains is required.
- No data migration: the 8 built-ins are re-created by hand via the console (per the spec).
