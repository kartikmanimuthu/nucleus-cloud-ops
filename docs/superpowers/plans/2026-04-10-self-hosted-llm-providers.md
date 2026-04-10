# Self-Hosted LLM Provider Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI-compatible self-hosted LLM provider support (Ollama, vLLM, LiteLLM, LocalAI) alongside existing AWS Bedrock for all three agent types (fast, planning, deep).

**Architecture:** A new `ProviderModel` Prisma table stores tenant-scoped provider configs. `model-factory.ts` routes to `ChatBedrockConverse` or `ChatOpenAI` based on a `ResolvedModelConfig`. Agent graphs require zero changes — they receive a `BaseChatModel` from the factory.

**Tech Stack:** Prisma ORM, `@langchain/openai`, Next.js API routes, React + Radix UI

**Spec:** `docs/superpowers/specs/2026-04-10-self-hosted-llm-providers-design.md`

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `prisma/schema.prisma` | Modify | Add `ProviderModel` model |
| `web-ui/lib/agent/model-resolver.ts` | Create | Parse model string → `ResolvedModelConfig`, DB lookup |
| `web-ui/lib/agent/model-factory.ts` | Modify | Route to `ChatBedrockConverse` or `ChatOpenAI` |
| `web-ui/lib/agent/agent-shared.ts` | Modify | Update `GraphConfig.model` type, `AgentModels` type |
| `web-ui/lib/agent/fast-agent.ts` | Modify | Pass `ResolvedModelConfig` to factory |
| `web-ui/lib/agent/planning-agent.ts` | Modify | Pass `ResolvedModelConfig` to factory |
| `web-ui/lib/agent/deep-agent.ts` | Modify | Use shared factory instead of direct `ChatBedrockConverse` |
| `web-ui/lib/provider-model-service.ts` | Create | CRUD service for `ProviderModel` table |
| `web-ui/app/api/chat/route.ts` | Modify | Call `resolveModelConfig()` before graph creation |
| `web-ui/app/api/settings/providers/route.ts` | Create | GET (list + merged models) / POST (create) |
| `web-ui/app/api/settings/providers/[id]/route.ts` | Create | PUT / DELETE provider |
| `web-ui/app/api/settings/providers/[id]/test/route.ts` | Create | POST connectivity test |
| `web-ui/components/agent/chat-interface.tsx` | Modify | Dynamic model list, grouped dropdown |
| `web-ui/components/settings/provider-settings.tsx` | Create | Provider management UI |
| `web-ui/app/app/settings/providers/page.tsx` | Create | Settings page shell |
| `web-ui/lib/agent/model-resolver.test.ts` | Create | Unit tests for model resolution |
| `web-ui/lib/provider-model-service.test.ts` | Create | Unit tests for provider service |

<!-- TASKS_START -->

### Task 1: Install `@langchain/openai` dependency

**Files:**
- Modify: `web-ui/package.json`

- [ ] **Step 1: Install the package**

```bash
cd web-ui && npm install @langchain/openai
```

- [ ] **Step 2: Verify installation**

```bash
cd web-ui && node -e "const { ChatOpenAI } = require('@langchain/openai'); console.log('OK:', typeof ChatOpenAI)"
```
Expected: `OK: function`

- [ ] **Step 3: Commit**

```bash
git add web-ui/package.json web-ui/package-lock.json
git commit -m "chore: add @langchain/openai for self-hosted LLM support"
```

### Task 2: Add `ProviderModel` to Prisma schema and migrate

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `web-ui/lib/db/pg-config.ts`

- [ ] **Step 1: Add the ProviderModel model to Prisma schema**

Add after the `TenantConfig` model block (line ~53) in `prisma/schema.prisma`:

```prisma
// ProviderModel — tenant-scoped self-hosted LLM provider configurations
// Stores OpenAI-compatible endpoint configs (Ollama, vLLM, LiteLLM, LocalAI)
// Bedrock is the built-in default and is NOT stored here
model ProviderModel {
  id        String   @id @default(uuid())
  tenantId  String   @map("tenant_id")
  name      String
  provider  String   @default("openai-compatible")
  baseUrl   String   @map("base_url")
  apiKey    String?  @map("api_key")
  models    Json     // Array<{ id: string; label: string; maxTokens?: number }>
  isEnabled Boolean  @default(true) @map("is_enabled")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@map("provider_models")
}
```

- [ ] **Step 2: Add relation to Tenant model**

In the `Tenant` model (line ~24), add after `configs TenantConfig[]`:

```prisma
  providerModels ProviderModel[]
```

- [ ] **Step 3: Add to TENANT_SCOPED_MODELS**

In `web-ui/lib/db/pg-config.ts`, add `'ProviderModel'` to the `TENANT_SCOPED_MODELS` set after `'Invitation'`:

```typescript
    'Invitation',
    'ProviderModel',
```

- [ ] **Step 4: Generate client and create migration**

