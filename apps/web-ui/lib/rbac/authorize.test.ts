import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn() }));
vi.mock('./permissions', () => ({ hasPermission: vi.fn(), hasCustomPermission: vi.fn() }));
vi.mock('./custom-role-service', () => ({ getCustomRolePermissions: vi.fn() }));
vi.mock('./session-ability', () => ({ getAbilityForSession: vi.fn() }));
vi.mock('./denials', () => ({ recordDenial: vi.fn().mockResolvedValue(undefined) }));

import { getAuthSession } from '@/lib/auth-session';
import { hasPermission, hasCustomPermission } from './permissions';
import { getCustomRolePermissions } from './custom-role-service';
import { getAbilityForSession } from './session-ability';
import { recordDenial } from './denials';
import { authorize, isAdmin, can, cannot } from './authorize';

function makeAbility(overrides: Partial<{ can: boolean; rule: any }> = {}) {
    return {
        can: vi.fn().mockReturnValue(overrides.can ?? true),
        relevantRuleFor: vi.fn().mockReturnValue(overrides.rule),
    };
}
function makeSessionAbility(ability: any, principalOverrides: Record<string, unknown> = {}) {
    return {
        ability,
        principal: { roleName: 'Owner', userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1', ...principalOverrides },
        dropped: [],
        actionAliases: {},
    };
}

const ORIGINAL_ENV = process.env.DYNAMIC_ABAC_ENABLED;

describe('authorize (shadow mode — legacy matrix decides)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.DYNAMIC_ABAC_ENABLED;
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co', tenantId: 'tenant-1', role: 'Owner' } } as any);
        vi.mocked(getAbilityForSession).mockResolvedValue(null);
    });
    afterEach(() => { process.env.DYNAMIC_ABAC_ENABLED = ORIGINAL_ENV; });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getAuthSession).mockResolvedValue(null as any);
        const res = await authorize('read', 'Account');
        expect(res?.status).toBe(401);
    });

    it('bypasses all checks for a SuperAdmin', async () => {
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', isSuperAdmin: true } } as any);
        const res = await authorize('delete', 'Account');
        expect(res).toBeNull();
    });

    it('allows when the legacy matrix grants a predefined role', async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        const res = await authorize('read', 'Account');
        expect(res).toBeNull();
    });

    it('denies (403) when the legacy matrix does not grant a predefined role', async () => {
        vi.mocked(hasPermission).mockReturnValue(false);
        const res = await authorize('delete', 'Account');
        expect(res?.status).toBe(403);
    });

    it('consults custom-role permissions for a non-predefined role', async () => {
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co', tenantId: 'tenant-1', role: 'custom-role-1' } } as any);
        vi.mocked(getCustomRolePermissions).mockResolvedValue({ Account: ['read'] } as any);
        vi.mocked(hasCustomPermission).mockReturnValue(true);

        const res = await authorize('read', 'Account');
        expect(getCustomRolePermissions).toHaveBeenCalledWith('custom-role-1', 'tenant-1');
        expect(res).toBeNull();
    });

    it('denies when a non-predefined role has no custom permissions row', async () => {
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', tenantId: 'tenant-1', role: 'unknown-role' } } as any);
        vi.mocked(getCustomRolePermissions).mockResolvedValue(null);

        const res = await authorize('read', 'Account');
        expect(res?.status).toBe(403);
    });

    it('returns 403 when the session carries no resolvable role at all', async () => {
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', tenantId: 'tenant-1', role: null } } as any);
        const res = await authorize('read', 'Account');
        expect(res?.status).toBe(403);
    });

    it('prefers the CASL-resolved roleName over the session role column when they diverge', async () => {
        // CASL says 'cloud-read' (grants nothing here); session.user.role says 'Owner' (would grant).
        // The FK-resolved name must win, so this should deny despite the legacy 'Owner' role column.
        const ability = makeAbility({ can: false });
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSessionAbility(ability, { roleName: 'cloud-read' }) as any);
        vi.mocked(hasCustomPermission).mockReturnValue(false);
        vi.mocked(getCustomRolePermissions).mockResolvedValue({} as any);

        const res = await authorize('delete', 'IAM');
        // role used for the legacy decision should be 'cloud-read', not 'Owner'
        expect(getCustomRolePermissions).toHaveBeenCalledWith('cloud-read', 'tenant-1');
        expect(res?.status).toBe(403);
    });
});

