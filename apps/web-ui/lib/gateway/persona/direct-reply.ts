// web-ui/lib/gateway/persona/direct-reply.ts
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createAgentModels } from '@/lib/agent/model-factory';
import { buildDirectSystemPrompt } from '@/lib/agent/prompt-templates';
import { contentToText, type ResolvedModelConfig } from '@/lib/agent/agent-shared';

/**
 * Channel-specific addendum to the shared direct prompt. The shared prompt is
 * written for web chat, where a "confirm or elaborate" follow-up gets re-triaged
 * with conversation history. Channels have neither history nor a pending run, so
 * a bare "yes go ahead" would arrive as its own incoherent task.
 */
const CHANNEL_REPLY_ADDENDUM = `## Channel Delivery

This reply goes out over a chat channel (Telegram/Slack), not the web UI:

- Plain text only — no markdown. Asterisks, underscores and backticks are escaped and render literally.
- Two or three short sentences at most; longer replies are truncated mid-word.
- Never offer to run something pending confirmation, and never end on a yes/no question. This turn keeps no history, so a reply of "yes" cannot be acted on. If the request needs live data or an action, ask the user to send the complete request as a single message.`;

/**
 * One-shot conversational reply for gateway channels: no tools, no memory
 * recall, no graph — a single plain model call. Mirrors the web chat's
 * direct-chat responder, minus the AI SDK streaming wrapper channels can't use.
 *
 * No conversation history is passed, and none is needed: on the gateway path a
 * message arriving during an active conversation is already routed to
 * handleResume by parseInbound, so anything reaching here is a fresh turn.
 */
export async function generateDirectReply(params: {
    message: string;
    model: ResolvedModelConfig;
}): Promise<string> {
    const { main } = createAgentModels(params.model);
    const resp = await main.invoke([
        new SystemMessage(`${buildDirectSystemPrompt()}\n\n${CHANNEL_REPLY_ADDENDUM}`),
        new HumanMessage(params.message.slice(0, 4000)),
    ]);

    const text = contentToText(resp.content).trim();
    // Throwing is the right signal here, not a fallback string. contentToText
    // yields '' for null content or a thinking-only block array; returning that
    // would make the caller ack with nothing sent and no run created, silently
    // eating the user's message. The caller fails open to the normal task path.
    if (!text) throw new Error('Direct reply model returned empty content');
    return text;
}
