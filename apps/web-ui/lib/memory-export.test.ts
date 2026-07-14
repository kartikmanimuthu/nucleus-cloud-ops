/**
 * Unit tests for the Memory → Markdown export builders. Mirrors
 * lib/skill-export.test.ts: only the pure builders are tested; the Blob/zip
 * wrappers are thin DOM code identical to skill-export's.
 */
import { describe, it, expect } from 'vitest';
import { buildMemoryMarkdown, buildAllMemoriesMarkdown, buildMemoryFile } from './memory-export';
import type { MemoryRow } from './queries/agent-memories';

function makeMemory(overrides: Partial<MemoryRow> = {}): MemoryRow {
    return {
        id: 'cm1a2b3c',
        userId: 'user-1',
        namespace: 'infra:ec2',
        category: 'infra',
        key: 'prod-stop-schedule',
        fact: 'Prod EC2 stops at 7pm.',
        source: 'scheduler-discovery-2026-07',
        confidence: 'high',
        value: { fact: 'Prod EC2 stops at 7pm.', source: 'scheduler-discovery-2026-07', confidence: 'high' },
        kind: 'SEMANTIC',
        sourceThreadId: null,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
        expiresAt: '2026-10-11T00:00:00.000Z',
        supersededById: null,
        supersededAt: null,
        ...overrides,
    };
}

describe('buildMemoryMarkdown', () => {
    it('renders the key as H1 and a metadata table', () => {
        const md = buildMemoryMarkdown(makeMemory());
        expect(md).toContain('# prod-stop-schedule');
        expect(md).toContain('| Kind | SEMANTIC |');
        expect(md).toContain('| Namespace | infra:ec2 |');
        expect(md).toContain('| Category | infra |');
        expect(md).toContain('| Confidence | high |');
        expect(md).toContain('| Source | scheduler-discovery-2026-07 |');
        expect(md).toContain('| Created | 2026-07-13T00:00:00.000Z |');
    });

    it('uses an em-dash for null confidence and source', () => {
        const md = buildMemoryMarkdown(makeMemory({ confidence: null, source: null }));
        expect(md).toContain('| Confidence | — |');
        expect(md).toContain('| Source | — |');
    });

    it('renders the superseded-by row', () => {
        const md = buildMemoryMarkdown(makeMemory({ supersededById: 'cm999' }));
        expect(md).toContain('| Superseded by | cm999 |');
    });

    it('renders SEMANTIC value body as Fact/Source/Confidence', () => {
        const md = buildMemoryMarkdown(makeMemory({ kind: 'SEMANTIC' }));
        expect(md).toContain('**Fact:** Prod EC2 stops at 7pm.');
        expect(md).toContain('**Source:** scheduler-discovery-2026-07');
        expect(md).toContain('**Confidence:** high');
    });

    it('renders EPISODIC value body as Context/Reasoning/Action/Outcome', () => {
        const md = buildMemoryMarkdown(
            makeMemory({
                kind: 'EPISODIC',
                confidence: null,
                value: { context: 'High CPU', reasoning: 'Scale up', action: 'Bumped ASG max', outcome: 'CPU normalized' },
            })
        );
        expect(md).toContain('**Context:** High CPU');
        expect(md).toContain('**Reasoning:** Scale up');
        expect(md).toContain('**Action:** Bumped ASG max');
        expect(md).toContain('**Outcome:** CPU normalized');
    });

    it('renders PROCEDURAL value body as Instruction/Trigger/Evidence/Confidence', () => {
        const md = buildMemoryMarkdown(
            makeMemory({
                kind: 'PROCEDURAL',
                confidence: 'medium',
                value: { instruction: 'Restart RDS', trigger: 'failover event', evidence: 'worked 3x', confidence: 'medium' },
            })
        );
        expect(md).toContain('**Instruction:** Restart RDS');
        expect(md).toContain('**Trigger:** failover event');
        expect(md).toContain('**Evidence:** worked 3x');
        expect(md).toContain('**Confidence:** medium');
    });

    it('renders an em-dash for missing value fields', () => {
        const md = buildMemoryMarkdown(
            makeMemory({ kind: 'EPISODIC', confidence: null, value: { context: 'only context' } })
        );
        expect(md).toContain('**Context:** only context');
        expect(md).toContain('**Reasoning:** —');
        expect(md).toContain('**Action:** —');
        expect(md).toContain('**Outcome:** —');
    });
});

