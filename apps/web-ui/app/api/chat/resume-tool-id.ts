// Pure helper for the approval-resume stream: map a LangGraph tool run back to
// the ORIGINAL tool_call_id from the pre-pause AIMessage, so the resumed stream
// updates the tool parts the client already rendered instead of creating
// duplicates keyed by run_id.

export interface ResumedPendingCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

/**
 * Resolve the original tool_call_id for a tool starting during an approval
 * resume.
 *
 * Candidates are the not-yet-consumed pending calls with a matching tool name:
 * - exactly one → use it;
 * - several → prefer the one whose args JSON-match the live input, else the
 *   first remaining (calls execute in order);
 * - none → fall back to `runId`.
 *
 * The chosen entry's id is added to `consumed` so two identical calls map to
 * distinct original ids.
 */
export function resolveResumedToolCallId(
    pendingCalls: ResumedPendingCall[],
    consumed: Set<string>,
    name: string,
    input: unknown,
    runId: string,
): string {
    const candidates = pendingCalls.filter(c => !consumed.has(c.id) && c.name === name);
    if (candidates.length === 0) return runId;

    let chosen = candidates[0];
    if (candidates.length > 1) {
        let inputJson: string | null = null;
        try {
            inputJson = JSON.stringify(input ?? {});
        } catch {
            inputJson = null;
        }
        if (inputJson !== null) {
            const argsMatch = candidates.find(c => {
                try {
                    return JSON.stringify(c.args ?? {}) === inputJson;
                } catch {
                    return false;
                }
            });
            if (argsMatch) chosen = argsMatch;
        }
    }
    consumed.add(chosen.id);
    return chosen.id;
}