```bash
cd web-ui && npx prisma generate && npx prisma migrate dev --name add_provider_models
```
Expected: Migration created, client generated.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ web-ui/lib/db/pg-config.ts
git commit -m "feat: add ProviderModel table for tenant-scoped LLM providers"
```

### Task 3: Create `ProviderModelService` with tests

**Files:**
- Create: `web-ui/lib/provider-model-service.ts`
- Create: `web-ui/lib/provider-model-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `web-ui/lib/provider-model-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: () => ({
        providerModel: {
            findMany: mockFindMany,
            findFirst: mockFindFirst,
            create: mockCreate,
            update: mockUpdate,
            delete: mockDelete,
        },
    }),
}));

import { ProviderModelService } from './provider-model-service';

describe('ProviderModelService', () => {
    const tenantId = 'tenant-123';

    beforeEach(() => vi.clearAllMocks());

    it('listProviders returns enabled providers', async () => {
        const providers = [{ id: 'p1', name: 'vLLM', isEnabled: true }];
        mockFindMany.mockResolvedValue(providers);
        const result = await ProviderModelService.listProviders(tenantId);
        expect(result).toEqual(providers);
        expect(mockFindMany).toHaveBeenCalledWith({
            where: { isEnabled: true },
            orderBy: { createdAt: 'asc' },
        });
    });

    it('getProvider returns provider by id', async () => {
        const provider = { id: 'p1', tenantId, name: 'vLLM' };
        mockFindFirst.mockResolvedValue(provider);
        const result = await ProviderModelService.getProvider('p1', tenantId);
        expect(result).toEqual(provider);
    });

    it('getProvider returns null when not found', async () => {
        mockFindFirst.mockResolvedValue(null);
        const result = await ProviderModelService.getProvider('x', tenantId);
        expect(result).toBeNull();
    });

    it('createProvider creates with correct data', async () => {
        const input = { name: 'Ollama', baseUrl: 'http://ollama:11434/v1', models: [{ id: 'mistral', label: 'Mistral 7B' }] };
        const created = { id: 'p2', tenantId, ...input };
        mockCreate.mockResolvedValue(created);
        const result = await ProviderModelService.createProvider(tenantId, input);
        expect(result).toEqual(created);
        expect(mockCreate).toHaveBeenCalledWith({
            data: { tenantId, name: 'Ollama', provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1', apiKey: undefined, models: input.models, isEnabled: true },
        });
    });

    it('deleteProvider throws when not found', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(ProviderModelService.deleteProvider('x', tenantId)).rejects.toThrow('Provider not found');
    });

    it('deleteProvider deletes existing provider', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', tenantId });
        mockDelete.mockResolvedValue({ id: 'p1' });
        await ProviderModelService.deleteProvider('p1', tenantId);
        expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web-ui && npx vitest run lib/provider-model-service.test.ts
```
Expected: FAIL — `Cannot find module './provider-model-service'`

- [ ] **Step 3: Implement the service**

Create `web-ui/lib/provider-model-service.ts`:

