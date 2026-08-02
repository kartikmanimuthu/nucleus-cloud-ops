// Pure helpers for useChatSession (and, temporarily, chat-interface.tsx's own
// copy of the same wiring — see use-chat-session.ts header comment). No React.

// The AI SDK surfaces HTTP failures as Error(message) where message is usually
// the raw response body — our API routes return `{"error":"..."}` — sometimes
// with surrounding text. Extract the human-readable server error when present.
/**
 * AI SDK stream-protocol violations ("text-delta for missing text part", bad
 * chunk ordering, …). These are internal invariants, not something the user can
 * act on from the raw wording — and the run's progress IS saved server-side, so
 * point them at the recovery path instead of the protocol internals.
 */
const STREAM_PROTOCOL_ERROR =
  /missing text part|text-(start|delta|end)" chunk|invalid chunk order/i;

export function extractServerErrorMessage(error: unknown): string | null {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.trim()) return null;
  if (STREAM_PROTOCOL_ERROR.test(message)) {
    return "The live stream was interrupted by a protocol error. The run's progress is saved — reload the thread to see its current state.";
  }
  const jsonMatch = message.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Not JSON — fall through to the raw message.
    }
  }
  return message.trim();
}
