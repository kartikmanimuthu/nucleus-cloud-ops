/**
 * aws_read — the ONLY route from a sub-agent to AWS.
 *
 * Sub-agents have no shell (see subagent.ts's denylist). This tool takes a
 * structured request and builds argv itself, then runs `execFile` with
 * shell: false. Nothing the model supplies is ever interpreted by a shell, so the
 * escape classes that broke two previous designs — metacharacters, quoting,
 * flag-order confusion, LD_PRELOAD prefixes, command substitution — are not
 * merely blocked here, they are unrepresentable.
 *
 * Three further restrictions close what a structured call could still reach:
 *  - no positional arguments, so `s3api get-object … OUTFILE` cannot write a file;
 *  - a denied-flag set, so --endpoint-url cannot exfiltrate and --cli-input-json
 *    cannot smuggle parameters past validation;
 *  - a denied-operation set, so credential-minting reads (sts get-session-token,
 *    ecr get-login-password) and mutating "get-" operations
 *    (redshift get-cluster-credentials --auto-create) are refused by name.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildCommandEnv } from './tools';

const execFileAsync = promisify(execFile);

const AWS_READ_TIMEOUT_MS = 120_000;
const AWS_READ_MAX_BUFFER = 10 * 1024 * 1024;
export const AWS_READ_OUTPUT_MAX_CHARS = 100_000;

/** Read-only operation prefixes, by AWS CLI convention. */
const READ_OPERATION_PREFIX = /^(describe|list|get|head|search|lookup|check|batch-get)-/;

/** Operations that match the read prefix but mint credentials or mutate. */
const DENIED_OPERATIONS = new Set([
    'get-session-token', 'get-federation-token', 'get-login-password',
    'get-token', 'get-password-data', 'get-cluster-credentials',
    'get-instance-access-details', 'get-credential-report', 'get-authorization-token',
]);

/** Flags that would let a structured call reach outside its intent. */
const DENIED_FLAGS = new Set([
    '--endpoint-url', '--cli-input-json', '--cli-input-yaml', '--outfile',
    '--debug', '--no-sign-request', '--ca-bundle', '--cli-binary-format',
]);

const IDENT = /^[a-z0-9][a-z0-9-]*$/;
const REGION = /^[a-z0-9-]+$/;
const PROFILE = /^[A-Za-z0-9_-]+$/;
const FLAG = /^--[a-z0-9][a-z0-9-]*$/;

export function validateAwsReadRequest(input: {
    service: string; operation: string; region?: string; profile?: string;
    params?: Record<string, string>;
}): string | null {
    if (!IDENT.test(input.service)) return `service "${input.service}" is not a valid AWS service name`;
    if (!IDENT.test(input.operation)) return `operation "${input.operation}" is not a valid operation name`;
    if (DENIED_OPERATIONS.has(input.operation)) {
        return `operation "${input.operation}" returns credentials or mutates state and is not available to sub-agents`;
    }
    if (!READ_OPERATION_PREFIX.test(input.operation)) {
        return `operation "${input.operation}" is not a read-only operation (must start with describe-, list-, get-, head-, search-, lookup-, check-, or batch-get-)`;
    }
    if (input.region !== undefined && !REGION.test(input.region)) return `invalid region "${input.region}"`;
    if (input.profile !== undefined && !PROFILE.test(input.profile)) return `invalid profile "${input.profile}"`;

    for (const [flag, value] of Object.entries(input.params ?? {})) {
        if (!FLAG.test(flag)) return `parameter "${flag}" is not a valid --flag name`;
        if (DENIED_FLAGS.has(flag)) return `parameter "${flag}" is not available to sub-agents`;
        if (typeof value !== 'string') return `parameter "${flag}" must have a string value`;
    }
    return null;
}

/** Build argv. Exported so tests can assert the exact array without executing anything. */
export function buildAwsReadArgv(input: {
    service: string; operation: string; region?: string; profile?: string;
    params?: Record<string, string>;
}): string[] {
    const argv = [input.service, input.operation];
    if (input.region) argv.push('--region', input.region);
    if (input.profile) argv.push('--profile', input.profile);
    for (const [flag, value] of Object.entries(input.params ?? {})) argv.push(flag, value);
    argv.push('--output', 'json');
    return argv;
}

export function createAwsReadTool(tenantId: string) {
    return tool(
        async (input: {
            service: string; operation: string; region?: string; profile?: string;
            params?: Record<string, string>;
        }): Promise<string> => {
            const error = validateAwsReadRequest(input);
            if (error) return `REFUSED: ${error}`;

            const argv = buildAwsReadArgv(input);
            try {
                // shell: false is the entire safety argument — argv elements are passed
                // to execve directly and are never tokenised or interpreted.
                const { stdout, stderr } = await execFileAsync('aws', argv, {
                    shell: false,
                    timeout: AWS_READ_TIMEOUT_MS,
                    maxBuffer: AWS_READ_MAX_BUFFER,
                    env: buildCommandEnv(tenantId) as NodeJS.ProcessEnv,
                });
                const output = stdout || stderr || '(no output)';
                return output.length > AWS_READ_OUTPUT_MAX_CHARS
                    ? `${output.slice(0, AWS_READ_OUTPUT_MAX_CHARS)}\n…[truncated]`
                    : output;
            } catch (err) {
                const e = err as { message?: string; stderr?: string };
                return `ERROR: ${e.message ?? String(err)}\n${e.stderr ?? ''}`.trim();
            }
        },
        {
            name: 'aws_read',
            description: `Run a READ-ONLY AWS CLI operation. This is your only route to AWS — you have no shell.

Provide the service and operation separately; do not write a command line. Parameters are passed as a map of flag to value.

Example: { "service": "ec2", "operation": "describe-instances", "region": "us-east-1", "profile": "nucleus_agent_123456789012_...", "params": { "--filters": "Name=instance-state-name,Values=running" } }

Only read operations are permitted (describe-, list-, get-, head-, search-, lookup-, check-, batch-get-). Mutations are refused: report what should change in your findings and the main agent will carry it out under human approval.`,
            schema: z.object({
                service: z.string().describe('AWS service, e.g. "ec2", "rds", "cloudwatch"'),
                operation: z.string().describe('Read-only operation, e.g. "describe-instances"'),
                region: z.string().optional().describe('AWS region'),
                profile: z.string().optional().describe('Profile name from get_aws_credentials'),
                params: z.record(z.string(), z.string()).optional()
                    .describe('CLI flags as a map, e.g. { "--instance-ids": "i-123" }'),
            }),
        },
    );
}
