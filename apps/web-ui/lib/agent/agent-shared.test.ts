import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

const mockEnv = vi.hoisted(() => ({ LLM_AUDIT: undefined as string | undefined, AWS_REGION: undefined as string | undefined, NEXT_PUBLIC_AWS_REGION: undefined as string | undefined }));
vi.mock('@/env', () => ({ env: mockEnv }));

const mcpManagerMocks = vi.hoisted(() => ({
    connectServers: vi.fn().mockResolvedValue(undefined),
    connectServerWithAwsCredentials: vi.fn().mockResolvedValue('scoped-id-1'),
}));
vi.mock('./mcp-manager', () => ({
    getMCPManager: vi.fn(() => mcpManagerMocks),
    tenantScopedKey: vi.fn((tenantId: string, serverId: string) => `${tenantId}:${serverId}`),
}));

const createMCPToolsMock = vi.hoisted(() => vi.fn().mockReturnValue(['tool-a']));
vi.mock('./mcp-tools', () => ({
    createMCPTools: createMCPToolsMock,
    getMCPToolsDescription: vi.fn().mockReturnValue(''),
}));

const mcpConfigMocks = vi.hoisted(() => ({
    mergeConfigs: vi.fn(),
    resolveEnabledServerIds: vi.fn(),
    DEFAULT_MCP_SERVERS: [] as any[],
}));
vi.mock('./mcp-config', () => mcpConfigMocks);

const tenantConfigMock = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock('../tenant-config-service', () => ({ TenantConfigService: tenantConfigMock }));

const assumeRoleMock = vi.hoisted(() => vi.fn());
vi.mock('./aws-credentials-tool', () => ({ assumeRoleForAccount: assumeRoleMock }));

const accountServiceMock = vi.hoisted(() => ({ getAccount: vi.fn() }));
vi.mock('../account-service', () => ({ AccountService: accountServiceMock }));

vi.mock('./persistence', () => ({
    getCheckpointer: vi.fn().mockResolvedValue('checkpointer-instance'),
    getMemoryStore: vi.fn().mockResolvedValue('store-instance'),
}));

import {
    extractTextContent,
    contentToText,
    critiqueVerdict,
    buildToolExecutionLog,
    computeReflectionStall,
    truncateOutput,
    truncateForReview,
    isToolResultError,
    tagMessagePhase,
    tagMessageAsDeliverable,
    findRenderedDeliverable,
    getRecentMessages,
    sanitizeMessagesForBedrock,
    withUnresolvedToolCallsOnly,
    llmAuditLog,
    getActiveMCPTools,
    getCheckpointer,
    getStore,
    isOpenAICompatibleProvider,
} from './agent-shared';

