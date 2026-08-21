import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = new Map<string, { tenantId: string; namespace: string; key: string; value: unknown; createdAt: Date; updatedAt: Date }>();
const k = (t: string, n: string, key: string) => `${t}|${n}|${key}`;

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        agentFile: {
            upsert: async ({ where, create }: never) => {
                const w = (where as never as { tenantId_namespace_key: { tenantId: string; namespace: string; key: string } }).tenantId_namespace_key;
                rows.set(k(w.tenantId, w.namespace, w.key), { ...(create as object), createdAt: new Date(), updatedAt: new Date() } as never);
            },
            findUnique: async ({ where }: never) => {
                const w = (where as never as { tenantId_namespace_key: { tenantId: string; namespace: string; key: string } }).tenantId_namespace_key;
                return rows.get(k(w.tenantId, w.namespace, w.key)) ?? null;
            },
            findMany: async ({ where }: never) => {
                const w = where as never as { tenantId: string; namespace?: { startsWith?: string } };
                return [...rows.values()].filter(r => r.tenantId === w.tenantId && (!w.namespace?.startsWith || r.namespace.startsWith(w.namespace.startsWith)));
            },
            deleteMany: async ({ where }: never) => {
                const w = where as never as { tenantId: string; namespace: string; key: string };
                rows.delete(k(w.tenantId, w.namespace, w.key));
            },
        },
    }),
}));

describe('PostgresFileStore', () => {
    beforeEach(() => rows.clear());

    it('round-trips a file through put and get', async () => {
        const { PostgresFileStore } = await import('@/lib/agent/deep/file-store');
        const s = new PostgresFileStore('t1');
        await s.put(['deep-agent'], 'AGENTS.md', { content: '# Agent Memory' });
        expect((await s.get(['deep-agent'], 'AGENTS.md'))?.value).toEqual({ content: '# Agent Memory' });
    });

    it('isolates tenants — one tenant never reads another tenant file', async () => {
        const { PostgresFileStore } = await import('@/lib/agent/deep/file-store');
        await new PostgresFileStore('t1').put(['deep-agent'], 'AGENTS.md', { content: 'secret' });
        expect(await new PostgresFileStore('t2').get(['deep-agent'], 'AGENTS.md')).toBeNull();
    });

    it('deletes on a null value', async () => {
        const { PostgresFileStore } = await import('@/lib/agent/deep/file-store');
        const s = new PostgresFileStore('t1');
        await s.put(['deep-agent'], 'AGENTS.md', { content: 'x' });
        await s.delete(['deep-agent'], 'AGENTS.md');
        expect(await s.get(['deep-agent'], 'AGENTS.md')).toBeNull();
    });

    it('searches by namespace prefix', async () => {
        const { PostgresFileStore } = await import('@/lib/agent/deep/file-store');
        const s = new PostgresFileStore('t1');
        await s.put(['deep-agent'], 'AGENTS.md', { content: 'a' });
        await s.put(['deep-agent'], 'notes.md', { content: 'b' });
        expect((await s.search(['deep-agent'])).map(i => i.key).sort()).toEqual(['AGENTS.md', 'notes.md']);
    });
});

describe('FilesystemBackend jail', () => {
    it('must be constructed with virtualMode so absolute paths cannot escape the tenant root', async () => {
        const src = await import('fs/promises').then(fs => fs.readFile('lib/agent/deep-agent.ts', 'utf-8'));
        // virtualMode:false (the default) treats absolute paths as real host paths, which
        // would expose /tmp/nucleus-aws-creds/<otherTenant>/credentials and .env.
        expect(src).toContain('virtualMode: true');
    });
});
