import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/account-service', () => ({ AccountService: { scanResources: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { AccountService } from '@/lib/account-service';
import { GET } from './route';

const makeParams = (accountId: string) => ({ params: Promise.resolve({ accountId }) });
const makeRequest = () => ({ url: 'http://localhost/api/accounts/acc-1/scan' }) as any;

describe('GET /api/accounts/[accountId]/scan', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('scans resources scoped to the session tenant', async () => {
        vi.mocked(AccountService.scanResources).mockResolvedValue({ ec2: 3 } as any);

        const res = await GET(makeRequest(), makeParams('acc-1'));
        const body = await res.json();

        expect(AccountService.scanResources).toHaveBeenCalledWith('acc-1', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: { ec2: 3 } });
    });

    it('returns 500 when scanning fails', async () => {
        vi.mocked(AccountService.scanResources).mockRejectedValue(new Error('AssumeRole failed'));
        const res = await GET(makeRequest(), makeParams('acc-1'));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('AssumeRole failed');
    });
});
