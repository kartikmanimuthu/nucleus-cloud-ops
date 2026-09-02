import { describe, it, expect, vi } from 'vitest';
import {
    CORE_PRINCIPLES,
    buildBaseIdentity,
    buildEffectiveSkillSection,
    buildAccountContext,
    buildAwsCliStandards,
    buildReportStrategy,
    buildAutoApproveGuidance,
    buildOperationalWorkflows,
    buildDirectSystemPrompt,
} from './prompt-templates';

describe('CORE_PRINCIPLES', () => {
    it('is a non-empty string', () => {
        expect(typeof CORE_PRINCIPLES).toBe('string');
        expect(CORE_PRINCIPLES.length).toBeGreaterThan(0);
    });
});

describe('buildBaseIdentity', () => {
    it('returns the skill-scoped identity when a skill is selected', () => {
        expect(buildBaseIdentity('cost-optimizer')).toBe('You are an expert AI agent operating under the "cost-optimizer" skill.');
    });
    it('returns the default DevOps identity when no skill is selected', () => {
        expect(buildBaseIdentity()).toContain('senior DevOps and Cloud Operations engineer');
        expect(buildBaseIdentity(null)).toContain('senior DevOps and Cloud Operations engineer');
    });
});

describe('buildEffectiveSkillSection', () => {
    it('renders the active-skill section with skill content and an optional catalog', () => {
        const withCatalog = buildEffectiveSkillSection('cost-optimizer', 'do X carefully', '- other-skill: desc');
        expect(withCatalog).toContain('ACTIVE SKILL: COST-OPTIMIZER');
        expect(withCatalog).toContain('do X carefully');
        expect(withCatalog).toContain('other-skill: desc');
        expect(withCatalog).toContain('load_skill');
    });

    it('omits the catalog follow-up block when no catalog is given', () => {
        const noCatalog = buildEffectiveSkillSection('cost-optimizer', 'do X');
        expect(noCatalog).toContain('ACTIVE SKILL');
        expect(noCatalog).not.toContain('If a phase of the task falls outside');
    });

    it('warns and falls through to base mode when a skill is selected but has no content', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = buildEffectiveSkillSection('cost-optimizer', null);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No content provided for skill: cost-optimizer'));
        expect(result).toContain('Base DevOps Engineer');
        warnSpy.mockRestore();
    });

    it('renders the base DevOps mode with a catalog follow-up when no skill is selected', () => {
        const result = buildEffectiveSkillSection(null, null, '- cost-optimizer: desc');
        expect(result).toContain('Base DevOps Engineer');
        expect(result).toContain('cost-optimizer: desc');
    });

    it('renders the base DevOps mode with no catalog block when neither skill nor catalog is given', () => {
        const result = buildEffectiveSkillSection();
        expect(result).toContain('Base DevOps Engineer');
        expect(result).not.toContain('If one of these skills covers the task');
    });
});

describe('buildAccountContext', () => {
    it('renders the multi-account workflow with two distinct example account ids', () => {
        const result = buildAccountContext({ accounts: [{ accountId: '111111111111', accountName: 'Prod' }, { accountId: '222222222222' }] });
        expect(result).toContain('Operating across 2 account(s)');
        expect(result).toContain('Prod (ID: 111111111111)');
        expect(result).toContain('222222222222 (ID: 222222222222)'); // falls back to id when no name
        expect(result).toContain('get_aws_credentials("111111111111")');
        expect(result).toContain('get_aws_credentials("222222222222")');
    });

    it('reuses the single account id for both examples when only one account is given', () => {
        const result = buildAccountContext({ accounts: [{ accountId: '333333333333' }] });
        expect(result).toContain('Operating across 1 account(s)');
        const occurrences = result.match(/333333333333/g) ?? [];
        expect(occurrences.length).toBeGreaterThanOrEqual(2);
    });

    it('renders the single-account workflow when accountId is given without an accounts array', () => {
        const result = buildAccountContext({ accountId: '444444444444', accountName: 'Staging' });
        expect(result).toContain('Operating in: **Staging** (ID: 444444444444)');
        expect(result).toContain('MUST call get_aws_credentials("444444444444")');
    });

    it('falls back to the accountId itself when accountName is absent', () => {
        const result = buildAccountContext({ accountId: '555555555555' });
        expect(result).toContain('Operating in: **555555555555**');
    });

    it('renders the discovery workflow when neither accounts nor accountId is given', () => {
        const result = buildAccountContext({});
        expect(result).toContain('No account specified');
        expect(result).toContain('list_aws_accounts');
    });
});

describe('buildAwsCliStandards', () => {
    it('mentions --output json and BSD date syntax', () => {
        const result = buildAwsCliStandards();
        expect(result).toContain('--output json');
        expect(result).toContain('date -v-30d');
    });
});

describe('buildReportStrategy', () => {
    it('instructs against writing reports to S3/filesystem', () => {
        expect(buildReportStrategy()).toContain('Do NOT write reports to the filesystem or S3');
    });
});

describe('buildAutoApproveGuidance', () => {
    it('renders the auto-approved mode, omitting the "once the user approves" caveat', () => {
        const result = buildAutoApproveGuidance(true);
        expect(result).toContain('Execution Mode: Auto-Approved');
        expect(result).not.toContain('once the user approves them');
        expect(result).toContain('Safety Gate (always active)');
    });

    it('renders the human-in-the-loop mode, including the "once the user approves" caveat', () => {
        const result = buildAutoApproveGuidance(false);
        expect(result).toContain('Execution Mode: Human-in-the-Loop');
        expect(result).toContain('once the user approves them');
    });
});

describe('buildOperationalWorkflows', () => {
    it('covers incident triage, rollback, health check, and capacity review', () => {
        const result = buildOperationalWorkflows();
        expect(result).toContain('Incident Triage');
        expect(result).toContain('Deployment Rollback');
        expect(result).toContain('Health Check');
        expect(result).toContain('Capacity Review');
    });
});

describe('buildDirectSystemPrompt', () => {
    it('embeds the base identity and conversational-mode guidance', () => {
        const result = buildDirectSystemPrompt();
        expect(result).toContain('senior DevOps and Cloud Operations engineer');
        expect(result).toContain('Conversational Reply Mode');
        expect(result).toContain('No tools are available in this mode');
    });
});