```typescript
import { getTenantClient } from '@/lib/db/pg-config';

export interface ProviderModelInput {
    name: string;
    baseUrl: string;
    apiKey?: string;
    models: Array<{ id: string; label: string; maxTokens?: number }>;
}

export class ProviderModelService {
    static async listProviders(tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findMany({
            where: { isEnabled: true },
            orderBy: { createdAt: 'asc' },
        });
    }

    static async listAllProviders(tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findMany({ orderBy: { createdAt: 'asc' } });
    }

    static async getProvider(id: string, tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findFirst({ where: { id } });
    }

    static async createProvider(tenantId: string, input: ProviderModelInput) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.create({
            data: {
                tenantId,
                name: input.name,
                provider: 'openai-compatible',
                baseUrl: input.baseUrl,
                apiKey: input.apiKey,
                models: input.models,
                isEnabled: true,
            },
        });
    }

    static async updateProvider(id: string, tenantId: string, input: Partial<ProviderModelInput> & { isEnabled?: boolean }) {
        const existing = await this.getProvider(id, tenantId);
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.update({
            where: { id },
            data: {
                ...(input.name !== undefined && { name: input.name }),
                ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
                ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
                ...(input.models !== undefined && { models: input.models }),
                ...(input.isEnabled !== undefined && { isEnabled: input.isEnabled }),
            },
        });
    }

    static async deleteProvider(id: string, tenantId: string) {
        const existing = await this.getProvider(id, tenantId);
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.delete({ where: { id } });
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web-ui && npx vitest run lib/provider-model-service.test.ts
```
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/provider-model-service.ts web-ui/lib/provider-model-service.test.ts
git commit -m "feat: add ProviderModelService for tenant-scoped provider CRUD"
```

### Task 4: Update `agent-shared.ts` types — `GraphConfig` and `AgentModels`

**Files:**
- Modify: `web-ui/lib/agent/agent-shared.ts`

- [ ] **Step 1: Add `ResolvedModelConfig` type export**

At the top of `web-ui/lib/agent/agent-shared.ts`, after the existing imports (line ~3), add:

```typescript
/** Resolved model configuration — provider-agnostic. */
export interface ResolvedModelConfig {
    provider: "bedrock" | "openai-compatible";
    modelId: string;
    baseUrl?: string;
    apiKey?: string;
    maxTokens?: number;
}
```

- [ ] **Step 2: Update `GraphConfig.model` type**

Change the `GraphConfig` interface (line ~378) from:

```typescript
export interface GraphConfig {
    model: string;
```

to:

```typescript
export interface GraphConfig {
    model: ResolvedModelConfig;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | head -30
```
Expected: Type errors in `fast-agent.ts`, `planning-agent.ts`, `deep-agent.ts`, `model-factory.ts`, `chat/route.ts` — these are expected and will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add web-ui/lib/agent/agent-shared.ts
git commit -m "feat: update GraphConfig.model to ResolvedModelConfig type"
```

### Task 5: Update `model-factory.ts` — provider-aware model creation

**Files:**
- Modify: `web-ui/lib/agent/model-factory.ts`

- [ ] **Step 1: Add ChatOpenAI import and update AgentModels type**

At the top of `web-ui/lib/agent/model-factory.ts`, add the ChatOpenAI import alongside the existing ChatBedrockConverse import:

```typescript
import { ChatBedrockConverse } from "@langchain/aws";
import { ChatOpenAI } from "@langchain/openai";
```

Update the `AgentModels` interface to use `BaseChatModel`:

```typescript
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface AgentModels {
    main: BaseChatModel;
    reflector: BaseChatModel;
}
```

- [ ] **Step 2: Update `createAgentModels` signature and implementation**

Replace the existing `createAgentModels` function with:

```typescript
import { ResolvedModelConfig } from "./agent-shared";

export function createAgentModels(config: ResolvedModelConfig): AgentModels {
    if (config.provider === "openai-compatible") {
        const openaiConfig = {
            modelName: config.modelId,
            configuration: {
                baseURL: config.baseUrl,
                apiKey: config.apiKey || "not-needed",
            },
            temperature: 0,
        };
        return {
            main: new ChatOpenAI({
                ...openaiConfig,
                maxTokens: config.maxTokens || 8192,
                streaming: true,
            }),
            reflector: new ChatOpenAI({
                ...openaiConfig,
                maxTokens: 2048,
                streaming: false,
            }),
        };
    }

    // Default: Bedrock
    const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null';
    const bedrockConfig = { region, model: config.modelId, temperature: 0 };
    return {
        main: new ChatBedrockConverse({
            ...bedrockConfig,
            maxTokens: config.maxTokens || 8192,
            streaming: true,
        }),
        reflector: new ChatBedrockConverse({
            ...bedrockConfig,
            maxTokens: 2048,
            streaming: false,
        }),
    };
}
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/agent/model-factory.ts
git commit -m "feat: model-factory routes to ChatBedrockConverse or ChatOpenAI"
```

### Task 6: Create `model-resolver.ts` with tests

**Files:**
- Create: `web-ui/lib/agent/model-resolver.ts`
- Create: `web-ui/lib/agent/model-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `web-ui/lib/agent/model-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetProvider = vi.fn();
vi.mock('@/lib/provider-model-service', () => ({
    ProviderModelService: { getProvider: mockGetProvider },
}));

import { resolveModelConfig } from './model-resolver';

describe('resolveModelConfig', () => {
    beforeEach(() => vi.clearAllMocks());

    it('resolves bare Bedrock model ID (backward compat)', async () => {
        const result = await resolveModelConfig('global.anthropic.claude-sonnet-4-6', 'tenant-1');
        expect(result).toEqual({ provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-6' });
    });

    it('resolves bedrock: prefixed model ID', async () => {
        const result = await resolveModelConfig('bedrock:global.anthropic.claude-sonnet-4-6', 'tenant-1');
        expect(result).toEqual({ provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-6' });
    });

    it('resolves openai-compatible model with DB lookup', async () => {
        mockGetProvider.mockResolvedValue({
            id: 'prov-uuid',
            baseUrl: 'http://vllm:8000/v1',
            apiKey: 'sk-test',
            models: [{ id: 'meta-llama/Llama-3.3-70B', label: 'Llama 70B', maxTokens: 4096 }],
            isEnabled: true,
        });
        const result = await resolveModelConfig('openai-compatible:meta-llama/Llama-3.3-70B:prov-uuid', 'tenant-1');
        expect(result).toEqual({
            provider: 'openai-compatible',
            modelId: 'meta-llama/Llama-3.3-70B',
            baseUrl: 'http://vllm:8000/v1',
            apiKey: 'sk-test',
            maxTokens: 4096,
        });
        expect(mockGetProvider).toHaveBeenCalledWith('prov-uuid', 'tenant-1');
    });

    it('throws when provider record not found', async () => {
        mockGetProvider.mockResolvedValue(null);
        await expect(resolveModelConfig('openai-compatible:llama:bad-uuid', 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });

    it('throws when provider is disabled', async () => {
        mockGetProvider.mockResolvedValue({ id: 'prov-uuid', isEnabled: false, models: [] });
        await expect(resolveModelConfig('openai-compatible:llama:prov-uuid', 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });

    it('throws when model not in provider model list', async () => {
        mockGetProvider.mockResolvedValue({
            id: 'prov-uuid', isEnabled: true, baseUrl: 'http://vllm:8000/v1',
            models: [{ id: 'other-model', label: 'Other' }],
        });
        await expect(resolveModelConfig('openai-compatible:llama:prov-uuid', 'tenant-1'))
            .rejects.toThrow('Model "llama" is not available');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web-ui && npx vitest run lib/agent/model-resolver.test.ts
```
Expected: FAIL — `Cannot find module './model-resolver'`

- [ ] **Step 3: Implement the resolver**

Create `web-ui/lib/agent/model-resolver.ts`:

```typescript
import { ProviderModelService } from '@/lib/provider-model-service';
import type { ResolvedModelConfig } from './agent-shared';

/**
 * Resolves a model identifier string into a provider-agnostic config.
 *
 * Format: {provider}:{modelId}:{providerRecordId}
 * Examples:
 *   bedrock:global.anthropic.claude-sonnet-4-6
 *   openai-compatible:meta-llama/Llama-3.3-70B:uuid
 *
 * Bare strings (no colon prefix) are treated as Bedrock for backward compatibility.
 */
export async function resolveModelConfig(
    modelString: string,
    tenantId: string,
): Promise<ResolvedModelConfig> {
    // Backward compat: bare Bedrock model IDs have no colon-separated provider prefix
    if (!modelString.includes(':') || modelString.startsWith('global.')) {
        return { provider: 'bedrock', modelId: modelString };
    }

    const parts = modelString.split(':');
    const providerType = parts[0];

    if (providerType === 'bedrock') {
        return { provider: 'bedrock', modelId: parts.slice(1).join(':') };
    }

    if (providerType === 'openai-compatible') {
        // Format: openai-compatible:{modelId}:{providerRecordId}
        const modelId = parts[1];
        const providerRecordId = parts[2];

        if (!providerRecordId) {
            throw new Error('Provider record ID is required for openai-compatible models');
        }

        const record = await ProviderModelService.getProvider(providerRecordId, tenantId);
        if (!record || !record.isEnabled) {
            throw new Error('Provider not found or disabled');
        }

        const models = record.models as Array<{ id: string; label: string; maxTokens?: number }>;
        const modelEntry = models.find(m => m.id === modelId);
        if (!modelEntry) {
            throw new Error(`Model "${modelId}" is not available on provider "${record.name}"`);
        }

        return {
            provider: 'openai-compatible',
            modelId,
            baseUrl: record.baseUrl,
            apiKey: record.apiKey || undefined,
            maxTokens: modelEntry.maxTokens,
        };
    }

    // Unknown provider prefix — treat as Bedrock
    return { provider: 'bedrock', modelId: modelString };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web-ui && npx vitest run lib/agent/model-resolver.test.ts
```
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/agent/model-resolver.ts web-ui/lib/agent/model-resolver.test.ts
git commit -m "feat: add model-resolver for provider-aware model string parsing"
```

### Task 7: Update agent files to use `ResolvedModelConfig`

**Files:**
- Modify: `web-ui/lib/agent/fast-agent.ts`
- Modify: `web-ui/lib/agent/planning-agent.ts`
- Modify: `web-ui/lib/agent/deep-agent.ts`

- [ ] **Step 1: Update `fast-agent.ts`**

In `web-ui/lib/agent/fast-agent.ts`, the `createFastGraph` function destructures `config.model` as a string on line 33:

```typescript
const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
```

Change to:

```typescript
const { model: modelConfig, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
const modelId = modelConfig.modelId; // For logging only
```

Then update the `createAgentModels` call on line 58 from:

```typescript
const { main: model, reflector: reflectorModel } = createAgentModels(modelId);
```

to:

```typescript
const { main: model, reflector: reflectorModel } = createAgentModels(modelConfig);
```

- [ ] **Step 2: Update `planning-agent.ts`**

In `web-ui/lib/agent/planning-agent.ts`, same pattern. Line 33:

```typescript
const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
```

Change to:

```typescript
const { model: modelConfig, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
const modelId = modelConfig.modelId;
```

Update the `createAgentModels` call on line 60 from:

```typescript
const { main: model, reflector: reflectorModel } = createAgentModels(modelId);
```

to:

```typescript
const { main: model, reflector: reflectorModel } = createAgentModels(modelConfig);
```

- [ ] **Step 3: Update `deep-agent.ts`**

In `web-ui/lib/agent/deep-agent.ts`, replace the direct `ChatBedrockConverse` construction (lines 66-72):

```typescript
const model = new ChatBedrockConverse({
    region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
    model: modelId,
    maxTokens: 8192,
    temperature: 0,
    streaming: true,
});
```

with:

```typescript
import { createAgentModels } from "./model-factory";

const modelConfig = config.model;
const modelId = modelConfig.modelId;
const { main: model } = createAgentModels(modelConfig);
```

Also update the destructuring at line 28 from:

```typescript
const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId, userId } = config as any;
```

to:

```typescript
const { model: modelConfig, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId, userId } = config as any;
const modelId = modelConfig.modelId;
```

Remove the now-unused `ChatBedrockConverse` import from the top of the file.

- [ ] **Step 4: Verify TypeScript compiles (agent files only)**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | grep -E "(fast-agent|planning-agent|deep-agent)" | head -10
```
Expected: No errors from these three files. Remaining errors should only be in `chat/route.ts` (fixed in Task 8).

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/agent/fast-agent.ts web-ui/lib/agent/planning-agent.ts web-ui/lib/agent/deep-agent.ts
git commit -m "feat: update all agents to use ResolvedModelConfig from factory"
```

### Task 8: Update `chat/route.ts` to resolve model config

**Files:**
- Modify: `web-ui/app/api/chat/route.ts`

- [ ] **Step 1: Add import for resolveModelConfig**

At the top of `web-ui/app/api/chat/route.ts`, add after the existing imports:

```typescript
import { resolveModelConfig } from '@/lib/agent/model-resolver';
```

- [ ] **Step 2: Add model resolution before graph creation**

Replace the `graphConfig` construction block (lines ~118-128):

```typescript
const graphConfig = {
    model: model || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    autoApprove: autoApprove,
    accounts: accounts,
    accountId: accountId,
    accountName: accountName,
    selectedSkill: selectedSkill || null,
    mcpServerIds: mcpServerIds || [],
    userId: resolvedUserId,
    tenantId: resolvedTenantId,
};
```

with:

```typescript
const resolvedModel = await resolveModelConfig(
    model || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    resolvedTenantId,
);

const graphConfig = {
    model: resolvedModel,
    autoApprove: autoApprove,
    accounts: accounts,
    accountId: accountId,
    accountName: accountName,
    selectedSkill: selectedSkill || null,
    mcpServerIds: mcpServerIds || [],
    userId: resolvedUserId,
    tenantId: resolvedTenantId,
};
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | head -20
```
Expected: No type errors (or only pre-existing unrelated ones).

- [ ] **Step 4: Commit**

```bash
git add web-ui/app/api/chat/route.ts
git commit -m "feat: resolve model config in chat API route before graph creation"
```

### Task 9: Create provider CRUD API routes

**Files:**
- Create: `web-ui/app/api/settings/providers/route.ts`
- Create: `web-ui/app/api/settings/providers/[id]/route.ts`
- Create: `web-ui/app/api/settings/providers/[id]/test/route.ts`

- [ ] **Step 1: Create the list + create route**

Create `web-ui/app/api/settings/providers/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';

// Built-in Bedrock models — always available regardless of tenant config
const BEDROCK_MODELS = [
    { id: 'bedrock:global.anthropic.claude-sonnet-4-6', label: 'Claude 4.6 Sonnet', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude 4.5 Sonnet', provider: 'bedrock' },
    { id: 'bedrock:global.amazon.nova-2-lite-v1:0', label: 'Nova 2 Lite', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude 4.5 Haiku', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude 4.5 Opus', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-opus-4-6-v1', label: 'Claude 4.6 Opus', provider: 'bedrock' },
];

export async function GET(_request: NextRequest) {
    console.log('API - GET /api/settings/providers - Fetching providers');
    const authError = await authorize('read', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const providers = await ProviderModelService.listAllProviders(tenantId);

        // Build merged model list: Bedrock defaults + tenant self-hosted models
        const selfHostedModels = providers
            .filter(p => p.isEnabled)
            .flatMap(p => {
                const models = p.models as Array<{ id: string; label: string; maxTokens?: number }>;
                return models.map(m => ({
                    id: `openai-compatible:${m.id}:${p.id}`,
                    label: `${m.label} (${p.name})`,
                    provider: 'openai-compatible' as const,
                }));
            });

        return NextResponse.json({
            success: true,
            data: {
                providers,
                models: [...BEDROCK_MODELS, ...selfHostedModels],
            },
        });
    } catch (error) {
        console.error('API - Error fetching providers:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch providers' },
            { status: 500 },
        );
    }
}

export async function POST(request: NextRequest) {
    console.log('API - POST /api/settings/providers - Creating provider');
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const { name, baseUrl, apiKey, models } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json({ success: false, error: 'Provider name is required' }, { status: 400 });
        }
        if (!baseUrl || typeof baseUrl !== 'string') {
            return NextResponse.json({ success: false, error: 'Base URL is required' }, { status: 400 });
        }
        if (!models || !Array.isArray(models) || models.length === 0) {
            return NextResponse.json({ success: false, error: 'At least one model is required' }, { status: 400 });
        }

        const provider = await ProviderModelService.createProvider(tenantId, {
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            apiKey: apiKey || undefined,
            models,
        });

        return NextResponse.json({ success: true, data: provider }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating provider:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create provider' },
            { status: 500 },
        );
    }
}
```

- [ ] **Step 2: Create the single-provider update/delete route**

Create `web-ui/app/api/settings/providers/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - PUT /api/settings/providers/${id} - Updating provider`);
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const updated = await ProviderModelService.updateProvider(id, tenantId, body);
        return NextResponse.json({ success: true, data: updated });
    } catch (error) {
        console.error('API - Error updating provider:', error);
        const message = error instanceof Error ? error.message : 'Failed to update provider';
        return NextResponse.json({ success: false, error: message }, { status: message.includes('not found') ? 404 : 500 });
    }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - DELETE /api/settings/providers/${id} - Deleting provider`);
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        await ProviderModelService.deleteProvider(id, tenantId);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('API - Error deleting provider:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete provider';
        return NextResponse.json({ success: false, error: message }, { status: message.includes('not found') ? 404 : 500 });
    }
}
```

- [ ] **Step 3: Create the connectivity test route**

Create `web-ui/app/api/settings/providers/[id]/test/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - POST /api/settings/providers/${id}/test - Testing connectivity`);
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const provider = await ProviderModelService.getProvider(id, tenantId);
        if (!provider) {
            return NextResponse.json({ success: false, error: 'Provider not found' }, { status: 404 });
        }

        // Hit the /v1/models endpoint to verify connectivity
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (provider.apiKey) {
            headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }

        const response = await fetch(`${provider.baseUrl}/models`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            return NextResponse.json({
                success: false,
                error: `Endpoint returned ${response.status}: ${response.statusText}`,
            }, { status: 502 });
        }

        const data = await response.json();
        const availableModels = data.data?.map((m: any) => ({ id: m.id, name: m.id })) ?? [];

        return NextResponse.json({
            success: true,
            data: { status: 'connected', availableModels },
        });
    } catch (error) {
        console.error('API - Error testing provider:', error);
        const message = error instanceof Error ? error.message : 'Connection failed';
        return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
}
```

- [ ] **Step 4: Verify routes compile**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | grep -i "settings/providers" | head -10
```
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add web-ui/app/api/settings/providers/
git commit -m "feat: add provider CRUD API routes with connectivity test"
```

### Task 10: Update `chat-interface.tsx` — dynamic model list from API

**Files:**
- Modify: `web-ui/components/agent/chat-interface.tsx`

- [ ] **Step 1: Replace hardcoded AVAILABLE_MODELS with API fetch**

In `web-ui/components/agent/chat-interface.tsx`, remove the hardcoded `AVAILABLE_MODELS` array (lines ~100-131):

```typescript
const AVAILABLE_MODELS = [
  {
    id: "global.anthropic.claude-sonnet-4-6",
    label: "Claude 4.6 Sonnet",
    provider: "amazon",
  },
  // ... all entries
];
```

Replace with a type and empty default:

```typescript
interface AvailableModel {
  id: string;
  label: string;
  provider: string;
}

const DEFAULT_MODELS: AvailableModel[] = [
  { id: "bedrock:global.anthropic.claude-sonnet-4-6", label: "Claude 4.6 Sonnet", provider: "bedrock" },
  { id: "bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Claude 4.5 Sonnet", provider: "bedrock" },
];
```

- [ ] **Step 2: Add state and fetch hook inside the component**

Inside the component function (after existing state declarations), add:

```typescript
const [availableModels, setAvailableModels] = useState<AvailableModel[]>(DEFAULT_MODELS);

useEffect(() => {
    async function fetchModels() {
        try {
            const res = await fetch('/api/settings/providers');
            const json = await res.json();
            if (res.ok && json.success && json.data?.models?.length > 0) {
                setAvailableModels(json.data.models);
            }
        } catch {
            // Silently fall back to defaults
        }
    }
    fetchModels();
}, []);
```

- [ ] **Step 3: Update the model selector dropdown to use `availableModels` with grouping**

Find the model selector `<Select>` that maps over `AVAILABLE_MODELS` and replace the mapping with grouped rendering:

```typescript
{/* Bedrock models */}
{availableModels.filter(m => m.provider === 'bedrock').length > 0 && (
  <SelectGroup>
    <SelectLabel className="text-xs text-muted-foreground px-2">Bedrock</SelectLabel>
    {availableModels.filter(m => m.provider === 'bedrock').map((model) => (
      <SelectItem key={model.id} value={model.id}>
        {model.label}
      </SelectItem>
    ))}
  </SelectGroup>
)}
{/* Self-hosted models */}
{availableModels.filter(m => m.provider === 'openai-compatible').length > 0 && (
  <SelectGroup>
    <SelectLabel className="text-xs text-muted-foreground px-2">Self-Hosted</SelectLabel>
    {availableModels.filter(m => m.provider === 'openai-compatible').map((model) => (
      <SelectItem key={model.id} value={model.id}>
        {model.label}
      </SelectItem>
    ))}
  </SelectGroup>
)}
```

Add `SelectGroup` and `SelectLabel` to the Radix UI imports if not already present:

```typescript
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from "@/components/ui/select";
```

- [ ] **Step 4: Update the default selectedModel state**

Find the `selectedModel` state initialization and update it to use the new prefixed format:

```typescript
const [selectedModel, setSelectedModel] = useState("bedrock:global.anthropic.claude-sonnet-4-6");
```

- [ ] **Step 5: Verify the component compiles**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | grep "chat-interface" | head -10
```
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add web-ui/components/agent/chat-interface.tsx
git commit -m "feat: dynamic model picker with Bedrock + self-hosted grouping"
```

### Task 11: Create provider settings page and component

**Files:**
- Create: `web-ui/components/settings/provider-settings.tsx`
- Create: `web-ui/app/app/settings/providers/page.tsx`

- [ ] **Step 1: Create the provider settings component**

Create `web-ui/components/settings/provider-settings.tsx`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Trash2, Plus, TestTube, Loader2, Server } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

interface ProviderModel {
    id: string;
    label: string;
    maxTokens?: number;
}

interface Provider {
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string | null;
    models: ProviderModel[];
    isEnabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export function ProviderSettings() {
    const [providers, setProviders] = useState<Provider[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [testing, setTesting] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

    // Form state
    const [formName, setFormName] = useState("");
    const [formBaseUrl, setFormBaseUrl] = useState("");
    const [formApiKey, setFormApiKey] = useState("");
    const [formModels, setFormModels] = useState<ProviderModel[]>([{ id: "", label: "" }]);
    const [saving, setSaving] = useState(false);

    const fetchProviders = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/settings/providers");
            const json = await res.json();
            if (!res.ok || !json.success) {
                setError(json.error ?? "Failed to load providers.");
                return;
            }
            setProviders(json.data.providers ?? []);
        } catch {
            setError("Failed to load providers.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchProviders(); }, [fetchProviders]);

    const handleCreate = async () => {
        setSaving(true);
        try {
            const validModels = formModels.filter(m => m.id.trim() && m.label.trim());
            if (validModels.length === 0) {
                setError("At least one model with ID and label is required.");
                setSaving(false);
                return;
            }
            const res = await fetch("/api/settings/providers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: formName,
                    baseUrl: formBaseUrl,
                    apiKey: formApiKey || undefined,
                    models: validModels,
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to create provider");
            setDialogOpen(false);
            resetForm();
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create provider");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            const res = await fetch(`/api/settings/providers/${id}`, { method: "DELETE" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error);
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to delete provider");
        }
    };

    const handleToggle = async (id: string, isEnabled: boolean) => {
        try {
            const res = await fetch(`/api/settings/providers/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isEnabled }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error);
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update provider");
        }
    };

    const handleTest = async (id: string) => {
        setTesting(id);
        setTestResult(null);
        try {
            const res = await fetch(`/api/settings/providers/${id}/test`, { method: "POST" });
            const json = await res.json();
            setTestResult({
                id,
                success: json.success,
                message: json.success
                    ? `Connected. ${json.data?.availableModels?.length ?? 0} models available.`
                    : json.error ?? "Connection failed",
            });
        } catch {
            setTestResult({ id, success: false, message: "Connection failed" });
        } finally {
            setTesting(null);
        }
    };

    const resetForm = () => {
        setFormName("");
        setFormBaseUrl("");
        setFormApiKey("");
        setFormModels([{ id: "", label: "" }]);
    };

    const addModelField = () => setFormModels([...formModels, { id: "", label: "" }]);

    const updateModelField = (index: number, field: "id" | "label", value: string) => {
        const updated = [...formModels];
        updated[index] = { ...updated[index], [field]: value };
        setFormModels(updated);
    };

    const removeModelField = (index: number) => {
        if (formModels.length <= 1) return;
        setFormModels(formModels.filter((_, i) => i !== index));
    };

    return (
        <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 bg-background">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                        <Server className="h-6 w-6" />
                        <h2 className="text-3xl font-bold tracking-tight text-foreground">LLM Providers</h2>
                    </div>
                    <p className="text-muted-foreground">
                        Configure self-hosted LLM endpoints (Ollama, vLLM, LiteLLM) for your organization.
                    </p>
                </div>
                <Button onClick={() => { resetForm(); setDialogOpen(true); }}>
                    <Plus className="mr-2 h-4 w-4" /> Add Provider
                </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {loading ? (
                <p className="text-muted-foreground text-sm">Loading providers...</p>
            ) : providers.length === 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>No providers configured</CardTitle>
                        <CardDescription>
                            Add a self-hosted LLM provider to use open-source models alongside AWS Bedrock.
                        </CardDescription>
                    </CardHeader>
                </Card>
            ) : (
                <div className="grid gap-4">
                    {providers.map((p) => (
                        <Card key={p.id}>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <div>
                                    <CardTitle className="text-lg">{p.name}</CardTitle>
                                    <CardDescription className="font-mono text-xs">{p.baseUrl}</CardDescription>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button variant="outline" size="sm" onClick={() => handleTest(p.id)} disabled={testing === p.id}>
                                        {testing === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <TestTube className="h-4 w-4" />}
                                        <span className="ml-1">Test</span>
                                    </Button>
                                    <Switch checked={p.isEnabled} onCheckedChange={(v) => handleToggle(p.id, v)} />
                                    <Button variant="ghost" size="sm" onClick={() => handleDelete(p.id)}>
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="flex flex-wrap gap-2">
                                    {(p.models as ProviderModel[]).map((m) => (
                                        <Badge key={m.id} variant="secondary">{m.label || m.id}</Badge>
                                    ))}
                                </div>
                                {testResult?.id === p.id && (
                                    <p className={`mt-2 text-sm ${testResult.success ? 'text-green-600' : 'text-destructive'}`}>
                                        {testResult.message}
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Add LLM Provider</DialogTitle>
                        <DialogDescription>
                            Configure an OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, LocalAI).
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="provider-name">Name</Label>
                            <Input id="provider-name" placeholder="Internal vLLM Cluster" value={formName} onChange={(e) => setFormName(e.target.value)} />
                        </div>
                        <div>
                            <Label htmlFor="provider-url">Base URL</Label>
                            <Input id="provider-url" placeholder="http://vllm.internal:8000/v1" value={formBaseUrl} onChange={(e) => setFormBaseUrl(e.target.value)} />
                        </div>
                        <div>
                            <Label htmlFor="provider-key">API Key (optional)</Label>
                            <Input id="provider-key" type="password" placeholder="sk-..." value={formApiKey} onChange={(e) => setFormApiKey(e.target.value)} />
                        </div>
                        <div>
                            <Label>Models</Label>
                            <div className="space-y-2 mt-1">
                                {formModels.map((m, i) => (
                                    <div key={i} className="flex gap-2">
                                        <Input placeholder="Model ID (e.g. meta-llama/Llama-3.3-70B)" value={m.id} onChange={(e) => updateModelField(i, "id", e.target.value)} />
                                        <Input placeholder="Display label" value={m.label} onChange={(e) => updateModelField(i, "label", e.target.value)} className="w-48" />
                                        {formModels.length > 1 && (
                                            <Button variant="ghost" size="sm" onClick={() => removeModelField(i)}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>
                                ))}
                                <Button variant="outline" size="sm" onClick={addModelField}>
                                    <Plus className="h-3 w-3 mr-1" /> Add Model
                                </Button>
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleCreate} disabled={saving || !formName.trim() || !formBaseUrl.trim()}>
                            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Add Provider
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
```

- [ ] **Step 2: Create the settings page**

Create `web-ui/app/app/settings/providers/page.tsx`:

```typescript
import { ProviderSettings } from "@/components/settings/provider-settings";

export default function ProvidersPage() {
    return <ProviderSettings />;
}
```

- [ ] **Step 3: Add navigation link to settings layout**

Check `web-ui/app/app/settings/page.tsx` for the settings navigation. Add a link to the providers page following the existing pattern (alongside Members, Roles, Organization links):

```typescript
{ href: "/app/settings/providers", label: "LLM Providers", icon: Server }
```

Import `Server` from `lucide-react` if not already imported.

- [ ] **Step 4: Verify the page compiles**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | grep -i "provider" | head -10
```
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add web-ui/components/settings/provider-settings.tsx web-ui/app/app/settings/providers/page.tsx web-ui/app/app/settings/page.tsx
git commit -m "feat: add provider settings page with CRUD UI and connectivity test"
```

### Task 12: Final verification — build and lint

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript compilation**

```bash
cd web-ui && npx tsc --noEmit
```
Expected: No errors (or only pre-existing unrelated ones).

- [ ] **Step 2: Run ESLint**

```bash
cd web-ui && npm run lint
```
Expected: No new lint errors.

- [ ] **Step 3: Run all tests**

```bash
cd web-ui && npm run test
```
Expected: All tests pass, including the new `model-resolver.test.ts` and `provider-model-service.test.ts`.

- [ ] **Step 4: Run build**

```bash
cd web-ui && npm run build
```
Expected: Build succeeds.

- [ ] **Step 5: Commit any lint/build fixes if needed**

```bash
git add -A && git commit -m "fix: resolve lint and build issues from provider support"
```
Only run this if Steps 1-4 required fixes.
