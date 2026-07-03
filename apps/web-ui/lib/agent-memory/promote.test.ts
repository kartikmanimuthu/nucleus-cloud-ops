import { describe, it, expect } from 'vitest';
import { buildSkillDraftFromMemory } from './promote';
import type { MemoryRow } from '@/lib/queries/agent-memories';

const row = (overrides: Partial<MemoryRow> = {}): MemoryRow => ({
    id: 'm1', userId: 'u1', namespace: 'procedures/aws-cli', category: 'other' as any,
    key: 'paginate-list-calls', fact: '', source: null, confidence: null,
    value: { instruction: 'Always paginate list/describe calls', trigger: 'any AWS CLI list operation', evidence: 'missed a resource once' },
    kind: 'PROCEDURAL', sourceThreadId: 'th-42',
    supersededById: null, supersededAt: null,
    createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z',
    ...overrides,
});

describe('buildSkillDraftFromMemory', () => {
    it('builds a draft from a procedural row', () => {
        const d = buildSkillDraftFromMemory(row());
        expect(d).not.toBeNull();
        expect(d!.name).toBe('Paginate List Calls');
        expect(d!.description).toBe('any AWS CLI list operation');
        expect(d!.tier).toBe('read-only');
        expect(d!.content).toContain('## Rule\nAlways paginate list/describe calls');
        expect(d!.content).toContain('## When it applies\nany AWS CLI list operation');
        expect(d!.content).toContain('## Why (evidence)\nmissed a resource once');
    });
    it('returns null for non-procedural rows', () => {
        expect(buildSkillDraftFromMemory(row({ kind: 'SEMANTIC' }))).toBeNull();
        expect(buildSkillDraftFromMemory(row({ kind: 'EPISODIC' }))).toBeNull();
    });
    it('returns null when instruction or trigger missing', () => {
        expect(buildSkillDraftFromMemory(row({ value: { trigger: 't' } }))).toBeNull();
        expect(buildSkillDraftFromMemory(row({ value: { instruction: 'i' } }))).toBeNull();
    });
    it('evidence missing → placeholder, still promotable', () => {
        const d = buildSkillDraftFromMemory(row({ value: { instruction: 'i', trigger: 't' } }));
        expect(d!.content).toContain('## Why (evidence)\n(not recorded)');
    });
});
