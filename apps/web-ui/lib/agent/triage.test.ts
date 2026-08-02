import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/skill-service', () => ({
    getSkillSummaries: vi.fn(),
    getSkillById: vi.fn(),
}));
vi.mock('./model-factory', () => ({ createAgentModels: vi.fn() }));
vi.mock('./auto-skill-select', () => ({ autoSelectSkill: vi.fn() }));
// triageChatMessage resolves the tenant's AI Ops feature settings fresh on every
// call; stub the store so tests control the chat-triage toggle.
vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));
import { TenantConfigService } from '@/lib/tenant-config-service';

import { getSkillSummaries, getSkillById } from '@/lib/skill-service';
import { createAgentModels } from './model-factory';
import { autoSelectSkill } from './auto-skill-select';
import { triageChatMessage, parseTriageResponse, chatTriageEnabled } from './triage';

const CATALOG = 'Available Skills:\n- cost-analyser: Cost Analyser - analyses spend';
const reflectorReturning = (content: string) => ({ reflector: { invoke: vi.fn().mockResolvedValue({ content }) } });
const base = { tenantId: 't1', message: 'hi there', model: {} as any };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSkillSummaries).mockResolvedValue(CATALOG);
    vi.mocked(getSkillById).mockResolvedValue({ id: 'cost-analyser', name: 'Cost Analyser', description: 'analyses spend', tier: 'read-only' } as any);
});
import { DEFAULT_FEATURES, primeAiopsFeaturesCache } from './aiops-features';

describe('chatTriageEnabled', () => {
    it('defaults true; tenant setting false disables', () => {
        expect(chatTriageEnabled()).toBe(true);
        primeAiopsFeaturesCache('t-triage-off', { ...DEFAULT_FEATURES, chatTriageEnabled: false });
        expect(chatTriageEnabled('t-triage-off')).toBe(false);
    });
});

describe('parseTriageResponse', () => {
    it('parses a direct route', () => {
        expect(parseTriageResponse('{"route": "direct", "skillId": null, "reasoning": "greeting"}', CATALOG))
            .toEqual({ route: 'direct', skillId: null, reasoning: 'greeting' });
    });

    it('parses a task route with a catalog-valid skill', () => {
        expect(parseTriageResponse('{"route": "task", "skillId": "cost-analyser", "reasoning": "costs"}', CATALOG))
            .toEqual({ route: 'task', skillId: 'cost-analyser', reasoning: 'costs' });
    });

    it('drops a skill slug not present in the catalog', () => {
        const res = parseTriageResponse('{"route": "task", "skillId": "made-up", "reasoning": "x"}', CATALOG);
        expect(res.skillId).toBeNull();
        expect(res.route).toBe('task');
    });

    it('fails open to task on unparseable output', () => {
        expect(parseTriageResponse('sure, sounds conversational!', CATALOG).route).toBe('task');
    });

    it('fails open to task on malformed JSON', () => {
        expect(parseTriageResponse('{"route": "direct", oops', CATALOG).route).toBe('task');
    });

    it('treats an unknown route value as task', () => {
        expect(parseTriageResponse('{"route": "chat", "skillId": null}', CATALOG).route).toBe('task');
    });
});

describe('triageChatMessage', () => {
    it('routes a greeting to direct with no skill', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"route": "direct", "skillId": null, "reasoning": "greeting"}') as any);
        const res = await triageChatMessage(base);
        expect(res.route).toBe('direct');
        expect(res.skillId).toBeNull();
    });

    it('routes a task and auto-selects the skill in the same call', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"route": "task", "skillId": "cost-analyser", "reasoning": "costs"}') as any);
        const res = await triageChatMessage({ ...base, message: 'analyse our EC2 costs' });
        expect(res).toEqual({ route: 'task', skillId: 'cost-analyser', reasoning: 'costs' });
    });

    it('drops a slug that fails the tenant DB re-verification', async () => {
        vi.mocked(getSkillById).mockResolvedValue(null);
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"route": "task", "skillId": "cost-analyser", "reasoning": "x"}') as any);
        const res = await triageChatMessage(base);
        expect(res.skillId).toBeNull();
    });

    it('skips skill matching when a skill is already selected', async () => {
        const models = reflectorReturning('{"route": "task", "skillId": null, "reasoning": "task"}');
        vi.mocked(createAgentModels).mockReturnValue(models as any);
        const res = await triageChatMessage({ ...base, skillAlreadySelected: true });
        expect(res.route).toBe('task');
        expect(vi.mocked(getSkillSummaries)).not.toHaveBeenCalled();
    });

    it('fails open to task when the model call throws', async () => {
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke: vi.fn().mockRejectedValue(new Error('throttled')) } } as any);
        const res = await triageChatMessage(base);
        expect(res).toEqual({ route: 'task', skillId: null, reasoning: 'fallback' });
    });

    it('kill-switch: falls back to legacy autoSelectSkill with route task', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ chatTriageEnabled: false } as never);
        vi.mocked(autoSelectSkill).mockResolvedValue({ slug: 'cost-analyser', reasoning: 'legacy' });
        const res = await triageChatMessage(base);
        expect(res).toEqual({ route: 'task', skillId: 'cost-analyser', reasoning: 'legacy' });
        expect(vi.mocked(createAgentModels)).not.toHaveBeenCalled();
    });

    it('kill-switch + preselected skill: pure task fallback, no LLM calls', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ chatTriageEnabled: false } as never);
        const res = await triageChatMessage({ ...base, skillAlreadySelected: true });
        expect(res.route).toBe('task');
        expect(vi.mocked(autoSelectSkill)).not.toHaveBeenCalled();
    });
});
