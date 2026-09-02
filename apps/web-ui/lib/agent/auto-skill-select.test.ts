import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/skill-service', () => ({
    getSkillSummaries: vi.fn(),
    getSkillById: vi.fn(),
}));
vi.mock('./model-factory', () => ({ createAgentModels: vi.fn() }));

import { getSkillSummaries, getSkillById } from '@/lib/skill-service';
import { createAgentModels } from './model-factory';
import { autoSelectSkill } from './auto-skill-select';

const reflectorReturning = (content: string) => ({ reflector: { invoke: vi.fn().mockResolvedValue({ content }) } });
const base = { tenantId: 't1', message: 'analyse our EC2 costs', model: {} as any };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSkillSummaries).mockResolvedValue('Available Skills:\n- cost-analyser: Cost Analyser - analyses spend');
    vi.mocked(getSkillById).mockResolvedValue({ id: 'cost-analyser', name: 'Cost Analyser', description: 'analyses spend', tier: 'read-only' } as any);
});
describe('autoSelectSkill', () => {
    it('matches a skill and returns slug + reasoning', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"skillId": "cost-analyser", "reasoning": "cost question"}') as any);
        const res = await autoSelectSkill(base);
        expect(res).toEqual({ slug: 'cost-analyser', reasoning: 'cost question' });
    });

    it('returns null when the model answers null', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"skillId": null, "reasoning": "generic"}') as any);
        expect(await autoSelectSkill(base)).toBeNull();
    });

    it('returns null on unparseable output', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('sure, use the cost skill!') as any);
        expect(await autoSelectSkill(base)).toBeNull();
    });

    it('returns null for a hallucinated slug not in the tenant catalog', async () => {
        vi.mocked(getSkillById).mockResolvedValue(null);
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"skillId": "made-up", "reasoning": "x"}') as any);
        expect(await autoSelectSkill(base)).toBeNull();
        expect(getSkillById).not.toHaveBeenCalled();
    });

    it('returns null when the slug is listed in the catalog string but no longer exists per-tenant (deleted mid-race)', async () => {
        vi.mocked(getSkillById).mockResolvedValue(null);
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"skillId": "cost-analyser", "reasoning": "cost question"}') as any);
        expect(await autoSelectSkill(base)).toBeNull();
        expect(getSkillById).toHaveBeenCalledWith('t1', 'cost-analyser');
    });

    it('returns null when no skills exist, without an LLM call', async () => {
        vi.mocked(getSkillSummaries).mockResolvedValue('No specialized skills available.');
        const models = reflectorReturning('{}');
        vi.mocked(createAgentModels).mockReturnValue(models as any);
        expect(await autoSelectSkill(base)).toBeNull();
        expect(models.reflector.invoke).not.toHaveBeenCalled();
    });

    it('LLM throwing → null, does not throw', async () => {
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke: vi.fn().mockRejectedValue(new Error('down')) } } as any);
        expect(await autoSelectSkill(base)).toBeNull();
    });
});
