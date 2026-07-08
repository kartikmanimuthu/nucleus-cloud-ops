import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-factory', async (orig) => {
    const actual = await (orig as any)();
    return { ...actual, assembleTools: vi.fn().mockResolvedValue([]) };
});

// Skill loading hits the repository factory's runtime require(), which vitest's
// transform can't resolve — irrelevant to this test, so it's mocked out.
vi.mock('@/lib/skill-service', () => ({
    loadSkills: vi.fn().mockResolvedValue([]),
    loadAllSkillContent: vi.fn().mockResolvedValue(new Map()),
}));

// Persistence touches a live Postgres (checkpointer setup + memory store), which
// would require a running DB + DATABASE_URL. Mock it so this test is hermetic.
vi.mock('@/lib/agent/persistence', () => ({
    getCheckpointer: vi.fn().mockResolvedValue({}),
    getMemoryStore: vi.fn().mockResolvedValue(undefined),
    saveMemory: vi.fn(),
    searchMemory: vi.fn().mockResolvedValue([]),
}));

import { assembleTools } from '@/lib/agent/model-factory';
import { createDynamicExecutorGraph } from './executor-graphs';

describe('Agent Ops executor — KB tool wiring', () => {
    beforeEach(() => vi.clearAllMocks());

    it('forwards knowledgeBaseIds from config to assembleTools', async () => {
        await createDynamicExecutorGraph({
            model: { provider: 'bedrock', modelId: 'm', accessKeyId: 'x', secretAccessKey: 'x', region: 'us-east-1' },
            tenantId: 't1',
            knowledgeBaseIds: ['kb1'],
        } as any);
        expect(assembleTools).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseIds: ['kb1'], tenantId: 't1' }));
    });
});
