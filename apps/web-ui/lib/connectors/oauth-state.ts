/**
 * oauth-state.ts
 *
 * HMAC-signed OAuth `state` parameter. Carries the initiating tenant + a nonce
 * across the provider round-trip; the nonce is cross-checked against an
 * httpOnly cookie in the callback (CSRF). Signature uses NEXTAUTH_SECRET.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '@/env';

export interface OAuthStatePayload { tenantId: string; provider: string; nonce: string; }

function sign(body: string): string {
    return createHmac('sha256', String(env.NEXTAUTH_SECRET)).update(body).digest('base64url');
}

export function signState(payload: OAuthStatePayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body)}`;
}

export function verifyState(token: string): OAuthStatePayload {
    const [body, sig] = token.split('.');
    if (!body || !sig) throw new Error('Invalid OAuth state');
    const expected = Buffer.from(sign(body));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error('Invalid OAuth state');
    }
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
}
