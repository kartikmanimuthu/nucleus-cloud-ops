import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedModelConfig } from './agent-shared';

vi.mock('./tools', () => ({
    executeCommandTool: 'execute_command', readFileTool: 'read_file', writeFileTool: 'write_file',
    lsTool: 'ls', editFileTool: 'edit_file', globTool: 'glob', grepTool: 'grep',
    createGetAwsCredentialsTool: vi.fn((tenantId: string) => `get_aws_credentials:${tenantId}`),
    createListAwsAccountsTool: vi.fn((tenantId: string) => `list_aws_accounts:${tenantId}`),
    writeFileToS3Tool: 'write_file_to_s3', getFileFromS3Tool: 'get_file_from_s3', askUserTool: 'ask_user',
}));
vi.mock('./right-sizing-tool', () => ({
    createGetRightSizingRecommendationsTool: vi.fn((tenantId: string) => `right_sizing:${tenantId}`),
}));
vi.mock('./kb-tool', () => ({
    createSearchKnowledgeBaseTool: vi.fn((tenantId: string, kbIds?: string[]) => `kb:${tenantId}:${kbIds?.join(',') ?? ''}`),
}));
vi.mock('./skill-tool', () => ({
    createLoadSkillTool: vi.fn((tenantId: string) => `load_skill:${tenantId}`),
}));

const getActiveMCPToolsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('./agent-shared', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./agent-shared')>();
    return { ...actual, getActiveMCPTools: getActiveMCPToolsMock };
});

const resolveAgentAbilityMock = vi.hoisted(() => vi.fn());
vi.mock('./agent-ability', () => ({ resolveAgentAbility: resolveAgentAbilityMock }));

const toolGateFilterMock = vi.hoisted(() => vi.fn());
const createToolGateMock = vi.hoisted(() => vi.fn(() => ({ filter: toolGateFilterMock })));
vi.mock('./tool-gate', () => ({ createToolGate: createToolGateMock }));

const saveMemoryMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const searchMemoryMock = vi.hoisted(() => vi.fn());
vi.mock('./persistence', () => ({ saveMemory: saveMemoryMock, searchMemory: searchMemoryMock }));

vi.mock('@/lib/provider-model-service', () => ({
    normalizeOpenAICompatibleBaseUrl: vi.fn((_provider: string, baseUrl?: string) => baseUrl),
}));

import {
    createAgentModels, deriveInputTokenBudget, createMemoryTools, assembleTools, createTools, DEFAULT_MAX_OUTPUT_TOKENS,
} from './model-factory';
import { ProviderConfigError } from './provider-errors';

