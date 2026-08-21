import { describe, it, expect, vi, beforeEach } from 'vitest';

const recallNode = vi.fn();
const saveNode = vi.fn();
vi.mock('@/lib/agent/memory-nodes', () => ({
    createMemoryRecallNode: () => recallNode,
    createMemorySaveNode: () => saveNode,
}));

const deps = { reflectorModel: {} as never, tenantId: 't1', userId: 'u1', store: {} };

// beforeAgent/afterAgent are `Handler | { hook: Handler }` (langchain middleware/types.d.ts),
// so they are not directly callable.
type Hook = (state: unknown, runtime: unknown) => Promise<unknown>;
function hookOf(h: unknown): Hook {
    return (typeof h === 'function' ? h : (h as { hook: Hook }).hook) as Hook;
}

describe('createDeepMemoryMiddleware', () => {
    beforeEach(() => {
        recallNode.mockReset().mockResolvedValue({ memoryContext: 'user prefers ap-south-1', memoryStats: null });
        saveNode.mockReset().mockResolvedValue({});
    });

    it('injects recalled memory into the system prompt before the agent runs', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        const result = await hookOf(mw.beforeAgent)({ messages: [] }, {});

        expect(recallNode).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).toContain('user prefers ap-south-1');
    });

    it('runs the save node after the agent finishes', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        await hookOf(mw.afterAgent)({ messages: [] }, {});

        expect(saveNode).toHaveBeenCalledTimes(1);
    });

    it('reports recall and save through onMemoryEvent so the UI can render cards', async () => {
        const onMemoryEvent = vi.fn();
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware({ ...deps, onMemoryEvent });

        await hookOf(mw.beforeAgent)({ messages: [] }, {});
        await hookOf(mw.afterAgent)({ messages: [] }, {});

        expect(onMemoryEvent).toHaveBeenCalledWith('recall', expect.stringContaining('ap-south-1'));
        expect(onMemoryEvent).toHaveBeenCalledWith('save', expect.any(String));
    });

    it('is inert without a tenant so no cross-tenant recall can happen', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware({ ...deps, tenantId: undefined });

        await hookOf(mw.beforeAgent)({ messages: [] }, {});

        expect(recallNode).not.toHaveBeenCalled();
    });

    it('never fails the run when the save node throws', async () => {
        saveNode.mockRejectedValue(new Error('db down'));
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        await expect(hookOf(mw.afterAgent)({ messages: [] }, {})).resolves.not.toThrow();
    });
});

describe('memory injection into the model prompt', () => {
    beforeEach(() => {
        recallNode.mockReset().mockResolvedValue({ memoryContext: 'user prefers ap-south-1', memoryStats: null });
        saveNode.mockReset().mockResolvedValue({});
    });

    // The original implementation stored memoryContext in state but never injected it,
    // so recall ran at full cost and the model saw nothing.
    it('appends recalled memory to the system prompt', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        let seen: string | undefined;
        const handler = vi.fn(async (req: { systemPrompt?: string }) => { seen = req.systemPrompt; return {} as never; });
        await (mw.wrapModelCall as unknown as (r: unknown, h: unknown) => Promise<unknown>)(
            { systemPrompt: 'BASE', state: { memoryContext: 'user prefers ap-south-1' } },
            handler,
        );

        expect(seen).toContain('BASE');
        expect(seen).toContain('## Relevant Context from Memory');
        expect(seen).toContain('user prefers ap-south-1');
    });

    it('leaves the prompt untouched when nothing was recalled', async () => {
        const { createDeepMemoryMiddleware } = await import('@/lib/agent/deep/memory-middleware');
        const mw = createDeepMemoryMiddleware(deps);

        let seen: string | undefined;
        const handler = vi.fn(async (req: { systemPrompt?: string }) => { seen = req.systemPrompt; return {} as never; });
        await (mw.wrapModelCall as unknown as (r: unknown, h: unknown) => Promise<unknown>)(
            { systemPrompt: 'BASE', state: {} },
            handler,
        );

        expect(seen).toBe('BASE');
    });
});
