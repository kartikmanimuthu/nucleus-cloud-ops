/**
 * Unit tests for slack-validator.ts
 *
 * Requirements: Slack signature verification
 */

import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: compute a valid Slack signature
// ---------------------------------------------------------------------------
function computeSignature(body: string, timestamp: string, secret: string): string {
    const sigBasestring = `v0:${timestamp}:${body}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(sigBasestring);
    return `v0=${hmac.digest('hex')}`;
}

/** Returns a fresh timestamp (seconds) within the 5-minute window */
function freshTimestamp(): string {
    return String(Math.floor(Date.now() / 1000));
}

/** Returns a timestamp that is 6 minutes in the past (stale) */
function staleTimestamp(): string {
    return String(Math.floor(Date.now() / 1000) - 6 * 60);
}

// ---------------------------------------------------------------------------
// Helper: load a fresh module instance with a specific SLACK_SIGNING_SECRET
// ---------------------------------------------------------------------------
async function loadValidatorWithSecret(secret: string) {
    vi.resetModules();
    process.env.SLACK_SIGNING_SECRET = secret;
    const mod = await import('../../lib/agent-ops/slack-validator');
    return {
        verifySlackSignature: mod.verifySlackSignature,
        parseSlackSlashCommand: mod.parseSlackSlashCommand,
    };
}

const TEST_SECRET = 'abc123defsecret';
const TEST_BODY = 'token=test&command=%2Fcloud-ops&text=hello';

// ---------------------------------------------------------------------------
// verifySlackSignature
// ---------------------------------------------------------------------------

describe('verifySlackSignature', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('returns true for a valid signature', async () => {
        const { verifySlackSignature } = await loadValidatorWithSecret(TEST_SECRET);
        const ts = freshTimestamp();
        const sig = computeSignature(TEST_BODY, ts, TEST_SECRET);
        expect(verifySlackSignature(TEST_BODY, ts, sig)).toBe(true);
    });

    it('returns false for an invalid/wrong signature', async () => {
        const { verifySlackSignature } = await loadValidatorWithSecret(TEST_SECRET);
        const ts = freshTimestamp();
        const wrongSig = computeSignature(TEST_BODY, ts, 'wrong-secret');
        expect(verifySlackSignature(TEST_BODY, ts, wrongSig)).toBe(false);
    });

    it('returns false for a stale timestamp (> 5 minutes old)', async () => {
        const { verifySlackSignature } = await loadValidatorWithSecret(TEST_SECRET);
        const ts = staleTimestamp();
        const sig = computeSignature(TEST_BODY, ts, TEST_SECRET);
        expect(verifySlackSignature(TEST_BODY, ts, sig)).toBe(false);
    });

    it('returns false when SLACK_SIGNING_SECRET is missing (empty string)', async () => {
        const { verifySlackSignature } = await loadValidatorWithSecret('');
        const ts = freshTimestamp();
        // Even a correctly-computed signature should be rejected without a secret
        const sig = computeSignature(TEST_BODY, ts, TEST_SECRET);
        expect(verifySlackSignature(TEST_BODY, ts, sig)).toBe(false);
    });

    it('returns true for an empty body when signature matches', async () => {
        const { verifySlackSignature } = await loadValidatorWithSecret(TEST_SECRET);
        const ts = freshTimestamp();
        const emptyBody = '';
        const sig = computeSignature(emptyBody, ts, TEST_SECRET);
        expect(verifySlackSignature(emptyBody, ts, sig)).toBe(true);
    });

    it('returns false for an empty body when signature does not match', async () => {
        const { verifySlackSignature } = await loadValidatorWithSecret(TEST_SECRET);
        const ts = freshTimestamp();
        const wrongSig = computeSignature('non-empty', ts, TEST_SECRET);
        expect(verifySlackSignature('', ts, wrongSig)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// parseSlackSlashCommand
// ---------------------------------------------------------------------------

describe('parseSlackSlashCommand', () => {
    let parseSlackSlashCommand: (body: string) => import('../../lib/agent-ops/slack-validator').SlackSlashCommandPayload;

    beforeEach(async () => {
        const mod = await loadValidatorWithSecret(TEST_SECRET);
        parseSlackSlashCommand = mod.parseSlackSlashCommand;
    });

    it('round-trips all fields from a URL-encoded body', () => {
        const payload = {
            token: 'tok123',
            team_id: 'T0001',
            team_domain: 'example',
            channel_id: 'C0001',
            channel_name: 'general',
            user_id: 'U0001',
            user_name: 'alice',
            command: '/cloud-ops',
            text: 'deploy prod',
            response_url: 'https://hooks.slack.com/commands/abc',
            trigger_id: 'trig123',
        };

        const body = new URLSearchParams(payload).toString();
        const result = parseSlackSlashCommand(body);

        expect(result.token).toBe(payload.token);
        expect(result.team_id).toBe(payload.team_id);
        expect(result.team_domain).toBe(payload.team_domain);
        expect(result.channel_id).toBe(payload.channel_id);
        expect(result.channel_name).toBe(payload.channel_name);
        expect(result.user_id).toBe(payload.user_id);
        expect(result.user_name).toBe(payload.user_name);
        expect(result.command).toBe(payload.command);
        expect(result.text).toBe(payload.text);
        expect(result.response_url).toBe(payload.response_url);
        expect(result.trigger_id).toBe(payload.trigger_id);
    });

    it('handles text with spaces encoded as + (application/x-www-form-urlencoded)', () => {
        // Slack encodes spaces in text as +
        const body = 'text=deploy+to+production&token=tok';
        const result = parseSlackSlashCommand(body);
        expect(result.text).toBe('deploy to production');
    });

    it('handles response_url with special characters', () => {
        const responseUrl = 'https://hooks.slack.com/commands/T0001/123/abc%2Fxyz';
        const body = `response_url=${encodeURIComponent(responseUrl)}&token=tok`;
        const result = parseSlackSlashCommand(body);
        expect(result.response_url).toBe(responseUrl);
    });

    it('returns empty strings for missing fields', () => {
        const result = parseSlackSlashCommand('token=only');
        expect(result.team_id).toBe('');
        expect(result.text).toBe('');
        expect(result.response_url).toBe('');
        expect(result.trigger_id).toBe('');
    });
});
