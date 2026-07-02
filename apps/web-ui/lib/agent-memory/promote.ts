/**
 * promote.ts — procedural memory → Skill draft mapping (Phase 4 bridge).
 * Pure and client-safe; persistence happens only through the existing
 * SkillFormDialog → useCreateSkill → POST /api/skills path (human-approved).
 */

import type { MemoryRow } from '@/lib/queries/agent-memories';

export interface SkillDraft {
    name: string;
    description: string;
    tier: string;
    content: string;
}

function humanize(key: string): string {
    return key
        .split(/[-_]+/)
        .filter(Boolean)
        .map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1))
        .join(' ');
}

export function buildSkillDraftFromMemory(row: MemoryRow): SkillDraft | null {
    if (row.kind !== 'PROCEDURAL') return null;
    const v = row.value as { instruction?: string; trigger?: string; evidence?: string };
    if (!v?.instruction || !v?.trigger) return null;
    return {
        name: humanize(row.key),
        description: v.trigger,
        tier: 'read-only',
        content:
            `## Rule\n${v.instruction}\n\n` +
            `## When it applies\n${v.trigger}\n\n` +
            `## Why (evidence)\n${v.evidence || '(not recorded)'}\n\n` +
            `_Learned by the agent; promoted from procedural memory._`,
    };
}
