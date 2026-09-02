/**
 * createDeepGraph is a large configuration-building factory around deepagents'
 * createDeepAgent — most of its branches are "which tools/prompt-section given this
 * config" decisions. Every collaborator is mocked; assertions read what actually got
 * passed to createDeepAgent (tools, subagents, middleware, systemPrompt) rather than
 * re-implementing deepagents itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolMessage, AIMessage } from '@langchain/core/messages';

const createDeepAgentMock = vi.fn().mockReturnValue({ __stub: 'deep-agent' });
vi.mock('deepagents', () => ({
    createDeepAgent: (...args: any[]) => createDeepAgentMock(...args),
    FilesystemBackend: vi.fn().mockImplementation(function (this: any, opts: any) { this.opts = opts; }),
    CompositeBackend: vi.fn().mockImplementation(function (this: any, ...routes: any[]) { this.routes = routes; }),
    StoreBackend: vi.fn().mockImplementation(function (this: any, opts: any) { this.opts = opts; }),
}));

const createMiddlewareMock = vi.fn((def: any) => def);
const todoListMiddlewareMock = vi.fn(() => ({ __mw: 'todo' }));
vi.mock('langchain', () => ({
    createMiddleware: (def: any) => createMiddlewareMock(def),
    todoListMiddleware: () => todoListMiddlewareMock(),
}));

const isGraphInterruptMock = vi.fn().mockReturnValue(false);
vi.mock('@langchain/langgraph', () => ({ isGraphInterrupt: (e: unknown) => isGraphInterruptMock(e) }));

vi.mock('@/lib/skill-service', () => ({
    getSkillContent: vi.fn().mockResolvedValue(null),
    getSkillSummaries: vi.fn().mockResolvedValue('No specialized skills configured.'),
}));

vi.mock('./tools', () => ({
    webSearchTool: { name: 'web_search' },
    webSearchAvailable: vi.fn().mockReturnValue(false),
    askUserTool: { name: 'ask_user' },
    writeFileToS3Tool: { name: 'write_file_to_s3' },
    getFileFromS3Tool: { name: 'get_file_from_s3' },
    createExecuteCommandTool: vi.fn().mockReturnValue({ name: 'execute_command' }),
    createGetAwsCredentialsTool: vi.fn().mockReturnValue({ name: 'get_aws_credentials' }),
    createListAwsAccountsTool: vi.fn().mockReturnValue({ name: 'list_aws_accounts' }),
}));

vi.mock('./right-sizing-tool', () => ({ createGetRightSizingRecommendationsTool: vi.fn().mockReturnValue({ name: 'right_sizing' }) }));
vi.mock('./kb-tool', () => ({ createSearchKnowledgeBaseTool: vi.fn().mockReturnValue({ name: 'search_kb' }) }));
vi.mock('./aws-read-tool', () => ({ createAwsReadTool: vi.fn().mockReturnValue({ name: 'aws_read' }) }));
vi.mock('./skill-tool', () => ({ createLoadSkillTool: vi.fn().mockReturnValue({ name: 'load_skill' }) }));

vi.mock('./agent-shared', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./agent-shared')>();
    return {
        ...actual,
        getCheckpointer: vi.fn().mockResolvedValue({ __checkpointer: true }),
        getStore: vi.fn().mockResolvedValue({ __store: true }),
        getActiveMCPTools: vi.fn().mockResolvedValue([]),
        repairEmptyAiContent: vi.fn((messages: unknown[]) => messages),
    };
});

vi.mock('./model-factory', () => ({
    createAgentModels: vi.fn().mockReturnValue({ main: { __model: 'main' }, reflector: { __model: 'reflector' } }),
    createMemoryTools: vi.fn().mockReturnValue([{ name: 'search_memory' }, { name: 'save_memory' }]),
}));

vi.mock('./deep/workdir', () => ({
    tenantWorkdir: vi.fn((tenantId: string) => `/data/${tenantId}`),
    ensureWorkdir: vi.fn().mockResolvedValue(undefined),
    AGENTS_MD_PATH: '/memories/AGENTS.md',
    MEMORIES_ROUTE: '/memories/',
}));
vi.mock('./deep/file-store', () => ({ PostgresFileStore: vi.fn().mockImplementation(function (this: any, tenantId: string) { this.tenantId = tenantId; }) }));
vi.mock('./deep/memory-middleware', () => ({ createDeepMemoryMiddleware: vi.fn().mockReturnValue({ __mw: 'memory' }) }));

import { webSearchAvailable, createExecuteCommandTool, createGetAwsCredentialsTool, createListAwsAccountsTool } from './tools';
import { createGetRightSizingRecommendationsTool } from './right-sizing-tool';
import { createSearchKnowledgeBaseTool } from './kb-tool';
import { createAwsReadTool } from './aws-read-tool';
import { createLoadSkillTool } from './skill-tool';
import { getActiveMCPTools, repairEmptyAiContent } from './agent-shared';
import { createMemoryTools } from './model-factory';
import { getSkillContent, getSkillSummaries } from '@/lib/skill-service';

const MODEL_CONFIG = { provider: 'bedrock' as const, modelId: 'test-model', maxTokens: 4096 };

function toolNames(): string[] {
    const args = createDeepAgentMock.mock.calls.at(-1)![0];
    return args.tools.map((t: any) => t.name);
}

function lastCallArgs() {
    return createDeepAgentMock.mock.calls.at(-1)![0];
}

beforeEach(() => {
    vi.clearAllMocks();
    createDeepAgentMock.mockReturnValue({ __stub: 'deep-agent' });
    isGraphInterruptMock.mockReturnValue(false);
    vi.mocked(webSearchAvailable).mockReturnValue(false);
    vi.mocked(getActiveMCPTools).mockResolvedValue([]);
    vi.mocked(getSkillContent).mockResolvedValue(null);
    vi.mocked(getSkillSummaries).mockResolvedValue('No specialized skills configured.');
    vi.mocked(createMemoryTools).mockReturnValue([{ name: 'search_memory' }, { name: 'save_memory' }] as any);
});

describe('createDeepGraph — base config, no tenant/skill/account context', () => {
    it('builds the autonomous-account-discovery prompt and excludes every tenant-gated tool', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);

        const args = lastCallArgs();
        expect(String(args.systemPrompt.content)).toContain('AUTONOMOUS AWS ACCOUNT DISCOVERY');
        expect(args.systemPrompt.content).not.toContain('MULTI-ACCOUNT');
        expect(toolNames()).not.toContain('right_sizing');
        expect(toolNames()).not.toContain('search_kb');
        expect(toolNames()).not.toContain('aws_read');
        expect(toolNames()).not.toContain('search_memory');
        expect(toolNames()).not.toContain('load_skill');
        expect(toolNames()).not.toContain('web_search');
        expect(args.interruptOn).toBeUndefined();
    });

    it('always includes the core tools and both S3 tools', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const names = toolNames();
        expect(names).toEqual(expect.arrayContaining(['execute_command', 'get_aws_credentials', 'list_aws_accounts', 'ask_user', 'write_file_to_s3', 'get_file_from_s3']));
    });
});

describe('createDeepGraph — account context', () => {
    it('uses the multi-account prompt when an accounts array is provided', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, accounts: [{ accountId: '111', accountName: 'Prod' }] } as any);
        expect(String(lastCallArgs().systemPrompt.content)).toContain('MULTI-ACCOUNT AWS CONTEXT');
    });

    it('uses the single-account prompt when only accountId is provided', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, accountId: '222', accountName: 'Staging' } as any);
        expect(String(lastCallArgs().systemPrompt.content)).toContain('AWS account: Staging (ID: 222)');
    });
});

describe('createDeepGraph — skill loading', () => {
    it('injects the active skill content into the system prompt when found', async () => {
        vi.mocked(getSkillContent).mockResolvedValue('Only touch resources tagged env=dev.');
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1', selectedSkill: 'dev-guard' } as any);

        expect(String(lastCallArgs().systemPrompt.content)).toContain('ACTIVE SKILL: DEV-GUARD');
        expect(String(lastCallArgs().systemPrompt.content)).toContain('Only touch resources tagged env=dev.');
    });

    it('falls back to the base DevOps operating mode when the skill has no content', async () => {
        vi.mocked(getSkillContent).mockResolvedValue(null);
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1', selectedSkill: 'missing-skill' } as any);
        expect(String(lastCallArgs().systemPrompt.content)).toContain('Operating Mode: Base DevOps Engineer');
    });

    it('includes the skill catalog section when other skills exist and auto-load is on', async () => {
        vi.mocked(getSkillSummaries).mockResolvedValue('- ec2-audit: audits EC2 fleets');
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1' } as any);
        expect(String(lastCallArgs().systemPrompt.content)).toContain('ec2-audit: audits EC2 fleets');
        expect(toolNames()).toContain('load_skill');
    });

    it('skips the skill catalog fetch and the load_skill tool when autoLoadSkills is false', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1', autoLoadSkills: false } as any);
        expect(getSkillSummaries).not.toHaveBeenCalled();
        expect(toolNames()).not.toContain('load_skill');
        expect(createLoadSkillTool).not.toHaveBeenCalled();
    });
});

describe('createDeepGraph — tenant-gated tools and memory', () => {
    it('includes right-sizing, KB search, aws_read, and only the search_memory tool when tenantId + userId are set', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1', userId: 'user-1', knowledgeBaseIds: ['kb-1'] } as any);

        const names = toolNames();
        expect(names).toContain('right_sizing');
        expect(names).toContain('search_kb');
        expect(names).toContain('aws_read');
        expect(names).toContain('search_memory');
        expect(names).not.toContain('save_memory');
        expect(createGetRightSizingRecommendationsTool).toHaveBeenCalledWith('tenant-1');
        expect(createSearchKnowledgeBaseTool).toHaveBeenCalledWith('tenant-1', ['kb-1']);
        expect(createAwsReadTool).toHaveBeenCalledWith('tenant-1', 'user-1');
    });

    it('omits memory tools when tenantId is set but userId is not', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1' } as any);
        expect(toolNames()).not.toContain('search_memory');
    });
});

describe('createDeepGraph — web search and MCP tools', () => {
    it('includes web_search in tools and the research subagent when a search provider is configured', async () => {
        vi.mocked(webSearchAvailable).mockReturnValue(true);
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);

        expect(toolNames()).toContain('web_search');
        const research = lastCallArgs().subagents.find((s: any) => s.name === 'research');
        expect(research.tools.map((t: any) => t.name)).toContain('web_search');
    });

    it('folds discovered MCP tools into allTools and the research subagent', async () => {
        vi.mocked(getActiveMCPTools).mockResolvedValue([{ name: 'mcp_grafana_query' }] as any);
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, mcpServerIds: ['grafana'] } as any);

        expect(toolNames()).toContain('mcp_grafana_query');
        const research = lastCallArgs().subagents.find((s: any) => s.name === 'research');
        expect(research.tools.map((t: any) => t.name)).toContain('mcp_grafana_query');
    });
});

describe('createDeepGraph — HITL interrupt configuration', () => {
    it('builds interruptOn for the four gated tools when autoApprove is false, and wires it into the gated subagents', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: false } as any);

        const args = lastCallArgs();
        expect(args.interruptOn).toEqual({ execute_command: true, write_file: true, edit_file: true, ask_user: true });
        const awsOps = args.subagents.find((s: any) => s.name === 'aws-ops');
        expect(awsOps.interruptOn).toBe(args.interruptOn);
    });
});

describe('createDeepGraph — wiring passed to createDeepAgent', () => {
    it('passes the checkpointer, the per-tenant file store, AGENTS.md as memory, and all four middleware', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1' } as any);

        const args = lastCallArgs();
        expect(args.checkpointer).toEqual({ __checkpointer: true });
        expect(args.store).toEqual({ tenantId: 'tenant-1' });
        expect(args.memory).toEqual(['/memories/AGENTS.md']);
        expect(args.middleware).toHaveLength(4);
    });

    it('returns whatever createDeepAgent produces', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        const result = await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        expect(result).toEqual({ __stub: 'deep-agent' });
    });
});

describe('createDeepGraph — HandleToolErrors middleware (wrapToolCall)', () => {
    function getHandleToolErrors() {
        const args = lastCallArgs();
        return args.middleware.find((m: any) => m.name === 'HandleToolErrors');
    }

    it('returns the handler result unchanged on success', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const mw = getHandleToolErrors();

        const handler = vi.fn().mockResolvedValue('ok');
        const result = await mw.wrapToolCall({ toolCall: { id: 't1', name: 'x' } }, handler);
        expect(result).toBe('ok');
    });

    it('rethrows a graph interrupt without converting it to a ToolMessage', async () => {
        isGraphInterruptMock.mockReturnValue(true);
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const mw = getHandleToolErrors();

        const interruptErr = new Error('interrupt');
        const handler = vi.fn().mockRejectedValue(interruptErr);
        await expect(mw.wrapToolCall({ toolCall: { id: 't1', name: 'x' } }, handler)).rejects.toBe(interruptErr);
    });

    it('rethrows an AbortError without converting it', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const mw = getHandleToolErrors();

        const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
        const handler = vi.fn().mockRejectedValue(abortErr);
        await expect(mw.wrapToolCall({ toolCall: { id: 't1', name: 'x' } }, handler)).rejects.toBe(abortErr);
    });

    it('converts any other tool error into a ToolMessage instead of aborting the run', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const mw = getHandleToolErrors();

        const handler = vi.fn().mockRejectedValue(new Error('bad argument: region'));
        const result = await mw.wrapToolCall({ toolCall: { id: 't1', name: 'execute_command' } }, handler);

        expect(result).toBeInstanceOf(ToolMessage);
        expect(result.content).toContain('Tool error: bad argument: region');
        expect(result.tool_call_id).toBe('t1');
        expect(result.name).toBe('execute_command');
    });
});

describe('createDeepGraph — RepairEmptyAiContent middleware (wrapModelCall)', () => {
    it('repairs empty AI content in the request messages before calling the handler', async () => {
        const { createDeepGraph } = await import('./deep-agent');
        await createDeepGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const args = lastCallArgs();
        const mw = args.middleware.find((m: any) => m.name === 'RepairEmptyAiContent');

        const messages = [new AIMessage({ content: '' })];
        const handler = vi.fn().mockResolvedValue('handled');
        const result = await mw.wrapModelCall({ messages }, handler);

        expect(repairEmptyAiContent).toHaveBeenCalledWith(messages);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ messages }));
        expect(result).toBe('handled');
    });
});
