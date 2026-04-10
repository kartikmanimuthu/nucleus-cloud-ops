# Self-Hosted LLM Provider Support for AI Ops Module

**Date:** 2026-04-10
**Status:** Draft
**Scope:** Add OpenAI-compatible self-hosted LLM provider support (Ollama, vLLM, LiteLLM, LocalAI, llama.cpp) alongside existing AWS Bedrock for all three agent types (fast, planning, deep).

## Motivation

- **Data sovereignty:** Some queries must never leave the customer's network. A fully self-hosted inference path is required.
- **Model flexibility:** Experiment with open-source models (Llama, Mistral, DeepSeek, etc.) alongside Claude on Bedrock.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Provider selection | Per-tenant config + per-session model picker | Tenant admins configure available providers; users pick from what their tenant enables |
| Protocol | OpenAI-compatible API only (`/v1/chat/completions`) | Covers Ollama, vLLM, LiteLLM, LocalAI, llama.cpp — 80/20 play |
| Tool calling | Required — models must support OpenAI tool-calling API | Keeps agent loop reliable; no prompt-based fallback hacks |
| Reflector model | Same provider, same model as main | Minimal config surface |
| Implementation | LangChain `ChatOpenAI` adapter | Same `BaseChatModel` interface as `ChatBedrockConverse`; zero changes to agent graphs |

## Architecture Overview

Three layers of change:

1. **Data layer** — New `ProviderModel` Prisma model for tenant-scoped provider configurations
2. **Model factory** — `model-factory.ts` routes to `ChatBedrockConverse` or `ChatOpenAI` based on resolved config
3. **Frontend** — Dynamic model picker merging Bedrock defaults with tenant-configured self-hosted models

Agent graphs (fast, planning, deep) require zero changes — they receive a `BaseChatModel` from the factory.

## Data Model

New Prisma model:

```prisma
model ProviderModel {
  id          String   @id @default(uuid())
  tenantId    String   @map("tenant_id")
  name        String                          // Display name: "Internal vLLM Cluster"
  provider    String   @default("openai-compatible")
  baseUrl     String   @map("base_url")       // e.g., "https://vllm.internal:8000/v1"
  apiKey      String?  @map("api_key")        // Optional — some internal endpoints skip auth
  models      Json                            // Array: [{ "id": "meta-llama/Llama-3.3-70B", "label": "Llama 3.3 70B", "maxTokens": 4096 }]
  isEnabled   Boolean  @default(true) @map("is_enabled")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  tenant      Tenant   @relation(fields: [tenantId], references: [id])

  @@map("provider_models")
}
```

- `models` is a JSON array with shape `Array<{ id: string; label: string; maxTokens?: number }>` — provider model lists change frequently, don't need relational queries
- `apiKey` is nullable — internal vLLM/Ollama endpoints often run without auth
- Bedrock is NOT stored here — it's the built-in default, always available
- `baseUrl` points to the OpenAI-compatible base (e.g., `http://ollama:11434/v1`, `http://vllm:8000/v1`)

## Model Resolution Flow

### Model Identifier Format

```
{provider}:{modelId}:{providerRecordId?}
```

Examples:
```
bedrock:global.anthropic.claude-sonnet-4-6
openai-compatible:meta-llama/Llama-3.3-70B:a1b2c3d4-uuid
```

Bare strings without a provider prefix (e.g., `global.anthropic.claude-sonnet-4-5-20250929-v1:0`) are treated as Bedrock for backward compatibility.

### ResolvedModelConfig Type

```typescript
interface ResolvedModelConfig {
  provider: "bedrock" | "openai-compatible";
  modelId: string;           // Bedrock model ID or self-hosted model name
  baseUrl?: string;          // Required for openai-compatible
  apiKey?: string;           // Optional for openai-compatible
  maxTokens?: number;        // Override from provider config, default 8192
}
```

### Resolution Function

New file: `web-ui/lib/agent/model-resolver.ts`

