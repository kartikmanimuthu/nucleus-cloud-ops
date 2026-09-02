import { describe, it, expect, vi } from 'vitest';
import { createDeepSubagents } from '../subagents';

const fakeTool = (name: string) => ({ name, description: name, invoke: vi.fn() }) as never;

const baseOpts = {
    accountContext: '\n\nACCOUNT CONTEXT MARKER',
    executeCommand: fakeTool('execute_command'),
    getAwsCredentials: fakeTool('get_aws_credentials'),
    listAwsAccounts: fakeTool('list_aws_accounts'),
    researchTools: [fakeTool('web_search'), fakeTool('search_knowledge_base')],
    interruptOn: { execute_command: true } as Record<string, boolean> | undefined,
};

describe('createDeepSubagents', () => {
    it('returns the three sub-agents in a stable order', () => {
        const subs = createDeepSubagents(baseOpts);
        expect(subs.map(s => s.name)).toEqual(['aws-ops', 'research', 'code-iac']);
    });

    it('gives aws-ops the three AWS tools and the interrupt config', () => {
        const [awsOps] = createDeepSubagents(baseOpts);
        expect(awsOps.tools?.map((t: { name: string }) => t.name)).toEqual([
            'execute_command', 'get_aws_credentials', 'list_aws_accounts',
        ]);
        expect(awsOps.interruptOn).toEqual({ execute_command: true });
    });

    it('injects the account context into the aws-ops prompt', () => {
        const [awsOps] = createDeepSubagents(baseOpts);
        expect(awsOps.systemPrompt).toContain('ACCOUNT CONTEXT MARKER');
    });

    it('leaves research un-gated — it is read-only', () => {
        const research = createDeepSubagents(baseOpts)[1];
        expect(research.interruptOn).toBeUndefined();
        expect(research.tools?.map((t: { name: string }) => t.name)).toEqual([
            'web_search', 'search_knowledge_base',
        ]);
    });

    it('gates code-iac, which can execute and write', () => {
        const code = createDeepSubagents(baseOpts)[2];
        expect(code.interruptOn).toEqual({ execute_command: true });
        expect(code.tools?.map((t: { name: string }) => t.name)).toEqual(['execute_command']);
    });

    it('omits interruptOn entirely when autoApprove left it undefined', () => {
        const subs = createDeepSubagents({ ...baseOpts, interruptOn: undefined });
        expect(subs[0].interruptOn).toBeUndefined();
        expect(subs[2].interruptOn).toBeUndefined();
    });
});
