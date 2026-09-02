import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMongoAbility } from '@casl/ability';

vi.mock('@/lib/rbac/session-ability', () => ({
    getAbilityForSession: vi.fn(),
}));
vi.mock('@/lib/rbac/registry', () => ({
    loadRegistrySnapshot: vi.fn(),
}));

import { getAbilityForSession } from '@/lib/rbac/session-ability';
import { loadRegistrySnapshot } from '@/lib/rbac/registry';
import { GET } from './route';

const emptyRegistry = (tenantId: string) => ({
    tenantId,
    modules: [{ id: 'mod-1', key: 'inventory', label: 'Inventory', icon: null, navPath: '/inventory', enabled: true, sortOrder: 1 }],
    actions: [{ id: 'act-1', key: 'read', label: 'Read', aliasOfKey: null, isDangerous: false }],
    subjects: [{ id: 'subj-1', key: 'Account', label: 'Account', kind: 'resource', navPath: null, sortOrder: 1 }],
    subjectModules: [{ subjectId: 'subj-1', moduleId: 'mod-1' }],
    moduleActions: [{ moduleId: 'mod-1', actionId: 'act-1', grantable: true }],
    subjectAttributes: [],
    principalAttributes: [],
});

describe('GET /api/me/ability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 401 with no-store cache headers when unauthenticated', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(null);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(401);
        expect(body).toEqual({ success: false, error: 'Unauthenticated' });
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
        expect(loadRegistrySnapshot).not.toHaveBeenCalled();
    });

    it('returns 200 with packed rules, modules, actions, and subjects', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue({
            ability: createMongoAbility([{ action: 'read', subject: 'Account' }]),
            version: 'v1',
            principal: { tenantId: 'tenant-1', userId: 'u1', email: 'a@b.co', roleId: 'r1', roleName: 'Admin', level: 10, isSuperAdmin: false, attributes: {} },
            dropped: [],
        } as any);
        vi.mocked(loadRegistrySnapshot).mockResolvedValue(emptyRegistry('tenant-1') as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data.rules)).toBe(true);
        expect(body.data.version).toBe('v1');
        expect(body.data.modules).toEqual([
            { key: 'inventory', label: 'Inventory', icon: null, navPath: '/inventory', sortOrder: 1 },
        ]);
        expect(body.data.actions).toEqual([
            { key: 'read', label: 'Read', aliasOfKey: null, isDangerous: false },
        ]);
        expect(body.data.moduleActions).toEqual([{ moduleKey: 'inventory', actionKey: 'read' }]);
        expect(body.data.subjects).toEqual([
            { key: 'Account', label: 'Account', kind: 'resource', navPath: null, sortOrder: 1, moduleKey: 'inventory' },
        ]);
        expect(loadRegistrySnapshot).toHaveBeenCalledWith('tenant-1');
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('logs but does not fail the request when the compiler drops rules', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(getAbilityForSession).mockResolvedValue({
            ability: createMongoAbility([]),
            version: 'v1',
            principal: { tenantId: 'tenant-1', isSuperAdmin: false },
            dropped: [{ rule: 'bogus', reason: 'unknown subject' }],
        } as any);
        vi.mocked(loadRegistrySnapshot).mockResolvedValue(emptyRegistry('tenant-1') as any);

        const res = await GET();
        expect(res.status).toBe(200);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('rules dropped'),
            expect.stringContaining('unknown subject')
        );
        errorSpy.mockRestore();
    });

    it('omits disabled modules from the modules list', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue({
            ability: createMongoAbility([]),
            version: 'v1',
            principal: { tenantId: 'tenant-1', isSuperAdmin: false },
            dropped: [],
        } as any);
        const registry = emptyRegistry('tenant-1');
        registry.modules.push({ id: 'mod-2', key: 'disabled-mod', label: 'Off', icon: null, navPath: '/off', enabled: false, sortOrder: 2 } as any);
        vi.mocked(loadRegistrySnapshot).mockResolvedValue(registry as any);

        const res = await GET();
        const body = await res.json();

        expect(body.data.modules.map((m: any) => m.key)).toEqual(['inventory']);
    });

    it('returns 500 with no-store headers when loadRegistrySnapshot throws', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue({
            ability: createMongoAbility([]),
            version: 'v1',
            principal: { tenantId: 'tenant-1', isSuperAdmin: false },
            dropped: [],
        } as any);
        vi.mocked(loadRegistrySnapshot).mockRejectedValue(new Error('DB down'));

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body).toEqual({ success: false, error: 'Failed to load ability' });
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    });
});
