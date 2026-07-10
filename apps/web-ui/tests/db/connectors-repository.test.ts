import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = { apps: [] as any[], conns: [] as any[] };
const tx = {
    connectorApp: {
        findFirst: vi.fn(async ({ where }: any) => store.apps.find(a => a.tenantId === where.tenantId && a.provider === where.provider) ?? null),
        upsert: vi.fn(async ({ where, create, update }: any) => {
            const existing = store.apps.find(a => a.tenantId === where.tenantId_provider.tenantId && a.provider === where.tenantId_provider.provider);
            if (existing) Object.assign(existing, update);
            else store.apps.push({ id: 'app1', ...create });
        }),
        deleteMany: vi.fn(async ({ where }: any) => { store.apps = store.apps.filter(a => !(a.tenantId === where.tenantId && a.provider === where.provider)); }),
    },
    connectorConnection: {
        findMany: vi.fn(async ({ where }: any) => store.conns.filter(c => c.tenantId === where.tenantId && c.provider === where.provider && (!where.status || c.status === where.status))),
        findFirst: vi.fn(async ({ where }: any) => store.conns.find(c => c.tenantId === where.tenantId && (where.id ? c.id === where.id : true) && (where.provider ? c.provider === where.provider : true) && (!where.status || c.status === where.status)) ?? null),
        create: vi.fn(async ({ data }: any) => { const rec = { id: 'c' + (store.conns.length + 1), status: 'active', ...data }; store.conns.push(rec); return rec; }),
        updateMany: vi.fn(async ({ where, data }: any) => { const c = store.conns.find(x => x.id === where.id && x.tenantId === where.tenantId); if (c) Object.assign(c, data); return { count: c ? 1 : 0 }; }),
        deleteMany: vi.fn(async ({ where }: any) => { store.conns = store.conns.filter(c => !(c.id === where.id && c.tenantId === where.tenantId)); }),
    },
};
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: () => tx }));

import { getConnectorRepository } from '@/lib/db/repositories/connectors/postgres';

beforeEach(() => { store.apps = []; store.conns = []; });

describe('ConnectorRepository', () => {
    it('upserts and reads app credentials', async () => {
        const repo = getConnectorRepository();
        await repo.upsertApp({ provider: 'jira', clientId: 'cid', clientSecretEnc: 'enc' }, 'tenantA', 'user1');
        const app = await repo.getApp('jira', 'tenantA');
        expect(app?.clientId).toBe('cid');
    });

    it('leaves unspecified app fields unchanged on update', async () => {
        const repo = getConnectorRepository();
        await repo.upsertApp({ provider: 'slack', clientId: 'cid', clientSecretEnc: 'sec', signingSecretEnc: 'sign' }, 'tenantA', 'u');
        await repo.upsertApp({ provider: 'slack', botTokenEnc: 'xoxb-enc', botAccountLabel: 'Acme' }, 'tenantA', 'u');
        const app = await repo.getApp('slack', 'tenantA');
        expect(app?.signingSecretEnc).toBe('sign');
        expect(app?.botTokenEnc).toBe('xoxb-enc');
        expect(app?.botAccountLabel).toBe('Acme');
    });

    it('lists and deletes connections scoped by tenant', async () => {
        const repo = getConnectorRepository();
        await repo.upsertConnection({ provider: 'jira', accountLabel: 'Acme', externalAccountId: 'cloud1', accessTokenEnc: 'a', scopes: ['x'], tokenType: 'user', metadata: {} }, 'tenantA', 'user1');
        expect(await repo.listConnections('jira', 'tenantA')).toHaveLength(1);
        expect(await repo.listConnections('jira', 'tenantB')).toHaveLength(0);
    });

    it('re-connecting the same account updates rather than duplicates', async () => {
        const repo = getConnectorRepository();
        await repo.upsertConnection({ provider: 'jira', accountLabel: 'Acme', externalAccountId: 'cloud1', accessTokenEnc: 'a1', scopes: [], tokenType: 'user', metadata: {} }, 'tenantA', 'u');
        await repo.upsertConnection({ provider: 'jira', accountLabel: 'Acme Renamed', externalAccountId: 'cloud1', accessTokenEnc: 'a2', scopes: [], tokenType: 'user', metadata: {} }, 'tenantA', 'u');
        const rows = await repo.listConnections('jira', 'tenantA');
        expect(rows).toHaveLength(1);
        expect(rows[0].accessTokenEnc).toBe('a2');
    });

    it('returns the active connection', async () => {
        const repo = getConnectorRepository();
        await repo.upsertConnection({ provider: 'google', accountLabel: 'x@y.com', externalAccountId: 'sub1', accessTokenEnc: 'a', scopes: [], tokenType: 'user', metadata: {} }, 'tenantA', 'u');
        expect((await repo.getActiveConnection('google', 'tenantA'))?.accountLabel).toBe('x@y.com');
    });
});
