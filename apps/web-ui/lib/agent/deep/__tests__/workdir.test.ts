import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SkillMetadata } from '@/lib/skill-service';

const loadSkillsMock = vi.fn();
const loadAllSkillContentMock = vi.fn();
vi.mock('@/lib/skill-service', () => ({
    loadSkills: (...a: unknown[]) => loadSkillsMock(...a),
    loadAllSkillContent: (...a: unknown[]) => loadAllSkillContentMock(...a),
}));

// Typed against the REAL SkillMetadata so a wrong field name is a compile error.
// The original bug read `skill.slug`, which does not exist — every skill was skipped
// and the mocks, written with the same wrong field, agreed with it.
function skill(id: string, description: string): SkillMetadata {
    return { id, name: id, description, tier: 'tenant' as SkillMetadata['tier'] };
}

describe('tenantWorkdir', () => {
    it('scopes the root to the tenant', async () => {
        const { tenantWorkdir } = await import('@/lib/agent/deep/workdir');
        const a = tenantWorkdir('tenant-a');
        const b = tenantWorkdir('tenant-b');
        expect(a).not.toBe(b);
        expect(a.endsWith(path.join('nucleus-agent', 'tenant-a'))).toBe(true);
    });

    it('rejects traversal in the tenant id', async () => {
        const { tenantWorkdir } = await import('@/lib/agent/deep/workdir');
        const p = tenantWorkdir('../../etc');
        expect(p.includes('..')).toBe(false);
    });
});

describe('materializeSkills', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
        loadSkillsMock.mockReset(); loadAllSkillContentMock.mockReset();
    });
    afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

    it('writes each skill as SKILL.md with valid frontmatter', async () => {
        loadSkillsMock.mockResolvedValue([{ id:'ec2-triage', description: 'Diagnose EC2 issues' }]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['ec2-triage', '# Steps\n1. Check state']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');

        const count = await materializeSkills('tenant-a', root);

        expect(count).toBe(1);
        const written = await fs.readFile(path.join(root, 'skills', 'ec2-triage', 'SKILL.md'), 'utf-8');
        expect(written).toBe(
            '---\nname: ec2-triage\ndescription: "Diagnose EC2 issues"\n---\n\n# Steps\n1. Check state\n'
        );
    });

    it('truncates descriptions to the 1024 char framework limit', async () => {
        loadSkillsMock.mockResolvedValue([{ id:'s', description: 'x'.repeat(2000) }]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['s', 'body']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        await materializeSkills('tenant-a', root);

        const written = await fs.readFile(path.join(root, 'skills', 's', 'SKILL.md'), 'utf-8');
        // Quoted scalar: strip `description: "` and the trailing `"`.
        const description = written.split('\n')[2].replace('description: "', '').replace(/"$/, '');
        expect(description.length).toBe(1024);
    });

    it('YAML-quotes descriptions containing YAML-significant characters', async () => {
        // Raw prose descriptions broke the frontmatter: a leading '>' was read as a YAML
        // block scalar and ':' / '#' / quotes derailed the parse, so the skills middleware
        // silently skipped the skill.
        loadSkillsMock.mockResolvedValue([skill('s', '> Use when: debugging "Redis" #1 on EC2')]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['s', 'body']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        await materializeSkills('tenant-a', root);

        const written = await fs.readFile(path.join(root, 'skills', 's', 'SKILL.md'), 'utf-8');
        expect(written).toContain('description: "> Use when: debugging \\"Redis\\" #1 on EC2"');
    });

    it('escapes backslashes so the quoted scalar stays well formed', async () => {
        loadSkillsMock.mockResolvedValue([skill('s', 'path C:\\temp and "quoted"')]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['s', 'body']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        await materializeSkills('tenant-a', root);

        const written = await fs.readFile(path.join(root, 'skills', 's', 'SKILL.md'), 'utf-8');
        expect(written).toContain('description: "path C:\\\\temp and \\"quoted\\""');
    });

    it('strips newlines from the description so frontmatter stays valid', async () => {
        loadSkillsMock.mockResolvedValue([{ id:'s', description: 'line one\nline two' }]);
        loadAllSkillContentMock.mockResolvedValue(new Map([['s', 'body']]));
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        await materializeSkills('tenant-a', root);

        const written = await fs.readFile(path.join(root, 'skills', 's', 'SKILL.md'), 'utf-8');
        expect(written).toContain('description: "line one line two"');
    });

    it('returns 0 and creates nothing when the tenant has no skills', async () => {
        loadSkillsMock.mockResolvedValue([]);
        loadAllSkillContentMock.mockResolvedValue(new Map());
        const { materializeSkills } = await import('@/lib/agent/deep/workdir');
        expect(await materializeSkills('tenant-a', root)).toBe(0);
    });
});

describe('ensureWorkdir', () => {
    let root: string;

    beforeEach(async () => { root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'wd-test-')), 'tenant-a'); });
    afterEach(async () => { await fs.rm(path.dirname(root), { recursive: true, force: true }); });

    it('creates the root even when the tenant has no skills', async () => {
        const { ensureWorkdir } = await import('@/lib/agent/deep/workdir');
        await ensureWorkdir(root);
        expect((await fs.stat(root)).isDirectory()).toBe(true);
    });

    it('does NOT put AGENTS.md on disk — it routes to the store backend', async () => {
        const { ensureWorkdir, AGENTS_MD_PATH, MEMORIES_ROUTE } = await import('@/lib/agent/deep/workdir');
        await ensureWorkdir(root);
        // Container storage is ephemeral; a disk-backed AGENTS.md is lost on every deploy.
        await expect(fs.access(path.join(root, 'AGENTS.md'))).rejects.toThrow();
        expect(AGENTS_MD_PATH.startsWith(MEMORIES_ROUTE)).toBe(true);
    });


});
