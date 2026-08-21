import { createMiddleware } from 'langchain';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMemoryRecallNode, createMemorySaveNode } from '@/lib/agent/memory-nodes';

interface DeepMemoryDeps {
    reflectorModel: BaseChatModel;
    tenantId?: string;
    userId?: string;
    store: unknown | null;
    onMemoryEvent?: (op: 'recall' | 'save', summary: string) => void;
}

const memoryStateSchema = z.object({
    memoryContext: z.string().optional(),
});

interface RuntimeContext { tenantId?: string; userId?: string }

/** Per-run context wins over construction-time values; the framework propagates it to subagents. */
function resolveIds(runtime: unknown, deps: DeepMemoryDeps): { tenantId?: string; userId?: string } {
    const ctx = (runtime as { context?: RuntimeContext } | undefined)?.context;
    return { tenantId: ctx?.tenantId ?? deps.tenantId, userId: ctx?.userId ?? deps.userId };
}

export function createDeepMemoryMiddleware(deps: DeepMemoryDeps) {
    const { onMemoryEvent, ...nodeDeps } = deps;
    const recall = createMemoryRecallNode(nodeDeps);
    const save = createMemorySaveNode(nodeDeps);
    const enabled = Boolean(nodeDeps.tenantId && nodeDeps.userId && nodeDeps.store);

    return createMiddleware({
        name: 'DeepMemoryMiddleware',
        stateSchema: memoryStateSchema,
        beforeAgent: async (state, runtime) => {
            const { tenantId, userId } = resolveIds(runtime, deps);
            if (!enabled || !tenantId || !userId) return undefined;
            const { memoryContext } = await recall(state as never);
            if (!memoryContext) return undefined;
            onMemoryEvent?.('recall', memoryContext);
            return { memoryContext };
        },
        // Without this the recalled text sits in state and the model never sees it.
        wrapModelCall: async (request, handler) => {
            const memoryContext = (request.state as { memoryContext?: string } | undefined)?.memoryContext;
            if (!memoryContext) return handler(request);
            return handler({
                ...request,
                systemPrompt: `${request.systemPrompt ?? ''}\n\n## Relevant Context from Memory\n${memoryContext}\n`,
            });
        },
        afterAgent: async (state, runtime) => {
            const { tenantId, userId } = resolveIds(runtime, deps);
            if (!enabled || !tenantId || !userId) return undefined;
            try {
                const result = await save(state as never);
                onMemoryEvent?.('save', JSON.stringify(result ?? {}));
            } catch (err) {
                console.error('[DeepMemory] save failed:', err);
            }
            return undefined;
        },
    });
}
