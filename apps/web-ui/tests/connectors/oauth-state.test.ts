import { describe, it, expect, vi } from 'vitest';
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 'state-secret' } }));
import { signState, verifyState } from '@/lib/connectors/oauth-state';

describe('oauth-state', () => {
    it('round-trips signed state', () => {
        const p = { tenantId: 't1', provider: 'jira', nonce: 'n1' };
        expect(verifyState(signState(p))).toEqual(p);
    });
    it('rejects tampered state', () => {
        const token = signState({ tenantId: 't1', provider: 'jira', nonce: 'n1' });
        const [body] = token.split('.');
        expect(() => verifyState(`${body}.deadbeef`)).toThrow();
    });
});
