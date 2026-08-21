/**
 * Capability gating for agent tools (Workstream H, Gate 4).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ OMISSION BEATS REFUSAL                                                   ║
 * ║                                                                          ║
 * ║ A tool the model can SEE but is refused is a tool the model will retry,  ║
 * ║ rephrase, and retry again — burning the reflection budget and ending the ║
 * ║ run with "I was blocked" instead of an answer. A tool that was never     ║
 * ║ bound to the model does not exist as far as the model is concerned, so   ║
 * ║ it plans around it from the first token.                                 ║
 * ║                                                                          ║
 * ║ So: an UNCONDITIONAL denial removes the tool from the bound set.         ║
 * ║ Refusal is reserved for the one case omission cannot express — a grant   ║
 * ║ that is CONDITIONAL, where whether the call is allowed depends on the    ║
 * ║ arguments and therefore cannot be decided until the model supplies them. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A conditional denial returns a STRUCTURED STRING, never a throw. Throwing out
 * of a LangGraph tool node aborts the run and loses the work already done; a
 * string comes back as a ToolMessage the model can read and reason about.
 *
 * Denials are capped at MAX_DENIALS_PER_RUN. Past the cap the tool stops
 * explaining itself and tells the model to stop, which is what actually breaks a
 * retry loop — and it stops writing audit rows, so a looping model cannot flood
 * the audit table (denials.ts samples per tenant; this caps per run).
 */

import { subject as tagSubject } from '@casl/ability';
import type { AbilityPrincipal, AppAbility } from '@nucleus/rbac';

import { recordDenial } from '@/lib/rbac/denials';

import { capabilityForTool, type ToolCapability } from './tool-capabilities';

/** Denials that produce a full explanation + an audit row, per assembled run. */
export const MAX_DENIALS_PER_RUN = 3;

/**
 * The slice of a LangChain tool this module needs. Deliberately structural: the
 * built-ins are DynamicStructuredTool and the MCP tools are whatever the MCP
 * adapter returns, and both satisfy this.
 */
export interface GateableTool {
    name: string;
    description?: string;
    schema?: unknown;
    invoke(input: unknown, config?: unknown): Promise<unknown>;
}

export interface ToolGateOptions {
    ability: AppAbility;
    principal: AbilityPrincipal;
    /** Action key -> terminal action, from the ability cache. */
    actionAliases: Record<string, string>;
    /** Names of tools that came from an MCP server (gated as `use AgentMcp`). */
    mcpToolNames?: ReadonlySet<string>;
}

export interface GateDecision {
    tool: string;
    requirement: ToolCapability;
    /** 'allow' — bind as-is · 'conditional' — bind wrapped · 'omit' — never bind. */
    verdict: 'allow' | 'conditional' | 'omit';
    reason?: string;
}

export interface ToolGateResult<T extends GateableTool> {
    tools: T[];
    /** One entry per GATED tool considered; ungated tools are not listed. */
    decisions: GateDecision[];
    omitted: string[];
}

function denialMessage(toolName: string, requirement: ToolCapability, roleName: string, reason?: string): string {
    return (
        `PERMISSION_DENIED: tool "${toolName}" requires '${requirement.action} ${requirement.subject}', ` +
        `which the role '${roleName || 'unknown'}' does not grant for these arguments.` +
        (reason ? ` Reason: ${reason}` : '') +
        ` Do not retry this tool with different arguments — the decision is about permissions, not phrasing.` +
        ` Continue using the tools you do have, and state plainly in your answer what you could not do and` +
        ` which permission would be needed.`
    );
}

function denialCapMessage(): string {
    return (
        `PERMISSION_DENIED_LIMIT: ${MAX_DENIALS_PER_RUN} permission denials have already occurred in this run.` +
        ` Stop calling permission-gated tools. Finish now with what you have and report the missing permissions.`
    );
}

/**
 * Builds a gate for one assembled tool set — i.e. for one run. The denial counter
 * lives in this closure, which is what makes the cap per-run rather than global.
 */
