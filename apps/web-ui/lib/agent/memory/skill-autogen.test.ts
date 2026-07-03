import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQueryRaw = vi.fn();
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => ({ $queryRaw: mockQueryRaw }) }));
vi.mock('@/lib/db/repository-factory', () => ({ getSkillRepository: vi.fn() }));
vi.mock('./memory-service', () => ({ getMemoryService: vi.fn() }));

import { getSkillRepository } from '@/lib/db/repository-factory';
import { getMemoryService } from './memory-service';
import { autoCreateSkillsFromMaturedRules, autoSkillCreationEnabled, autoSkillMaturityThreshold } from './skill-autogen';

const mockRepo = { getBySlug: vi.fn(), create: vi.fn() };
const mockSvc = { update: vi.fn().mockResolvedValue(undefined) };

const candidate = (overrides: Record<string, unknown> = {}) => ({
    id: 'mem-1', key: 'paginate-list-calls',
    value: { instruction: 'Always paginate list calls', trigger: 'any list op', evidence: 'missed items', confidence: 'high' },
    sourceThreadId: 'th-1', accessCount: 4,
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockResolvedValue([candidate()]);
    mockRepo.getBySlug.mockResolvedValue(null);
    mockRepo.create.mockResolvedValue({ id: 's1' });
    mockSvc.update.mockResolvedValue(undefined);
    vi.mocked(getSkillRepository).mockReturnValue(mockRepo as any);
    vi.mocked(getMemoryService).mockReturnValue(mockSvc as any);
});
afterEach(() => {
    delete process.env.AUTO_SKILL_CREATION_ENABLED;
    delete process.env.AUTO_SKILL_MATURITY_THRESHOLD;
});

describe('flags', () => {
    it('creation defaults true; threshold defaults 3 with env override', () => {
        expect(autoSkillCreationEnabled()).toBe(true);
        expect(autoSkillMaturityThreshold()).toBe(3);
        process.env.AUTO_SKILL_MATURITY_THRESHOLD = '5';
        expect(autoSkillMaturityThreshold()).toBe(5);
    });
});

describe('autoCreateSkillsFromMaturedRules', () => {
    it('creates an enabled, read-only, system skill and stamps the memory', async () => {
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1', threadId: 'th-run' });
        expect(n).toBe(1);
        expect(mockRepo.create).toHaveBeenCalledWith('t1', expect.objectContaining({
            slug: 'paginate-list-calls',
            source: 'system',
            isEnabled: true,
            tier: 'read-only',
            sourceRunId: 'th-run',
        }));
        expect(mockSvc.update).toHaveBeenCalledWith('t1', 'mem-1', expect.objectContaining({ promotedSkillSlug: 'paginate-list-calls' }));
    });

    it('existing slug → stamps marker, does not create (disable-as-veto)', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-existing', isEnabled: false });
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1' });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockSvc.update).toHaveBeenCalled();
    });

    it('P2002 race → treated as exists, still stamps, does not throw', async () => {
        mockRepo.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1' });
        expect(n).toBe(0);
        expect(mockSvc.update).toHaveBeenCalled();
    });

    it('rule missing instruction/trigger → skipped entirely', async () => {
        mockQueryRaw.mockResolvedValue([candidate({ value: { evidence: 'e', confidence: 'high' } })]);
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1' });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('no candidates → 0, repo untouched', async () => {
        mockQueryRaw.mockResolvedValue([]);
        expect(await autoCreateSkillsFromMaturedRules({ tenantId: 't1' })).toBe(0);
        expect(getSkillRepository).not.toHaveBeenCalled();
    });

    it('flag off → 0 without querying', async () => {
        process.env.AUTO_SKILL_CREATION_ENABLED = 'false';
        expect(await autoCreateSkillsFromMaturedRules({ tenantId: 't1' })).toBe(0);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('query throwing → 0, does not throw', async () => {
        mockQueryRaw.mockRejectedValue(new Error('db down'));
        expect(await autoCreateSkillsFromMaturedRules({ tenantId: 't1' })).toBe(0);
    });
});
