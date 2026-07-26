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
        // Step 6 replaced the shell blocklist with an allowlist, so the reason is
        // now non-membership ("not a verified read-only operation") rather than a
        // matched mutative pattern. The refusal itself is what matters.
        expect(verdict.reason).toMatch(/shell call refused/i);
        expect(verdict.reason).toContain('terminate-instances');
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

describe('shell allowlist — proven bypasses of the old blocklist', () => {
    const REFUSED = [
        'aws --region us-east-1 ec2 terminate-instances --instance-ids i-1',
        'aws --profile prod ec2 stop-instances --instance-ids i-1',
        'aws ec2 "terminate-instances" --instance-ids i-1',
        "aws ec2 'delete-security-group' --group-id sg-1",
        'aws ec2 authorize-security-group-ingress --group-id sg-1 --port 22 --cidr 0.0.0.0/0',
        'aws ecs execute-command --cluster c --task t --command /bin/sh',
        'aws s3 sync ./evil s3://prod-bucket --delete',
        'aws s3 cp ./evil.sh s3://prod-bucket/boot.sh',
        'aws rds restore-db-instance-from-db-snapshot --db-instance-identifier x',
        'aws kms schedule-key-deletion --key-id k --pending-window-in-days 7',
        'aws cloudformation cancel-update-stack --stack-name s',
        'pulumi up --stack prod --yes',
        'pulumi destroy --yes',
        'python3 -c import boto3',
        'rm important.tf',
        'rm -r /app/data',
        'kubectl run evil --image=alpine',
        'kubectl delete pod x',
        'npm run deploy:prod',
        'bash deploy.sh',
        'node ./scripts/wipe.js',
        'echo pwned > /app/config.json',                 // metacharacter
        'aws ec2 describe-instances && rm -rf /',         // metacharacter
        'aws ec2 describe-instances; pulumi destroy',     // metacharacter
        'aws ec2 describe-instances $(rm -rf /)',         // metacharacter
    ];

    for (const cmd of REFUSED) {
        it(`refuses: ${cmd}`, () => {
            expect(isReadOnlyForSubagent('execute_command', { command: cmd }).allowed).toBe(false);
        });
    }

    const ALLOWED = [
        'aws ec2 describe-instances --output json',
        'aws --region us-east-1 ec2 describe-instances',
        'AWS_PROFILE=nucleus_agent_1 aws ec2 describe-instances',
        'aws --profile p --region r rds describe-db-instances',
        'aws sts get-caller-identity',
        'aws cloudwatch get-metric-statistics --metric-name CPUUtilization',
        'aws logs filter-log-events --log-group-name x',
        'aws s3 ls s3://bucket',
        'kubectl get pods -n default',
        'kubectl describe pod x',
        'kubectl logs pod/x',
        'cat /tmp/report.json',
        'ls -la /tmp',
        'grep -r error /var/log',
        'jq .Reservations /tmp/out.json',
    ];

    for (const cmd of ALLOWED) {
        it(`allows: ${cmd}`, () => {
            expect(isReadOnlyForSubagent('execute_command', { command: cmd }).allowed).toBe(true);
        });
    }

    it('refuses a bash-like call with no usable command string', () => {
        // classifyTool fails OPEN on {} and stringifies an array into a
        // comma-joined string that matches no mutative pattern.
        expect(isReadOnlyForSubagent('execute_command', {}).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', undefined).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', { command: ['aws', 'ec2', 'terminate-instances'] } as never).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', { command: '' }).allowed).toBe(false);
        expect(isReadOnlyForSubagent('execute_command', { command: 0 } as never).allowed).toBe(false);
    });

    it('applies the allowlist to every bash-like tool name, any case', () => {
        for (const name of ['bash', 'shell', 'run_command', 'EXECUTE_COMMAND', 'Bash']) {
            expect(isReadOnlyForSubagent(name, { command: 'pulumi destroy --yes' }).allowed).toBe(false);
            expect(isReadOnlyForSubagent(name, { command: 'aws ec2 describe-instances' }).allowed).toBe(true);
        }
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