function bedrockConfig(overrides: Partial<ResolvedModelConfig> = {}): ResolvedModelConfig {
    return { provider: 'bedrock', modelId: 'claude', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', ...overrides };
}

describe('deriveInputTokenBudget', () => {
    it('derives from the provider context window minus output reserve and safety margin', () => {
        expect(deriveInputTokenBudget(bedrockConfig())).toBe(200_000 - DEFAULT_MAX_OUTPUT_TOKENS - 2_000);
    });
    it('uses the configured maxTokens as the output reserve when set', () => {
        expect(deriveInputTokenBudget(bedrockConfig({ maxTokens: 1000 }))).toBe(200_000 - 1000 - 2_000);
    });
    it('falls back to a 16k context window for an unknown provider family and floors at 8000', () => {
        const result = deriveInputTokenBudget({ provider: 'openai-compatible', modelId: 'x', maxTokens: 20_000 });
        expect(result).toBe(8_000); // 16000 - 20000 - 2000 would be negative, floored
    });
});

describe('createAgentModels', () => {
    it('throws ProviderConfigError for a self-hosted provider missing a base URL', () => {
        expect(() => createAgentModels({ provider: 'ollama', modelId: 'llama3' })).toThrow(ProviderConfigError);
    });

    it('does not require a base URL for native "openai"', () => {
        const models = createAgentModels({ provider: 'openai', modelId: 'gpt-4', apiKey: 'sk-x' });
        expect(models.main).toBeDefined();
        expect(models.reflector).toBeDefined();
    });

    it('builds OpenAI-compatible main (streaming) and reflector (non-streaming, 4096 cap) models', () => {
        const models = createAgentModels({ provider: 'ollama', modelId: 'llama3', baseUrl: 'http://localhost:11434/v1' });
        expect(models.main).toBeDefined();
        expect(models.reflector).toBeDefined();
    });

    it('builds native Anthropic main + reflector models', () => {
        const models = createAgentModels({ provider: 'anthropic', modelId: 'claude-3', apiKey: 'sk-ant', temperature: 0.5, baseUrl: 'https://gateway.example.com' });
        expect(models.main).toBeDefined();
        expect(models.reflector).toBeDefined();
    });

    it('throws ProviderConfigError for Bedrock missing credentials/region', () => {
        expect(() => createAgentModels({ provider: 'bedrock', modelId: 'claude' })).toThrow(ProviderConfigError);
        expect(() => createAgentModels({ provider: 'bedrock', modelId: 'claude', region: 'us-east-1' })).toThrow(ProviderConfigError);
    });

    it('builds Bedrock main + reflector models when fully configured', () => {
        const models = createAgentModels(bedrockConfig({ temperature: 0.2 }));
        expect(models.main).toBeDefined();
        expect(models.reflector).toBeDefined();
    });
});

describe('createMemoryTools', () => {
    beforeEach(() => vi.clearAllMocks());

    it('save_memory delegates to saveMemory scoped to tenant/user and confirms the path', async () => {
        const [saveTool] = createMemoryTools('tenant-1', 'user-1');
        const result = await saveTool.invoke({ namespace: ['infra', 'acc-1'], key: 'note', value: { a: 1 } });
        expect(saveMemoryMock).toHaveBeenCalledWith('tenant-1', 'user-1', ['infra', 'acc-1'], 'note', { a: 1 });
        expect(result).toBe('Memory saved: infra/acc-1/note');
    });

    it('search_memory returns scoped results directly when found', async () => {
        searchMemoryMock.mockResolvedValueOnce([{ key: 'note' }]);
        const [, searchTool] = createMemoryTools('tenant-1', 'user-1');
        const result = await searchTool.invoke({ namespacePrefix: ['infra'], query: 'lambda' });
        expect(searchMemoryMock).toHaveBeenCalledWith('tenant-1', 'user-1', ['infra'], 'lambda', 5);
        expect(JSON.parse(result)).toEqual([{ key: 'note' }]);
    });

    it('search_memory returns "No memories found." when scoped search is empty and there is no prefix', async () => {
        searchMemoryMock.mockResolvedValueOnce([]);
        const [, searchTool] = createMemoryTools('tenant-1', 'user-1');
        const result = await searchTool.invoke({ query: 'lambda' });
        expect(result).toBe('No memories found.');
    });

    it('search_memory falls back to an unscoped search when the prefixed search is empty', async () => {
        searchMemoryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ key: 'other' }]);
        const [, searchTool] = createMemoryTools('tenant-1', 'user-1');
        const result = await searchTool.invoke({ namespacePrefix: ['infra', 'acc-1', 'lambda'], query: 'runtime' });
        expect(searchMemoryMock).toHaveBeenNthCalledWith(2, 'tenant-1', 'user-1', [], 'runtime', 5);
        expect(result).toContain('No memories under "infra/acc-1/lambda"');
        expect(result).toContain('found 1');
    });

    it('search_memory reports "No memories found." when both the prefixed and fallback search are empty', async () => {
        searchMemoryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        const [, searchTool] = createMemoryTools('tenant-1', 'user-1');
        const result = await searchTool.invoke({ namespacePrefix: ['infra'], query: 'runtime' });
        expect(result).toBe('No memories found.');
    });

    it('search_memory respects a custom limit', async () => {
        searchMemoryMock.mockResolvedValueOnce([{ key: 'x' }]);
        const [, searchTool] = createMemoryTools('tenant-1', 'user-1');
        await searchTool.invoke({ query: 'q', limit: 20 });
        expect(searchMemoryMock).toHaveBeenCalledWith('tenant-1', 'user-1', [], 'q', 20);
    });
});

