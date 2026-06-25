/**
 * Builds a descriptive, developer-friendly error string for the chat client.
 *
 * The AI SDK turns an `{ type: "error", errorText }` UI-message-stream part into
 * `new Error(errorText)` on the client, and the chat UI renders `error.message`.
 * Previously the stream was torn down with `controller.error()`, which the SDK
 * surfaced as a generic "network error" — hiding the real backend failure.
 *
 * This formatter exposes the actual error: its name + message, plus the underlying
 * `cause` for wrapped SDK errors (e.g. Bedrock `ValidationException`), so developers
 * see the exact failure instead of a generic message.
 */
export function buildClientErrorText(error: unknown): string {
    if (error instanceof Error) {
        const head = error.name && error.name !== 'Error'
            ? `${error.name}: ${error.message}`
            : error.message;
        const parts: string[] = [head];

        const cause = (error as { cause?: unknown }).cause;
        if (cause) {
            const causeMsg = cause instanceof Error
                ? `${cause.name}: ${cause.message}`
                : String(cause);
            if (causeMsg && !head.includes(causeMsg)) {
                parts.push(`Cause: ${causeMsg}`);
            }
        }
        return parts.join(' — ');
    }
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return 'Unknown error';
    }
}
