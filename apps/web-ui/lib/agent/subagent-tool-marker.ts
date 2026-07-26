/**
 * Identity marker for tools that are safe for a sub-agent BY THEIR OWN
 * IMPLEMENTATION rather than by what `classifyTool` says about their name.
 *
 * The sub-agent jail used to exempt any tool *named* `aws_read`. Remote MCP tool
 * names are kept UNPREFIXED (mcp-manager.ts), so a tenant-configured MCP server
 * exposing a tool called `aws_read` was waved straight through the fail-closed
 * jail — and, being last in `toolsByName`, it also shadowed the real tool. A name
 * is a claim; this marker is identity.
 *
 * A unique `Symbol()`, deliberately NOT `Symbol.for()`: a registered symbol can be
 * re-derived from its string key by anyone, and a marker anyone can mint is a name
 * again. A tool reconstructed from remote JSON cannot carry a symbol-keyed property
 * at all, which is the property that makes this unforgeable across the MCP boundary.
 *
 * Lives in its own dependency-free module so `subagent.ts` can check the marker
 * without importing `aws-read-tool.ts` (and through it `tools.ts`, the AWS SDK and
 * `@/env`) — and so a later `dispatch_agent` tool in `tools.ts` cannot close an
 * import cycle through it. `aws-read-tool.ts` re-exports it for convenience.
 */
export const SUBAGENT_READ_ONLY_TOOL: unique symbol = Symbol('nucleus.subagent.readOnlyTool');

/** Stamp the marker on a tool instance. Non-enumerable so it never lands in serialised tool specs. */
export function markSubagentReadOnlyTool<T extends object>(instance: T): T {
    Object.defineProperty(instance, SUBAGENT_READ_ONLY_TOOL, {
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return instance;
}

/** True only for an instance this process stamped. Never true for a plain `{ name: 'aws_read' }`. */
export function hasSubagentReadOnlyMarker(instance: unknown): boolean {
    return (
        (typeof instance === 'object' || typeof instance === 'function') &&
        instance !== null &&
        (instance as Record<symbol, unknown>)[SUBAGENT_READ_ONLY_TOOL] === true
    );
}
