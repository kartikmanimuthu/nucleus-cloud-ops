import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDisconnect, PrismaClientMock } = vi.hoisted(() => {
    const mockDisconnect = vi.fn().mockResolvedValue(undefined);
    class PrismaClientMock {
        $disconnect = mockDisconnect;
        $extends(config: unknown) { return { __extendedWith: config }; }
        constructor(public opts: unknown) {}
    }
    return { mockDisconnect, PrismaClientMock };
});

vi.mock('@prisma/client', () => ({ PrismaClient: PrismaClientMock }));
vi.mock('@/env', () => ({ env: { NODE_ENV: 'test' } }));

import { env } from '@/env';
import {
    getPrismaClient, disconnectPrisma, getTenantClient, applyTenantScope, andWhere, TENANT_SCOPED_MODELS,
} from './pg-config';

beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).__prismaClient;
    (env as any).NODE_ENV = 'test';
});

describe('getPrismaClient', () => {
    it('creates and reuses a single client via the global in non-production', () => {
        const a = getPrismaClient();
        const b = getPrismaClient();
        expect(a).toBe(b);
        expect((a as any).opts).toEqual({ log: ['query', 'error', 'warn'] });
    });

    it('creates a fresh module-scoped client (not the dev global) in production, with error-only logging', () => {
        (env as any).NODE_ENV = 'production';
        const client = getPrismaClient();
        expect((client as any).opts).toEqual({ log: ['error'] });
        expect(globalThis.__prismaClient).toBeUndefined();
    });

    it('reuses the production client across calls without constructing a second one', () => {
        (env as any).NODE_ENV = 'production';
        const a = getPrismaClient();
        const b = getPrismaClient();
        expect(a).toBe(b);
    });
});

