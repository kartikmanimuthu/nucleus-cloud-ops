import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const recall = vi.fn();
vi.mock('./memory/memory-service', () => ({ getMemoryService: () => ({ recall, remember: rememberMock }) }));

const rememberMock = vi.fn().mockResolvedValue(undefined);
const captureEpisodeMock = vi.fn().mockResolvedValue(undefined);
let episodicEnabled = false;
vi.mock('./memory/episode', () => ({
    episodicMemoryEnabled: () => episodicEnabled,
    captureEpisode: (...a: any[]) => captureEpisodeMock(...a),
    formatEpisodesSection: (eps: unknown[]) => `EPISODES:${eps.length}`,
    composeMemoryContext: (facts: string, episodes: string, procedures: string) => [facts, episodes, procedures].filter(Boolean).join('\n---\n'),
    EPISODE_RECALL_LIMIT: 2,
    EPISODE_DISTANCE_THRESHOLD: 0.5,
}));

let proceduralEnabled = false;
vi.mock('./memory/procedural', () => ({
    proceduralMemoryEnabled: () => proceduralEnabled,
    formatProceduresSection: (rules: unknown[]) => `RULES:${rules.length}`,
    isValidExtractedItem: (m: any) => !!m && typeof m === 'object' && !!m.namespace && !!m.key && !!m.value
        && (m.value.confidence === 'high' || m.value.confidence === 'medium'),
    PROCEDURE_RECALL_LIMIT: 3,
    PROCEDURE_DISTANCE_THRESHOLD: 0.5,
}));

let reconcileIsEnabled = false;
const reconcileMemoriesMock = vi.fn().mockResolvedValue({ added: 1, updated: 0, superseded: 0, reinforced: 0, noop: 0, failed: 0 });
vi.mock('./memory/reconcile', () => ({
    reconcileEnabled: () => reconcileIsEnabled,
    reconcileMemories: (...a: any[]) => reconcileMemoriesMock(...a),
}));

const synthesizeDomainSkillsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./memory/skill-synthesis', () => ({ synthesizeDomainSkills: (...a: any[]) => synthesizeDomainSkillsMock(...a) }));

const saveMemoryMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./persistence', () => ({ saveMemory: (...a: any[]) => saveMemoryMock(...a) }));

import { createMemoryRecallNode, createMemorySaveNode } from './memory-nodes';

const baseState = {
    messages: [new HumanMessage('check costs')],
    taskDescription: 'check costs',
    plan: [], toolResults: [], errors: [], reflection: '',
    iterationCount: 0, isComplete: true, memoryContext: '',
};

beforeEach(() => {
    vi.clearAllMocks();
    episodicEnabled = false;
    proceduralEnabled = false;
    reconcileIsEnabled = false;
    recall.mockResolvedValue([]);
    rememberMock.mockResolvedValue(undefined);
    saveMemoryMock.mockResolvedValue(undefined);
    reconcileMemoriesMock.mockResolvedValue({ added: 1, updated: 0, superseded: 0, reinforced: 0, noop: 0, failed: 0 });
});

