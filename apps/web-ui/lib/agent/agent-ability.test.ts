import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildPrincipalForMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rbac/session-ability', () => ({ buildPrincipalFor: buildPrincipalForMock }));

const getAbilityForPrincipalMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rbac/ability-cache', () => ({ getAbilityForPrincipal: getAbilityForPrincipalMock }));

const findUniqueMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => ({ authUser: { findUnique: findUniqueMock } }) }));

import { resolveAgentAbility } from './agent-ability';

describe('resolveAgentAbility', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null when tenantId is missing', async () => {
        expect(await resolveAgentAbility(undefined, 'user-1')).toBeNull();
    });

    it('returns null when userId is missing', async () => {
        expect(await resolveAgentAbility('tenant-1', undefined)).toBeNull();
    });

    it('never dereferences the auth_users tenant client — reads the global user directly by id', async () => {
        findUniqueMock.mockResolvedValue({ email: 'a@b.co', isSuperAdmin: false });
        buildPrincipalForMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1' });
        getAbilityForPrincipalMock.mockResolvedValue({ ability: 'ability-obj', dropped: [], actionAliases: {} });

        await resolveAgentAbility('tenant-1', 'user-1');

        expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: { email: true, isSuperAdmin: true } });
    });

    it('builds the principal from the resolved user row, never trusting a caller-supplied role', async () => {
        findUniqueMock.mockResolvedValue({ email: 'admin@b.co', isSuperAdmin: true });
        buildPrincipalForMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1' });
        getAbilityForPrincipalMock.mockResolvedValue({ ability: 'ability-obj', dropped: [], actionAliases: {} });

        await resolveAgentAbility('tenant-1', 'user-1');

        expect(buildPrincipalForMock).toHaveBeenCalledWith({
            userId: 'user-1', email: 'admin@b.co', tenantId: 'tenant-1', roleName: null, isSuperAdmin: true,
        });
    });

    it('defaults email to empty string and isSuperAdmin to false when the user row is missing', async () => {
        findUniqueMock.mockResolvedValue(null);
        buildPrincipalForMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1' });
        getAbilityForPrincipalMock.mockResolvedValue({ ability: 'a', dropped: [], actionAliases: {} });

        await resolveAgentAbility('tenant-1', 'user-1');

        expect(buildPrincipalForMock).toHaveBeenCalledWith(
            expect.objectContaining({ email: '', isSuperAdmin: false }),
        );
    });

    it('returns null when the principal cannot be built', async () => {
        findUniqueMock.mockResolvedValue({ email: 'a@b.co', isSuperAdmin: false });
        buildPrincipalForMock.mockResolvedValue(null);

        expect(await resolveAgentAbility('tenant-1', 'user-1')).toBeNull();
        expect(getAbilityForPrincipalMock).not.toHaveBeenCalled();
    });

    it('returns the compiled ability, principal, and actionAliases on success', async () => {
        const principal = { userId: 'user-1', tenantId: 'tenant-1' };
        findUniqueMock.mockResolvedValue({ email: 'a@b.co', isSuperAdmin: false });
        buildPrincipalForMock.mockResolvedValue(principal);
        getAbilityForPrincipalMock.mockResolvedValue({ ability: 'ability-obj', dropped: [], actionAliases: { view: 'read' } });

        const result = await resolveAgentAbility('tenant-1', 'user-1');

        expect(result).toEqual({ ability: 'ability-obj', principal, actionAliases: { view: 'read' } });
    });

    it('logs but does not throw when rules were dropped during compilation', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        findUniqueMock.mockResolvedValue({ email: 'a@b.co', isSuperAdmin: false });
        buildPrincipalForMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1' });
        getAbilityForPrincipalMock.mockResolvedValue({ ability: 'a', dropped: [{ reason: 'bad condition' }], actionAliases: {} });

        const result = await resolveAgentAbility('tenant-1', 'user-1');

        expect(result).not.toBeNull();
        expect(errorSpy).toHaveBeenCalledWith('[AgentAbility] rules dropped during compilation:', expect.stringContaining('bad condition'));
        errorSpy.mockRestore();
    });

    it('never throws — returns null and logs when the compilation pipeline throws', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        findUniqueMock.mockRejectedValue(new Error('DB down'));

        const result = await resolveAgentAbility('tenant-1', 'user-1');

        expect(result).toBeNull();
        expect(errorSpy).toHaveBeenCalledWith('[AgentAbility] failed to compile agent ability:', expect.any(Error));
        errorSpy.mockRestore();
    });
});
