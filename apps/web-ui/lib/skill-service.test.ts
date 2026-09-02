import { describe, it, expect, vi, beforeEach } from 'vitest';

const listByTenant = vi.fn();
const getBySlug = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({
    getSkillRepository: () => ({ listByTenant, getBySlug }),
}));

import { loadSkills, getSkillById, getSkillContent, loadAllSkillContent, slugify, getSkillSummaries } from './skill-service';

const rec = (over: Record<string, unknown> = {}) => ({
    id: 'cuid', tenantId: 't', slug: 'cost-analyser', name: 'Cost Analyser',
    description: 'Analyse spend', tier: 'read-only', content: '# body',
    source: 'user', isEnabled: true, createdBy: null, sourceRunId: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('skill-service', () => {
    beforeEach(() => { listByTenant.mockReset(); getBySlug.mockReset(); });

    it('loadSkills maps records to {id:slug,name,description,tier}', async () => {
        listByTenant.mockResolvedValue([rec(), rec({ slug: 'off', name: 'Off', isEnabled: false })]);
        const skills = await loadSkills('t');
        expect(skills).toHaveLength(1);
        expect(skills[0]).toEqual({ id: 'cost-analyser', name: 'Cost Analyser', description: 'Analyse spend', tier: 'read-only' });
    });

    it('getSkillById returns skill metadata by slug, or null when not found', async () => {
        getBySlug.mockResolvedValueOnce(rec());
        expect(await getSkillById('t', 'cost-analyser')).toEqual({
            id: 'cost-analyser', name: 'Cost Analyser', description: 'Analyse spend', tier: 'read-only',
        });
        getBySlug.mockResolvedValueOnce(null);
        expect(await getSkillById('t', 'missing')).toBeNull();
    });

    it('getSkillContent returns the markdown body or null', async () => {
        getBySlug.mockResolvedValueOnce(rec({ content: '# Hello' }));
        expect(await getSkillContent('t', 'cost-analyser')).toBe('# Hello');
        getBySlug.mockResolvedValueOnce(null);
        expect(await getSkillContent('t', 'missing')).toBeNull();
        getBySlug.mockResolvedValueOnce(rec({ isEnabled: false }));
        expect(await getSkillContent('t', 'disabled')).toBeNull();
    });

    it('loadAllSkillContent returns a slug→content Map', async () => {
        listByTenant.mockResolvedValue([rec({ slug: 'a', content: 'A' }), rec({ slug: 'b', content: 'B' }), rec({ slug: 'c', content: 'C', isEnabled: false })]);
        const map = await loadAllSkillContent('t');
        expect(map.get('a')).toBe('A');
        expect(map.get('b')).toBe('B');
        expect(map.has('c')).toBe(false);
    });

    it('getSkillSummaries renders a bulleted list', async () => {
        listByTenant.mockResolvedValue([rec()]);
        expect(await getSkillSummaries('t')).toContain('- cost-analyser: Cost Analyser - Analyse spend');
    });

    it('slugify lowercases and hyphenates', () => {
        expect(slugify('Cost Analyser 2!')).toBe('cost-analyser-2');
    });
});
