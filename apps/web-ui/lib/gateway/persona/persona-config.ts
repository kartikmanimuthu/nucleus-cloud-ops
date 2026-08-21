// web-ui/lib/gateway/persona/persona-config.ts
import type { ChannelType } from '@/lib/gateway/types';

/**
 * Only Telegram is safe by default: the direct-reply path makes two sequential
 * LLM calls before responding, and Slack slash commands / Discord interactions
 * both hard-fail at 3 seconds. Telegram's webhook has no such deadline.
 * CHATBOT_PERSONA_CHANNELS can widen this once an ack-then-deliver design lands.
 */
const DEFAULT_CHANNELS: ChannelType[] = ['telegram'];

/**
 * Default OFF (opt-in), unlike CHAT_TRIAGE_ENABLED's default-on kill-switch —
 * this is new and untested on live channels, so it dark-launches per channel.
 */
export function chatbotPersonaEnabled(channelType: ChannelType): boolean {
    const globalFlag = process.env.CHATBOT_PERSONA_ENABLED?.toLowerCase();
    if (globalFlag !== 'true' && globalFlag !== '1') return false;

    const configured = process.env.CHATBOT_PERSONA_CHANNELS
        ?.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    // An empty CHATBOT_PERSONA_CHANNELS means "unset", not "no channels" — it falls
    // back to the Telegram default. CHATBOT_PERSONA_ENABLED is the only off switch.
    const allowlist = configured?.length ? configured : DEFAULT_CHANNELS;
    return allowlist.includes(channelType);
}