describe('createMemoryRecallNode', () => {
    const deps = (model: any = { invoke: vi.fn() }) => ({ reflectorModel: model, tenantId: 't1', userId: 'u1', store: {} });

    it('skips when store/tenantId/userId are missing', async () => {
        const node = createMemoryRecallNode({ reflectorModel: {} as any, tenantId: undefined, userId: 'u1', store: {} });
        const out = await node(baseState as any);
        expect(out).toEqual({ memoryContext: '', memoryStats: null });
    });

    it('skips when there is no human message in state', async () => {
        const node = createMemoryRecallNode(deps());
        const out = await node({ ...baseState, messages: [new AIMessage('hi')] } as any);
        expect(out).toEqual({ memoryContext: '', memoryStats: null });
    });

    it('filters semantic hits through the LLM relevance filter and keeps the filtered result', async () => {
        recall.mockResolvedValue([{ namespace: 'infra', key: 'region', value: { fact: 'x' }, distance: 0.1 }]);
        const model = { invoke: vi.fn().mockResolvedValue({ content: '- [infra/region] x' }) };
        const node = createMemoryRecallNode(deps(model));
        const out = await node(baseState as any);
        expect(out.memoryContext).toContain('[infra/region] x');
        expect(out.memoryStats?.injected).toBe(true);
    });

    it('treats a literal NONE response from the relevance filter as nothing relevant', async () => {
        recall.mockResolvedValue([{ namespace: 'infra', key: 'region', value: { fact: 'x' }, distance: 0.1 }]);
        const model = { invoke: vi.fn().mockResolvedValue({ content: 'NONE' }) };
        const node = createMemoryRecallNode(deps(model));
        const out = await node(baseState as any);
        expect(out.memoryContext).toBe('');
        expect(out.memoryStats?.injected).toBe(false);
    });

    it('falls back to the raw top-5 hits when the relevance filter LLM call throws', async () => {
        recall.mockResolvedValue([{ namespace: 'infra', key: 'region', value: { fact: 'x' }, distance: 0.1 }]);
        const model = { invoke: vi.fn().mockRejectedValue(new Error('provider down')) };
        const node = createMemoryRecallNode(deps(model));
        const out = await node(baseState as any);
        expect(out.memoryContext).toContain('[infra/region]');
    });

    it('swallows a semantic search failure and continues with an empty facts section', async () => {
        recall.mockRejectedValue(new Error('db down'));
        const node = createMemoryRecallNode(deps());
        const out = await node(baseState as any);
        expect(out.memoryStats?.facts).toEqual([]);
    });

    it('recalls and distance-gates procedural rules when procedural memory is enabled', async () => {
        proceduralEnabled = true;
        recall.mockResolvedValue([
            { namespace: 'procedures', key: 'near', value: { instruction: 'do x', trigger: 'y' }, distance: 0.2 },
            { namespace: 'procedures', key: 'far', value: { instruction: 'do z', trigger: 'w' }, distance: 0.9 },
        ]);
        const node = createMemoryRecallNode(deps());
        const out = await node(baseState as any);
        expect(out.memoryContext).toContain('RULES:1');
        expect(out.memoryStats?.rules).toEqual([{ key: 'near', distance: 0.2 }]);
    });

    it('drops a near-distance procedural rule missing instruction/trigger', async () => {
        proceduralEnabled = true;
        recall.mockResolvedValue([{ namespace: 'procedures', key: 'incomplete', value: { instruction: 'x' }, distance: 0.1 }]);
        const node = createMemoryRecallNode(deps());
        const out = await node(baseState as any);
        expect(out.memoryContext).not.toContain('RULES:');
    });

    it('swallows a procedural search failure', async () => {
        proceduralEnabled = true;
        recall.mockImplementation(({ kinds }: any) => (kinds?.[0] === 'PROCEDURAL' ? Promise.reject(new Error('x')) : Promise.resolve([])));
        const node = createMemoryRecallNode(deps());
        await expect(node(baseState as any)).resolves.toBeTruthy();
    });

    it('recalls and distance-gates episodic memories when episodic memory is enabled', async () => {
        episodicEnabled = true;
        recall.mockResolvedValue([
            { namespace: 'episodes', key: 'ep1', value: { summary: 'did x' }, distance: 0.3 },
            { namespace: 'episodes', key: 'ep2', value: { summary: 'did y' }, distance: 0.99 },
        ]);
        const node = createMemoryRecallNode(deps());
        const out = await node(baseState as any);
        expect(out.memoryContext).toContain('EPISODES:1');
        expect(out.memoryStats?.episodes).toEqual([{ key: 'ep1', distance: 0.3 }]);
    });

    it('swallows an episodic search failure', async () => {
        episodicEnabled = true;
        recall.mockImplementation(({ kinds }: any) => (kinds?.[0] === 'EPISODIC' ? Promise.reject(new Error('x')) : Promise.resolve([])));
        const node = createMemoryRecallNode(deps());
        await expect(node(baseState as any)).resolves.toBeTruthy();
    });

    it('reports nothing-relevant when every section comes back empty', async () => {
        const node = createMemoryRecallNode(deps());
        const out = await node(baseState as any);
        expect(out.memoryContext).toBe('');
        expect(out.memoryStats).toEqual({ phase: 'recall', facts: [], rules: [], episodes: [], injected: false });
    });
});

