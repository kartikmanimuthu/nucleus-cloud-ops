import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: { listKnowledgeBases: vi.fn() },
}));
vi.mock('./model-factory', () => ({ createAgentModels: vi.fn() }));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { createAgentModels } from './model-factory';
import { autoSelectKb, resolveKnowledgeBaseIds, autoKbSelectionEnabled } from './auto-kb-select';

const model = { provider: 'x', modelId: 'm' } as any;
function mockReflector(content: string) {
    vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke: vi.fn().mockResolvedValue({ content }) } } as any);
}

describe('autoSelectKb', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks', vectorCount: 5, status: 'active' },
            { id: 'kb-hr', name: 'HR', description: 'people policies', vectorCount: 3, status: 'active' },
        ] as any);
    });

    it('returns the KB ids the reflector selected (validated against the catalog)', async () => {
        mockReflector('{"kbIds":["kb-runbooks"],"reasoning":"ops question"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'how do I restart the pipeline', model });
        expect(r.kbIds).toEqual(['kb-runbooks']);
    });

    it('drops hallucinated ids not in the catalog', async () => {
        mockReflector('{"kbIds":["kb-runbooks","kb-ghost"],"reasoning":"x"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(r.kbIds).toEqual(['kb-runbooks']);
    });

    it('returns [] when the reflector picks none', async () => {
        mockReflector('{"kbIds":[],"reasoning":"general question"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'what is 2+2', model });
        expect(r.kbIds).toEqual([]);
    });

    it('returns [] (never throws) when there are no KBs', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([]);
        const r = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(r.kbIds).toEqual([]);
    });

    it('excludes empty KBs (vectorCount 0) from the catalog even if the reflector picks them', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks', vectorCount: 5, status: 'active' },
            { id: 'kb-empty', name: 'Empty', description: 'no synced docs yet', vectorCount: 0, status: 'active' },
        ] as any);
        mockReflector('{"kbIds":["kb-runbooks","kb-empty"],"reasoning":"x"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(r.kbIds).toEqual(['kb-runbooks']);
    });

    it('never selects an inactive KB even if the model names it', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks', vectorCount: 5, status: 'inactive' },
        ] as any);
        mockReflector('{"kbIds":["kb-runbooks"],"reasoning":"ops"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'restart pipeline', model });
        expect(r.kbIds).toEqual([]);
    });
});

describe('resolveKnowledgeBaseIds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'R', description: 'ops', vectorCount: 5, status: 'active' },
        ] as any);
    });

    it('returns the manual selection without calling the reflector', async () => {
        const spy = vi.mocked(createAgentModels);
        const ids = await resolveKnowledgeBaseIds({ tenantId: 't1', selectedIds: ['kb-x'], message: 'q', model });
        expect(ids).toEqual(['kb-x']);
        expect(spy).not.toHaveBeenCalled();
    });

    it('auto-selects when no manual selection', async () => {
        mockReflector('{"kbIds":["kb-runbooks"],"reasoning":"x"}');
        const ids = await resolveKnowledgeBaseIds({ tenantId: 't1', selectedIds: null, message: 'restart pipeline', model });
        expect(ids).toEqual(['kb-runbooks']);
    });
});

// Both of these failed silently on every turn of a real deep thread — caught and
// logged as "non-fatal", so no KB was ever selected and nobody could tell.
describe('autoSelectKb — malformed input and empty messages', () => {
    it('skips the model call entirely when there is no user text', async () => {
        // A resume turn carries a Command, not a message. Calling the model with an
        // empty HumanMessage throws "'human' must contain non-empty content".
        const result = await autoSelectKb({ tenantId: 't1', message: '   ', model: {} as never });
        expect(result).toEqual({ kbIds: [], reasoning: '' });
    });

    it('returns [] when the reflector response has no parseable JSON', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'R', description: 'ops', vectorCount: 5, status: 'active' },
        ] as any);
        mockReflector('I am not sure which knowledge base applies here.');
        const result = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(result).toEqual({ kbIds: [], reasoning: '' });
    });

    it('never throws — returns [] when listKnowledgeBases itself fails', async () => {
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockRejectedValue(new Error('DB down'));
        const result = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(result).toEqual({ kbIds: [], reasoning: '' });
    });
});

describe('autoKbSelectionEnabled', () => {
    const ORIGINAL = process.env.AUTO_KB_SELECTION_ENABLED;
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.AUTO_KB_SELECTION_ENABLED;
        else process.env.AUTO_KB_SELECTION_ENABLED = ORIGINAL;
    });

    it('defaults to enabled when unset', () => {
        delete process.env.AUTO_KB_SELECTION_ENABLED;
        expect(autoKbSelectionEnabled()).toBe(true);
    });

    it('is disabled when set to "false" or "0"', () => {
        process.env.AUTO_KB_SELECTION_ENABLED = 'false';
        expect(autoKbSelectionEnabled()).toBe(false);
        process.env.AUTO_KB_SELECTION_ENABLED = '0';
        expect(autoKbSelectionEnabled()).toBe(false);
    });

    it('short-circuits autoSelectKb to an empty result when disabled', async () => {
        process.env.AUTO_KB_SELECTION_ENABLED = 'false';
        const result = await autoSelectKb({ tenantId: 't1', message: 'restart the pipeline', model });
        expect(result).toEqual({ kbIds: [], reasoning: '' });
        expect(KnowledgeBaseService.listKnowledgeBases).not.toHaveBeenCalled();
    });
});