describe('disconnectPrisma', () => {
    it('disconnects the dev-global client when one exists', async () => {
        getPrismaClient(); // populates globalThis.__prismaClient
        await disconnectPrisma();
        expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it('disconnects the production module-scoped client when one exists', async () => {
        (env as any).NODE_ENV = 'production';
        getPrismaClient();
        await disconnectPrisma();
        expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it('does nothing when no client was ever created', async () => {
        // The production branch's `prismaClient` is a module-scoped `let` with no
        // exported reset — once another test creates it, it stays for the rest of
        // this file's run. Force a genuinely fresh module instance instead.
        vi.resetModules();
        const fresh = await import('./pg-config');
        await expect(fresh.disconnectPrisma()).resolves.toBeUndefined();
        expect(mockDisconnect).not.toHaveBeenCalled();
    });
});

describe('getTenantClient', () => {
    it('throws when tenantId is falsy — the whole point of the wrapper', () => {
        expect(() => getTenantClient('')).toThrow('getTenantClient: tenantId is required');
    });

    it('extends the singleton with a query middleware for all models/operations', () => {
        const client = getTenantClient('tenant-1') as any;
        expect(client.__extendedWith.query.$allModels.$allOperations).toBeTypeOf('function');
    });

    it('routes every operation through applyTenantScope before calling the underlying query', async () => {
        const client = getTenantClient('tenant-1') as any;
        const handler = client.__extendedWith.query.$allModels.$allOperations;
        const query = vi.fn().mockResolvedValue('result');

        const result = await handler({ model: 'Account', operation: 'findMany', args: { where: { active: true } }, query });

        expect(query).toHaveBeenCalledWith({ where: { active: true, tenantId: 'tenant-1' } });
        expect(result).toBe('result');
    });
});

describe('applyTenantScope', () => {
    const T = 'tenant-1';

    it('passes non-tenant-scoped models through untouched', () => {
        const args = { where: { id: 1 } };
        expect(applyTenantScope('AuthUser', 'findMany', args, T)).toBe(args);
    });

    it.each(['findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy'])(
        'injects tenantId into where on %s reads',
        (operation) => {
            const result = applyTenantScope('Account', operation, { where: { active: true } }, T);
            expect(result.where).toEqual({ active: true, tenantId: T });
        },
    );

    it('a caller-supplied where.tenantId cannot override the real tenant on a read', () => {
        const result = applyTenantScope('Account', 'findMany', { where: { tenantId: 'attacker-tenant' } }, T);
        expect(result.where.tenantId).toBe(T);
    });

    it('injects tenantId into data on create', () => {
        const result = applyTenantScope('Account', 'create', { data: { name: 'x' } }, T);
        expect(result.data).toEqual({ name: 'x', tenantId: T });
    });

    it('injects tenantId into every row of an array createMany', () => {
        const result = applyTenantScope('Account', 'createMany', { data: [{ name: 'a' }, { name: 'b' }] }, T);
        expect(result.data).toEqual([{ name: 'a', tenantId: T }, { name: 'b', tenantId: T }]);
    });

    it('injects tenantId into a single-object createMany payload', () => {
        const result = applyTenantScope('Account', 'createMany', { data: { name: 'a' } }, T);
        expect(result.data).toEqual({ name: 'a', tenantId: T });
    });

    it('scopes both where and create on upsert', () => {
        const result = applyTenantScope('Account', 'upsert', {
            where: { accountId: 'a1' }, create: { name: 'x' }, update: { name: 'y' },
        }, T);
        expect(result.where).toEqual({ accountId: 'a1', tenantId: T });
        expect(result.create).toEqual({ name: 'x', tenantId: T });
        expect(result.update).toEqual({ name: 'y' }); // update is untouched by upsert's own rewrite
    });

    it.each(['update', 'updateMany'])('scopes where and strips a client-supplied data.tenantId on %s', (operation) => {
        const result = applyTenantScope('Account', operation, {
            where: { id: 1 }, data: { name: 'renamed', tenantId: 'attacker-tenant' },
        }, T);
        expect(result.where).toEqual({ id: 1, tenantId: T });
        expect(result.data).toEqual({ name: 'renamed' });
        expect(result.data).not.toHaveProperty('tenantId');
    });

    it('leaves update data untouched when it carries no tenantId to strip', () => {
        const result = applyTenantScope('Account', 'update', { where: { id: 1 }, data: { name: 'x' } }, T);
        expect(result.data).toEqual({ name: 'x' });
    });

    it('leaves a non-object update data value untouched (no stripping attempted)', () => {
        const result = applyTenantScope('Account', 'updateMany', { where: { id: 1 }, data: undefined }, T);
        expect(result.data).toBeUndefined();
        expect(result.where).toEqual({ id: 1, tenantId: T });
    });

    it.each(['delete', 'deleteMany'])('injects tenantId into where on %s', (operation) => {
        const result = applyTenantScope('Account', operation, { where: { id: 1 } }, T);
        expect(result.where).toEqual({ id: 1, tenantId: T });
    });

    it('treats an undefined model name as not tenant-scoped (raw/$transaction calls)', () => {
        const args = { where: { id: 1 } };
        expect(applyTenantScope(undefined, 'findMany', args, T)).toBe(args);
    });
});

describe('andWhere', () => {
    it('returns base unchanged when there is no filter', () => {
        const base = { status: 'active' };
        expect(andWhere(base)).toBe(base);
        expect(andWhere(base, null)).toBe(base);
        expect(andWhere(base, {})).toBe(base);
    });

    it('nests a single filter under a new AND when base has none', () => {
        const result = andWhere({ status: 'active' }, { accountId: { in: ['a1'] } });
        expect(result).toEqual({ status: 'active', AND: [{ accountId: { in: ['a1'] } }] });
    });

    it('appends to an existing array AND without discarding prior conjuncts', () => {
        const result = andWhere({ status: 'active', AND: [{ a: 1 }, { b: 2 }] }, { c: 3 });
        expect(result.AND).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it('promotes a single existing AND object into an array alongside the new filter', () => {
        const result = andWhere({ status: 'active', AND: { a: 1 } }, { c: 3 });
        expect(result.AND).toEqual([{ a: 1 }, { c: 3 }]);
    });

    it('never lets the row filter displace an existing OR clause', () => {
        const base = { OR: [{ name: { contains: 'x' } }, { id: 'y' }] };
        const result = andWhere(base, { accountId: { in: ['a1'] } });
        expect(result.OR).toEqual(base.OR);
        expect(result.AND).toEqual([{ accountId: { in: ['a1'] } }]);
    });
});

describe('TENANT_SCOPED_MODELS', () => {
    it('deliberately excludes the nullable-tenantId RBAC registry tables', () => {
        for (const name of ['RbacModule', 'RbacAction', 'RbacSubject', 'RbacRoleRule', 'RbacGlobalVersion']) {
            expect(TENANT_SCOPED_MODELS.has(name)).toBe(false);
        }
    });

    it('includes RbacUserAttribute, whose tenantId is NOT NULL', () => {
        expect(TENANT_SCOPED_MODELS.has('RbacUserAttribute')).toBe(true);
    });

    it('excludes platform-level auth tables that are not tenant-owned', () => {
        for (const name of ['AuthUser', 'AuthAccount', 'AuthSession', 'VerificationToken']) {
            expect(TENANT_SCOPED_MODELS.has(name)).toBe(false);
        }
    });
});
