/**
 * Slack Request Validator
 * 
 * Validates Slack webhook signatures using HMAC-SHA256.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */

import * as crypto from 'crypto';

const SLACK_TIMESTAMP_MAX_AGE = 5 * 60; // 5 minutes

export interface SlackSlashCommandPayload {
    token: string;
    team_id: string;
    team_domain: string;
    channel_id: string;
    channel_name: string;
    user_id: string;
    user_name: string;
    command: string;
    text: string;
    response_url: string;
    trigger_id: string;
}

/**
 * Verify the Slack request signature.
 *
 * @param body - Raw URL-encoded request body
 * @param timestamp - x-slack-request-timestamp header value
 * @param signature - x-slack-signature header value (v0=<hex>)
 * @param signingSecretOverride - Signing secret from DynamoDB; falls back to SLACK_SIGNING_SECRET env var
 */
export function verifySlackSignature(
    body: string,
    timestamp: string,
    signature: string,
    signingSecretOverride?: string
): boolean {
    const secret = signingSecretOverride || process.env.SLACK_SIGNING_SECRET || '';
    if (!secret) {
        console.error('[SlackValidator] Signing secret not configured (no DynamoDB value or SLACK_SIGNING_SECRET env var)');
        return false;
    }

    // Reject requests older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const requestTimestamp = parseInt(timestamp, 10);
    if (Math.abs(now - requestTimestamp) > SLACK_TIMESTAMP_MAX_AGE) {
        console.warn('[SlackValidator] Request too old:', { now, requestTimestamp });
        return false;
    }

    // Compute expected signature
    const sigBasestring = `v0:${timestamp}:${body}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(sigBasestring);
    const expectedSignature = `v0=${hmac.digest('hex')}`;

    // Timing-safe comparison
    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch {
        return false;
    }
}

/**
 * Parse a Slack slash command payload from URL-encoded form data.
 */
export function parseSlackSlashCommand(body: string): SlackSlashCommandPayload {
    const params = new URLSearchParams(body);
    return {
        token: params.get('token') || '',
        team_id: params.get('team_id') || '',
        team_domain: params.get('team_domain') || '',
        channel_id: params.get('channel_id') || '',
        channel_name: params.get('channel_name') || '',
        user_id: params.get('user_id') || '',
        user_name: params.get('user_name') || '',
        command: params.get('command') || '',
        text: params.get('text') || '',
        response_url: params.get('response_url') || '',
        trigger_id: params.get('trigger_id') || '',
    };
}