describe('authorize (dynamic ABAC — CASL decides)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.DYNAMIC_ABAC_ENABLED = 'true';
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co', tenantId: 'tenant-1', role: 'Owner' } } as any);
    });
    afterEach(() => { process.env.DYNAMIC_ABAC_ENABLED = ORIGINAL_ENV; });

    it('denies when no verdict can be computed (ability build failure)', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(null);
        const res = await authorize('read', 'Account');
        expect(res?.status).toBe(403);
    });

    it('allows when CASL grants the action', async () => {
        const ability = makeAbility({ can: true });
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSessionAbility(ability) as any);
        const res = await authorize('read', 'Account');
        expect(res).toBeNull();
    });

    it('denies and records the denial when CASL rejects the action', async () => {
        const ability = makeAbility({ can: false, rule: { reason: 'no grant for this role' } });
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSessionAbility(ability) as any);

        const res = await authorize('delete', 'Account');
        expect(res?.status).toBe(403);
        expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u1', tenantId: 'tenant-1', action: 'delete', subject: 'Account', reason: 'no grant for this role',
        }));
    });

    it('denies a conditional grant evaluated with no subject data (fail-closed)', async () => {
        const ability = makeAbility({ can: true, rule: { conditions: { accountId: 'x' } } });
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSessionAbility(ability) as any);

        const res = await authorize('update', 'Account'); // no third arg
        expect(res?.status).toBe(403);
    });

    it('allows a conditional grant when subject data is supplied and the rule passes', async () => {
        const ability = makeAbility({ can: true, rule: { conditions: { accountId: 'acc-1' } } });
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSessionAbility(ability) as any);

        const res = await authorize('update', 'Account', { accountId: 'acc-1' });
        expect(res).toBeNull();
    });

    it('resolves an aliased action through actionAliases before evaluating', async () => {
        const ability = makeAbility({ can: true });
        const sessionAbility = makeSessionAbility(ability);
        sessionAbility.actionAliases = { execute: 'update' };
        vi.mocked(getAbilityForSession).mockResolvedValue(sessionAbility as any);

        await authorize('execute', 'Schedule');
        expect(ability.can).toHaveBeenCalledWith('update', 'Schedule');
    });
});

describe('isAdmin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.DYNAMIC_ABAC_ENABLED;
    });
    afterEach(() => { process.env.DYNAMIC_ABAC_ENABLED = ORIGINAL_ENV; });

    it('returns false with no session', async () => {
        vi.mocked(getAuthSession).mockResolvedValue(null as any);
        expect(await isAdmin()).toBe(false);
    });

    it('returns true for a SuperAdmin', async () => {
        vi.mocked(getAuthSession).mockResolvedValue({ user: { isSuperAdmin: true } } as any);
        expect(await isAdmin()).toBe(true);
    });

    it('returns true for Owner and Admin, false for Member/Viewer (shadow mode)', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(null);
        vi.mocked(getAuthSession).mockResolvedValue({ user: { role: 'Owner' } } as any);
        expect(await isAdmin()).toBe(true);

        vi.mocked(getAuthSession).mockResolvedValue({ user: { role: 'Member' } } as any);
        expect(await isAdmin()).toBe(false);
    });

    it('prefers the ability-derived roleName over the session role column', async () => {
        const ability = makeAbility();
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSessionAbility(ability, { roleName: 'Member' }) as any);
        vi.mocked(getAuthSession).mockResolvedValue({ user: { role: 'Owner' } } as any);
        expect(await isAdmin()).toBe(false);
    });

    it('delegates to the CASL verdict when dynamic ABAC is enabled', async () => {
        process.env.DYNAMIC_ABAC_ENABLED = 'true';
        const ability = makeAbility({ can: true });
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', tenantId: 'tenant-1' } } as any);
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSessionAbility(ability) as any);
        expect(await isAdmin()).toBe(true);
    });
});

describe('can / cannot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.DYNAMIC_ABAC_ENABLED;
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', tenantId: 'tenant-1', role: 'Owner' } } as any);
        vi.mocked(getAbilityForSession).mockResolvedValue(null);
    });

    it('can() reflects an authorized action', async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        expect(await can('read', 'Account')).toBe(true);
    });

    it('cannot() reflects a denied action', async () => {
        vi.mocked(hasPermission).mockReturnValue(false);
        expect(await cannot('delete', 'Account')).toBe(true);
    });
});
