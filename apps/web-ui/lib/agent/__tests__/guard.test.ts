import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createGuardNode, pendingToolCallsOf } from '@/lib/agent/guard';

const baseState = (messages: unknown[]) => ({ messages } as any);

const aiWithCalls = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) =>
    new AIMessage({ content: '', tool_calls: calls.map(c => ({ ...c, type: 'tool_call' as const })) });

const okRiskModel = {
    invoke: async () => ({
        content: JSON.stringify([{
            toolCallId: 't1', severity: 'HIGH',
            action: 'Terminates EC2 instance i-0abc', blastRadius: 'Instance destroyed',
            reversible: false, saferPath: 'Stop the instance instead',
        }]),
    }),
};

describe('pendingToolCallsOf', () => {
    it('returns only calls without an existing ToolMessage result', () => {
        const msgs = [
            new HumanMessage('do it'),
            aiWithCalls([{ id: 't1', name: 'execute_command', args: {} }, { id: 't2', name: 'read_file', args: {} }]),
            new ToolMessage({ tool_call_id: 't2', content: 'done' }),
        ];
        const pending = pendingToolCallsOf(baseState(msgs));
        expect(pending.map(c => c.id)).toEqual(['t1']);
    });
});

describe('guard node', () => {
    it('read-only calls get non-mutative verdicts without invoking the risk model', async () => {
        let invoked = false;
        const node = createGuardNode({ riskModel: { invoke: async () => { invoked = true; return { content: '[]' }; } } });
        const msgs = [aiWithCalls([{ id: 't1', name: 'get_aws_credentials', args: { accountId: 'x' } }])];
        const out = await node(baseState(msgs));
        expect(out.guardVerdicts!['t1'].isMutative).toBe(false);
        expect(invoked).toBe(false);
    });

    it('mutative calls get an LLM risk assessment', async () => {
        const node = createGuardNode({ riskModel: okRiskModel });
        const msgs = [aiWithCalls([{ id: 't1', name: 'execute_command', args: { command: 'aws ec2 terminate-instances --instance-ids i-0abc' } }])];
        const out = await node(baseState(msgs));
        const v = out.guardVerdicts!['t1'];
        expect(v.isMutative).toBe(true);
        expect(v.severity).toBe('HIGH');
        expect(v.reversible).toBe(false);
        expect(v.saferPath).toContain('Stop');
    });

    it('fail-closed: risk model failure yields HIGH severity mutative verdict', async () => {
        const node = createGuardNode({ riskModel: { invoke: async () => { throw new Error('throttled'); } } });
        const msgs = [aiWithCalls([{ id: 't1', name: 'execute_command', args: { command: 'aws s3 rm s3://x --recursive' } }])];
        const out = await node(baseState(msgs));
        expect(out.guardVerdicts!['t1'].severity).toBe('HIGH');
        expect(out.guardVerdicts!['t1'].isMutative).toBe(true);
    });

    it('ask_user calls get a non-mutative verdict (gate routing is the router\'s job)', async () => {
        const node = createGuardNode({ riskModel: okRiskModel });
        const msgs = [aiWithCalls([{ id: 't1', name: 'ask_user', args: { question: 'which one?' } }])];
        const out = await node(baseState(msgs));
        expect(out.guardVerdicts!['t1'].isMutative).toBe(false);
    });

    it('returns empty verdicts when the last message has no tool calls', async () => {
        const node = createGuardNode({ riskModel: okRiskModel });
        const out = await node(baseState([new AIMessage({ content: 'plain text' })]));
        expect(out.guardVerdicts).toEqual({});
    });

    it('unknown-named tool the LLM judges read-only gets a non-mutative verdict', async () => {
        const node = createGuardNode({
            riskModel: {
                invoke: async () => ({
                    content: JSON.stringify([{ toolCallId: 't1', mutative: false }]),
                }),
            },
        });
        const msgs = [aiWithCalls([{ id: 't1', name: 'mystery_mcp_tool', args: { foo: 'bar' } }])];
        const out = await node(baseState(msgs));
        const v = out.guardVerdicts!['t1'];
        expect(v.isMutative).toBe(false);
        expect(v.severity).toBe('LOW');
    });

    it('unknown-named tool fails closed HIGH when the risk model throws', async () => {
        const node = createGuardNode({ riskModel: { invoke: async () => { throw new Error('down'); } } });
        const msgs = [aiWithCalls([{ id: 't1', name: 'mystery_mcp_tool', args: {} }])];
        const out = await node(baseState(msgs));
        const v = out.guardVerdicts!['t1'];
        expect(v.isMutative).toBe(true);
        expect(v.severity).toBe('HIGH');
    });

    it('unknown-named tool fails closed HIGH when omitted from the LLM response array', async () => {
        const node = createGuardNode({ riskModel: { invoke: async () => ({ content: '[]' }) } });
        const msgs = [aiWithCalls([{ id: 't1', name: 'mystery_mcp_tool', args: {} }])];
        const out = await node(baseState(msgs));
        const v = out.guardVerdicts!['t1'];
        expect(v.isMutative).toBe(true);
        expect(v.severity).toBe('HIGH');
    });

    it('fails closed HIGH without throwing when the classifier itself throws', async () => {
        const node = createGuardNode({
            riskModel: okRiskModel,
            classifier: () => { throw new Error('boom'); },
        });
        const msgs = [aiWithCalls([{ id: 't1', name: 'read_file', args: {} }])];
        const result = await node(baseState(msgs));
        const v = result.guardVerdicts!['t1'];
        expect(v.isMutative).toBe(true);
        expect(v.severity).toBe('HIGH');
    });

    it('known-mutative call stays mutative even if the LLM reports mutative:false', async () => {
        const node = createGuardNode({
            riskModel: {
                invoke: async () => ({
                    content: JSON.stringify([{
                        toolCallId: 't1', mutative: false, severity: 'HIGH',
                        action: 'Terminates EC2 instance i-0abc', blastRadius: 'Instance destroyed',
                        reversible: false, saferPath: 'Stop the instance instead',
                    }]),
                }),
            },
        });
        const msgs = [aiWithCalls([{ id: 't1', name: 'execute_command', args: { command: 'aws ec2 terminate-instances --instance-ids i-0abc' } }])];
        const out = await node(baseState(msgs));
        const v = out.guardVerdicts!['t1'];
        expect(v.isMutative).toBe(true);
        expect(v.severity).toBe('HIGH');
    });

    it('parses the LLM refinement when the risk model returns block-array content (Claude Sonnet 5 shape)', async () => {
        const node = createGuardNode({
            riskModel: {
                invoke: async () => ({
                    content: [{
                        type: 'text',
                        text: JSON.stringify([{
                            toolCallId: 't1', mutative: true, severity: 'MEDIUM',
                            action: 'Stops instance', blastRadius: 'Downtime',
                            reversible: true, saferPath: '',
                        }]),
                    }],
                }),
            },
        });
        const msgs = [aiWithCalls([{ id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances --instance-ids i-0abc' } }])];
        const out = await node(baseState(msgs));
        const v = out.guardVerdicts!['t1'];
        expect(v.severity).toBe('MEDIUM');
    });
});
