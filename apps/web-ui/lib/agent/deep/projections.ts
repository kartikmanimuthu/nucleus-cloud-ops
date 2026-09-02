/**
 * Structural types for the deepagents v3 stream projections.
 *
 * Extracted from app/api/chat/deep-stream.ts so the Agent Ops executor and the
 * AI Ops SSE translator describe the same handles instead of keeping two copies
 * that can drift. These are duck-typed against what streamEvents({version:'v3'})
 * yields — there is no runtime import from deepagents here.
 */
export type ToolCallStatus = 'running' | 'finished' | 'error';

export interface ToolCallHandle {
    readonly name: string;
    readonly callId: string;
    readonly input: unknown;
    readonly output: Promise<unknown>;
    readonly status: Promise<ToolCallStatus>;
    readonly error: Promise<string | undefined>;
}

/**
 * A type alias, not `interface TextStream extends AsyncIterable<string> {}` as it was
 * declared inline in deep-stream.ts: that form trips @typescript-eslint/no-empty-object-type.
 * Structurally identical.
 */
export type TextStream = AsyncIterable<string>;

export interface UsageLike { input_tokens?: number; output_tokens?: number }

export interface MessageHandle {
    readonly node?: string;
    readonly text: TextStream;
    readonly reasoning: TextStream;
    readonly usage: PromiseLike<UsageLike | undefined>;
}

export interface SubagentHandle {
    readonly name: string;
    readonly taskInput: PromiseLike<unknown>;
    readonly output: PromiseLike<unknown>;
    readonly toolCalls: AsyncIterable<ToolCallHandle>;
    readonly messages: AsyncIterable<MessageHandle>;
}

export interface DeepRun extends AsyncIterable<unknown> {
    readonly messages: AsyncIterable<MessageHandle>;
    readonly toolCalls: AsyncIterable<ToolCallHandle>;
    readonly subagents: AsyncIterable<SubagentHandle>;
    readonly values: AsyncIterable<Record<string, unknown>>;
    readonly interrupted: boolean;
}

/**
 * The four projections a consumer actually drains. `DeepRun` also carries the
 * top-level async-iterable and `interrupted`, neither of which a row/chunk
 * translator reads — accepting the narrower shape lets tests build a fake run
 * out of four async iterables with no casts.
 */
export type DeepProjections = Pick<DeepRun, 'messages' | 'toolCalls' | 'subagents' | 'values'>;
