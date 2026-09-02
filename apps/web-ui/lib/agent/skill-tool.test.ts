import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSkillContentMock = vi.hoisted(() => vi.fn());
const getSkillSummariesMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/skill-service', () => ({ getSkillContent: getSkillContentMock, getSkillSummaries: getSkillSummariesMock }));

import { createLoadSkillTool } from './skill-tool';

describe('createLoadSkillTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('loads the skill scoped to the bound tenantId and trims the slug', async () => {
        getSkillContentMock.mockResolvedValue('do the thing carefully');
        const tool = createLoadSkillTool('tenant-1');

        const result = await tool.invoke({ skill_id: '  cost-optimizer  ' });

        expect(getSkillContentMock).toHaveBeenCalledWith('tenant-1', 'cost-optimizer');
        expect(result).toContain('SKILL LOADED: COST-OPTIMIZER');
        expect(result).toContain('do the thing carefully');
        expect(result).toContain('END SKILL');
    });

    it('returns a not-found error with the skill catalog when the skill is disabled or unknown', async () => {
        getSkillContentMock.mockResolvedValue(null);
        getSkillSummariesMock.mockResolvedValue('- cost-optimizer: saves money\n- ec2-triage: diagnoses instances');
        const tool = createLoadSkillTool('tenant-1');

        const result = await tool.invoke({ skill_id: 'unknown-skill' });

        expect(result).toContain('Error: skill "unknown-skill" not found or not enabled');
        expect(result).toContain('cost-optimizer: saves money');
    });

    it('falls back to a generic catalog message when fetching the catalog itself fails', async () => {
        getSkillContentMock.mockResolvedValue(null);
        getSkillSummariesMock.mockRejectedValue(new Error('DB down'));
        const tool = createLoadSkillTool('tenant-1');

        const result = await tool.invoke({ skill_id: 'unknown-skill' });

        expect(result).toContain('No specialized skills available.');
    });

    it('logs when a skill is successfully loaded', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        getSkillContentMock.mockResolvedValue('instructions');
        const tool = createLoadSkillTool('tenant-1');

        await tool.invoke({ skill_id: 'ec2-triage' });

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Loaded skill "ec2-triage"'));
        logSpy.mockRestore();
    });
});
