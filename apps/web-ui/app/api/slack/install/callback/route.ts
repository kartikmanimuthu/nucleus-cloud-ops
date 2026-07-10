/**
 * Slack Workspace-Bot Install — callback
 *
 * GET /api/slack/install/callback — verifies state + CSRF nonce, exchanges the
 * code for a bot token via oauth.v2.access, and stores it (encrypted) on the
 * tenant's Slack ConnectorApp. Redirects back to the Slack settings page.
 */
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { verifyState } from '@/lib/connectors/oauth-state';
import { exchangeSlackBot } from '@/lib/connectors/token-exchange';
import { resolveAppCredentials } from '@/lib/connectors/app-credentials';
import { encryptJson } from '@/lib/crypto/provider-credentials';

export async function GET(req: Request) {
    const origin = new URL(req.url).origin;
    const back = (q: string) => NextResponse.redirect(`${origin}/app/channels/slack-settings?${q}`);
    try {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const stateToken = url.searchParams.get('state');
        if (!code || !stateToken) throw new Error('Missing code/state');
        const state = verifyState(stateToken);
        if (state.provider !== 'slack') throw new Error('State provider mismatch');
        const cookieNonce = req.headers.get('cookie')?.match(/connector_install_nonce=([^;]+)/)?.[1];
        if (!cookieNonce || cookieNonce !== state.nonce) throw new Error('CSRF nonce mismatch');
        const repo = getConnectorRepository();
        const creds = await resolveAppCredentials('slack', state.tenantId);
        if (!creds) throw new Error('Slack app not configured');
        const result = await exchangeSlackBot(creds, code, `${origin}/api/slack/install/callback`);
        await repo.upsertApp({ provider: 'slack', botTokenEnc: encryptJson(result.botToken), botAccountLabel: result.teamName }, state.tenantId, 'user');
        const res = back('bot_installed=1');
        res.cookies.delete('connector_install_nonce');
        return res;
    } catch (err: unknown) {
        return back(`error=${encodeURIComponent(err instanceof Error ? err.message : 'install_failed')}`);
    }
}
