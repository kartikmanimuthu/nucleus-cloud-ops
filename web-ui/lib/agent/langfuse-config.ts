/**
 * Langfuse observability wrapper for the LangGraph AI agent.
 *
 * Feature-flagged via LANGFUSE_ENABLED env var. When disabled (the default),
 * this module returns null immediately and never loads langfuse-langchain,
 * incurring zero overhead.
 *
 * Usage:
 *   const handler = await getLangfuseCallbackHandler(threadId, userId);
 *   const callbacks = handler ? [handler as any] : [];
 */

/**
 * Returns a configured Langfuse CallbackHandler, or null if:
 * - LANGFUSE_ENABLED !== "true"
 * - LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY are missing
 *
 * @param sessionId - Maps to Langfuse sessionId (use threadId for per-conversation tracing)
 * @param userId    - Optional user identifier from NextAuth session
 */
export async function getLangfuseCallbackHandler(
  sessionId: string,
  userId?: string
): Promise<object | null> {
  // Feature flag: disabled by default; requires explicit opt-in
  if (process.env.LANGFUSE_ENABLED !== "true") {
    return null;
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) {
    console.warn(
      "[Langfuse] LANGFUSE_ENABLED=true but LANGFUSE_PUBLIC_KEY or " +
        "LANGFUSE_SECRET_KEY is missing. Tracing disabled."
    );
    return null;
  }

  // Dynamic import: langfuse-langchain bundle is never loaded when the flag is off
  const { CallbackHandler } = await import("langfuse-langchain");

  const config: Record<string, string> = {
    publicKey,
    secretKey,
    sessionId,
  };

  if (process.env.LANGFUSE_HOST) {
    config.baseUrl = process.env.LANGFUSE_HOST;
  }

  if (userId) {
    config.userId = userId;
  }

  return new CallbackHandler(config);
}
