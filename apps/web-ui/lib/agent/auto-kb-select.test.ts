import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: { listKnowledgeBases: vi.fn() },
}));
vi.mock('./model-factory', () => ({ createAgentModels: vi.fn() }));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { createAgentModels } from './model-factory';
import { autoSelectKb, resolveKnowledgeBaseIds } from './auto-kb-select';

const model = { provider: 'x', modelId: 'm' } as any;
function mockReflector(content: string) {
    vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke: vi.fn().mockResolvedValue({ content }) } } as any);
}

describe('autoSelectKb', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks', vectorCount: 5 },
            { id: 'kb-hr', name: 'HR', description: 'people policies', vectorCount: 3 },
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
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks', vectorCount: 5 },
            { id: 'kb-empty', name: 'Empty', description: 'no synced docs yet', vectorCount: 0 },
        ] as any);
        mockReflector('{"kbIds":["kb-runbooks","kb-empty"],"reasoning":"x"}');
        const r = await autoSelectKb({ tenantId: 't1', message: 'q', model });
        expect(r.kbIds).toEqual(['kb-runbooks']);
    });
});

describe('resolveKnowledgeBaseIds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'R', description: 'ops', vectorCount: 5 },
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
