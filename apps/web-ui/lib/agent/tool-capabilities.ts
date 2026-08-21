/**
 * Agent tool -> capability requirement (Workstream H, Gate 4).
 *
 * The agent runs AS the requesting user, with that user's AWS credentials and
 * inside that user's tenant. Route-level authorization (Layers 1 and 2) covers
 * "may you open the chat"; it says nothing about "may the model then run a shell
 * command on the container". These rows close that gap: every tool in tools.ts is
 * mapped onto one of the five `kind: 'capability'` subjects seeded by
 * 20260730000000_dynamic_abac, all hanging off the AIOps module.
 *
 * Because the capability subjects belong to AIOps, the preset grants already
 * mean something sensible without anyone editing a role:
 *
 *   Viewer  AIOps:read            -> read AgentFile / AgentStorage / AgentWeb,
 *                                    use AgentMcp. NO execute_command, NO writes.
 *   Member  AIOps:create+read+update -> everything except delete-only actions.
 *   Owner   AIOps:*               -> everything.
 *
 * NOTE — aliases. `execute` and `use` are ALIAS actions in the registry
 * (`execute`->`update`, `use`->`read`). Rules compile to TERMINAL verbs, so a
 * check must translate through the `actionAliases` map the ability cache returns
 * before it reaches CASL. tool-gate.ts does that; do not call `ability.can()`
 * with a raw requirement from this file.
 */

export interface ToolCapability {
    /** Registry action key — may be an alias (`execute`, `use`). */
    action: string;
    /** Registry subject key — one of the five `capability` subjects. */
    subject: string;
}

/** MCP servers are dynamic, so their tools are matched by origin, not by name. */
export const MCP_CAPABILITY: ToolCapability = { action: 'use', subject: 'AgentMcp' };

/**
 * The built-in tools, keyed by the `name` given to `tool()` in tools.ts.
 *
 * A tool absent from this map is UNGATED. That is a deliberate, reviewed decision
 * per tool, not a default to fall into:
 *
 *   ask_user                  asks the human a question; it has no side effect and
 *                             gating it would strand a run at the approval gate.
 *   get_aws_credentials /     already tenant-scoped and separately audited; the
 *   list_aws_accounts         Account subject governs them at the route layer.
 *   search_knowledge_base /   read-only over rows the caller already reached
 *   get_right_sizing_*        through an authorized route.
 *   save_memory /             scoped to (tenantId, userId) by construction.
 *   search_memory
 *   load_skill                tenant-scoped, enabled-only catalog.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, ToolCapability>> = Object.freeze({
    // Shell — the single most dangerous capability the agent has.
    execute_command: { action: 'execute', subject: 'AgentShell' },

    // Local filesystem (inside the AGENT_WORKDIR jail).
    read_file: { action: 'read', subject: 'AgentFile' },
    ls: { action: 'read', subject: 'AgentFile' },
    glob: { action: 'read', subject: 'AgentFile' },
    grep: { action: 'read', subject: 'AgentFile' },
    write_file: { action: 'update', subject: 'AgentFile' },
    edit_file: { action: 'update', subject: 'AgentFile' },

    // Durable S3 scratch space. Writing is `create` (it produces a new object);
    // reading back is `read`.
    write_file_to_s3: { action: 'create', subject: 'AgentStorage' },
    get_file_from_s3: { action: 'read', subject: 'AgentStorage' },

    // Egress to the public internet.
    web_search: { action: 'read', subject: 'AgentWeb' },
});

/** Every capability subject this file can ask about. */
export const CAPABILITY_SUBJECTS = Object.freeze([
    'AgentShell',
    'AgentFile',
    'AgentStorage',
    'AgentWeb',
    'AgentMcp',
] as const);

/**
 * The requirement for a tool, or null when the tool is ungated.
 *
 * @param toolName the tool's `name`
 * @param isMcp    true for tools loaded from an MCP server (their names are
 *                 server-defined and cannot be enumerated here)
 */
export function capabilityForTool(toolName: string, isMcp = false): ToolCapability | null {
    if (isMcp) return MCP_CAPABILITY;
    return TOOL_CAPABILITIES[toolName] ?? null;
}
