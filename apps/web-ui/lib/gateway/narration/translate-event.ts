import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createAgentModels } from '@/lib/agent/model-factory';
import { contentToText, type ResolvedModelConfig } from '@/lib/agent/agent-shared';
import { describeToolCall } from './describe-step';
import type { StepPhrase } from './checklist';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

// The agent's real tool catalog (lib/agent/tools.ts + the per-domain tool files).
// These are the generic fallbacks: describe-step.ts names a call from its arguments
// first, since AWS work all goes through execute_command and the tool name alone
// says nothing. Anything outside both (notably per-tenant MCP tools) falls back to
// a cheap model call rather than leaking a raw tool name.
const TOOL_PHRASES: Record<string, StepPhrase> = {
    execute_command: { active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' },
    ls: { active: 'Listing files...', done: 'Listed files' },
    read_file: { active: 'Reading a file...', done: 'Read a file' },
    write_file: { active: 'Writing a file...', done: 'Wrote a file' },
    edit_file: { active: 'Editing a file...', done: 'Edited a file' },
    glob: { active: 'Searching for files...', done: 'Searched for files' },
    grep: { active: 'Searching file contents...', done: 'Searched file contents' },
    web_search: { active: 'Searching the web...', done: 'Searched the web' },
    write_file_to_s3: { active: 'Uploading the report to S3...', done: 'Uploaded the report to S3' },
    get_file_from_s3: { active: 'Fetching a file from S3...', done: 'Fetched a file from S3' },
    ask_user: { active: 'Waiting on your input...', done: 'Got your input' },
    get_aws_credentials: { active: 'Connecting to the AWS account...', done: 'Connected to the AWS account' },
    list_aws_accounts: { active: 'Listing connected AWS accounts...', done: 'Listed connected AWS accounts' },
    get_right_sizing_recommendations: {
        active: 'Reviewing right-sizing recommendations...',
        done: 'Reviewed right-sizing recommendations',
    },
    search_knowledge_base: { active: 'Searching the knowledge base...', done: 'Searched the knowledge base' },
    load_skill: { active: 'Loading a specialized skill...', done: 'Loaded a specialized skill' },
};

// Real LangGraph node names (see agent-executor.ts mapNodeToEventType).
//
// `tools` carries the bulk of fall-through traffic: a tool_result is emitted with
// node 'tools' (agent-executor.ts:548, node || toolName), so every invocation of an
// unmapped per-tenant MCP tool would otherwise cost a reflector round trip. Its
// phrase must read as a COMPLETED step, since that is what a tool result is.
//
// `agent`, `evaluator`, `final`, `approval_gate` and `clarification` are unreachable
// under today's topology — `agent` lives only in fast-agent.ts (Agent Ops runs use
// executor-graphs.ts); `evaluator`/`final` only ever emit non-step-boundary event
// types; `approval_gate`/`clarification` are written with agentOpsService.recordEvent
// directly and so never reach the gateway bus. Retained deliberately: graph topology
// changes, and a stale template is cheaper than a silent LLM call.
const NODE_PHRASES: Record<string, StepPhrase> = {
    planner: { active: 'Planning the approach...', done: 'Planned the approach' },
    generate: { active: 'Working on it...', done: 'Worked on it' },
    agent: { active: 'Working on it...', done: 'Worked on it' },
    reflect: { active: 'Double-checking the results...', done: 'Double-checked the results' },
    revise: { active: 'Refining the approach...', done: 'Refined the approach' },
    tools: { active: 'Finishing that step...', done: 'Finished that step' },
    evaluator: { active: 'Assessing the request...', done: 'Assessed the request' },
    final: { active: 'Wrapping up...', done: 'Wrapped up' },
    // Waiting is a state, not an action — it reads the same either way.
    approval_gate: { active: 'Waiting for your approval...', done: 'Waiting for your approval' },
    clarification: { active: 'Waiting on your answer...', done: 'Waiting on your answer' },
};

const GENERIC_PHRASE: StepPhrase = { active: 'Working on the task...', done: 'Worked on the task' };

// toolName is tenant-controlled for MCP tools, so both lookups must be own-property
// checks — a tool named `constructor` would otherwise return Object off the prototype
// chain and post "function Object() { [native code] }" into a user's channel.
export function translateEventTemplate(event: AgentOpsEvent, accountName?: string): StepPhrase | null {
    const described = describeToolCall(event, accountName);
    if (described) return described;
    if (event.toolName && Object.hasOwn(TOOL_PHRASES, event.toolName)) return TOOL_PHRASES[event.toolName];
    if (Object.hasOwn(NODE_PHRASES, event.node)) return NODE_PHRASES[event.node];
    return null;
}

export async function translateEventWithFallback(
    event: AgentOpsEvent,
    model: ResolvedModelConfig,
    accountName?: string,
): Promise<StepPhrase> {
    try {
        const templated = translateEventTemplate(event, accountName);
        if (templated) return templated;

        const { reflector } = createAgentModels(model);
        const resp = await reflector.invoke([
            new SystemMessage('Rewrite this internal agent step as one short, friendly sentence for a non-technical user. No jargon, no code, no tool names. Max 12 words.'),
            new HumanMessage(`tool: ${event.toolName ?? 'none'}, node: ${event.node}, detail: ${(event.content ?? '').slice(0, 500)}`),
        ]);
        // The model gets one shot at a label, so there is no reliable second form
        // to tense-shift into — the same text serves both states.
        const text = contentToText(resp.content).trim();
        return text ? { active: text, done: text } : GENERIC_PHRASE;
    } catch {
        return GENERIC_PHRASE;
    }
}
