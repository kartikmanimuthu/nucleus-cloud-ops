import { describe, it, expect, vi } from 'vitest';

vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 'test-secret-for-crypto' } }));

import { encryptJson, decryptJson } from '@/lib/crypto/provider-credentials';

describe('encryptJson/decryptJson', () => {
    it('round-trips an object', () => {
        const value = { accessToken: 'xoxb-123', scopes: ['a', 'b'] };
        const enc = encryptJson(value);
        expect(enc).not.toContain('xoxb-123');
        expect(enc.split('.')).toHaveLength(3);
        expect(decryptJson<typeof value>(enc)).toEqual(value);
    });

    it('round-trips a bare string', () => {
        const enc = encryptJson('secret-string');
        expect(decryptJson<string>(enc)).toBe('secret-string');
    });

    it('rejects a tampered payload', () => {
        const enc = encryptJson({ a: 1 });
        const [iv, tag] = enc.split('.');
        const tampered = [iv, tag, Buffer.from('zzzz').toString('base64')].join('.');
        expect(() => decryptJson(tampered)).toThrow();
    });
});
