/**
 * provider-credentials.ts
 *
 * AES-256-GCM encryption for LLM provider credentials at rest. Mirrors the
 * chatbot project's EncryptionService. Secrets (apiKey / accessKeyId /
 * secretAccessKey / baseUrl) are stored as a single encrypted JSON blob in
 * ProviderModel.credentials; only `credentialsConfigured` + a masked hint are
 * ever returned to the client.
 *
 * Wire format: base64(iv).base64(authTag).base64(ciphertext)
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { env } from '@/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM

/** Decrypted credential bag. All fields optional — varies by provider type. */
export interface ProviderCredentials {
    apiKey?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    baseUrl?: string;
}

/**
 * Derives the 32-byte AES-256 key. Encryption is on by default with no extra
 * configuration: the key is derived (SHA-256) from NEXTAUTH_SECRET, which is a
 * required app secret. This makes encrypted credential storage the standard,
 * with no separate key to provision or manage.
 */
function getKey(): Buffer {
    const secret = env.NEXTAUTH_SECRET;
    return createHash('sha256').update(String(secret), 'utf8').digest();
}

/** Encrypts a credentials object into the wire format string. */
export function encryptCredentials(creds: ProviderCredentials): string {
    const key = getKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(creds), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** Decrypts a wire-format string back into a credentials object. */
export function decryptCredentials(payload: string): ProviderCredentials {
    const key = getKey();
    const parts = payload.split('.');
    if (parts.length !== 3) {
        throw new Error('Malformed encrypted credentials payload');
    }
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as ProviderCredentials;
}

/** Encrypts any JSON-serializable value into the wire format string. */
export function encryptJson<T>(value: T): string {
    const key = getKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** Decrypts a wire-format string produced by encryptJson back into a value. */
export function decryptJson<T>(payload: string): T {
    const key = getKey();
    const parts = payload.split('.');
    if (parts.length !== 3) throw new Error('Malformed encrypted payload');
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
}

/**
 * Produces a masked hint for a secret, e.g. "sk-…X9f2", for display in the UI
 * without revealing the full credential. Returns null when there is no secret.
 */
export function credentialHint(creds: ProviderCredentials | null | undefined): string | null {
    if (!creds) return null;
    const secret = creds.apiKey || creds.secretAccessKey || creds.accessKeyId;
    if (!secret) return null;
    if (secret.length <= 8) return `${'•'.repeat(Math.max(0, secret.length - 2))}${secret.slice(-2)}`;
    return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}
