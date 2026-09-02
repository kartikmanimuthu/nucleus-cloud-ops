import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 'test-secret-value' } }));

import { env } from '@/env';
import { encryptCredentials, decryptCredentials, credentialHint } from './provider-credentials';

describe('encryptCredentials / decryptCredentials', () => {
    beforeEach(() => {
        (env as any).NEXTAUTH_SECRET = 'test-secret-value';
    });

    it('round-trips a full credentials object', () => {
        const creds = { apiKey: 'sk-abc123', accessKeyId: 'AKIA123', secretAccessKey: 'secret123', baseUrl: 'https://x.com' };
        const encrypted = encryptCredentials(creds);
        expect(decryptCredentials(encrypted)).toEqual(creds);
    });

    it('round-trips an empty credentials object', () => {
        const encrypted = encryptCredentials({});
        expect(decryptCredentials(encrypted)).toEqual({});
    });

    it('produces a 3-part dot-separated base64 wire format', () => {
        const encrypted = encryptCredentials({ apiKey: 'x' });
        const parts = encrypted.split('.');
        expect(parts).toHaveLength(3);
        parts.forEach((p) => expect(() => Buffer.from(p, 'base64')).not.toThrow());
    });

    it('produces different ciphertext for the same input on each call (random IV)', () => {
        const a = encryptCredentials({ apiKey: 'x' });
        const b = encryptCredentials({ apiKey: 'x' });
        expect(a).not.toBe(b);
    });

    it('throws on a malformed payload (wrong part count)', () => {
        expect(() => decryptCredentials('only.two')).toThrow('Malformed encrypted credentials payload');
        expect(() => decryptCredentials('one')).toThrow('Malformed encrypted credentials payload');
    });

    it('throws when the ciphertext has been tampered with (GCM auth tag mismatch)', () => {
        const encrypted = encryptCredentials({ apiKey: 'secret-value' });
        const [iv, tag, data] = encrypted.split('.');
        const tamperedData = Buffer.from(data, 'base64');
        tamperedData[0] ^= 0xff;
        const tampered = [iv, tag, tamperedData.toString('base64')].join('.');
        expect(() => decryptCredentials(tampered)).toThrow();
    });

    it('fails to decrypt with a different NEXTAUTH_SECRET than it was encrypted with', () => {
        const encrypted = encryptCredentials({ apiKey: 'x' });
        (env as any).NEXTAUTH_SECRET = 'a-completely-different-secret';
        expect(() => decryptCredentials(encrypted)).toThrow();
    });
});

describe('credentialHint', () => {
    it('returns null for null or undefined credentials', () => {
        expect(credentialHint(null)).toBeNull();
        expect(credentialHint(undefined)).toBeNull();
    });

    it('returns null when no secret field is present', () => {
        expect(credentialHint({ baseUrl: 'https://x.com' })).toBeNull();
    });

    it('masks a short secret (<= 8 chars), keeping only the last 2 characters visible', () => {
        expect(credentialHint({ apiKey: 'abcd12' })).toBe('••••12');
    });

    it('masks a long secret with a leading 3-char prefix and trailing 4-char suffix', () => {
        expect(credentialHint({ apiKey: 'sk-abcdef123456789' })).toBe('sk-…6789');
    });

    it('prefers apiKey over secretAccessKey and accessKeyId', () => {
        expect(credentialHint({ apiKey: 'apikey123456', secretAccessKey: 'secretkey123', accessKeyId: 'accesskey123' }))
            .toContain('api');
    });

    it('falls back to secretAccessKey, then accessKeyId, when apiKey is absent', () => {
        expect(credentialHint({ secretAccessKey: 'secretkey123' })).toContain('sec');
        expect(credentialHint({ accessKeyId: 'accesskey123' })).toContain('acc');
    });
});
