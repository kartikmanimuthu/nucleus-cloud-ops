/**
 * Unit tests for the Skill → Markdown export builder.
 *
 * buildSkillMarkdown()/buildAllSkillsMarkdown() are the pure cores of the
 * "Export markdown" (per-skill) and "Export all" (toolbar) downloads. Mirrors
 * tests/agent-ops/export-markdown.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDownloadText, mockDownloadBlob, mockGenerateAsync, mockFile, mockFolder } = vi.hoisted(() => ({
    mockDownloadText: vi.fn(),
    mockDownloadBlob: vi.fn(),
    mockGenerateAsync: vi.fn().mockResolvedValue('zip-blob'),
    mockFile: vi.fn(),
    mockFolder: vi.fn(() => ({ file: vi.fn() })),
}));
mockFolder.mockImplementation(() => ({ file: mockFile }));

vi.mock('@/lib/export-utils', async () => {
    const actual = await vi.importActual<typeof import('./export-utils')>('./export-utils');
    return { ...actual, downloadText: mockDownloadText, downloadBlob: mockDownloadBlob };
});

vi.mock('jszip', () => ({
    default: vi.fn().mockImplementation(function (this: any) {
        this.folder = mockFolder;
        this.generateAsync = mockGenerateAsync;
    }),
}));

import {
    buildSkillMarkdown, buildAllSkillsMarkdown, buildSkillFile,
    exportSkillToFile, exportSkillToMarkdown, exportAllSkillsToMarkdown, exportAllSkillsToZip,
} from './skill-export';
import type { SkillDTO } from './client-skill-service';

function makeSkill(overrides: Partial<SkillDTO> = {}): SkillDTO {
    return {
        id: 'stop-ec2-at-night',
        name: 'Stop EC2 at night',
        description: 'Stop non-prod EC2 instances overnight to save cost.',
        tier: 'mutation',
        source: 'user',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
        content: '## Steps\n\n1. List instances\n2. Stop them',
        ...overrides,
    };
}

describe('buildSkillMarkdown', () => {
    it('renders the skill name as the H1 and description as a blockquote', () => {
        const md = buildSkillMarkdown(makeSkill());
        expect(md).toContain('# Stop EC2 at night');
        expect(md).toContain('> Stop non-prod EC2 instances overnight to save cost.');
    });

    it('renders the metadata table with slug, tier, source and status', () => {
        const md = buildSkillMarkdown(makeSkill());
        expect(md).toContain('| Slug | `stop-ec2-at-night` |');
        expect(md).toContain('| Tier | mutation |');
        expect(md).toContain('| Source | user |');
        expect(md).toContain('| Status | Enabled |');
    });

    it('marks disabled skills as Disabled in the status row', () => {
        const md = buildSkillMarkdown(makeSkill({ isEnabled: false }));
        expect(md).toContain('| Status | Disabled |');
    });

    it('falls back to an em-dash when createdBy is null', () => {
        const md = buildSkillMarkdown(makeSkill({ createdBy: null }));
        expect(md).toContain('| Created by | — |');
    });

    it('wraps content in a fenced code block', () => {
        const md = buildSkillMarkdown(makeSkill({ content: 'do the thing' }));
        expect(md).toContain('## Content');
        expect(md).toContain('```markdown\ndo the thing\n```');
    });

    it('lengthens the fence when content itself contains backtick runs', () => {
        const content = 'Here is a code block:\n```js\nconsole.log("hi")\n```';
        const md = buildSkillMarkdown(makeSkill({ content }));
        // The fence must be 4 backticks (one longer than the 3-run inside content).
        expect(md).toContain('````markdown\n' + content + '\n````');
        // ...and must NOT contain a bare 3-backtick fence that would close early.
        expect(md).not.toContain('````\n```\n');
    });
});

describe('buildAllSkillsMarkdown', () => {
    it('renders a header with the skill count', () => {
        const md = buildAllSkillsMarkdown([makeSkill(), makeSkill({ id: 'a', name: 'Alpha skill' })]);
        expect(md).toContain('# Skills export');
        expect(md).toContain('Exported 2 skill(s).');
    });

    it('renders an empty-state message when there are no skills', () => {
        const md = buildAllSkillsMarkdown([]);
        expect(md).toContain('Exported 0 skill(s).');
        expect(md).toContain('_No skills to export._');
    });

    it('renders a table of contents linking to each skill by name anchor', () => {
        const md = buildAllSkillsMarkdown([
            makeSkill({ id: 'alpha', name: 'Alpha skill' }),
            makeSkill({ id: 'beta', name: 'Beta skill' }),
        ]);
        expect(md).toContain('## Table of contents');
        expect(md).toContain('- [Alpha skill](#alpha-skill)');
        expect(md).toContain('- [Beta skill](#beta-skill)');
    });

    it('sorts skills by name and separates them with horizontal rules', () => {
        const md = buildAllSkillsMarkdown([
            makeSkill({ id: 'zeta', name: 'Zeta skill' }),
            makeSkill({ id: 'alpha', name: 'Alpha skill' }),
        ]);
        const alphaIdx = md.indexOf('# Alpha skill');
        const zetaIdx = md.indexOf('# Zeta skill');
        expect(alphaIdx).toBeGreaterThan(-1);
        expect(zetaIdx).toBeGreaterThan(-1);
        expect(alphaIdx).toBeLessThan(zetaIdx);
        expect(md).toContain('\n---\n');
    });

    it('includes the full body of every skill', () => {
        const md = buildAllSkillsMarkdown([
            makeSkill({ id: 'a', name: 'A', content: 'AAA' }),
            makeSkill({ id: 'b', name: 'B', content: 'BBB' }),
        ]);
        expect(md).toContain('# A');
        expect(md).toContain('AAA');
        expect(md).toContain('# B');
        expect(md).toContain('BBB');
    });
});

describe('buildSkillFile (portable SKILL.md)', () => {
    it('emits YAML frontmatter delimited by --- fences', () => {
        const md = buildSkillFile(makeSkill());
        expect(md.startsWith('---\n')).toBe(true);
        expect(md).toMatch(/\n---\n/);
    });

    it('places name, description, tier and enabled in the frontmatter', () => {
        const md = buildSkillFile(makeSkill());
        expect(md).toContain('name: "Stop EC2 at night"');
        expect(md).toContain('description: "Stop non-prod EC2 instances overnight to save cost."');
        expect(md).toContain('tier: "mutation"');
        expect(md).toContain('enabled: true');
    });

    it('writes enabled: false for disabled skills', () => {
        const md = buildSkillFile(makeSkill({ isEnabled: false }));
        expect(md).toContain('enabled: false');
    });

    it('puts the skill content as the body after the frontmatter', () => {
        const md = buildSkillFile(makeSkill({ content: '## Steps\n1. Do the thing' }));
        const bodyStart = md.indexOf('\n---\n') + '\n---\n'.length;
        const body = md.slice(bodyStart);
        expect(body.trim()).toBe('## Steps\n1. Do the thing');
    });

    it('escapes double quotes and backslashes in frontmatter values', () => {
        const md = buildSkillFile(makeSkill({ name: 'A "quoted" skill', description: 'path\\to thing' }));
        expect(md).toContain('name: "A \\"quoted\\" skill"');
        expect(md).toContain('description: "path\\\\to thing"');
    });

    it('uses a YAML block scalar for multi-line descriptions', () => {
        const md = buildSkillFile(makeSkill({ description: 'line one\nline two' }));
        expect(md).toContain('description: |-\n  line one\n  line two');
    });
});

describe('exportSkillToFile / exportSkillToMarkdown / exportAllSkillsToMarkdown (Blob downloads)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('exportSkillToFile downloads the portable SKILL.md content under the skill id', () => {
        exportSkillToFile(makeSkill());
        expect(mockDownloadText).toHaveBeenCalledWith(
            expect.stringContaining('name: "Stop EC2 at night"'),
            'stop-ec2-at-night.md',
        );
    });

    it('exportSkillToFile falls back to a slugified name when the skill has no id', () => {
        exportSkillToFile(makeSkill({ id: '' }));
        expect(mockDownloadText).toHaveBeenCalledWith(expect.any(String), 'stop-ec2-at-night.md');
    });

    it('exportSkillToMarkdown downloads the human-readable report under a skill- prefixed filename', () => {
        exportSkillToMarkdown(makeSkill());
        expect(mockDownloadText).toHaveBeenCalledWith(
            expect.stringContaining('# Stop EC2 at night'),
            'skill-stop-ec2-at-night.md',
        );
    });

    it('exportAllSkillsToMarkdown downloads a dated export file', () => {
        exportAllSkillsToMarkdown([makeSkill()]);
        expect(mockDownloadText).toHaveBeenCalledWith(
            expect.stringContaining('# Skills export'),
            expect.stringMatching(/^skills-export-\d{4}-\d{2}-\d{2}\.md$/),
        );
    });
});

describe('exportAllSkillsToZip', () => {
    beforeEach(() => vi.clearAllMocks());

    it('writes one SKILL.md per skill under skills/<id>/, sorted by name', async () => {
        await exportAllSkillsToZip([
            makeSkill({ id: 'zeta', name: 'Zeta skill' }),
            makeSkill({ id: 'alpha', name: 'Alpha skill' }),
        ]);

        expect(mockFolder).toHaveBeenCalledWith('skills');
        expect(mockFile).toHaveBeenCalledTimes(2);
        expect(mockFile.mock.calls[0][0]).toBe('alpha/SKILL.md');
        expect(mockFile.mock.calls[1][0]).toBe('zeta/SKILL.md');
    });

    it('generates and downloads the zip as a dated file', async () => {
        await exportAllSkillsToZip([makeSkill()]);

        expect(mockGenerateAsync).toHaveBeenCalledWith({ type: 'blob' });
        expect(mockDownloadBlob).toHaveBeenCalledWith(
            'zip-blob',
            expect.stringMatching(/^skills-export-\d{4}-\d{2}-\d{2}\.zip$/),
        );
    });

    it('throws when the zip folder cannot be created', async () => {
        mockFolder.mockReturnValueOnce(null as any);
        await expect(exportAllSkillsToZip([makeSkill()])).rejects.toThrow('Failed to create skills folder in zip');
    });
});