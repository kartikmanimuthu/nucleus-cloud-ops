/**
 * Property-based tests for verifySlackSignature
 *
 * **Validates: Requirements — HMAC-SHA256 verification**
 *
 * Property 1: Signature correctness
 *   For any (body, timestamp, secret) triple where timestamp is within 300s of now:
 *   - verifySlackSignature returns true  iff the signature was computed with the same secret
 *   - verifySlackSignature returns false when the signature was computed with a different secret
 */

import * as fc from 'fast-check';
import * as crypto from 'crypto';
import { describe, it, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: compute a valid Slack signature for a given (body, timestamp, secret)
// ---------------------------------------------------------------------------
function computeSignature(body: string, timestamp: string, secret: string): string {
    const sigBasestring = `v0:${timestamp}:${body}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(sigBasestring);
    return `v0=${hmac.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Helper: load a fresh module instance with a specific SLACK_SIGNING_SECRET
// ---------------------------------------------------------------------------
async function loadValidatorWithSecret(secret: string) {
    vi.resetModules();
    process.env.SLACK_SIGNING_SECRET = secret;
    const mod = await import('../../lib/agent-ops/slack-validator');
    return mod.verifySlackSignature;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A non-empty string used as a signing secret (alphanumeric, realistic length) */
const secretArb = fc.stringMatching(/^[a-f0-9]{8,64}$/);

/** Arbitrary URL-encoded body (printable ASCII, no control chars) */
const bodyArb = fc.string({ minLength: 0, maxLength: 500 });

/** Timestamp within ±290 seconds of now (safely inside the 300s window) */
const freshTimestampArb = fc.integer({ min: -290, max: 290 }).map(
    (offset) => String(Math.floor(Date.now() / 1000) + offset)
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifySlackSignature — Property 1: Signature correctness', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('returns true when signature is computed with the same secret', async () => {
        await fc.assert(
            fc.asyncProperty(bodyArb, freshTimestampArb, secretArb, async (body, timestamp, secret) => {
                const verifySlackSignature = await loadValidatorWithSecret(secret);
                const sig = computeSignature(body, timestamp, secret);
                return verifySlackSignature(body, timestamp, sig) === true;
            }),
            { numRuns: 100 }
        );
    });

    it('returns false when signature is computed with a different secret', async () => {
        await fc.assert(
            fc.asyncProperty(
                bodyArb,
                freshTimestampArb,
                secretArb,
                secretArb,
                async (body, timestamp, secret, wrongSecret) => {
                    // Ensure the two secrets are actually different
                    fc.pre(secret !== wrongSecret);

                    const verifySlackSignature = await loadValidatorWithSecret(secret);
                    const sigWithWrongSecret = computeSignature(body, timestamp, wrongSecret);
                    return verifySlackSignature(body, timestamp, sigWithWrongSecret) === false;
                }
            ),
            { numRuns: 100 }
        );
    });
});
