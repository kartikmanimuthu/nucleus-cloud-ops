import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: { listKnowledgeBases: vi.fn() },
}));
vi.mock('./model-factory', () => ({ createAgentModels: vi.fn() }));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { createAgentModels } from './model-factory';
import { autoSelectKb } from './auto-kb-select';

const model = { provider: 'x', modelId: 'm' } as any;
function mockReflector(content: string) {
    vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke: vi.fn().mockResolvedValue({ content }) } } as any);
}

describe('autoSelectKb', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.listKnowledgeBases).mockResolvedValue([
            { id: 'kb-runbooks', name: 'Runbooks', description: 'ops runbooks' },
            { id: 'kb-hr', name: 'HR', description: 'people policies' },
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
});
