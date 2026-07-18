// Pure helpers for useChatSession (and, temporarily, chat-interface.tsx's own
// copy of the same wiring — see use-chat-session.ts header comment). No React.

// The AI SDK surfaces HTTP failures as Error(message) where message is usually
// the raw response body — our API routes return `{"error":"..."}` — sometimes
// with surrounding text. Extract the human-readable server error when present.
export function extractServerErrorMessage(error: unknown): string | null {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.trim()) return null;
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
