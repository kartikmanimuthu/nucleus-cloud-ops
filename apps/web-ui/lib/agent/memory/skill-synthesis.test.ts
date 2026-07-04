import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQueryRaw = vi.fn();
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => ({ $queryRaw: mockQueryRaw }) }));
vi.mock('@/lib/db/repository-factory', () => ({ getSkillRepository: vi.fn() }));
vi.mock('./memory-service', () => ({ getMemoryService: vi.fn() }));

import { getSkillRepository } from '@/lib/db/repository-factory';
import { getMemoryService } from './memory-service';
import {
    synthesizeDomainSkills, autoSkillCreationEnabled, autoSkillMaturityThreshold, skillSynthesisMinRules,
} from './skill-synthesis';

const mockRepo = { getBySlug: vi.fn(), create: vi.fn(), update: vi.fn() };
const mockSvc = { update: vi.fn() };

const candidateRow = { domain: 'aws-cli', matured: 3, pending: 2 };
const rule = (id: string, key: string, marked = false) => ({
    id, key,
    value: {
        instruction: `instruction for ${key}`, trigger: `trigger for ${key}`, evidence: `evidence for ${key}`,
        confidence: 'high', ...(marked ? { synthesizedIntoSkill: 'sys-aws-cli' } : {}),
    },
    sourceThreadId: `th-${id}`, accessCount: 4,
});
const episodeRow = { key: 'thread-r1', value: { context: 'ctx', reasoning: 'rsn', action: 'act', outcome: 'SUCCEEDED' } };

const distillerReturning = (content: string) => ({ invoke: vi.fn().mockResolvedValue({ content }) }) as any;
const goodDistill = JSON.stringify({
    name: 'AWS CLI Operations', description: 'Reliable AWS CLI usage patterns.',
    narrative: '## Purpose\nUse the AWS CLI safely.\n\n## When to use\nAny CLI task.',
});
const base = { tenantId: 't1', threadId: 'th-run' };

function primeQueries(opts: { candidates?: unknown[]; rules?: unknown[]; episodes?: unknown[] } = {}) {
    mockQueryRaw.mockReset();
    mockQueryRaw
        .mockResolvedValueOnce(opts.candidates ?? [candidateRow])          // 1: candidate domains
        .mockResolvedValueOnce(opts.rules ?? [rule('r1', 'paginate-list-calls'), rule('r2', 'use-startdate-enddate'), rule('r3', 'check-region', true)]) // 2: domain rules
        .mockResolvedValueOnce(opts.episodes ?? [episodeRow]);            // 3: episodes
}

beforeEach(() => {
    vi.clearAllMocks();
    primeQueries();
    mockRepo.getBySlug.mockResolvedValue(null);
    mockRepo.create.mockResolvedValue({ id: 's1' });
    mockRepo.update.mockResolvedValue({ id: 's1' });
    mockSvc.update.mockResolvedValue(undefined);
    vi.mocked(getSkillRepository).mockReturnValue(mockRepo as any);
    vi.mocked(getMemoryService).mockReturnValue(mockSvc as any);
});
afterEach(() => {
    delete process.env.AUTO_SKILL_CREATION_ENABLED;
    delete process.env.AUTO_SKILL_MATURITY_THRESHOLD;
    delete process.env.SKILL_SYNTHESIS_MIN_RULES;
});

describe('flags', () => {
    it('defaults + env overrides', () => {
        expect(autoSkillCreationEnabled()).toBe(true);
        expect(autoSkillMaturityThreshold()).toBe(3);
        expect(skillSynthesisMinRules()).toBe(3);
        process.env.SKILL_SYNTHESIS_MIN_RULES = '5';
        expect(skillSynthesisMinRules()).toBe(5);
    });
});