export function createToolGate(options: ToolGateOptions) {
    const { ability, principal, actionAliases, mcpToolNames } = options;

    let denials = 0;

    /** Rules compile to terminal verbs; `execute`/`use` must be translated first. */
    const resolve = (action: string): string => actionAliases[action] ?? action;

    /**
     * Assembly-time verdict, asked about the BARE subject type. CASL answers
     * "could this ever be allowed", so:
     *   false                 -> no rule at all       -> omit
     *   true, no conditions   -> unconditional grant  -> allow
     *   true, with conditions -> depends on arguments -> conditional (wrap)
     */
    function decide(toolName: string, requirement: ToolCapability): GateDecision {
        const action = resolve(requirement.action);
        const allowed = ability.can(action, requirement.subject as never);
        const rule = ability.relevantRuleFor(action, requirement.subject as never);

        if (!allowed) {
            return { tool: toolName, requirement, verdict: 'omit', reason: rule?.reason };
        }
        if (rule?.conditions) {
            return { tool: toolName, requirement, verdict: 'conditional', reason: rule.reason };
        }
        return { tool: toolName, requirement, verdict: 'allow' };
    }

    /**
     * Invocation-time verdict for a conditionally-granted tool. The tool's own
     * arguments become the subject instance the conditions evaluate against.
     * Returns a denial string, or null when the call may proceed.
     */
    function checkInvocation(
        toolName: string,
        requirement: ToolCapability,
        input: unknown,
        /**
         * The `reason` carried by the conditional rule found at assembly time.
         * Needed because once the arguments FAIL the condition no rule matches,
         * so relevantRuleFor() has nothing to return — and the rule's reason is
         * the only human explanation of why this call was refused.
         */
        fallbackReason?: string
    ): string | null {
        const action = resolve(requirement.action);
        const attributes = input && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        const target = tagSubject(requirement.subject, { tool: toolName, ...attributes });

        if (ability.can(action, target as never)) return null;

        denials += 1;
        if (denials > MAX_DENIALS_PER_RUN) return denialCapMessage();

        const reason = ability.relevantRuleFor(action, target as never)?.reason ?? fallbackReason;
        // Fire-and-forget: a failed audit write must not turn a clean denial into
        // a thrown tool error (recordDenial already swallows its own failures).
        void recordDenial({
            userId: principal.userId,
            email: principal.email,
            tenantId: principal.tenantId,
            roleName: principal.roleName,
            action: requirement.action,
            subject: requirement.subject,
            reason: reason ?? `agent tool '${toolName}'`,
        });

        return denialMessage(toolName, requirement, principal.roleName, reason);
    }

    /**
     * Wraps a conditionally-granted tool so the check runs with the model's
     * arguments in hand. The wrapper is a thin proxy over the original — same
     * name, description and schema — so the model sees no difference and the
     * RunnableConfig (which carries tenant_id / user_id) passes straight through.
     */
    function wrap<T extends GateableTool>(original: T, requirement: ToolCapability, reason?: string): T {
        const proxy = Object.create(original) as T;
        Object.defineProperty(proxy, 'invoke', {
            value: async (input: unknown, config?: unknown) => {
                const denial = checkInvocation(original.name, requirement, input, reason);
                if (denial) {
                    console.warn(`[ToolGate] denied '${original.name}' for role '${principal.roleName}'`);
                    return denial;
                }
                return original.invoke(input, config);
            },
            writable: true,
            configurable: true,
        });
        return proxy;
    }

    /** Applies the gate to an assembled tool list. */
    function filter<T extends GateableTool>(tools: T[]): ToolGateResult<T> {
        const decisions: GateDecision[] = [];
        const omitted: string[] = [];
        const kept: T[] = [];

        for (const t of tools) {
            const requirement = capabilityForTool(t.name, mcpToolNames?.has(t.name) ?? false);
            if (!requirement) {
                kept.push(t); // ungated by design — see tool-capabilities.ts
                continue;
            }

            const decision = decide(t.name, requirement);
            decisions.push(decision);

            if (decision.verdict === 'omit') {
                omitted.push(t.name);
                continue;
            }
            kept.push(decision.verdict === 'conditional' ? wrap(t, requirement, decision.reason) : t);
        }

        return { tools: kept, decisions, omitted };
    }

    return { filter, decide, checkInvocation, get denialCount() { return denials; } };
}

export type ToolGate = ReturnType<typeof createToolGate>;
