import { buildInterruptParts, DataPart } from '@/app/api/chat/stream-parts';
import type { PlanStep, ReflectionState } from '@/lib/agent/agent-shared';

export interface ThreadRunState {
    plan: PlanStep[] | null;
    pendingInterrupt: { parts: DataPart[] } | null;
}

/**
 * Derives the live plan + parked-interrupt state for a thread from its raw
 * checkpoint channel_values, WITHOUT compiling a graph.
 *
 * Why this is safe (and not "silently always empty"):
 * LangGraph's `graph.getState().next` is computed by `_prepareNextTasks`
 * (see node_modules/@langchain/langgraph/dist/pregel/algo.js `candidateNodes`),
 * which needs the compiled graph's node/trigger-channel map — that topology
 * genuinely does not exist on the raw checkpoint tuple (no `channel_versions`
 * or `pendingWrites` field encodes "next node name"). So deriving `next`
 * from the tuple alone (this file's original approach) is not possible without
 * either (a) reimplementing Pregel's task-matching against a hardcoded copy of
 * the graph topology (fragile, drifts silently when nodes/edges change), or
 * (b) compiling a throwaway graph just to call `getState()` (heavy, and needs
 * a resolved model/provider config that may not be available to this route).
 *
 * Instead we use `pendingToolCallsOf` (via `buildInterruptParts`), which is
 * already the single source of truth the guard node / gate routers / the
 * `/api/chat` resume handler use for "is there a pending decision" — it looks
 * at whether the last AIMessage has tool_calls with no matching ToolMessage.
 * Verified against the graph topology (fast-agent.ts, planning-agent.ts):
 * `approval_gate` is the ONLY node reachable while tool_calls are still
 * unresolved — every terminal/finalize node in both graphs always appends a
 * clean AIMessage with no tool bindings before the graph can stop running,
 * and `ask_user` calls are themselves routed through guard -> approval_gate
 * like any other tool call. So for a thread that is not currently executing,
 * "last AIMessage has unresolved tool_calls" is equivalent to "parked at
 * approval_gate" — there is no other way to end up in that state at rest.
 *
 * Limitation: a thread killed mid-tool-execution (process crash between the
 * tools node dispatching a call and its ToolMessage being written) would also
 * read as pending here, even though nothing is actually waiting on user input.
 * This is acceptable: the pending-decision card simply lets the user re-decide
 * (approve/deny again), which is a safe, idempotent action to surface.
 */
export function extractThreadRunState(
    channelValues: Partial<ReflectionState> | undefined,
    threadId: string,
): ThreadRunState {
    const plan = Array.isArray(channelValues?.plan) && channelValues!.plan!.length > 0
        ? channelValues!.plan!
        : null;

    const parts = buildInterruptParts(
        { messages: channelValues?.messages ?? [], guardVerdicts: channelValues?.guardVerdicts ?? {} },
        threadId,
    );
    const pendingInterrupt = parts.length > 0 ? { parts } : null;

    return { plan, pendingInterrupt };
}
