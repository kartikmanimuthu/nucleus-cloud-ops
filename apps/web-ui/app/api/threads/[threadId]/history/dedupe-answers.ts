/**
 * Removes the duplicate answer a reloaded thread would otherwise show twice.
 *
 * finalNode promotes an already-composed deliverable by re-emitting it verbatim as
 * a 'final'-phase message. Live that copy never streams (promotion makes no model
 * call, and the route only emits text from on_chat_model_* events), so the reader
 * sees the answer once. Persistence has no such filter — both rows are stored — and
 * history replays 'execution' and 'final' alike, so the report appears twice.
 *
 * Dropping the LATER copy keeps the reloaded thread identical to the live view.
 * Matching is on text, not phase: a fragmented reasoning-model turn is stored as a
 * raw content-block array with no phase marker at all (route.ts only prefixes the
 * marker when content is a string), so the execution copy frequently has no phase
 * to match on. A genuine finalNode fallback answer differs from the execution text
 * and is therefore never dropped — which is what keeps "did promotion fire?"
 * readable from the transcript.
 */

type Part = { type: string; text?: string };
type Msg = { role: string; content?: string; parts?: Part[] };

/**
 * Same floor finalNode uses to decide a message is a deliverable. Below it, an
 * identical repeat is ordinary narration ("Now pulling CloudWatch metrics.") that
 * legitimately occurs twice in a run.
 */
const MIN_DUPLICATE_LENGTH = 800;

function answerText(m: Msg): string {
    const fromParts = (m.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
    return (fromParts || m.content || '').trim();
}

/** A turn that called tools is never a promoted copy — promotion emits text only. */
function hasToolParts(m: Msg): boolean {
    return (m.parts ?? []).some((p) => p.type === 'tool-invocation');
}

export function dropDuplicateAnswers<T extends Msg>(messages: T[]): T[] {
    const seen = new Set<string>();
    const kept: T[] = [];

    for (const msg of messages) {
        if (msg.role === 'assistant' && !hasToolParts(msg)) {
            const text = answerText(msg);
            if (text.length >= MIN_DUPLICATE_LENGTH) {
                if (seen.has(text)) continue;
                seen.add(text);
            }
        }
        kept.push(msg);
    }

    return kept;
}
