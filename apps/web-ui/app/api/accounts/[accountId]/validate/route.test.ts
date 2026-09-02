import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/account-service', () => ({ AccountService: { validateAccount: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { AccountService } from '@/lib/account-service';
import { POST } from './route';

const makeParams = (accountId: string) => ({ params: Promise.resolve({ accountId }) });

describe('POST /api/accounts/[accountId]/validate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST({} as any, makeParams('acc-1'));
        expect(res).toBe(authError);
        expect(AccountService.validateAccount).not.toHaveBeenCalled();
    });

    it('returns valid: true when connectionStatus is connected', async () => {
        vi.mocked(AccountService.validateAccount).mockResolvedValue({ connectionStatus: 'connected' } as any);

        const res = await POST({} as any, makeParams('acc-1'));
        const body = await res.json();

        expect(AccountService.validateAccount).toHaveBeenCalledWith('acc-1', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body.valid).toBe(true);
    });

    it('returns valid: false when connectionStatus is not connected', async () => {
        vi.mocked(AccountService.validateAccount).mockResolvedValue({ connectionStatus: 'failed' } as any);
        const res = await POST({} as any, makeParams('acc-1'));
        const body = await res.json();
        expect(body.valid).toBe(false);
    });

    it('returns 500 when validation throws', async () => {
        vi.mocked(AccountService.validateAccount).mockRejectedValue(new Error('AssumeRole failed'));
        const res = await POST({} as any, makeParams('acc-1'));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('AssumeRole failed');
    });
});
