import { describe, it, expect, beforeEach } from 'vitest';
import { SkillPostgresRepository } from './postgres';

// These tests require a local Postgres (docker compose up -d postgres) + migrations applied.
const repo = new SkillPostgresRepository();
const TENANT_A = 'test-tenant-a';
const TENANT_B = 'test-tenant-b';

async function cleanup() {
    for (const t of [TENANT_A, TENANT_B]) {
        const all = await repo.listByTenant(t, { includeDisabled: true });
        for (const s of all) await repo.remove(t, s.id);
    }
}

describe('SkillPostgresRepository', () => {
    beforeEach(cleanup);

    it('creates a skill and reads it back by slug', async () => {
        const created = await repo.create(TENANT_A, {
            slug: 'cost-analyser', name: 'Cost Analyser',
            description: 'Analyse AWS spend', tier: 'read-only',
            content: '# Cost Analyser\nSteps...', source: 'user', isEnabled: true,
            createdBy: 'user-1', sourceRunId: null,
        });
        expect(created.id).toBeTruthy();
        const fetched = await repo.getBySlug(TENANT_A, 'cost-analyser');
        expect(fetched?.name).toBe('Cost Analyser');
    });

    it('does NOT leak skills across tenants', async () => {
        await repo.create(TENANT_A, {
            slug: 'a-only', name: 'A', description: 'd', tier: 'read-only',
            content: 'x', source: 'user', isEnabled: true, createdBy: 'u', sourceRunId: null,
        });
        const fromB = await repo.getBySlug(TENANT_B, 'a-only');
        expect(fromB).toBeNull();
        const listB = await repo.listByTenant(TENANT_B);
        expect(listB.find(s => s.slug === 'a-only')).toBeUndefined();
    });

    it('listByTenant excludes disabled unless includeDisabled', async () => {
        await repo.create(TENANT_A, {
            slug: 'off', name: 'Off', description: 'd', tier: 'read-only',
            content: 'x', source: 'user', isEnabled: false, createdBy: 'u', sourceRunId: null,
        });
        expect((await repo.listByTenant(TENANT_A)).find(s => s.slug === 'off')).toBeUndefined();
        expect((await repo.listByTenant(TENANT_A, { includeDisabled: true })).find(s => s.slug === 'off')).toBeTruthy();
    });
});
