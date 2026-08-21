/**
 * loadRegistrySnapshot's subjectModules merge (Finding C2, task-4 fix round).
 *
 * Every other snapshot list (modules/actions/subjects) already shadows global
 * rows via mergeByKey; subjectModules was passed through RAW. A tenant remap
 * therefore left the global link standing alongside the new tenant-local one,
 * and rule-compiler.ts — which has no orderBy on either fetch and no
 * deduplication of its own — bucketed the subject under BOTH modules.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    prisma: {
        rbacModule: { findMany: vi.fn().mockResolvedValue([]) },
        rbacAction: { findMany: vi.fn().mockResolvedValue([]) },
        rbacSubject: { findMany: vi.fn().mockResolvedValue([]) },
        rbacSubjectModule: { findMany: vi.fn() },
        rbacModuleAction: { findMany: vi.fn().mockResolvedValue([]) },
        rbacSubjectAttribute: { findMany: vi.fn().mockResolvedValue([]) },
        rbacPrincipalAttribute: { findMany: vi.fn().mockResolvedValue([]) },
    },
}));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => h.prisma }));

import { loadRegistrySnapshot } from './registry';

describe('loadRegistrySnapshot — subjectModules merge', () => {
    it('lets a tenant-local subject-module link shadow the global link for the same subject', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: null, subjectId: 's-spotguard', moduleId: 'm-sched' },
            { tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toHaveLength(1);
        expect(snapshot.subjectModules[0]).toEqual({ tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' });
    });

    it('keeps the global link when no tenant override exists', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: null, subjectId: 's-acc', moduleId: 'm-acc' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toEqual([{ tenantId: null, subjectId: 's-acc', moduleId: 'm-acc' }]);
    });

    it('is order-independent — the tenant link wins whichever row the query returns first', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' },
            { tenantId: null, subjectId: 's-spotguard', moduleId: 'm-sched' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toEqual([{ tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' }]);
    });

    it('keeps unrelated subjects as separate entries', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: null, subjectId: 's-spotguard', moduleId: 'm-sched' },
            { tenantId: null, subjectId: 's-acc', moduleId: 'm-acc' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toHaveLength(2);
    });
});