describe('buildAllMemoriesMarkdown', () => {
    it('renders a header with the record count', () => {
        const md = buildAllMemoriesMarkdown([makeMemory(), makeMemory({ id: 'b', key: 'second' })]);
        expect(md).toContain('# Memory export');
        expect(md).toContain('Exported 2 memory record(s).');
    });

    it('renders an empty-state message when there are no memories', () => {
        const md = buildAllMemoriesMarkdown([]);
        expect(md).toContain('Exported 0 memory record(s).');
        expect(md).toContain('_No memories to export._');
    });

    it('groups the table of contents by kind in enum order', () => {
        const md = buildAllMemoriesMarkdown([
            makeMemory({ id: 'p', key: 'proc', kind: 'PROCEDURAL' }),
            makeMemory({ id: 's', key: 'sem', kind: 'SEMANTIC' }),
            makeMemory({ id: 'e', key: 'ep', kind: 'EPISODIC' }),
        ]);
        expect(md).toContain('### SEMANTIC');
        expect(md).toContain('### EPISODIC');
        expect(md).toContain('### PROCEDURAL');
        expect(md.indexOf('### SEMANTIC')).toBeLessThan(md.indexOf('### EPISODIC'));
        expect(md.indexOf('### EPISODIC')).toBeLessThan(md.indexOf('### PROCEDURAL'));
    });

    it('links TOC entries to key anchors', () => {
        const md = buildAllMemoriesMarkdown([makeMemory({ key: 'prod-stop-schedule' })]);
        expect(md).toContain('- [prod-stop-schedule](#prod-stop-schedule)');
    });

    it('sorts memories within a kind by createdAt descending', () => {
        const md = buildAllMemoriesMarkdown([
            makeMemory({ id: 'old', key: 'old', kind: 'SEMANTIC', createdAt: '2026-01-01T00:00:00.000Z' }),
            makeMemory({ id: 'new', key: 'new', kind: 'SEMANTIC', createdAt: '2026-07-01T00:00:00.000Z' }),
        ]);
        expect(md.indexOf('# new')).toBeLessThan(md.indexOf('# old'));
    });

    it('separates each memory with a horizontal rule and includes bodies', () => {
        const md = buildAllMemoriesMarkdown([
            makeMemory({ id: 'a', key: 'alpha' }),
            makeMemory({ id: 'b', key: 'beta' }),
        ]);
        expect(md).toContain('# alpha');
        expect(md).toContain('# beta');
        expect(md).toContain('\n---\n');
    });

    it('omits a kind group entirely when no memories of that kind exist', () => {
        const md = buildAllMemoriesMarkdown([makeMemory({ kind: 'PROCEDURAL' })]);
        expect(md).not.toContain('### SEMANTIC');
        expect(md).toContain('### PROCEDURAL');
    });
});

describe('buildMemoryFile (portable frontmatter)', () => {
    it('emits YAML frontmatter delimited by --- fences', () => {
        const md = buildMemoryFile(makeMemory());
        expect(md.startsWith('---\n')).toBe(true);
        expect(md).toMatch(/\n---\n/);
    });

    it('places kind, namespace, key, category, created_at, updated_at in frontmatter', () => {
        const md = buildMemoryFile(makeMemory());
        expect(md).toContain('kind: SEMANTIC');
        expect(md).toContain('namespace: "infra:ec2"');
        expect(md).toContain('key: "prod-stop-schedule"');
        expect(md).toContain('category: infra');
        expect(md).toContain('created_at: 2026-07-13T00:00:00.000Z');
        expect(md).toContain('updated_at: 2026-07-13T00:00:00.000Z');
    });

    it('includes confidence when present', () => {
        const md = buildMemoryFile(makeMemory({ confidence: 'high' }));
        expect(md).toContain('confidence: high');
    });

    it('omits the confidence line when null', () => {
        const md = buildMemoryFile(makeMemory({ confidence: null }));
        expect(md).not.toMatch(/^confidence:/m);
    });

    it('puts the kind-aware body after the frontmatter', () => {
        const md = buildMemoryFile(makeMemory({ kind: 'SEMANTIC' }));
        const bodyStart = md.indexOf('\n---\n') + '\n---\n'.length;
        const body = md.slice(bodyStart);
        expect(body).toContain('**Fact:** Prod EC2 stops at 7pm.');
        expect(body).toContain('**Source:** scheduler-discovery-2026-07');
        expect(body).toContain('**Confidence:** high');
    });

    it('escapes double quotes and backslashes in namespace/key', () => {
        const md = buildMemoryFile(makeMemory({ namespace: 'a"b', key: 'c\\d' }));
        expect(md).toContain('namespace: "a\\"b"');
        expect(md).toContain('key: "c\\\\d"');
    });

    it('uses a YAML block scalar for multi-line namespaces', () => {
        const md = buildMemoryFile(makeMemory({ namespace: 'line one\nline two' }));
        expect(md).toContain('namespace: |-\n  line one\n  line two');
    });
});
