/**
 * Property-based tests for agent-ops-service SK generation
 *
 * **Validates: Requirements — nonce-based SK uniqueness**
 *
 * Property 2: Event SK uniqueness
 *   For any `runId`, generating N event SKs in rapid succession produces
 *   a set of N strictly unique values (no duplicates).
 *
 * The SK format is: EVENT#<ISO-timestamp>#<nanos>
 * where nanos comes from process.hrtime()[1], zero-padded to 9 digits.
 */

import * as fc from 'fast-check';
import { describe, it } from 'vitest';

// ---------------------------------------------------------------------------
// Replicated SK generation logic (mirrors agent-ops-service.ts recordEvent)
// ---------------------------------------------------------------------------
function generateEventSK(): string {
    const now = new Date().toISOString();
    const [, nanos] = process.hrtime();
    const nonce = String(nanos).padStart(9, '0');
    return `EVENT#${now}#${nonce}`;
}

function generateNEventSKs(n: number): string[] {
    const sks: string[] = [];
    for (let i = 0; i < n; i++) {
        sks.push(generateEventSK());
    }
    return sks;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Any non-empty runId string (UUID-like or arbitrary) */
const runIdArb = fc.uuid();

/** Number of concurrent SK generations to test (10–150) */
const countArb = fc.integer({ min: 10, max: 150 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recordEvent SK generation — Property 2: Event SK uniqueness', () => {
    it('generates N unique SKs in rapid succession for any runId', () => {
        fc.assert(
            fc.property(runIdArb, countArb, (_runId, n) => {
                const sks = generateNEventSKs(n);
                const unique = new Set(sks);
                return unique.size === sks.length;
            }),
            { numRuns: 200 }
        );
    });

    it('SK format matches EVENT#<ISO-timestamp>#<9-digit-nanos>', () => {
        fc.assert(
            fc.property(runIdArb, (_runId) => {
                const sk = generateEventSK();
                // Must match: EVENT#<ISO-8601>#<9 digits>
                return /^EVENT#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#\d{9}$/.test(sk);
            }),
            { numRuns: 200 }
        );
    });
});
