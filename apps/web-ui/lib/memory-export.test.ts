/**
 * Unit tests for the Memory → Markdown export builders. Mirrors
 * lib/skill-export.test.ts: only the pure builders are tested; the Blob/zip
 * wrappers are thin DOM code identical to skill-export's.
 */
import { describe, it, expect } from 'vitest';
import { buildMemoryMarkdown } from './memory-export';
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