describe('synthesizeDomainSkills', () => {
    it('creates sys-<domain> with narrative + complete ledger and stamps pending rules only', async () => {
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(1);
        expect(mockRepo.create).toHaveBeenCalledWith('t1', expect.objectContaining({
            slug: 'sys-aws-cli', name: 'AWS CLI Operations', source: 'system',
            isEnabled: true, tier: 'read-only', sourceRunId: 'th-run',
        }));
        const content = mockRepo.create.mock.calls[0][1].content as string;
        expect(content).toContain('## Purpose');
        expect(content).toContain('## Learned rules & gotchas');
        // EVERY matured rule in the ledger — including the already-marked one
        expect(content).toContain('instruction for paginate-list-calls');
        expect(content).toContain('instruction for use-startdate-enddate');
        expect(content).toContain('instruction for check-region');
        // stamps ONLY the two pending rules
        expect(mockSvc.update).toHaveBeenCalledTimes(2);
        expect(mockSvc.update).toHaveBeenCalledWith('t1', 'r1', expect.objectContaining({ synthesizedIntoSkill: 'sys-aws-cli' }));
        expect(mockSvc.update).toHaveBeenCalledWith('t1', 'r2', expect.objectContaining({ synthesizedIntoSkill: 'sys-aws-cli' }));
    });

    it('existing ENABLED system skill → update content+description only', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-x', source: 'system', isEnabled: true, content: 'old' });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(1);
        expect(mockRepo.create).not.toHaveBeenCalled();
        const [tenant, id, patch] = mockRepo.update.mock.calls[0];
        expect(tenant).toBe('t1');
        expect(id).toBe('s-x');
        expect(Object.keys(patch).sort()).toEqual(['content', 'description']);
    });

    it('existing DISABLED system skill → veto: stamp pending, no distill, no update', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-x', source: 'system', isEnabled: false, content: 'old' });
        const distiller = distillerReturning(goodDistill);
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distiller });
        expect(n).toBe(0);
        expect(distiller.invoke).not.toHaveBeenCalled();
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockSvc.update).toHaveBeenCalledTimes(2); // pending rules stamped
    });

    it('user-owned slug → skip domain, stamp NOTHING, no writes', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-x', source: 'user', isEnabled: true, content: 'mine' });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('distiller garbage → no writes, no stamps (retry next run)', async () => {
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning('not json at all') });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('distiller output missing a field → treated as invalid', async () => {
        const bad = JSON.stringify({ name: 'X', narrative: '' });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(bad) });
        expect(n).toBe(0);
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('episode material is included in the distiller input', async () => {
        const distiller = distillerReturning(goodDistill);
        await synthesizeDomainSkills({ ...base, distillerModel: distiller });
        const messages = distiller.invoke.mock.calls[0][0];
        const human = String(messages[1].content);
        expect(human).toContain('SUCCEEDED');
    });

    it('no qualifying domain → 0, nothing else queried', async () => {
        primeQueries({ candidates: [] });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it('flag off → 0 without any query', async () => {
        process.env.AUTO_SKILL_CREATION_ENABLED = 'false';
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('candidate query throwing → 0, does not throw', async () => {
        mockQueryRaw.mockReset();
        mockQueryRaw.mockRejectedValue(new Error('db down'));
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
    });

    it('P2002 create race → re-fetches and updates instead', async () => {
        mockRepo.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
        mockRepo.getBySlug
            .mockResolvedValueOnce(null) // ownership check: absent
            .mockResolvedValueOnce({ id: 's-race', source: 'system', isEnabled: true, content: 'old' }); // re-fetch after P2002
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(1);
        expect(mockRepo.update).toHaveBeenCalledWith('t1', 's-race', expect.objectContaining({ content: expect.any(String) }));
        expect(mockSvc.update).toHaveBeenCalledTimes(2);
    });

    it('P2002 race with a USER-owned winner → no update, no stamps', async () => {
        mockRepo.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
        mockRepo.getBySlug
            .mockResolvedValueOnce(null) // ownership check: absent
            .mockResolvedValueOnce({ id: 's-user', source: 'user', isEnabled: true, content: 'mine' }); // user won the race
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(0);
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('rules missing trigger/instruction are excluded from the ledger (no literal undefined)', async () => {
        primeQueries({
            rules: [
                rule('r1', 'paginate-list-calls'),
                { id: 'r-bad', key: 'legacy-broken', value: { evidence: 'e', confidence: 'high' }, sourceThreadId: null, accessCount: 5 },
            ],
        });
        const n = await synthesizeDomainSkills({ ...base, distillerModel: distillerReturning(goodDistill) });
        expect(n).toBe(1);
        const content = mockRepo.create.mock.calls[0][1].content as string;
        expect(content).toContain('instruction for paginate-list-calls');
        expect(content).not.toContain('undefined');
    });
});
