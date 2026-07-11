import { describe, it, expect, vi } from 'vitest';

const { mockRecall } = vi.hoisted(() => ({
    mockRecall: vi.fn(),
}));

vi.mock('../../lib/agent/memory/memory-service', () => ({
    getMemoryService: () => ({ recall: mockRecall }),
}));
// Neutralize optional layers so only the semantic path runs
vi.mock('../../lib/agent/memory/episode', () => ({
    episodicMemoryEnabled: () => false,
    captureEpisode: vi.fn(),
    formatEpisodesSection: (x: unknown) => String(x),
    composeMemoryContext: (facts: string) => facts,
    EPISODE_RECALL_LIMIT: 2,
    EPISODE_DISTANCE_THRESHOLD: 0.65,
}));
vi.mock('../../lib/agent/memory/procedural', () => ({
    proceduralMemoryEnabled: () => false,
    formatProceduresSection: (x: unknown) => String(x),
    isValidExtractedItem: () => true,
    PROCEDURE_RECALL_LIMIT: 3,
    PROCEDURE_DISTANCE_THRESHOLD: 0.55,
}));
vi.mock('../../lib/agent/memory/reconcile', () => ({
    reconcileEnabled: () => false,
    reconcileMemories: vi.fn(),
}));
vi.mock('../../lib/agent/memory/skill-synthesis', () => ({
    synthesizeDomainSkills: vi.fn(),
}));
vi.mock('../../lib/agent/persistence', () => ({ saveMemory: vi.fn() }));

import { HumanMessage } from '@langchain/core/messages';
import { createMemoryRecallNode, createMemorySaveNode } from '../../lib/agent/memory-nodes';

const reflectorModel = {
    invoke: vi.fn().mockResolvedValue({ content: '- [infra/acct] region is ap-south-1' }),
} as never;

const baseState = {
    messages: [new HumanMessage('check costs')],
    taskDescription: 'check costs',
    plan: [], toolResults: [], errors: [], reflection: '',
    iterationCount: 0, isComplete: true, memoryContext: '',
};

describe('memoryStats', () => {
    it('recall returns memoryStats with fact hits and injected=true', async () => {
        mockRecall.mockResolvedValue([
            { namespace: 'infra/acct', key: 'region', value: { fact: 'ap-south-1' }, distance: 0.21 },
            { namespace: 'infra/acct', key: 'payer', value: { fact: 'mgmt acct' }, distance: 0.34 },
        ]);
        const node = createMemoryRecallNode({
            reflectorModel, tenantId: 't1', userId: 'u1', store: {},
        });
        const out = await node(baseState as never);
        expect(out.memoryStats).toEqual({
            phase: 'recall',
            facts: [{ key: 'region', distance: 0.21 }, { key: 'payer', distance: 0.34 }],
            rules: [], episodes: [],
            injected: true,
        });
    });

    it('recall skip path returns memoryStats: null', async () => {
        const node = createMemoryRecallNode({
            reflectorModel, tenantId: undefined, userId: 'u1', store: {},
        });
        const out = await node(baseState as never);
        expect(out.memoryStats).toBeNull();
    });

    it('save returns counts by kind', async () => {
        const extraction = JSON.stringify([
            { namespace: ['infra', 'a'], key: 'k1', value: { fact: 'x', confidence: 'high' } },
            { kind: 'PROCEDURAL', namespace: ['procedures', 'aws'], key: 'k2', value: { instruction: 'y', trigger: 'z' } },
        ]);
        const saveModel = { invoke: vi.fn().mockResolvedValue({ content: extraction }) } as never;
        const node = createMemorySaveNode({
            reflectorModel: saveModel, tenantId: 't1', userId: 'u1', store: {},
        });
        const out = await node({
            ...baseState,
            messages: [new HumanMessage('a'), new HumanMessage('b')],
        } as never, { configurable: { thread_id: 'th1' } });
        expect(out.memoryStats).toMatchObject({
            phase: 'save', savedFacts: 1, savedRules: 1, episodeCaptured: false,
        });
    });
});
