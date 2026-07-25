import { describe, it, expect, vi } from 'vitest';
import {
    isReadOnlyForSubagent,
    filterReadOnlyTools,
    runSubagent,
    SUBAGENT_REPORT_MAX_CHARS,
    type SubagentSpec,
} from './subagent';

const BUDGET = {
    enabled: true,
    maxConcurrentSubagents: 3,
    maxSubagentsPerRun: 8,
    maxSubagentTokensPerRun: 400_000,
    subagentMaxIterations: 4,
    subagentTimeoutMs: 5_000,
};

const SPEC: SubagentSpec = {
    role: 'EC2 auditor',
    task: 'List idle instances in account 111111111111',
    expectedOutput: 'instance ids with CPU below 5%',
};

/** Model stub: returns each scripted response in turn. */
function scriptedModel(responses: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>) {
    let i = 0;
    const model: any = {
        bindTools: () => model,
        invoke: vi.fn(async () => {
            const r = responses[Math.min(i, responses.length - 1)];
            i++;
            return { content: r.content, tool_calls: r.tool_calls ?? [], usage_metadata: { input_tokens: 100, output_tokens: 20 } };
        }),
    };
    return model;
}

const readTool = { name: 'describe_instances', invoke: vi.fn(async () => 'i-123 running') };
const shellRead = { name: 'execute_command', invoke: vi.fn(async () => 'ok') };
const writeTool = { name: 'write_file', invoke: vi.fn(async () => 'written') };

describe('isReadOnlyForSubagent', () => {
    it('allows an explicit read-only tool', () => {
        expect(isReadOnlyForSubagent('describe_instances').allowed).toBe(true);
    });

    it('allows a read-only shell command', () => {
        expect(isReadOnlyForSubagent('execute_command', { command: 'aws ec2 describe-instances' }).allowed).toBe(true);
    });

    it('blocks a mutative shell command', () => {
        const verdict = isReadOnlyForSubagent('execute_command', { command: 'aws ec2 terminate-instances --instance-ids i-1' });
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/mutat/i);
    });

    it('blocks a mutative tool name', () => {
        expect(isReadOnlyForSubagent('write_file').allowed).toBe(false);
    });

    it('blocks an unknown-named tool (fail closed)', () => {
        // classifyTool returns isMutative:false, matchedRule:false for unknowns.
        // In the orchestrator that means "ask the human"; here there is no human,
        // so it must mean "block".
        const verdict = isReadOnlyForSubagent('some_mcp_thing');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/not on the verified read-only list/i);
    });

    it('blocks dispatch_agent so sub-agents cannot recurse', () => {
        expect(isReadOnlyForSubagent('dispatch_agent').allowed).toBe(false);
    });

    it('blocks ask_user — no human is reachable inside a tool call', () => {
        expect(isReadOnlyForSubagent('ask_user').allowed).toBe(false);
    });
});

describe('filterReadOnlyTools', () => {
    it('keeps read-only tools and drops the rest', () => {
        const kept = filterReadOnlyTools([readTool, shellRead, writeTool, { name: 'dispatch_agent' }]);
        expect(kept.map(t => t.name)).toEqual(['describe_instances', 'execute_command']);
    });
});

describe('runSubagent', () => {
    it('returns the final prose as the report', async () => {
        const model = scriptedModel([{ content: 'Found 2 idle instances: i-1, i-2' }]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(result.status).toBe('done');
        expect(result.report).toContain('i-1');
        expect(result.tokensIn).toBe(100);
    });

    it('executes an allowed tool call and loops', async () => {
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }] },
            { content: 'Instance i-123 is running' },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(readTool.invoke).toHaveBeenCalled();
        expect(result.toolCount).toBe(1);
        expect(result.report).toContain('i-123');
    });

    it('refuses a mutative tool call instead of executing it', async () => {
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'write_file', args: { file_path: 'x', content: 'y' } }] },
            { content: 'Understood — reporting instead.' },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [readTool, writeTool], budget: BUDGET });

        expect(writeTool.invoke).not.toHaveBeenCalled();
        expect(result.status).toBe('done');
    });

    it('stops at the iteration cap and marks the report incomplete', async () => {
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }] },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: { ...BUDGET, subagentMaxIterations: 2 } });

        expect(result.report).toMatch(/incomplete/i);
        expect(model.invoke).toHaveBeenCalledTimes(2);
    });

    it('truncates an over-long report', async () => {
        const model = scriptedModel([{ content: 'x'.repeat(SUBAGENT_REPORT_MAX_CHARS + 5000) }]);
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(result.report.length).toBeLessThanOrEqual(SUBAGENT_REPORT_MAX_CHARS + 100);
        expect(result.report).toMatch(/TRUNCATED/);
    });

    it('returns a failed status instead of throwing when the model errors', async () => {
        const model: any = { bindTools: () => model, invoke: vi.fn().mockRejectedValue(new Error('provider down')) };
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: BUDGET });

        expect(result.status).toBe('failed');
        expect(result.report).toMatch(/provider down/);
    });

    it('returns partial findings on timeout', async () => {
        const model: any = {
            bindTools: () => model,
            invoke: vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ content: 'late', tool_calls: [] }), 500))),
        };
        const result = await runSubagent(SPEC, { model, tools: [readTool], budget: { ...BUDGET, subagentTimeoutMs: 50 } });

        expect(result.report).toMatch(/timed out/i);
    });

    it('reports a failing tool without aborting the loop', async () => {
        const boom = { name: 'describe_instances', invoke: vi.fn().mockRejectedValue(new Error('AccessDenied')) };
        const model = scriptedModel([
            { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }] },
            { content: 'Could not read: AccessDenied' },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [boom], budget: BUDGET });

        expect(result.status).toBe('done');
        expect(result.report).toContain('AccessDenied');
    });
});
