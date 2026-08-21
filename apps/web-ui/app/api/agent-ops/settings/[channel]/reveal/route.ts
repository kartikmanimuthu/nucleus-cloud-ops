/**
 * Channel secret reveal
 *
 * GET /api/agent-ops/settings/<channel>/reveal — returns the channel's plaintext
 * credentials for the settings form's eye toggle, and audits it at high severity.
 *
 * Split out of each channel's GET so that "look at the config" (`read`) and
 * "read the secrets back out" (`update`) stop sharing one method — see
 * lib/channels/secret-reveal.ts for the full rationale.
 *
 * `[channel]` is a dynamic segment sibling to the static slack/telegram/discord/
 * jira/webhook routes. Those stay exact-matched by Next's static-first
 * resolution; only the /reveal sub-path lands here, and the slug is validated
 * against REVEALABLE_CHANNELS before any lookup happens.
 */

import { revealChannelSecrets } from '@/lib/channels/secret-reveal';
import type { RouteAuthz } from '@nucleus/rbac';

/**
 * Layer 1 permission declaration. `update`, not `read`: handing back a plaintext
 * bot token is not a read of the settings page, it is the recovery of a
 * credential, and it is the same bar the old in-handler gate enforced.
 */
export const authz: RouteAuthz = {
    GET: { action: 'update', subject: 'Channel' },
};

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }) {
    const { channel } = await params;
    return revealChannelSecrets(channel);
}
