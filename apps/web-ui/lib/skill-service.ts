import { getSkillRepository } from '@/lib/db/repository-factory';
import type { SkillTier } from '@/lib/db/repositories/skill/interface';

export interface SkillMetadata {
    id: string; // == slug
    name: string;
    description: string;
    tier: SkillTier;
}

export function slugify(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export async function loadSkills(tenantId: string): Promise<SkillMetadata[]> {
    const rows = await getSkillRepository().listByTenant(tenantId);
    return rows.filter((s) => s.isEnabled).map((s) => ({ id: s.slug, name: s.name, description: s.description, tier: s.tier }));
}

export async function getSkillById(tenantId: string, slug: string): Promise<SkillMetadata | null> {
    const s = await getSkillRepository().getBySlug(tenantId, slug);
    return s ? { id: s.slug, name: s.name, description: s.description, tier: s.tier } : null;
}

export async function getSkillContent(tenantId: string, slug: string): Promise<string | null> {
    const s = await getSkillRepository().getBySlug(tenantId, slug);
    return s && s.isEnabled ? s.content : null;
}

export async function loadAllSkillContent(tenantId: string): Promise<Map<string, string>> {
    const rows = await getSkillRepository().listByTenant(tenantId);
    return new Map(rows.filter((s) => s.isEnabled).map((s) => [s.slug, s.content]));
}

export async function getSkillSummaries(tenantId: string): Promise<string> {
    const skills = await loadSkills(tenantId);
    if (skills.length === 0) return 'No specialized skills available.';
    const summaries = skills.map((s) => `- ${s.id}: ${s.name} - ${s.description}`).join('\n');
    return `Available Skills:\n${summaries}`;
}