```typescript
async function resolveModelConfig(
  modelString: string,
  tenantId: string
): Promise<ResolvedModelConfig>
```

- Parses the `{provider}:{modelId}:{providerRecordId}` format
- For `bedrock:*` — no DB lookup, construct config directly
- For `openai-compatible:*` — fetch `ProviderModel` by ID + tenantId, verify model is in its `models` array, build config with `baseUrl` and `apiKey`
- Bare model IDs (no prefix) → Bedrock (backward compatible)

## Model Factory Changes

`model-factory.ts` — `createAgentModels()` signature changes:

**Before:** `createAgentModels(modelId: string): AgentModels`
**After:** `createAgentModels(config: ResolvedModelConfig): AgentModels`

```typescript
function createAgentModels(config: ResolvedModelConfig): AgentModels {
  if (config.provider === "openai-compatible") {
    const model = new ChatOpenAI({
      modelName: config.modelId,
      configuration: { baseURL: config.baseUrl, apiKey: config.apiKey || "not-needed" },
      maxTokens: config.maxTokens || 8192,
      temperature: 0,
      streaming: true,
    });
    const reflector = new ChatOpenAI({
      modelName: config.modelId,
      configuration: { baseURL: config.baseUrl, apiKey: config.apiKey || "not-needed" },
      maxTokens: 2048,
      temperature: 0,
      streaming: false,
    });
    return { main: model, reflector: reflector };
  }

  // Default: Bedrock (existing behavior, unchanged)
  const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null';
  return {
    main: new ChatBedrockConverse({ region, model: config.modelId, maxTokens: 8192, temperature: 0, streaming: true }),
    reflector: new ChatBedrockConverse({ region, model: config.modelId, maxTokens: 2048, temperature: 0, streaming: false }),
  };
}
```

`ChatOpenAI` requires a non-empty API key string — for keyless internal endpoints, pass `"not-needed"`.

### AgentModels Type Update

```typescript
// Before
export interface AgentModels {
  main: ChatBedrockConverse;
  reflector: ChatBedrockConverse;
}

// After
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface AgentModels {
  main: BaseChatModel;
  reflector: BaseChatModel;
}
```

### GraphConfig Change

```typescript
// Before
export interface GraphConfig {
  model: string;
  // ...
}

// After
export interface GraphConfig {
  model: ResolvedModelConfig;
  // ...
}
```

### deep-agent.ts

Currently creates its own `ChatBedrockConverse` directly. Updated to use the shared `createAgentModels()` factory, receiving the same `ResolvedModelConfig` as fast and planning agents.

## API Route Changes

### `chat/route.ts`

Before graph creation, resolve the model string:

```typescript
const resolvedModel = await resolveModelConfig(
  model || 'bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  resolvedTenantId
);

const graphConfig = {
  model: resolvedModel,
  // ... rest unchanged
};
```

### New Provider CRUD Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/settings/providers` | List provider configs for tenant + merged model list |
| `POST` | `/api/settings/providers` | Add a new provider endpoint |
| `PUT` | `/api/settings/providers/[id]` | Update provider config |
| `DELETE` | `/api/settings/providers/[id]` | Remove provider |
| `POST` | `/api/settings/providers/[id]/test` | Test connectivity — hits `/v1/models` on the endpoint |

All routes use `authorize('update', 'Settings')` — tenant admin only.

### Provider Models API Response

`GET /api/settings/providers` returns a merged model list:

```json
{
  "providers": [ /* raw ProviderModel records for the settings UI */ ],
  "models": [
    { "id": "bedrock:global.anthropic.claude-sonnet-4-6", "label": "Claude 4.6 Sonnet", "provider": "bedrock" },
    { "id": "openai-compatible:meta-llama/Llama-3.3-70B:uuid", "label": "Llama 3.3 70B (vLLM)", "provider": "openai-compatible" }
  ]
}
```

## Frontend Changes

