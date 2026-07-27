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

    it('blocks a shell command however read-only it looks', () => {
        // Sub-agents have no shell at all. Two designs that judged the command
        // string were escaped, the second to RCE, so the string is never parsed:
        // the tool name alone decides.
        const verdict = isReadOnlyForSubagent('execute_command', { command: 'aws ec2 describe-instances' });
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/not available to sub-agents/);
    });

    it('blocks a mutative shell command', () => {
        const verdict = isReadOnlyForSubagent('execute_command', { command: 'aws ec2 terminate-instances --instance-ids i-1' });
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/not available to sub-agents/);
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

    it('blocks denylisted tools regardless of case', () => {
        // classifyTool lowercases internally, so once dispatch_agent joins its
        // READ_ONLY_ALLOWLIST (Task 8) a case-sensitive denylist would let
        // "Dispatch_Agent" through as allowlisted-read-only — re-enabling
        // sub-agent recursion. Pin the lowercasing.
        for (const name of ['Dispatch_Agent', 'DISPATCH_AGENT', 'Ask_User', 'ASK_USER']) {
            expect(isReadOnlyForSubagent(name).allowed).toBe(false);
        }
    });

    it('blocks ask_user — no human is reachable inside a tool call', () => {
        expect(isReadOnlyForSubagent('ask_user').allowed).toBe(false);
    });
});

