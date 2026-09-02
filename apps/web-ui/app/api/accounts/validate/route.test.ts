import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/account-service', () => ({ AccountService: { validateCredentials: vi.fn() } }));

import { AccountService } from '@/lib/account-service';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/accounts/validate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 400 when roleArn is missing', async () => {
        const res = await POST(makeRequest({ region: 'us-east-1' }));
        expect(res.status).toBe(400);
        expect(AccountService.validateCredentials).not.toHaveBeenCalled();
    });

    it('returns 400 when region is missing', async () => {
        const res = await POST(makeRequest({ roleArn: 'arn:aws:iam::123:role/x' }));
        expect(res.status).toBe(400);
    });

    it('validates credentials and returns the result', async () => {
        vi.mocked(AccountService.validateCredentials).mockResolvedValue({ isValid: true, error: undefined } as any);

        const res = await POST(makeRequest({ roleArn: 'arn:aws:iam::123:role/x', externalId: 'ext-1', region: 'us-east-1' }));
        const body = await res.json();

        expect(AccountService.validateCredentials).toHaveBeenCalledWith({
            roleArn: 'arn:aws:iam::123:role/x', externalId: 'ext-1', region: 'us-east-1',
        });
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ isValid: true, error: undefined });
    });

    it('returns 500 when validation throws', async () => {
        vi.mocked(AccountService.validateCredentials).mockRejectedValue(new Error('STS error'));
        const res = await POST(makeRequest({ roleArn: 'arn:x', region: 'us-east-1' }));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('STS error');
    });
});