### chat-interface.tsx — Dynamic Model List

Replace hardcoded `AVAILABLE_MODELS` with a fetch from `/api/settings/providers` (models field). Models grouped by provider in the dropdown:

```
── Bedrock ──
  Claude 4.6 Sonnet
  Claude 4.5 Sonnet
  Claude 4.5 Haiku
  Claude 4.5 Opus
  Claude 4.6 Opus
── Self-Hosted ──
  Llama 3.3 70B (vLLM)
  Mistral 7B (Ollama)
```

Selected model ID (e.g., `openai-compatible:meta-llama/Llama-3.3-70B:uuid`) sent as-is in the chat request body.

### Provider Settings Page

New page at `/app/settings/providers`:
- Add provider: name, base URL, optional API key
- Test connectivity: hit `/v1/models` to verify reachability and list available models
- Select which models to expose to users
- Enable/disable providers
- Standard CRUD form using existing Radix UI + React Hook Form patterns

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Self-hosted server unreachable | `ChatOpenAI.invoke()` throws connection error → caught by agent node `try/catch` → user sees "Failed to reach model endpoint" |
| Model doesn't support tool calling | Malformed tool call response → LangChain parsing error → iteration error, capped by `MAX_ITERATIONS` |
| API key rotation | `resolveModelConfig()` reads from DB on every request — no secret caching |
| Provider deleted mid-conversation | Next message fails at `resolveModelConfig()` → user sees error, can switch models. Thread history preserved |
| Bedrock message sanitization on OpenAI | `sanitizeMessagesForBedrock()` inserts synthetic `ToolMessage` placeholders — valid in OpenAI spec, harmless |
| Streaming | `ChatOpenAI` supports streaming natively. `streamEvents()` in chat API route works identically via LangGraph abstraction |

## What's NOT Changing

- Agent graph logic (fast-agent.ts, planning-agent.ts, deep-agent.ts graph structure)
- Tool definitions, MCP integration
- Memory (DynamoDBStore), checkpointing (DynamoDBSaver)
- Message sanitization (`sanitizeMessagesForBedrock()` — runs for all providers)
- Prompt templates, skill loading
- Audit logging

## New Dependency

```
@langchain/openai
```

Added to `web-ui/package.json`.

## Files Changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `ProviderModel` model |
| `web-ui/lib/agent/model-resolver.ts` | New — resolves model string → `ResolvedModelConfig` |
| `web-ui/lib/agent/model-factory.ts` | `createAgentModels()` accepts `ResolvedModelConfig`, routes to Bedrock or OpenAI |
| `web-ui/lib/agent/agent-shared.ts` | `GraphConfig.model` type → `ResolvedModelConfig`; `AgentModels` uses `BaseChatModel` |
| `web-ui/lib/agent/fast-agent.ts` | Pass `ResolvedModelConfig` to factory (minor signature change) |
| `web-ui/lib/agent/planning-agent.ts` | Pass `ResolvedModelConfig` to factory (minor signature change) |
| `web-ui/lib/agent/deep-agent.ts` | Use shared factory instead of direct `ChatBedrockConverse` construction |
| `web-ui/app/api/chat/route.ts` | Call `resolveModelConfig()` before graph creation |
| `web-ui/app/api/settings/providers/route.ts` | New — CRUD for provider configs + merged model list |
| `web-ui/app/api/settings/providers/[id]/route.ts` | New — single provider update/delete |
| `web-ui/app/api/settings/providers/[id]/test/route.ts` | New — connectivity test |
| `web-ui/lib/provider-model-service.ts` | New — repository/service for `ProviderModel` |
| `web-ui/components/agent/chat-interface.tsx` | Dynamic model list from API, grouped dropdown |
| `web-ui/components/settings/provider-settings.tsx` | New — provider management UI |
| `web-ui/app/app/settings/providers/page.tsx` | New — settings page |
| `web-ui/package.json` | Add `@langchain/openai` |