describe('filterReadOnlyTools', () => {
    it('keeps read-only tools and drops the rest', () => {
        const kept = filterReadOnlyTools([readTool, shellRead, writeTool, { name: 'dispatch_agent' }]);
        expect(kept.map(t => t.name)).toEqual(['describe_instances']);
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

describe('transcript redaction runs before truncation', () => {
    /** Per-tool output cap inside a sub-agent (subagent.ts). */
    const CAP = 4000;

    /**
     * A `lambda get-function-configuration` response comfortably over the cap —
     * which a real one is, routinely. `BOOTSTRAP` is deliberately NOT secret-shaped:
     * only the `Environment.Variables` LOCATION rule catches it, and that rule needs
     * JSON that still parses. Truncate first and the redactor falls through to its
     * regex path, where the strongest rule does not exist.
     */
    function bigLambdaConfig(): string {
        const vars: Record<string, string> = { BOOTSTRAP: 'hunter2', DB_PASSWORD: 'letmein' };
        for (let i = 0; i < 120; i++) vars[`PLAIN_SETTING_${i}`] = 'x'.repeat(30);
        return JSON.stringify({ FunctionName: 'api-worker', Environment: { Variables: vars } });
    }

    const lambdaRun = async (payload: string) => {
        const tool = { name: 'get_function_configuration', invoke: vi.fn(async () => payload) };
        const model = scriptedModel([
            { content: 'reading the configuration', tool_calls: [{ id: 't1', name: 'get_function_configuration', args: {} }] },
            { content: 'BOOTSTRAP is set in plaintext.' },
        ]);
        const result = await runSubagent(SPEC, { model, tools: [tool], budget: BUDGET });
        return { result, model };
    };

    it('keeps the location rule alive on an over-cap payload', async () => {
        const payload = bigLambdaConfig();
        expect(payload.length).toBeGreaterThan(CAP);

        const { result } = await lambdaRun(payload);
        const toolEntry = result.transcript.find(e => e.kind === 'tool')!;

        expect(toolEntry.text).not.toContain('hunter2');
        // The key survives: an operator must still see that BOOTSTRAP exists.
        expect(toolEntry.text).toContain('BOOTSTRAP');
    });

    it('still caps the transcript entry at the per-tool limit', async () => {
        const { result } = await lambdaRun(bigLambdaConfig());
        const toolEntry = result.transcript.find(e => e.kind === 'tool')!;

        expect(toolEntry.text.length).toBeLessThanOrEqual(CAP + 3);
    });

    it('does not change what the sub-agent model sees', async () => {
        // Redaction is a PERSISTENCE-boundary concern. The location rule redacts
        // EVERY value under `Variables`, benign ones included — correct for at-rest
        // storage, wrong for a live agent that has to answer "which function still
        // points at the deprecated table". The model-visible copy stays raw.
        const payload = bigLambdaConfig();
        const { model } = await lambdaRun(payload);

        const messages = model.invoke.mock.calls[0][0] as Array<{ content?: unknown }>;
        const toolMessage = messages.find(m => typeof m.content === 'string' && (m.content as string).includes('FunctionName'))!;

        expect(toolMessage.content).toBe(payload.slice(0, CAP) + '...');
    });
});

describe('shell is unavailable to sub-agents', () => {
    it('refuses every bash-like tool name in any case', () => {
        for (const name of ['bash', 'shell', 'run_command', 'execute_command', 'Execute_Command', 'EXECUTE_COMMAND']) {
            const verdict = isReadOnlyForSubagent(name, { command: 'aws ec2 describe-instances' });
            expect(verdict.allowed).toBe(false);
            expect(verdict.reason).toMatch(/not available to sub-agents/);
        }
    });

    it('drops shell tools from the filtered list', () => {
        const kept = filterReadOnlyTools([
            { name: 'describe_instances' }, { name: 'execute_command' },
            { name: 'bash' }, { name: 'dispatch_agent' }, { name: 'ask_user' },
        ]);
        expect(kept.map(t => t.name)).toEqual(['describe_instances']);
    });
});

describe('timeout cancellation', () => {
    it('stops the loop instead of leaving it running', async () => {
        let laps = 0;
        const model: any = {
            bindTools: () => model,
            invoke: async () => {
                laps++;
                await new Promise(r => setTimeout(r, 30));
                return { content: '', tool_calls: [{ id: `${laps}`, name: 'describe_instances', args: {} }], usage_metadata: { input_tokens: 10, output_tokens: 5 } };
            },
        };
        const tool = { name: 'describe_instances', invoke: async () => 'ok' };

        await runSubagent(SPEC, { model, tools: [tool], budget: { ...BUDGET, subagentMaxIterations: 20, subagentTimeoutMs: 60 } });
        const lapsAtReturn = laps;

        // If the loop were abandoned rather than cancelled it would keep going.
        await new Promise(r => setTimeout(r, 300));
        expect(laps).toBeLessThanOrEqual(lapsAtReturn + 1);
    });

    it('reports real usage on timeout rather than zeros', async () => {
        const model: any = {
            bindTools: () => model,
            invoke: async () => {
                await new Promise(r => setTimeout(r, 30));
                return { content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }], usage_metadata: { input_tokens: 100, output_tokens: 20 } };
            },
        };
        const tool = { name: 'describe_instances', invoke: async () => 'ok' };

        const result = await runSubagent(SPEC, { model, tools: [tool], budget: { ...BUDGET, subagentMaxIterations: 20, subagentTimeoutMs: 80 } });
        expect(result.tokensIn).toBeGreaterThan(0);
    });
});

describe('runSubagent totality', () => {
    it('does not throw on a malformed budget', async () => {
        const model: any = { bindTools: () => model, invoke: async () => ({ content: 'x', tool_calls: [] }) };
        await expect(
            runSubagent(SPEC, { model, tools: [], budget: undefined as never }),
        ).resolves.toMatchObject({ status: 'failed' });
    });
});

describe('hallucinated tool names', () => {
    it('refuses a tool that passes the jail but is not in the tool list', async () => {
        // The second layer's whole purpose: the model invents a name it was never given.
        const model: any = {
            bindTools: () => model,
            invoke: vi.fn()
                .mockResolvedValueOnce({ content: '', tool_calls: [{ id: '1', name: 'describe_instances', args: {} }], usage_metadata: {} })
                .mockResolvedValueOnce({ content: 'Could not read it.', tool_calls: [], usage_metadata: {} }),
        };
        const result = await runSubagent(SPEC, { model, tools: [], budget: BUDGET });
        expect(result.status).toBe('done');
        expect(result.transcript.some(e => e.text.includes('REFUSED'))).toBe(true);
    });
});
