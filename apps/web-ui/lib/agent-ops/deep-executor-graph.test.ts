import { describe, it, expect, vi, beforeEach } from 'vitest';

const createDeepAgent = vi.fn().mockReturnValue({ compiled: true });
const todoListMiddleware = vi.fn().mockReturnValue({ name: 'TodoList' });

vi.mock('deepagents', () => ({
    createDeepAgent: (...a: unknown[]) => createDeepAgent(...a),
    FilesystemBackend: class { constructor(public opts: unknown) {} },
    CompositeBackend: class { constructor(...a: unknown[]) { this.args = a; } args: unknown[]; },
    StoreBackend: class { constructor(public opts: unknown) {} },
}));
vi.mock('langchain', () => ({
    todoListMiddleware: () => todoListMiddleware(),
    createMiddleware: (c: unknown) => c,
}));
vi.mock('@langchain/langgraph', () => ({ isGraphInterrupt: () => false }));
vi.mock('@/lib/agent/model-factory', () => ({
    createAgentModels: () => ({ main: { bindTools: vi.fn() }, reflector: {} }),
    createMemoryTools: () => [{ name: 'search_memory' }, { name: 'save_memory' }],
}));
vi.mock('@/lib/agent/agent-shared', () => ({
    getCheckpointer: async () => ({ ck: true }),
    getStore: async () => ({ st: true }),
    getActiveMCPTools: async () => [],
    repairEmptyAiContent: (m: unknown) => m,
}));
vi.mock('@/lib/agent/deep/memory-middleware', () => ({
    createDeepMemoryMiddleware: () => ({ name: 'DeepMemory' }),
}));
vi.mock('@/lib/agent/deep/workdir', () => ({
    tenantWorkdir: (t: string) => `/tmp/wd/${t}`,
    ensureWorkdir: async () => undefined,
    AGENTS_MD_PATH: '/memories/AGENTS.md',
    MEMORIES_ROUTE: '/memories/',
}));
vi.mock('@/lib/agent/deep/file-store', () => ({ PostgresFileStore: class {} }));
vi.mock('@/lib/agent/tools', () => ({
    createExecuteCommandTool: () => ({ name: 'execute_command' }),
    createGetAwsCredentialsTool: () => ({ name: 'get_aws_credentials' }),
    createListAwsAccountsTool: () => ({ name: 'list_aws_accounts' }),
    askUserTool: { name: 'ask_user' },
    webSearchTool: { name: 'web_search' },
    webSearchAvailable: () => true,
    writeFileToS3Tool: { name: 'write_file_to_s3' },
    getFileFromS3Tool: { name: 'get_file_from_s3' },
}));
vi.mock('@/lib/agent/right-sizing-tool', () => ({ createGetRightSizingRecommendationsTool: () => ({ name: 'rs' }) }));
vi.mock('@/lib/agent/kb-tool', () => ({ createSearchKnowledgeBaseTool: () => ({ name: 'search_knowledge_base' }) }));
vi.mock('@/lib/agent/aws-read-tool', () => ({ createAwsReadTool: () => ({ name: 'aws_read' }) }));
vi.mock('@/lib/agent/skill-tool', () => ({ createLoadSkillTool: () => ({ name: 'load_skill' }) }));
vi.mock('@/lib/skill-service', () => ({
    getSkillContent: async () => null,
    getSkillSummaries: async () => 'Available skills: none',
}));

import { createDeepExecutorGraph } from './deep-executor-graph';

const baseConfig = {
    model: { modelId: 'anthropic.claude', provider: 'bedrock' },
    autoApprove: false,
    tenantId: 't1',
    userId: 'u1',
    accountId: '111122223333',
    accountName: 'prod',
} as never;

const callArg = () => createDeepAgent.mock.calls[0][0] as Record<string, never>;

describe('createDeepExecutorGraph', () => {
    beforeEach(() => vi.clearAllMocks());

    it('passes todoListMiddleware first — todos are opt-in since deepagents v0.7', async () => {
        await createDeepExecutorGraph(baseConfig);
        const names = (callArg().middleware as Array<{ name: string }>).map(m => m.name);
        expect(names).toEqual(['TodoList', 'DeepMemory', 'HandleToolErrors', 'RepairMessages']);
    });

    it('wires the three shared sub-agents', async () => {
        await createDeepExecutorGraph(baseConfig);
        expect((callArg().subagents as Array<{ name: string }>).map(s => s.name))
            .toEqual(['aws-ops', 'research', 'code-iac']);
    });

    it('excludes save_memory — the memory middleware already saves', async () => {
        await createDeepExecutorGraph(baseConfig);
        const names = (callArg().tools as Array<{ name: string }>).map(t => t.name);
        expect(names).toContain('search_memory');
        expect(names).not.toContain('save_memory');
    });

    it('gates the four mutating tools when autoApprove is false', async () => {
        await createDeepExecutorGraph(baseConfig);
        expect(callArg().interruptOn).toEqual({
            execute_command: true, write_file: true, edit_file: true, ask_user: true,
        });
    });

    it('omits interruptOn entirely when autoApprove is true', async () => {
        await createDeepExecutorGraph({ ...(baseConfig as object), autoApprove: true } as never);
        expect(callArg().interruptOn).toBeUndefined();
    });

    it('registers AGENTS.md as durable memory', async () => {
        await createDeepExecutorGraph(baseConfig);
        expect(callArg().memory).toEqual(['/memories/AGENTS.md']);
    });

    it('drops load_skill when autoLoadSkills is false', async () => {
        await createDeepExecutorGraph({ ...(baseConfig as object), autoLoadSkills: false } as never);
        const names = (callArg().tools as Array<{ name: string }>).map(t => t.name);
        expect(names).not.toContain('load_skill');
    });

    it('throws when no tenant is supplied — every tool is tenant-scoped', async () => {
        await expect(createDeepExecutorGraph({ ...(baseConfig as object), tenantId: undefined } as never))
            .rejects.toThrow(/tenant/i);
    });
});
