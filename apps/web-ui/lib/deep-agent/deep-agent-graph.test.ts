import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateDeepAgent, mockEnv, mockExistsSync, mockReaddirSync, mockReadFileSync } = vi.hoisted(() => ({
    mockCreateDeepAgent: vi.fn(),
    mockEnv: {} as Record<string, any>,
    mockExistsSync: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockReadFileSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, existsSync: mockExistsSync, readdirSync: mockReaddirSync, readFileSync: mockReadFileSync };
});

vi.mock('deepagents', () => ({
    createDeepAgent: mockCreateDeepAgent,
    CompositeBackend: vi.fn().mockImplementation(function (this: any, ...args: any[]) { this.args = args; }),
    StateBackend: vi.fn().mockImplementation(function (this: any, cfg: any) { this.cfg = cfg; }),
    StoreBackend: vi.fn().mockImplementation(function (this: any, cfg: any) { this.cfg = cfg; }),
}));

vi.mock('@/env', () => ({ env: mockEnv }));

vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'm', maxTokens: undefined }),
}));
vi.mock('@/lib/agent/model-factory', () => ({
    createAgentModels: vi.fn().mockReturnValue({ main: { id: 'mock-model' }, reflector: { id: 'mock-reflector' } }),
}));
vi.mock('../agent/tools', () => ({
    createGetAwsCredentialsTool: vi.fn().mockReturnValue({ name: 'get_aws_credentials' }),
    createListAwsAccountsTool: vi.fn().mockReturnValue({ name: 'list_aws_accounts' }),
}));
vi.mock('../agent/agent-shared', () => ({
    getActiveMCPTools: vi.fn().mockResolvedValue([]),
}));
vi.mock('./db/mongo-client', () => ({
    getMongoClient: vi.fn().mockResolvedValue({ mock: 'client' }),
}));
vi.mock('./db/safe-mongo-saver', () => ({
    SafeMongoDBSaver: vi.fn().mockImplementation(function (this: any, opts: any) { this.opts = opts; }),
}));
vi.mock('./db/memory-store', () => ({
    mongoStore: { mock: 'mongoStore' },
}));

import { createDeepAgentGraph } from './deep-agent-graph';
import { resolveModelConfig } from '@/lib/agent/model-resolver';
import { getActiveMCPTools } from '../agent/agent-shared';
import { getMongoClient } from './db/mongo-client';
import { SafeMongoDBSaver } from './db/safe-mongo-saver';

const BASE_CONFIG = {
    model: 'bedrock:claude', autoApprove: true, tenantId: 't1',
};

