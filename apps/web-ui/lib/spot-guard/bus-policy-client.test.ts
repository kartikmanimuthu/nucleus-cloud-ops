import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

import { getBoss } from '@/lib/boss-client';
import { requestBusPolicyReconcile } from './bus-policy-client';

describe('requestBusPolicyReconcile', () => {
    beforeEach(() => vi.clearAllMocks());

    it('enqueues a singleton reconcile job with the given reason', async () => {
        const send = vi.fn().mockResolvedValue(undefined);
        vi.mocked(getBoss).mockResolvedValue({ send } as any);

        requestBusPolicyReconcile('account-enabled');
        await new Promise((r) => setImmediate(r));

        expect(send).toHaveBeenCalledWith(
            'spot-guard-bus-policy-reconcile',
            { reason: 'account-enabled' },
            expect.objectContaining({ singletonKey: 'spot-guard-bus-policy', singletonSeconds: 30 }),
        );
    });

    it('never throws, even when the enqueue fails, and logs instead', async () => {
        vi.mocked(getBoss).mockRejectedValue(new Error('boss unavailable'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => requestBusPolicyReconcile('account-disabled')).not.toThrow();
        await new Promise((r) => setImmediate(r));

        expect(errSpy).toHaveBeenCalledWith(
            expect.stringContaining('account-disabled'),
            expect.any(Error),
        );
    });

    it('is fire-and-forget — returns before the enqueue promise settles', () => {
        let resolveBoss: () => void;
        vi.mocked(getBoss).mockReturnValue(new Promise((r) => { resolveBoss = () => r({ send: vi.fn() } as any); }));

        const result = requestBusPolicyReconcile('x');
        expect(result).toBeUndefined();
        resolveBoss!();
    });
});