describe('assembleTools', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getActiveMCPToolsMock.mockResolvedValue([]);
        toolGateFilterMock.mockImplementation((tools: unknown[]) => ({ tools, omitted: [] }));
    });

    it('warns and falls back to a "default" tenant when none is given, and returns the ungated list when no ability resolves', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        resolveAgentAbilityMock.mockResolvedValue(null);

        const tools = await assembleTools({});

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('called without tenantId'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('agent tools are NOT capability-gated'));
        expect(tools).toContain('get_aws_credentials:default');
        warnSpy.mockRestore();
    });

    it('does not include memory tools when includeMemoryTools is true but userId is missing', async () => {
        resolveAgentAbilityMock.mockResolvedValue(null);
        const tools = await assembleTools({ tenantId: 't1', includeMemoryTools: true });
        expect(tools.some((t: unknown) => typeof t === 'object' && (t as { name?: string }).name === 'save_memory')).toBe(false);
    });

    it('includes memory, kb, and skill tools when tenantId + userId are present', async () => {
        resolveAgentAbilityMock.mockResolvedValue(null);
        const tools = await assembleTools({ tenantId: 't1', userId: 'u1', includeMemoryTools: true, knowledgeBaseIds: ['kb-1'] });
        expect(tools.some((t: unknown) => typeof t === 'object' && (t as { name?: string }).name === 'save_memory')).toBe(true);
        expect(tools).toContain('kb:t1:kb-1');
        expect(tools).toContain('load_skill:t1');
    });

    it('omits the skill tool when includeSkillTool is false', async () => {
        resolveAgentAbilityMock.mockResolvedValue(null);
        const tools = await assembleTools({ tenantId: 't1', includeSkillTool: false });
        expect(tools).not.toContain('load_skill:t1');
    });

    it('includes S3 tools only when includeS3Tools is true', async () => {
        resolveAgentAbilityMock.mockResolvedValue(null);
        const withS3 = await assembleTools({ tenantId: 't1', includeS3Tools: true });
        expect(withS3).toContain('write_file_to_s3');
        const withoutS3 = await assembleTools({ tenantId: 't1' });
        expect(withoutS3).not.toContain('write_file_to_s3');
    });

    it('includes a supplied dispatchAgentTool', async () => {
        resolveAgentAbilityMock.mockResolvedValue(null);
        const tools = await assembleTools({ tenantId: 't1', dispatchAgentTool: 'dispatch_agent' });
        expect(tools).toContain('dispatch_agent');
    });

    it('logs and appends MCP tools when any are loaded', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        resolveAgentAbilityMock.mockResolvedValue(null);
        getActiveMCPToolsMock.mockResolvedValue([{ name: 'mcp_tool_a' }]);

        const tools = await assembleTools({ tenantId: 't1', mcpServerIds: ['srv-a'] });

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Loaded 1 MCP tools'));
        expect(tools).toContainEqual({ name: 'mcp_tool_a' });
        logSpy.mockRestore();
    });

    it('returns the ungated list immediately when enforceCapabilities is false, without resolving an ability', async () => {
        const tools = await assembleTools({ tenantId: 't1', enforceCapabilities: false });
        expect(resolveAgentAbilityMock).not.toHaveBeenCalled();
        expect(tools).toContain('get_aws_credentials:t1');
    });

    it('uses a directly-supplied agentAbility instead of resolving one', async () => {
        const ability = { ability: 'ability-obj', principal: { roleName: 'Admin' }, actionAliases: {} };
        toolGateFilterMock.mockReturnValue({ tools: ['gated-tool'], omitted: [] });

        const tools = await assembleTools({ tenantId: 't1', agentAbility: ability as any });

        expect(resolveAgentAbilityMock).not.toHaveBeenCalled();
        expect(createToolGateMock).toHaveBeenCalledWith(expect.objectContaining({ ability: 'ability-obj' }));
        expect(tools).toEqual(['gated-tool']);
    });

    it('applies the capability gate and logs which tools were omitted', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const ability = { ability: 'ability-obj', principal: { roleName: 'Viewer' }, actionAliases: {} };
        resolveAgentAbilityMock.mockResolvedValue(ability);
        toolGateFilterMock.mockReturnValue({ tools: ['read_file'], omitted: ['execute_command', 'write_file'] });

        const tools = await assembleTools({ tenantId: 't1' });

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("capability gate omitted 2 tool(s) for role 'Viewer'"));
        expect(tools).toEqual(['read_file']);
        logSpy.mockRestore();
    });

    it('createTools is an alias for assembleTools', () => {
        expect(createTools).toBe(assembleTools);
    });
});