describe('agent-shared', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnv.LLM_AUDIT = undefined;
        mockEnv.AWS_REGION = undefined;
        mockEnv.NEXT_PUBLIC_AWS_REGION = undefined;
        mcpManagerMocks.connectServers.mockResolvedValue(undefined);
        mcpManagerMocks.connectServerWithAwsCredentials.mockResolvedValue('scoped-id-1');
        createMCPToolsMock.mockReturnValue(['tool-a']);
        mcpConfigMocks.mergeConfigs.mockReturnValue([]);
        mcpConfigMocks.resolveEnabledServerIds.mockReturnValue([]);
    });

    describe('isOpenAICompatibleProvider', () => {
        it('returns true for an OpenAI-compatible provider and false for bedrock', () => {
            expect(isOpenAICompatibleProvider('openai')).toBe(true);
            expect(isOpenAICompatibleProvider('bedrock')).toBe(false);
        });
    });

    describe('extractTextContent', () => {
        it('returns empty string for null/undefined', () => {
            expect(extractTextContent(null)).toBe('');
            expect(extractTextContent(undefined)).toBe('');
        });
        it('returns a string as-is', () => {
            expect(extractTextContent('hello')).toBe('hello');
        });
        it('joins text blocks from an array, skipping non-text blocks', () => {
            expect(extractTextContent([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }])).toBe('ab');
        });
        it('handles a plain string inside the array', () => {
            expect(extractTextContent(['x', { type: 'text', text: 'y' }])).toBe('xy');
        });
        it('stringifies a plain object that is neither string nor array', () => {
            expect(extractTextContent({ foo: 'bar' })).toBe('{"foo":"bar"}');
        });
        it('String()-converts a non-object primitive like a number', () => {
            expect(extractTextContent(42)).toBe('42');
        });
    });

    describe('contentToText', () => {
        it('returns a string unchanged', () => {
            expect(contentToText('hi')).toBe('hi');
        });
        it('joins array blocks with a .text field', () => {
            expect(contentToText([{ text: 'a' }, 'b', { type: 'tool_use' }])).toBe('ab');
        });
        it('returns empty string for null', () => {
            expect(contentToText(null)).toBe('');
        });
        it('JSON.stringifies a non-array object', () => {
            expect(contentToText({ a: 1 })).toBe('{"a":1}');
        });
    });

    describe('critiqueVerdict', () => {
        it('accepts an empty critique', () => {
            expect(critiqueVerdict('   ')).toBe('accept');
        });
        it('accepts a COMPLETE critique', () => {
            expect(critiqueVerdict('Looks COMPLETE now')).toBe('accept');
        });
        it('revises anything else', () => {
            expect(critiqueVerdict('missing the region')).toBe('revise');
        });
    });

    describe('buildToolExecutionLog', () => {
        it('returns empty string for no results', () => {
            expect(buildToolExecutionLog(undefined)).toBe('');
            expect(buildToolExecutionLog([])).toBe('');
        });
        it('formats OK and ERROR entries', () => {
            const log = buildToolExecutionLog([
                { toolName: 'list_accounts', output: '[]', isError: false, iterationIndex: 1 },
                { toolName: 'stop_instance', output: 'boom', isError: true, iterationIndex: 2 },
            ]);
            expect(log).toContain('list_accounts: OK');
            expect(log).toContain('stop_instance: ERROR');
        });
    });

    describe('computeReflectionStall', () => {
        it('resets when there is no issue', () => {
            expect(computeReflectionStall('None', 'None', 1)).toEqual({ stallCount: 0, stalled: false });
        });
        it('resets when the issue changed', () => {
            expect(computeReflectionStall('issue A', 'issue B', 1)).toEqual({ stallCount: 0, stalled: false });
        });
        it('increments when the same issue repeats', () => {
            expect(computeReflectionStall('issue A', 'issue A', 1)).toEqual({ stallCount: 2, stalled: true });
        });
        it('is not stalled below the limit', () => {
            expect(computeReflectionStall('issue A', 'issue A', 0)).toEqual({ stallCount: 1, stalled: false });
        });
    });

    describe('truncateOutput', () => {
        it('returns empty for falsy input', () => {
            expect(truncateOutput('')).toBe('');
        });
        it('passes short text through unchanged', () => {
            expect(truncateOutput('short')).toBe('short');
        });
        it('truncates long text with an ellipsis', () => {
            expect(truncateOutput('x'.repeat(10), 5)).toBe('xxxxx...');
        });
    });

    describe('truncateForReview', () => {
        it('returns empty for falsy input', () => {
            expect(truncateForReview('', 10)).toBe('');
        });
        it('passes text at or under the limit through unchanged', () => {
            expect(truncateForReview('short', 10)).toBe('short');
        });
        it('appends a review-only truncation marker for long text', () => {
            const result = truncateForReview('x'.repeat(20), 5);
            expect(result).toContain('TRUNCATED FOR REVIEW ONLY');
            expect(result).toContain('20 characters');
        });
    });

    describe('isToolResultError', () => {
        it('treats status "error" as an error regardless of content', () => {
            expect(isToolResultError('error', 'anything')).toBe(true);
        });
        it('treats empty content as not an error', () => {
            expect(isToolResultError(undefined, '')).toBe(false);
        });
        it('flags a "Command failed:" prefix', () => {
            expect(isToolResultError(undefined, 'Command failed: exit 1')).toBe(true);
        });
        it('flags an "Error:" / "Error " prefix', () => {
            expect(isToolResultError(undefined, 'Error: boom')).toBe(true);
            expect(isToolResultError(undefined, 'Error doing X: boom')).toBe(true);
        });
        it('flags Glob/Grep/Web-search error prefixes', () => {
            expect(isToolResultError(undefined, 'Glob error: bad pattern')).toBe(true);
            expect(isToolResultError(undefined, 'Grep error: bad regex')).toBe(true);
            expect(isToolResultError(undefined, 'Web search error: timeout')).toBe(true);
        });
        it('parses JSON with success:false as an error', () => {
            expect(isToolResultError(undefined, '{"success": false}')).toBe(true);
        });
        it('parses JSON with success:true as not an error', () => {
            expect(isToolResultError(undefined, '{"success": true}')).toBe(false);
        });
        it('does not flag valid JSON without a success field', () => {
            expect(isToolResultError(undefined, '{"Label":"Errors"}')).toBe(false);
        });
        it('does not throw on truncated/invalid JSON starting with {', () => {
            expect(isToolResultError(undefined, '{"truncated')).toBe(false);
        });
        it('does not flag plain non-error text', () => {
            expect(isToolResultError(undefined, 'all good')).toBe(false);
        });
    });

    describe('tagMessagePhase / tagMessageAsDeliverable', () => {
        it('tags a message with the agent phase, preserving existing metadata', () => {
            const msg = new AIMessage({ content: 'hi', response_metadata: { existing: 1 } });
            const tagged = tagMessagePhase(msg, 'execution');
            expect((tagged as any).response_metadata).toEqual({ existing: 1, agentPhase: 'execution' });
        });
        it('tags a message as the deliverable', () => {
            const msg = new AIMessage({ content: 'hi' });
            const tagged = tagMessageAsDeliverable(msg);
            expect((tagged as any).response_metadata.agentDeliverable).toBe(true);
        });
    });

    describe('findRenderedDeliverable', () => {
        it('returns null when nothing qualifies', () => {
            expect(findRenderedDeliverable([new HumanMessage('hi')])).toBeNull();
        });
        it('promotes a marked-at-source short deliverable at or above the floor', () => {
            const msg = tagMessageAsDeliverable(tagMessagePhase(new AIMessage({ content: 'x'.repeat(20) }), 'execution'));
            expect(findRenderedDeliverable([msg])).toBe('x'.repeat(20));
        });
        it('does not promote a marked deliverable below the floor', () => {
            const msg = tagMessageAsDeliverable(tagMessagePhase(new AIMessage({ content: 'short' }), 'execution'));
            expect(findRenderedDeliverable([msg])).toBeNull();
        });
        it('promotes an unmarked message when it is long enough', () => {
            const msg = tagMessagePhase(new AIMessage({ content: 'y'.repeat(801) }), 'revision');
            expect(findRenderedDeliverable([msg])).toBe('y'.repeat(801));
        });
        it('ignores messages from phases outside the deliverable set', () => {
            const msg = tagMessagePhase(new AIMessage({ content: 'z'.repeat(801) }), 'planning');
            expect(findRenderedDeliverable([msg])).toBeNull();
        });
        it('ignores non-AI messages', () => {
            const msg = tagMessagePhase(new HumanMessage('z'.repeat(801)) as any, 'execution');
            expect(findRenderedDeliverable([msg])).toBeNull();
        });
        it('keeps scanning and returns the LAST qualifying message', () => {
            const first = tagMessagePhase(new AIMessage({ content: 'a'.repeat(801) }), 'execution');
            const second = tagMessagePhase(new AIMessage({ content: 'b'.repeat(801) }), 'revision');
            expect(findRenderedDeliverable([first, second])).toBe('b'.repeat(801));
        });
    });

    describe('getRecentMessages', () => {
        it('returns [] for an empty or all-empty-content input', () => {
            expect(getRecentMessages([])).toEqual([]);
            expect(getRecentMessages([new AIMessage({ content: '' })])).toEqual([]);
        });
        it('keeps an AI message with tool_calls even when content is empty', () => {
            const ai = new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'x', args: {} }] });
            const result = getRecentMessages([ai]);
            expect(result).toContain(ai);
        });
        it('returns everything when under the max', () => {
            const msgs = [new HumanMessage('hi'), new AIMessage({ content: 'yo' })];
            expect(getRecentMessages(msgs, 30)).toEqual(msgs);
        });
        it('keeps a multi-message tool batch paired with its owning AI tool_calls message when trimming from the tail', () => {
            const human = new HumanMessage('start');
            const ai = new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: {} }] });
            const tool1 = new ToolMessage({ content: 'r1', tool_call_id: 't1' });
            const tool2 = new ToolMessage({ content: 'r2', tool_call_id: 't2' });
            const filler = Array.from({ length: 5 }, (_, i) => new HumanMessage(`filler ${i}`));
            const msgs = [human, ...filler, ai, tool1, tool2];
            const result = getRecentMessages(msgs, 3);
            expect(result.filter(m => m._getType() === 'tool')).toHaveLength(2);
            expect(result).toContain(ai);
        });
        it('drops a trailing tool batch whose owning AI message has no tool_calls', () => {
            const filler = Array.from({ length: 5 }, (_, i) => new HumanMessage(`filler ${i}`));
            const ai = new AIMessage({ content: 'no calls here' });
            const orphanTool = new ToolMessage({ content: 'r1', tool_call_id: 'missing' });
            const result = getRecentMessages([...filler, ai, orphanTool], 2);
            expect(result.some(m => m._getType() === 'tool')).toBe(false);
        });
        it('drops a trailing tool batch with no preceding AI message at all', () => {
            const filler = Array.from({ length: 5 }, (_, i) => new HumanMessage(`filler ${i}`));
            const orphanTool = new ToolMessage({ content: 'r1', tool_call_id: 'missing' });
            const result = getRecentMessages([...filler, orphanTool], 2);
            expect(result.some(m => m._getType() === 'tool')).toBe(false);
        });
        it('re-prepends the first message after trimming orphaned leading tool messages', () => {
            const firstMsg = new HumanMessage('task');
            const many = Array.from({ length: 40 }, (_, i) => new AIMessage({ content: `msg ${i}` }));
            const result = getRecentMessages([firstMsg, ...many], 5);
            expect(result[0]).toBe(firstMsg);
        });
        it('inserts a synthetic Human "Proceed." between two consecutive AI messages', () => {
            const human = new HumanMessage('start');
            const ai1 = new AIMessage({ content: 'first' });
            const ai2 = new AIMessage({ content: 'second' });
            const result = getRecentMessages([human, ai1, ai2], 30);
            const idx = result.indexOf(ai1);
            expect(result[idx + 1]._getType()).toBe('human');
            expect((result[idx + 1] as HumanMessage).content).toBe('Proceed.');
        });
        it('inserts a synthetic AI "Acknowledged." between two consecutive Human messages', () => {
            const human1 = new HumanMessage('first');
            const human2 = new HumanMessage('second');
            const result = getRecentMessages([human1, human2], 30);
            const idx = result.indexOf(human1);
            expect(result[idx + 1]._getType()).toBe('ai');
        });
        it('prepends a synthetic Human "Start session." when the conversation would otherwise start with AI', () => {
            const ai = new AIMessage({ content: 'orphan-first', tool_calls: [{ id: 't1', name: 'x', args: {} }] });
            const tool = new ToolMessage({ content: 'r1', tool_call_id: 't1' });
            const result = getRecentMessages([ai, tool], 30);
            expect(result[0]._getType()).toBe('human');
            expect((result[0] as HumanMessage).content).toBe('Start session.');
        });
    });

    describe('sanitizeMessagesForBedrock', () => {
        it('re-attaches a ToolMessage immediately after its owning AI message even when reordered', () => {
            const ai = new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'x', args: {} }] });
            const tool = new ToolMessage({ content: 'result', tool_call_id: 't1' });
            const human = new HumanMessage('Proceed.');
            const result = sanitizeMessagesForBedrock([ai, human, tool]);
            const aiIdx = result.indexOf(ai);
            expect(result[aiIdx + 1]).toBe(tool);
        });
        it('inserts a synthetic placeholder ToolMessage for an orphaned tool_call', () => {
            const ai = new AIMessage({ content: '', tool_calls: [{ id: 'missing-1', name: 'x', args: {} }] });
            const result = sanitizeMessagesForBedrock([ai]);
            const synthetic = result.find(m => m._getType() === 'tool') as ToolMessage;
            expect(synthetic).toBeDefined();
            expect(synthetic.content).toContain('synthetic placeholder');
        });
        it('collects tool_use ids from raw content blocks in addition to tool_calls', () => {
            const ai = new AIMessage({ content: [{ type: 'tool_use', id: 'raw-1', name: 'y' }] as any });
            const result = sanitizeMessagesForBedrock([ai]);
            const synthetic = result.find(m => m._getType() === 'tool') as ToolMessage;
            expect(synthetic.tool_call_id).toBe('raw-1');
        });
        it('strips reasoning/thinking blocks from AI content', () => {
            const ai = new AIMessage({ content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }] as any });
            const [result] = sanitizeMessagesForBedrock([ai]);
            expect(JSON.stringify((result as AIMessage).content)).not.toContain('secret');
        });
        it('rewrites a reasoning-only message that strips down to empty content', () => {
            const ai = new AIMessage({ content: [{ type: 'thinking', thinking: 'secret' }] as any });
            const [result] = sanitizeMessagesForBedrock([ai]);
            expect((result as AIMessage).content).toBe('(reasoning omitted)');
        });
        it('leaves a non-AI, non-tool message untouched', () => {
            const human = new HumanMessage('hi');
            const [result] = sanitizeMessagesForBedrock([human]);
            expect(result).toBe(human);
        });
    });

    describe('withUnresolvedToolCallsOnly', () => {
        it('returns null when there is no AI message', () => {
            expect(withUnresolvedToolCallsOnly({ messages: [new HumanMessage('hi')] })).toBeNull();
        });
        it('returns null when the last AI message has no tool_calls', () => {
            expect(withUnresolvedToolCallsOnly({ messages: [new AIMessage({ content: 'no calls' })] })).toBeNull();
        });
        it('returns null when all tool_calls already have results', () => {
            const ai = new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'x', args: {} }] });
            const tool = new ToolMessage({ content: 'done', tool_call_id: 't1' });
            expect(withUnresolvedToolCallsOnly({ messages: [ai, tool] })).toBeNull();
        });
        it('returns the state unchanged when every call is unresolved', () => {
            const ai = new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'x', args: {} }] });
            const state = { messages: [ai] };
            const result = withUnresolvedToolCallsOnly(state);
            expect(result!.messages).toBe(state.messages);
        });
        it('filters the last AI message down to only the unresolved calls, leaving state untouched', () => {
            const ai = new AIMessage({ content: 'partial', tool_calls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: {} }] });
            const resolved = new ToolMessage({ content: 'done', tool_call_id: 't1' });
            const state = { messages: [ai, resolved] };
            const result = withUnresolvedToolCallsOnly(state);
            expect(result).not.toBeNull();
            const filteredAi = result!.messages.find(m => m._getType() === 'ai') as AIMessage;
            expect(filteredAi.tool_calls).toHaveLength(1);
            expect(filteredAi.tool_calls![0].id).toBe('t2');
            expect(state.messages[0]).toBe(ai); // original state untouched
        });
        it('defaults to an empty messages array', () => {
            expect(withUnresolvedToolCallsOnly({ messages: undefined as any })).toBeNull();
        });
    });

    describe('llmAuditLog', () => {
        it('does nothing when LLM_AUDIT is unset', () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            llmAuditLog('PLANNER', [new HumanMessage('hi')], new AIMessage({ content: 'ok' }), Date.now());
            expect(logSpy).not.toHaveBeenCalled();
            logSpy.mockRestore();
        });
        it('does nothing when LLM_AUDIT is "0" or "false"', () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockEnv.LLM_AUDIT = '0';
            llmAuditLog('PLANNER', [], new AIMessage({ content: 'ok' }), Date.now());
            mockEnv.LLM_AUDIT = 'false';
            llmAuditLog('PLANNER', [], new AIMessage({ content: 'ok' }), Date.now());
            expect(logSpy).not.toHaveBeenCalled();
            logSpy.mockRestore();
        });
        it('logs a full audit including thinking blocks, text, and tool_calls', () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockEnv.LLM_AUDIT = '1';
            const aiInput = new AIMessage({
                content: [{ type: 'thinking', thinking: 'reasoning here' }, { type: 'text', text: 'partial' }] as any,
            });
            const response = new AIMessage({
                content: 'final answer',
                tool_calls: [{ id: 't1', name: 'do_thing', args: { x: 1 } }],
                usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } as any,
            });
            llmAuditLog('EXECUTOR', [new HumanMessage('task'), aiInput], response, Date.now() - 5);
            expect(logSpy).toHaveBeenCalledTimes(1);
            const output = logSpy.mock.calls[0][0] as string;
            expect(output).toContain('LLM AUDIT');
            expect(output).toContain('[THINKING]');
            expect(output).toContain('[TOOL_CALL]');
            expect(output).toContain('tokens_in=10');
            logSpy.mockRestore();
        });
        it('logs a compact audit truncating long content, and reports unknown tokens when usage is absent', () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockEnv.LLM_AUDIT = 'compact';
            const humanLong = new HumanMessage('h'.repeat(500));
            const response = new AIMessage({ content: 'ok' });
            llmAuditLog('REFLECTOR', [humanLong], response, Date.now());
            const output = logSpy.mock.calls[0][0] as string;
            expect(output).toContain('tokens=unknown');
            expect(output).toContain('...');
            logSpy.mockRestore();
        });
        it('falls back to (empty) for an AI input message with no content and no tool_calls', () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockEnv.LLM_AUDIT = '1';
            const emptyAi = new AIMessage({ content: '' });
            llmAuditLog('REVISER', [emptyAi], new AIMessage({ content: 'done' }), Date.now());
            const output = logSpy.mock.calls[0][0] as string;
            expect(output).toContain('(empty)');
            logSpy.mockRestore();
        });
        it('JSON.stringifies non-string, non-extractable content for a non-AI input message', () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockEnv.LLM_AUDIT = '1';
            const toolMsg = new ToolMessage({ content: [{ weird: true }] as any, tool_call_id: 't1' });
            llmAuditLog('TOOLS', [toolMsg], new AIMessage({ content: 'done' }), Date.now());
            const output = logSpy.mock.calls[0][0] as string;
            expect(output).toContain('weird');
            logSpy.mockRestore();
        });
    });

    describe('getCheckpointer / getStore', () => {
        it('delegate to persistence.ts', async () => {
            await expect(getCheckpointer()).resolves.toBe('checkpointer-instance');
            await expect(getStore()).resolves.toBe('store-instance');
        });
    });

    describe('getActiveMCPTools', () => {
        it('returns [] when no server ids are given', async () => {
            expect(await getActiveMCPTools()).toEqual([]);
            expect(await getActiveMCPTools([])).toEqual([]);
        });

        it('connects regular servers and returns tools, using saved tenant config', async () => {
            const configs = [{ id: 'srv-a', enabled: true, requiresAwsCredentials: false }];
            tenantConfigMock.getConfig.mockResolvedValue({ some: 'json' });
            mcpConfigMocks.mergeConfigs.mockReturnValue(configs);
            mcpConfigMocks.resolveEnabledServerIds.mockReturnValue(['srv-a']);

            const result = await getActiveMCPTools(['srv-a'], 'tenant-1');

            expect(tenantConfigMock.getConfig).toHaveBeenCalledWith('mcp-servers', 'tenant-1');
            expect(mcpManagerMocks.connectServers).toHaveBeenCalledWith(['srv-a'], configs, 'tenant-1');
            expect(result).toEqual(['tool-a']);
        });

        it('falls back to DEFAULT_MCP_SERVERS when the tenant config read throws', async () => {
            tenantConfigMock.getConfig.mockRejectedValue(new Error('DynamoDB down'));
            mcpConfigMocks.DEFAULT_MCP_SERVERS = [{ id: 'srv-default', enabled: true, requiresAwsCredentials: false }] as any;
            mcpConfigMocks.resolveEnabledServerIds.mockReturnValue(['srv-default']);

            const result = await getActiveMCPTools(['srv-default']);

            expect(mcpManagerMocks.connectServers).toHaveBeenCalledWith(['srv-default'], mcpConfigMocks.DEFAULT_MCP_SERVERS, 'default');
            expect(result).toEqual(['tool-a']);
        });

        it('connects a credential-required server for every selected account and skips one with no roleArn', async () => {
            const configs = [{ id: 'aws-srv', enabled: true, requiresAwsCredentials: true }];
            mcpConfigMocks.mergeConfigs.mockReturnValue(configs);
            mcpConfigMocks.resolveEnabledServerIds.mockReturnValue(['aws-srv']);
            tenantConfigMock.getConfig.mockResolvedValue(null);

            accountServiceMock.getAccount.mockImplementation(async (accountId: string) => {
                if (accountId === 'acc-no-role') return { accountId, roleArn: undefined, regions: [] };
                return { accountId, roleArn: 'arn:aws:iam::123:role/x', regions: ['us-west-2'] };
            });
            assumeRoleMock.mockResolvedValue({ credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } });

            const result = await getActiveMCPTools(
                ['aws-srv'],
                'tenant-2',
                [{ accountId: 'acc-ok', accountName: 'OK' }, { accountId: 'acc-no-role', accountName: 'NoRole' }],
            );

            expect(accountServiceMock.getAccount).toHaveBeenCalledTimes(2);
            expect(assumeRoleMock).toHaveBeenCalledTimes(1);
            expect(mcpManagerMocks.connectServerWithAwsCredentials).toHaveBeenCalledTimes(1);
            expect(result).toEqual(['tool-a']);
        });

        it('skips an account entirely when getAccount returns null', async () => {
            const configs = [{ id: 'aws-srv', enabled: true, requiresAwsCredentials: true }];
            mcpConfigMocks.mergeConfigs.mockReturnValue(configs);
            mcpConfigMocks.resolveEnabledServerIds.mockReturnValue(['aws-srv']);
            tenantConfigMock.getConfig.mockResolvedValue(null);
            accountServiceMock.getAccount.mockResolvedValue(null);

            await getActiveMCPTools(['aws-srv'], 'tenant-3', [{ accountId: 'acc-missing', accountName: 'Missing' }]);

            expect(assumeRoleMock).not.toHaveBeenCalled();
        });

        it('logs and continues when assumeRoleForAccount throws for one account', async () => {
            const configs = [{ id: 'aws-srv', enabled: true, requiresAwsCredentials: true }];
            mcpConfigMocks.mergeConfigs.mockReturnValue(configs);
            mcpConfigMocks.resolveEnabledServerIds.mockReturnValue(['aws-srv']);
            tenantConfigMock.getConfig.mockResolvedValue(null);
            accountServiceMock.getAccount.mockResolvedValue({ accountId: 'acc-1', roleArn: 'arn:x', regions: [] });
            assumeRoleMock.mockRejectedValue(new Error('assume role failed'));

            const result = await getActiveMCPTools(['aws-srv'], 'tenant-4', [{ accountId: 'acc-1', accountName: 'A' }]);

            expect(mcpManagerMocks.connectServerWithAwsCredentials).not.toHaveBeenCalled();
            expect(result).toEqual(['tool-a']);
        });

        it('continues past one failed connectServerWithAwsCredentials call', async () => {
            const configs = [{ id: 'aws-srv', enabled: true, requiresAwsCredentials: true }];
            mcpConfigMocks.mergeConfigs.mockReturnValue(configs);
            mcpConfigMocks.resolveEnabledServerIds.mockReturnValue(['aws-srv']);
            tenantConfigMock.getConfig.mockResolvedValue(null);
            accountServiceMock.getAccount.mockResolvedValue({ accountId: 'acc-1', roleArn: 'arn:x', regions: [] });
            assumeRoleMock.mockResolvedValue({ credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } });
            mcpManagerMocks.connectServerWithAwsCredentials.mockRejectedValue(new Error('connect failed'));

            const result = await getActiveMCPTools(['aws-srv'], 'tenant-5', [{ accountId: 'acc-1', accountName: 'A' }]);

            expect(result).toEqual(['tool-a']);
        });

        it('does not attempt credential connection when no accounts are provided', async () => {
            const configs = [{ id: 'aws-srv', enabled: true, requiresAwsCredentials: true }];
            mcpConfigMocks.mergeConfigs.mockReturnValue(configs);
            mcpConfigMocks.resolveEnabledServerIds.mockReturnValue(['aws-srv']);
            tenantConfigMock.getConfig.mockResolvedValue(null);

            await getActiveMCPTools(['aws-srv'], 'tenant-6');

            expect(accountServiceMock.getAccount).not.toHaveBeenCalled();
        });
    });
});
