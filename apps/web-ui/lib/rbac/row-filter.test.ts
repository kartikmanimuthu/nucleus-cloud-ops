import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./prisma-filter', () => ({ readFilterFor: vi.fn(), UntranslatableFilterError: class UntranslatableFilterError extends Error {} }));
vi.mock('./session-ability', () => ({ getAbilityForSession: vi.fn() }));

import { readFilterFor, UntranslatableFilterError } from './prisma-filter';
import { getAbilityForSession } from './session-ability';
import { getReadRowFilter } from './row-filter';

const ORIGINAL_ENV = process.env.DYNAMIC_ABAC_ENABLED;

function makeSession(overrides: Record<string, unknown> = {}) {
    return { ability: {}, principal: { isSuperAdmin: false, roleName: 'Owner', ...overrides } };
}

describe('getReadRowFilter (shadow mode)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.DYNAMIC_ABAC_ENABLED;
    });
    afterEach(() => { process.env.DYNAMIC_ABAC_ENABLED = ORIGINAL_ENV; });

    it('returns null when there is no session', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(null);
        expect(await getReadRowFilter('Account')).toBeNull();
    });

    it('returns null for a SuperAdmin without walking the filter', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession({ isSuperAdmin: true }) as any);
        expect(await getReadRowFilter('Account')).toBeNull();
        expect(readFilterFor).not.toHaveBeenCalled();
    });

    it('computes but never applies the filter — always returns null', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession() as any);
        vi.mocked(readFilterFor).mockReturnValue({ accountId: { in: ['a1'] } } as any);
        expect(await getReadRowFilter('Account')).toBeNull();
        expect(readFilterFor).toHaveBeenCalled();
    });

    it('swallows an untranslatable-filter error and returns null', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession() as any);
        vi.mocked(readFilterFor).mockImplementation(() => { throw new UntranslatableFilterError('cannot translate'); });
        expect(await getReadRowFilter('Account')).toBeNull();
    });
});

describe('getReadRowFilter (dynamic ABAC enforcing)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.DYNAMIC_ABAC_ENABLED = 'true';
    });
    afterEach(() => { process.env.DYNAMIC_ABAC_ENABLED = ORIGINAL_ENV; });

    it('denies all rows when there is no session (fail-closed)', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(null);
        expect(await getReadRowFilter('Account')).toEqual({ OR: [] });
    });

    it('returns null for a SuperAdmin', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession({ isSuperAdmin: true }) as any);
        expect(await getReadRowFilter('Account')).toBeNull();
    });

    it('returns the translated filter when it narrows the result set', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession() as any);
        vi.mocked(readFilterFor).mockReturnValue({ accountId: { in: ['a1'] } } as any);
        expect(await getReadRowFilter('Account')).toEqual({ accountId: { in: ['a1'] } });
    });

    it('returns null when the translated filter is empty (no narrowing)', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession() as any);
        vi.mocked(readFilterFor).mockReturnValue({} as any);
        expect(await getReadRowFilter('Account')).toBeNull();
    });

    it('throws on an untranslatable filter (fail-closed — the route 500s)', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession() as any);
        const err = new UntranslatableFilterError('cannot translate');
        vi.mocked(readFilterFor).mockImplementation(() => { throw err; });
        await expect(getReadRowFilter('Account')).rejects.toThrow(err);
    });

    it('re-throws a non-UntranslatableFilterError from readFilterFor', async () => {
        vi.mocked(getAbilityForSession).mockResolvedValue(makeSession() as any);
        vi.mocked(readFilterFor).mockImplementation(() => { throw new Error('unexpected'); });
        await expect(getReadRowFilter('Account')).rejects.toThrow('unexpected');
    });
});