describe('createDeepAgentGraph', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnv.MONGODB_URI = undefined;
        mockEnv.DEEP_AGENT_DB_NAME = undefined;
        mockCreateDeepAgent.mockResolvedValue({ mock: 'agent' });
        mockExistsSync.mockReturnValue(false); // real SKILLS_DIR is absent in this checkout
    });

    it('throws a ProviderConfigError when tenantId is missing', async () => {
        await expect(createDeepAgentGraph({ ...BASE_CONFIG, tenantId: undefined } as any))
            .rejects.toThrow('A tenant context is required');
    });

    it('builds a MemorySaver checkpointer and InMemoryStore when MONGODB_URI is unset', async () => {
        const { agent, skillFiles } = await createDeepAgentGraph(BASE_CONFIG as any);
        expect(agent).toEqual({ mock: 'agent' });
        expect(skillFiles).toEqual({});
        expect(getMongoClient).not.toHaveBeenCalled();
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.checkpointer.constructor.name).toBe('MemorySaver');
        expect(callArgs.store.constructor.name).toBe('InMemoryStore');
    });

    it('uses the Mongo checkpointer and mongoStore when MONGODB_URI is set', async () => {
        mockEnv.MONGODB_URI = 'mongodb://localhost/test';
        await createDeepAgentGraph(BASE_CONFIG as any);
        expect(getMongoClient).toHaveBeenCalled();
        expect(SafeMongoDBSaver).toHaveBeenCalledWith(expect.objectContaining({ dbName: 'nucleus' }));
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.store).toEqual({ mock: 'mongoStore' });
    });

    it('falls back to MemorySaver if the Mongo checkpointer fails to initialize', async () => {
        mockEnv.MONGODB_URI = 'mongodb://localhost/test';
        vi.mocked(getMongoClient).mockRejectedValueOnce(new Error('conn refused'));
        await createDeepAgentGraph(BASE_CONFIG as any);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.checkpointer.constructor.name).toBe('MemorySaver');
    });

    it('respects a custom DEEP_AGENT_DB_NAME', async () => {
        mockEnv.MONGODB_URI = 'mongodb://localhost/test';
        mockEnv.DEEP_AGENT_DB_NAME = 'custom_db';
        await createDeepAgentGraph(BASE_CONFIG as any);
        expect(SafeMongoDBSaver).toHaveBeenCalledWith(expect.objectContaining({ dbName: 'custom_db' }));
    });

    it('sets interruptOn with per-tool decisions when autoApprove is false', async () => {
        await createDeepAgentGraph({ ...BASE_CONFIG, autoApprove: false } as any);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.interruptOn.execute_command.allowedDecisions).toEqual(['approve', 'edit', 'reject']);
        expect(callArgs.interruptOn.write_file.allowedDecisions).toEqual(['approve', 'reject']);
    });

    it('omits interruptOn entirely when autoApprove is true', async () => {
        await createDeepAgentGraph({ ...BASE_CONFIG, autoApprove: true } as any);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.interruptOn).toBeUndefined();
    });

    it('dedupes MCP tools that share a name with a base tool, keeping the MCP version', async () => {
        vi.mocked(getActiveMCPTools).mockResolvedValueOnce([
            { name: 'get_aws_credentials', from: 'mcp' } as any,
            { name: 'jira_search', from: 'mcp' } as any,
        ]);
        await createDeepAgentGraph(BASE_CONFIG as any);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        const names = callArgs.tools.map((t: any) => t.name);
        expect(names).toEqual(['get_aws_credentials', 'list_aws_accounts', 'jira_search']);
        expect(callArgs.tools.find((t: any) => t.name === 'get_aws_credentials').from).toBe('mcp');
    });

    it('builds multi-account context into the system prompt when accounts[] is provided', async () => {
        await createDeepAgentGraph({
            ...BASE_CONFIG,
            accounts: [{ accountId: '111', accountName: 'Prod' }, { accountId: '222' }],
        } as any);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.systemPrompt).toContain('operating across 2 AWS account(s)');
        expect(callArgs.systemPrompt).toContain('Prod (ID: 111)');
        expect(callArgs.systemPrompt).toContain('222 (ID: 222)');
    });

    it('builds single-account context into the system prompt when only accountId is provided', async () => {
        await createDeepAgentGraph({ ...BASE_CONFIG, accountId: '333', accountName: 'Staging' } as any);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.systemPrompt).toContain('operating in AWS account: Staging (ID: 333)');
    });

    it('builds an account-discovery prompt when neither accounts nor accountId is provided', async () => {
        await createDeepAgentGraph(BASE_CONFIG as any);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.systemPrompt).toContain('AWS Account Discovery');
        expect(callArgs.systemPrompt).toContain('Call list_aws_accounts to discover');
    });

    it('returns an empty skillFiles map when the skills directory does not exist on disk', async () => {
        // The real skills directory is absent in this checkout — exercises the
        // existsSync(false) branch of loadSkillFiles without mocking fs.
        const { skillFiles } = await createDeepAgentGraph(BASE_CONFIG as any);
        expect(skillFiles).toEqual({});
    });

    it('loads skill files from disk when the skills directory exists, auto-loading all when none selected', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([
            { name: 'aws-ops', isDirectory: () => true },
            { name: 'research', isDirectory: () => true },
        ] as any);
        mockReadFileSync.mockReturnValue('# Skill content');

        const { skillFiles } = await createDeepAgentGraph(BASE_CONFIG as any);
        expect(Object.keys(skillFiles)).toEqual(['/skills/aws-ops/SKILL.md', '/skills/research/SKILL.md']);
        const callArgs = mockCreateDeepAgent.mock.calls[0][0];
        expect(callArgs.skills).toEqual(['/skills/']);
    });

    it('loads only the selected skills when selectedSkills is non-empty', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([
            { name: 'aws-ops', isDirectory: () => true },
            { name: 'research', isDirectory: () => true },
        ] as any);
        mockReadFileSync.mockReturnValue('# Skill content');

        const { skillFiles } = await createDeepAgentGraph({ ...BASE_CONFIG, selectedSkills: ['research'] } as any);
        expect(Object.keys(skillFiles)).toEqual(['/skills/research/SKILL.md']);
    });

    it('skips a skill directory whose SKILL.md is missing', async () => {
        mockExistsSync.mockImplementation((p: any) => !String(p).includes('missing-skill'));
        mockReaddirSync.mockReturnValue([
            { name: 'missing-skill', isDirectory: () => true },
            { name: 'aws-ops', isDirectory: () => true },
        ] as any);
        mockReadFileSync.mockReturnValue('# Skill content');

        const { skillFiles } = await createDeepAgentGraph(BASE_CONFIG as any);
        expect(Object.keys(skillFiles)).toEqual(['/skills/aws-ops/SKILL.md']);
    });

    it('returns empty skillFiles and logs when loading throws', async () => {
        mockExistsSync.mockImplementation(() => { throw new Error('disk error'); });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { skillFiles } = await createDeepAgentGraph(BASE_CONFIG as any);
        expect(skillFiles).toEqual({});
        expect(errSpy).toHaveBeenCalledWith('[DeepAgent] Error loading skills:', expect.any(Error));
    });

    it('propagates resolveModelConfig failures (no implicit Bedrock fallback)', async () => {
        const { ProviderConfigError } = await import('@/lib/agent/provider-errors');
        vi.mocked(resolveModelConfig).mockRejectedValueOnce(new ProviderConfigError('no provider configured'));
        await expect(createDeepAgentGraph(BASE_CONFIG as any)).rejects.toThrow('no provider configured');
    });
});
