import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPrismaClient } from '@/lib/db/pg-config';
import { SlackWorkspaceLinkPostgresRepository } from './postgres';
import { SlackWorkspaceLinkConflictError } from './interface';

declare const __HAS_DB__: boolean;

// These tests require a local Postgres (docker compose up -d postgres) + migrations applied.
const repo = new SlackWorkspaceLinkPostgresRepository();
const prisma = getPrismaClient();

const TENANT_A = 'swl-test-tenant-a';
const TENANT_B = 'swl-test-tenant-b';

async function cleanup() {
    await prisma.slackWorkspaceLink.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
}

describe.skipIf(!__HAS_DB__)('SlackWorkspaceLinkPostgresRepository', () => {
    beforeAll(async () => {
        // vitest still invokes suite-level beforeAll/afterAll even when every
        // test in a skipIf'd describe is skipped — guard explicitly rather than
        // rely on skipIf alone to keep this suite DB-free by default.
        if (!__HAS_DB__) return;
        await cleanup();
        await prisma.tenant.createMany({
            data: [
                { id: TENANT_A, name: 'SWL Test Tenant A', slug: 'swl-test-tenant-a' },
                { id: TENANT_B, name: 'SWL Test Tenant B', slug: 'swl-test-tenant-b' },
            ],
            skipDuplicates: true,
        });
    });

    afterAll(async () => {
        if (!__HAS_DB__) return;
        await cleanup();
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    });

    beforeEach(cleanup);

    it('resolves the tenant that linked a given team_id', async () => {
        await repo.upsertLink({ teamId: 'T-A', tenantId: TENANT_A, botUserId: 'B-A' });
        expect(await repo.findTenantIdByTeamId('T-A')).toBe(TENANT_A);
    });

    it('returns null for an unlinked team_id', async () => {
        expect(await repo.findTenantIdByTeamId('T-UNKNOWN')).toBeNull();
    });

    it('upsertLink is idempotent for the same tenant', async () => {
        await repo.upsertLink({ teamId: 'T-A', tenantId: TENANT_A, botUserId: 'B-OLD' });
        await repo.upsertLink({ teamId: 'T-A', tenantId: TENANT_A, botUserId: 'B-NEW' });
        expect(await repo.findTenantIdByTeamId('T-A')).toBe(TENANT_A);
        expect((await repo.getLinkForTenant(TENANT_A))?.botUserId).toBe('B-NEW');
    });

    it('refuses to relink a team_id already owned by a different tenant', async () => {
        await repo.upsertLink({ teamId: 'T-SHARED', tenantId: TENANT_A });
        await expect(
            repo.upsertLink({ teamId: 'T-SHARED', tenantId: TENANT_B }),
        ).rejects.toThrow(SlackWorkspaceLinkConflictError);
        // Original link is untouched
        expect(await repo.findTenantIdByTeamId('T-SHARED')).toBe(TENANT_A);
    });

    it('getLinkForTenant returns null when the tenant has no link', async () => {
        expect(await repo.getLinkForTenant(TENANT_B)).toBeNull();
    });
});
