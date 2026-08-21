import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));

import { createAgentModels } from '@/lib/agent/model-factory';
import { translateEventTemplate, translateEventWithFallback } from './translate-event';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

function makeEvent(overrides: Partial<AgentOpsEvent> = {}): AgentOpsEvent {
    return { PK: '', SK: '', runId: 'run-1', eventType: 'tool_call', node: 'agent', createdAt: '', ttl: 0, ...overrides };
}

describe('translateEventTemplate', () => {
    it('maps a known tool name to a friendly phrase pair', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'execute_command' })))
            .toEqual({ active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' });
    });

    it('maps another known tool name', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'search_knowledge_base' })))
            .toEqual({ active: 'Searching the knowledge base...', done: 'Searched the knowledge base' });
    });

    // The whole point of the args-derived layer: without it every AWS action in the
    // product renders the same generic execute_command phrase.
    it('prefers an argument-derived phrase over the generic tool phrase', () => {
        const event = makeEvent({
            toolName: 'execute_command',
            toolArgs: { command: 'aws ec2 describe-instances --region ap-south-1' },
        });
        expect(translateEventTemplate(event))
            .toEqual({ active: 'Listing EC2 instances in ap-south-1...', done: 'Listed EC2 instances in ap-south-1' });
    });

    it('names the account on a credentials call when the run knows it', () => {
        const event = makeEvent({ toolName: 'get_aws_credentials', toolArgs: { accountId: '970547372609' } });
        expect(translateEventTemplate(event, 'STX-CLOUD-PLATFORM'))
            .toEqual({ active: 'Connecting to STX-CLOUD-PLATFORM...', done: 'Connected to STX-CLOUD-PLATFORM' });
    });

    it('falls back to the generic tool phrase when the args yield nothing better', () => {
        const event = makeEvent({ toolName: 'execute_command', toolArgs: { command: 'kubectl get pods' } });
        expect(translateEventTemplate(event))
            .toEqual({ active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' });
    });

    it('falls back to a known LangGraph node phrase when there is no tool name', () => {
        expect(translateEventTemplate(makeEvent({ toolName: undefined, node: 'planner' })))
            .toEqual({ active: 'Planning the approach...', done: 'Planned the approach' });
    });

    it('returns null for an unmapped tool and unmapped node', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' })))
            .toBeNull();
    });

    // Production-dominant path: an unmapped MCP tool must FALL THROUGH to the node
    // lookup, not short-circuit to null on the tool miss.
    it('falls through to the node phrase when the tool name is unmapped', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'mcp_custom_thing', node: 'generate' })))
            .toEqual({ active: 'Working on it...', done: 'Worked on it' });
    });

    it('templates the tools node so unmapped tool results cost no model call', () => {
        expect(translateEventTemplate(makeEvent({ eventType: 'tool_result', toolName: 'mcp_custom_thing', node: 'tools' })))
            .toEqual({ active: 'Finishing that step...', done: 'Finished that step' });
    });

    // toolName is tenant-controlled for MCP tools — a prototype-chain hit must not
    // leak "function Object() { [native code] }" into a channel.
    it('ignores prototype-chain properties in the tool and node maps', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'constructor', node: 'mystery_node' }))).toBeNull();
        expect(translateEventTemplate(makeEvent({ toolName: undefined, node: 'toString' }))).toBeNull();
        expect(translateEventTemplate(makeEvent({ toolName: undefined, node: 'valueOf' }))).toBeNull();
    });
});

describe('translateEventWithFallback', () => {
    beforeEach(() => vi.clearAllMocks());

    it('uses the template phrase without calling the model when one exists', async () => {
        const invoke = vi.fn();
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'execute_command' }), {} as any);

        expect(result).toEqual({ active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('uses an argument-derived phrase without calling the model', async () => {
        const invoke = vi.fn();
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const event = makeEvent({
            toolName: 'execute_command',
            toolArgs: { command: 'aws ec2 describe-addresses --region ap-south-1' },
        });
        const result = await translateEventWithFallback(event, {} as any);

        expect(result.done).toBe('Listed Elastic IPs in ap-south-1');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('calls the reflector model for an unmapped tool on an unmapped node', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'Running a custom check...' });
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' }), {} as any);

        // The model produces one label; there is no reliable second tense to derive.
        expect(result).toEqual({ active: 'Running a custom check...', done: 'Running a custom check...' });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    // Newer Bedrock/Claude models return an array of content blocks, not a string.
    // String(content) would render "[object Object]" straight into a user's chat.
    it('flattens an array-of-content-blocks model response', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Running a custom check...' }] });
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' }), {} as any);

        expect(result.active).toBe('Running a custom check...');
    });

    it('falls back to a generic phrase when the model returns empty text', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: '' });
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' }), {} as any);

        expect(result).toEqual({ active: 'Working on the task...', done: 'Worked on the task' });
    });

    it('falls back to a generic phrase when the model call throws', async () => {
        const invoke = vi.fn().mockRejectedValue(new Error('throttled'));
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' }), {} as any);

        expect(result).toEqual({ active: 'Working on the task...', done: 'Worked on the task' });
    });
});
