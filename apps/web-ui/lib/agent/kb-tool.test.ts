import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/knowledge-base/retrieval', () => ({ searchKbChunks: vi.fn() }));

import { searchKbChunks } from '@/lib/knowledge-base/retrieval';
import { createSearchKnowledgeBaseTool } from './kb-tool';

describe('createSearchKnowledgeBaseTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('searches with the tool-call ids when provided', async () => {
        vi.mocked(searchKbChunks).mockResolvedValue([
            { vectorKey: 'k', documentName: 'Runbook', sourceType: 'document', chunkIndex: 0, totalChunks: 1, knowledgeBaseId: 'kb1', dataSourceId: 'ds', textContent: 'restart the service', score: 0.88 },
        ]);
        const tool = createSearchKnowledgeBaseTool('t1', ['default-kb']);
        const out = await tool.invoke({ query: 'how to restart', knowledgeBaseIds: ['kb1'] });
        expect(searchKbChunks).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', query: 'how to restart', knowledgeBaseIds: ['kb1'] }));
        expect(out).toContain('Runbook');
        expect(out).toContain('restart the service');
    });

    it('falls back to the factory default kb ids when the call omits them', async () => {
        vi.mocked(searchKbChunks).mockResolvedValue([]);
        const tool = createSearchKnowledgeBaseTool('t1', ['default-kb']);
        await tool.invoke({ query: 'q' });
        expect(searchKbChunks).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseIds: ['default-kb'] }));
    });

    it('returns a no-results message, never throws, when search fails', async () => {
        vi.mocked(searchKbChunks).mockRejectedValue(new Error('db down'));
        const tool = createSearchKnowledgeBaseTool('t1');
        const out = await tool.invoke({ query: 'q' });
        expect(typeof out).toBe('string');
        expect(out.toLowerCase()).toContain('no');
    });
});
