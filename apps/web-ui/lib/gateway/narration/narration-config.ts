// web-ui/lib/gateway/narration/narration-config.ts
import type { ChannelType } from '@/lib/gateway/types';

/**
 * Per-channel switch for the run narration checklist.
 *
 * A strict allowlist: only the channels named in NARRATION_CHANNELS narrate, and an
 * unset or empty value allows nothing. Deliberately unlike CHATBOT_PERSONA_CHANNELS,
 * where empty falls back to a default channel — narration has to be opted into, so
 * a missing variable can never turn it on somewhere unintended.
 *
 * NARRATION_CHANNELS=telegram        → checklist on Telegram; Slack keeps ack + result
 * NARRATION_CHANNELS=telegram,slack  → both
 * unset / empty                      → no channel narrates
 */
export function narrationEnabled(channelType: ChannelType): boolean {
    const allowlist = process.env.NARRATION_CHANNELS
        ?.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

    return !!allowlist?.includes(channelType);
}