describe('createMemorySaveNode', () => {
    const deps = (model: any) => ({ reflectorModel: model, tenantId: 't1', userId: 'u1', store: {} });
    const twoTurnState = { ...baseState, messages: [new HumanMessage('a'), new AIMessage('b')] };

    it('skips when store/tenantId/userId are missing', async () => {
        const node = createMemorySaveNode({ reflectorModel: {} as any, tenantId: undefined, userId: 'u1', store: {} });
        const out = await node(twoTurnState as any);
        expect(out).toEqual({ memoryStats: null });
    });

    it('skips when the conversation is too short to extract anything', async () => {
        const node = createMemorySaveNode(deps({ invoke: vi.fn() }));
        const out = await node(baseState as any);
        expect(out).toEqual({ memoryStats: null });
    });

    it('reports zero saves when the extractor returns no JSON array at all', async () => {
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: 'nothing to extract' }) }));
        const out = await node(twoTurnState as any);
        expect(out.memoryStats).toMatchObject({ phase: 'save', savedFacts: 0, savedRules: 0 });
    });

    it('drops low-confidence or malformed extracted items and reports zero saves', async () => {
        const extraction = JSON.stringify([{ namespace: ['x'], key: 'k1', value: { fact: 'y', confidence: 'low' } }]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        const out = await node(twoTurnState as any);
        expect(out.memoryStats).toMatchObject({ savedFacts: 0, savedRules: 0 });
    });

    it('saves a SEMANTIC fact via saveMemory and a PROCEDURAL rule via remember when reconcile is disabled', async () => {
        const extraction = JSON.stringify([
            { namespace: ['infra', 'a'], key: 'k1', value: { fact: 'x', confidence: 'high' } },
            { kind: 'PROCEDURAL', namespace: ['procedures', 'aws'], key: 'k2', value: { instruction: 'y', trigger: 'z', confidence: 'high' } },
        ]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        await node(twoTurnState as any, { configurable: { thread_id: 'th1' } });

        expect(saveMemoryMock).toHaveBeenCalledWith('t1', 'u1', ['infra', 'a'], 'k1', { fact: 'x', confidence: 'high' });
        expect(rememberMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PROCEDURAL', key: 'k2' }));
    });

    it('logs but does not throw when an individual save fails (non-reconcile path)', async () => {
        saveMemoryMock.mockRejectedValueOnce(new Error('write failed'));
        const extraction = JSON.stringify([{ namespace: ['x'], key: 'k1', value: { fact: 'y', confidence: 'high' } }]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        await expect(node(twoTurnState as any)).resolves.toBeTruthy();
    });

    it('routes through reconcileMemories instead of direct saves when reconcile is enabled', async () => {
        reconcileIsEnabled = true;
        const extraction = JSON.stringify([{ namespace: ['x'], key: 'k1', value: { fact: 'y', confidence: 'high' } }]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        const out = await node(twoTurnState as any, { configurable: { thread_id: 'th1' } });

        expect(reconcileMemoriesMock).toHaveBeenCalled();
        expect(saveMemoryMock).not.toHaveBeenCalled();
        expect(out.memoryStats?.reconcileActions).toEqual({ added: 1, updated: 0, superseded: 0, reinforced: 0, noop: 0, failed: 0 });
    });

    it('swallows an extraction failure (unparsable JSON) without throwing', async () => {
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: '[not valid json' }) }));
        await expect(node(twoTurnState as any)).resolves.toBeTruthy();
    });

    it('swallows the extractor LLM call itself throwing', async () => {
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockRejectedValue(new Error('provider down')) }));
        await expect(node(twoTurnState as any)).resolves.toBeTruthy();
    });

    it('captures an episode when episodic memory is enabled, a thread id is present, and tool results exist', async () => {
        // Episode capture and skill synthesis only run past the extraction step's
        // own early-return, so the extractor must find something to save here.
        episodicEnabled = true;
        const extraction = JSON.stringify([{ namespace: ['x'], key: 'k1', value: { fact: 'y', confidence: 'high' } }]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        const out = await node(
            { ...twoTurnState, toolResults: [{ toolName: 'x', output: 'y', isError: false, iterationIndex: 0 }] } as any,
            { configurable: { thread_id: 'th1' } },
        );
        expect(captureEpisodeMock).toHaveBeenCalled();
        expect(out.memoryStats?.episodeCaptured).toBe(true);
    });

    it('does not capture an episode without a thread id even when episodic memory is enabled', async () => {
        episodicEnabled = true;
        const extraction = JSON.stringify([{ namespace: ['x'], key: 'k1', value: { fact: 'y', confidence: 'high' } }]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        const out = await node({ ...twoTurnState, toolResults: [{ toolName: 'x', output: 'y', isError: false, iterationIndex: 0 }] } as any);
        expect(captureEpisodeMock).not.toHaveBeenCalled();
        expect(out.memoryStats?.episodeCaptured).toBe(false);
    });

    it('synthesizes domain skills when procedural memory is enabled', async () => {
        proceduralEnabled = true;
        const extraction = JSON.stringify([{ namespace: ['x'], key: 'k1', value: { fact: 'y', confidence: 'high' } }]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        await node(twoTurnState as any, { configurable: { thread_id: 'th1' } });
        expect(synthesizeDomainSkillsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', threadId: 'th1' }));
    });

    it('does not synthesize domain skills when procedural memory is disabled', async () => {
        const extraction = JSON.stringify([{ namespace: ['x'], key: 'k1', value: { fact: 'y', confidence: 'high' } }]);
        const node = createMemorySaveNode(deps({ invoke: vi.fn().mockResolvedValue({ content: extraction }) }));
        await node(twoTurnState as any, { configurable: { thread_id: 'th1' } });
        expect(synthesizeDomainSkillsMock).not.toHaveBeenCalled();
    });
});
