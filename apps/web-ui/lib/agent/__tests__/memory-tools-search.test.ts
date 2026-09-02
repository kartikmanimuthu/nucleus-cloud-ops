import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMemory = vi.fn();

vi.mock('@/lib/agent/persistence', () => ({
    saveMemory: vi.fn(),
    searchMemory: (...args: unknown[]) => searchMemory(...args),
}));

import { createMemoryTools } from '@/lib/agent/model-factory';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const search = () => createMemoryTools('t1', 'u1').find((t: any) => t.name === 'search_memory') as any;
const hit = (key: string) => ({ key, namespace: 'patterns/lambda', value: { fact: key } });

describe('search_memory — a wrong namespace must not hide real memories', () => {
    beforeEach(() => searchMemory.mockReset());

    it('returns the scoped hits when the prefix matches something', async () => {
        searchMemory.mockResolvedValueOnce([hit('lambda-audit-checklist')]);
        const out = await search().invoke({ namespacePrefix: ['patterns', 'lambda'], query: 'lambda audit' });
        expect(out).toContain('lambda-audit-checklist');
        expect(searchMemory).toHaveBeenCalledTimes(1);
    });

    it('falls back to every namespace when the prefix finds nothing, and says so', async () => {
        // The observed failure: a guessed path that does not exist, while the same
        // query unfiltered returns plenty.
        searchMemory
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([hit('lambda-deprecated-runtimes'), hit('lambda-missing-dlq')]);
        const out = await search().invoke({
            namespacePrefix: ['infra', '970547372609', 'lambda'],
            query: 'Lambda audit findings',
        });
        expect(out).toContain('infra/970547372609/lambda');
        expect(out).toContain('Searching all namespaces instead found 2');
        expect(out).toContain('lambda-deprecated-runtimes');
        expect(searchMemory).toHaveBeenNthCalledWith(2, 't1', 'u1', [], 'Lambda audit findings', 5);
    });

    it('reports empty only when the unfiltered search is also empty', async () => {
        searchMemory.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        const out = await search().invoke({ namespacePrefix: ['user'], query: 'nothing stored' });
        expect(out).toBe('No memories found.');
    });

    it('searches everything when the prefix is omitted, without a second query', async () => {
        searchMemory.mockResolvedValueOnce([]);
        const out = await search().invoke({ query: 'anything' });
        expect(out).toBe('No memories found.');
        expect(searchMemory).toHaveBeenCalledTimes(1);
        expect(searchMemory).toHaveBeenCalledWith('t1', 'u1', [], 'anything', 5);
    });
});
