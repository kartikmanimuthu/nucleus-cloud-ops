/**
 * aws_read — the ONLY route from a sub-agent to AWS.
 *
 * Sub-agents have no shell (see subagent.ts's denylist). This tool takes a
 * structured request, builds argv itself, and runs execFile with shell: false, so
 * metacharacters, quoting, command substitution and LD_PRELOAD-style env prefixes
 * are unrepresentable rather than blocked.
 *
 * ALLOWLISTS ONLY. An earlier revision used denylists and was escaped twice:
 *  - argparse has allow_abbrev=True, so every denied flag had an accepted
 *    abbreviation (--endpoint for --endpoint-url). A denylist over an abbreviating
 *    parser is structurally unsound.
 *  - a zero-arity flag ("--no-cli-pager": "/tmp/x") emitted `flag value`, and the
 *    CLI read the value as a POSITIONAL — which for `s3api get-object` is the
 *    outfile. That wrote an arbitrary local file, and a credential_process entry in
 *    ~/.aws/config turned it into arbitrary code execution.
 *
 * Hence every flag declares its ARITY. A zero-arity flag never emits a value token,
 * so no positional can be produced by construction — not by policy.
 *
 * THE ARGV INVARIANT. Arity alone is not sufficient, because the allowlist
 * constrains the KEYS of `params` while the model controls the VALUES, and argparse
 * decides what is a flag by looking at the token. A 'many' flag emits each array
 * element as its own token, so `{"--instance-ids": ["i-1", "--endpoint-url", "…"]}`
 * would have argparse stop consuming at "--endpoint-url" and parse it as a flag —
 * defeating the flag allowlist through the one axis it does not cover. The
 * invariant that closes it, enforced below on every value including region and
 * profile:
 *
 *     No argv token may begin with "-" unless the builder emitted it as a flag.
 *
 * No legitimate AWS value starts with "-" (ids, ARNs, JMESPath expressions,
 * Name=…,Values=… filters, ISO timestamps, epoch seconds), so this costs nothing
 * and makes "the model cannot introduce a flag" structural in the same way arity
 * makes "the model cannot introduce a positional" structural.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildCommandEnv } from './tools';
import { Semaphore } from './concurrency';
import { AuditService } from '@/lib/audit-service';

const execFileAsync = promisify(execFile);

const AWS_READ_TIMEOUT_MS = 120_000;
const AWS_READ_MAX_BUFFER = 10 * 1024 * 1024;
export const AWS_READ_OUTPUT_MAX_CHARS = 100_000;

/**
 * Bounds concurrent `aws` subprocesses. execute_command already has this bound
 * (TOOL_CONCURRENCY) precisely because subprocesses need one; N sub-agents each
 * issuing a parallel turn would otherwise fan out unbounded ~100MB processes in
 * the ECS task.
 */
const AWS_READ_CONCURRENCY = Number(process.env.TOOL_CONCURRENCY) || 6;
const awsReadSemaphore = new Semaphore(AWS_READ_CONCURRENCY);

/**
 * Permitted (service, operation) pairs. Explicit, not prefix-matched: a `get-`
 * prefix proves nothing — `redshift get-cluster-credentials` mutates, and
 * `sts get-session-token`, `sso get-role-credentials`, `ecr get-login-password`
 * and `secretsmanager get-secret-value` all return usable credentials.
 *
 * Add entries as the audit use case needs them. A refusal here is a feature
 * request, never a security incident.
 */
export const ALLOWED_OPS: Record<string, ReadonlySet<string>> = {
    ec2: new Set([
        'describe-instances', 'describe-volumes', 'describe-snapshots', 'describe-images',
        'describe-security-groups', 'describe-vpcs', 'describe-subnets', 'describe-addresses',
        'describe-network-interfaces', 'describe-route-tables', 'describe-nat-gateways',
        'describe-internet-gateways', 'describe-regions', 'describe-availability-zones',
        'describe-instance-types', 'describe-tags',
        'describe-instance-status', 'describe-vpc-endpoints', 'describe-flow-logs',
        // NOT describe-instance-attribute: --attribute userData returns the instance's
        // user-data script, which routinely carries bootstrap credentials. Permanently out.
    ]),
    rds: new Set(['describe-db-instances', 'describe-db-clusters', 'describe-db-snapshots', 'describe-db-cluster-snapshots']),
    elbv2: new Set([
        'describe-load-balancers', 'describe-target-groups', 'describe-target-health',
        'describe-listeners', 'describe-rules',
    ]),
    autoscaling: new Set(['describe-auto-scaling-groups', 'describe-auto-scaling-instances']),
    ecs: new Set(['list-clusters', 'list-services', 'list-tasks', 'describe-clusters', 'describe-services', 'describe-tasks']),
    eks: new Set(['list-clusters', 'describe-cluster', 'list-nodegroups', 'describe-nodegroup']),
    // NOTE: get-function-configuration returns Environment.Variables in plaintext,
    // which routinely holds DB passwords and API keys. Kept because it is the only
    // way to answer ordinary Lambda configuration questions — but sub-agent reports
    // reach orchestrator context and, once Task 11 lands, Postgres. Revisit before
    // transcript persistence ships.
    lambda: new Set(['list-functions', 'get-function-configuration']),
    s3api: new Set([
        'list-buckets', 'get-bucket-location', 'get-bucket-tagging', 'get-bucket-encryption',
        'get-bucket-versioning', 'get-bucket-policy', 'get-bucket-acl', 'get-public-access-block',
        'get-bucket-logging', 'list-objects-v2',
        // NOT get-object: its outfile is a POSITIONAL, i.e. an arbitrary local file write.
    ]),
    cloudwatch: new Set(['get-metric-statistics', 'get-metric-data', 'list-metrics', 'describe-alarms']),
    logs: new Set(['describe-log-groups', 'describe-log-streams', 'filter-log-events', 'get-log-events']),
    cloudformation: new Set(['list-stacks', 'describe-stacks', 'describe-stack-resources']),
    cloudtrail: new Set(['lookup-events']),
    iam: new Set([
        'list-roles', 'list-policies', 'get-role', 'get-policy', 'list-attached-role-policies',
        'get-policy-version', 'list-role-policies', 'get-role-policy', 'list-users',
        'list-attached-user-policies',
        // NOT get-credential-report.
    ]),
    organizations: new Set(['list-accounts', 'describe-organization', 'list-accounts-for-parent', 'list-tags-for-resource']),
    acm: new Set(['list-certificates', 'describe-certificate']),
    kms: new Set(['list-keys', 'describe-key', 'list-aliases']),
    route53: new Set(['list-hosted-zones', 'list-resource-record-sets']),
    cloudfront: new Set(['list-distributions']),
    sts: new Set(['get-caller-identity']),
    ce: new Set(['get-cost-and-usage', 'get-cost-forecast', 'get-dimension-values']),
    tag: new Set(['get-resources']),
    // Deliberately absent: ssm (get-parameter returns SecureString plaintext),
    // secretsmanager, sso, ecr, redshift, cognito-identity, and the `s3` command set
    // (cp/sync/mv write files and mutate buckets — s3api is the read-only surface).
};

/**
 * Permitted flags and how many values each consumes.
 *  - 'none' — a boolean flag. Value MUST be `true`; the flag is emitted alone, so
 *    no value token exists to be mistaken for a positional.
 *  - 'one'  — exactly one value.
 *  - 'many' — one or more values (e.g. --instance-ids i-1 i-2).
 *
 * --profile, --region and --output are deliberately absent: the builder supplies
 * them from validated fields, and allowing them here would let a later duplicate
 * override the validated one (the AWS CLI takes the last occurrence).
 *
 * Every entry is a resource selector, a filter, or pagination — the parameters an
 * allowlisted operation needs to be callable at all. An operation on ALLOWED_OPS
 * whose required parameter is missing here is not actually available (e.g.
 * `elbv2 describe-target-health` without --target-group-arn), which is the
 * uselessness that pushes users back toward a shell. Nothing here changes WHERE the
 * CLI connects, WHAT credentials it uses, or WHERE it writes.
 */
export const ALLOWED_FLAGS: Record<string, 'none' | 'one' | 'many'> = {
    // Filters, queries and pagination (cross-service)
    '--filters': 'many',
    '--filter': 'many',
    '--query': 'one',
    '--max-items': 'one',
    '--max-results': 'one',
    '--max-keys': 'one',
    '--limit': 'one',
    '--starting-token': 'one',
    '--continuation-token': 'one',
    '--page-size': 'one',
    '--no-paginate': 'none',
    '--include-deleted': 'none',

    // EC2
    '--instance-ids': 'many',
    '--instance-types': 'many',
    '--volume-ids': 'many',
    '--snapshot-ids': 'many',
    '--owner-ids': 'many',
    '--owners': 'many',
    '--image-ids': 'many',
    '--group-ids': 'many',
    '--group-names': 'many',
    '--vpc-ids': 'many',
    '--subnet-ids': 'many',
    '--route-table-ids': 'many',
    '--network-interface-ids': 'many',
    '--nat-gateway-ids': 'many',
    '--internet-gateway-ids': 'many',
    '--vpc-endpoint-ids': 'many',
    '--flow-log-ids': 'many',
    '--allocation-ids': 'many',
    '--public-ips': 'many',
    '--region-names': 'many',
    '--zone-names': 'many',
    '--include-all-instances': 'none',

    // RDS
    '--db-instance-identifier': 'one',
    '--db-cluster-identifier': 'one',
    '--db-snapshot-identifier': 'one',
    '--snapshot-type': 'one',

    // ELBv2
    '--load-balancer-arn': 'one',
    '--load-balancer-arns': 'many',
    '--target-group-arn': 'one',
    '--target-group-arns': 'many',
    '--listener-arn': 'one',
    '--listener-arns': 'many',
    '--rule-arns': 'many',

    // Auto Scaling / ECS / EKS
    '--auto-scaling-group-names': 'many',
    '--cluster': 'one',
    '--clusters': 'many',
    '--cluster-name': 'one',
    '--nodegroup-name': 'one',
    '--service': 'one',
    '--services': 'many',
    '--tasks': 'many',
    '--name': 'one',
    '--names': 'many',

    // Lambda
    '--function-name': 'one',
    '--qualifier': 'one',

    // S3 (s3api)
    '--bucket': 'one',
    '--prefix': 'one',
    '--delimiter': 'one',

    // CloudWatch
    '--metric-name': 'one',
    '--metric': 'one',
    '--namespace': 'one',
    '--dimensions': 'many',
    '--statistics': 'many',
    '--period': 'one',
    '--metric-data-queries': 'many',
    '--scan-by': 'one',
    '--alarm-names': 'many',
    '--state-value': 'one',

    // Logs / CloudTrail
    '--log-group-name': 'one',
    '--log-group-name-prefix': 'one',
    '--log-stream-name': 'one',
    '--log-stream-names': 'many',
    '--filter-pattern': 'one',
    '--start-from-head': 'none',
    '--lookup-attributes': 'many',

    // CloudFormation
    '--stack-name': 'one',

    // IAM
    '--role-name': 'one',
    '--user-name': 'one',
    '--policy-arn': 'one',
    '--policy-name': 'one',
    '--version-id': 'one',
    '--path-prefix': 'one',

    // Organizations / ACM / KMS / Route 53
    '--parent-id': 'one',
    '--resource-id': 'one',
    '--certificate-arn': 'one',
    '--certificate-statuses': 'many',
    '--key-id': 'one',
    '--hosted-zone-id': 'one',
    '--start-record-name': 'one',

    // Time windows and Cost Explorer
    '--start-time': 'one',
    '--end-time': 'one',
    '--time-period': 'one',
    '--granularity': 'one',
    '--metrics': 'many',
    '--group-by': 'many',
    '--dimension': 'one',
    '--search-string': 'one',

    // Resource Groups Tagging
    '--resource-type-filters': 'many',
    '--tag-filters': 'many',
};

export type ParamValue = string | string[] | true;

const SERVICE = /^[a-z0-9][a-z0-9-]*$/;
/**
 * Anchored to a leading letter, not merely to the lowercase-and-hyphen character
 * class: `^[a-z0-9-]+$` matches the literal string "--endpoint-url", which would
 * put an option-looking token in argv and leave safety resting on argparse's error
 * handling. Same reasoning for PROFILE's leading character class.
 */
const REGION = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Own-property lookup. Both maps are plain objects, so a bare index would resolve
 * inherited keys: `ALLOWED_OPS['constructor']` returns the Object constructor
 * (truthy, and `.has` is undefined — a TypeError thrown out of a function whose
 * contract is to return a refusal string), and `ALLOWED_FLAGS['constructor']`
 * likewise reads as a defined arity.
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export interface AwsReadRequest {
    service: string;
    operation: string;
    region?: string;
    profile?: string;
    params?: Record<string, ParamValue>;
}

/** Returns an error string for a refusal, or null when the request is permitted. */
export function validateAwsReadRequest(input: AwsReadRequest): string | null {
    if (typeof input?.service !== 'string' || !SERVICE.test(input.service)) {
        return `service "${input?.service}" is not a permitted AWS service`;
    }
    const operations = own(ALLOWED_OPS, input.service);
    if (!operations) {
        return `service "${input.service}" is not available to sub-agents (permitted: ${Object.keys(ALLOWED_OPS).join(', ')})`;
    }
    if (typeof input.operation !== 'string' || !operations.has(input.operation)) {
        return `operation "${input.operation}" is not a permitted read-only operation for ${input.service}`;
    }
    if (input.region !== undefined && (typeof input.region !== 'string' || !REGION.test(input.region))) {
        return `invalid region "${input.region}"`;
    }
    if (input.profile !== undefined && (typeof input.profile !== 'string' || !PROFILE.test(input.profile))) {
        return `invalid profile "${input.profile}"`;
    }

    for (const [flag, value] of Object.entries(input.params ?? {})) {
        const arity = own(ALLOWED_FLAGS, flag);
        if (!arity) return `parameter "${flag}" is not a permitted flag`;

        if (arity === 'none') {
            // A value here is exactly the positional-smuggling vector.
            if (value !== true) return `parameter "${flag}" takes no value — pass true`;
            continue;
        }
        const values = Array.isArray(value) ? value : [value];
        if (values.length === 0) return `parameter "${flag}" requires a value`;
        if (arity === 'one' && values.length !== 1) return `parameter "${flag}" takes exactly one value`;
        for (const v of values) {
            if (typeof v !== 'string' || v.length === 0) return `parameter "${flag}" values must be non-empty strings`;
            // The argv invariant. A 'many' flag emits each element as its own
            // token, so a value beginning with "-" would be parsed by the CLI as a
            // FLAG — which is how the flag allowlist gets bypassed through the one
            // axis it does not constrain.
            if (v.startsWith('-')) {
                return `parameter "${flag}" values must not begin with "-" (a value starting with a dash would be parsed as a flag)`;
            }
        }
    }
    return null;
}

/**
 * Build argv. Exported so tests can assert the exact array without executing.
 * Every emitted token is either a flag or a value belonging to a flag of declared
 * non-zero arity — so a positional argument cannot be produced.
 */
export function buildAwsReadArgv(input: AwsReadRequest): string[] {
    const argv = [input.service, input.operation];
    if (input.region) argv.push('--region', input.region);
    if (input.profile) argv.push('--profile', input.profile);
    for (const [flag, value] of Object.entries(input.params ?? {})) {
        // own(): the builder is exported and independently callable, and "cannot
        // emit a positional" must hold on its own rather than by trusting its
        // caller to have validated first.
        if (own(ALLOWED_FLAGS, flag) === 'none') { argv.push(flag); continue; }
        argv.push(flag, ...(Array.isArray(value) ? value : [value as string]));
    }
    argv.push('--output', 'json');
    return argv;
}

export function createAwsReadTool(tenantId: string, userId?: string) {
    return tool(
        async (input: AwsReadRequest): Promise<string> => {
            const error = validateAwsReadRequest(input);
            if (error) return `REFUSED: ${error}`;

            const argv = buildAwsReadArgv(input);

            // Sub-agent AWS activity has no human gate, so it must be auditable.
            // Fire-and-forget: an audit failure must never block the read.
            AuditService.logResourceAction({
                eventType: 'agent.subagent.aws_read',
                action: 'aws_read',
                resourceType: 'agent_tool',
                resourceId: 'aws_read',
                resourceName: 'Sub-agent AWS read',
                status: 'success',
                details: `aws ${argv.join(' ')}`.slice(0, 2000),
                user: userId || 'subagent',
                userType: userId ? 'user' : 'system',
                source: 'agent',
                severity: 'low',
                tenantId,
                metadata: { tenantId, service: input.service, operation: input.operation },
            }).catch(() => {});

            try {
                return await awsReadSemaphore.run(async () => {
                    // shell: false is the safety argument — argv elements go to execve
                    // directly and are never tokenised or interpreted.
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
                });
            } catch (err) {
                const e = err as { message?: string; stderr?: string };
                return `ERROR: ${e.message ?? String(err)}\n${e.stderr ?? ''}`.trim();
            }
        },
        {
            name: 'aws_read',
            description: `Run a permitted READ-ONLY AWS CLI operation. This is your only route to AWS — you have no shell.

Give the service and operation separately; never write a command line. Parameters are a map of flag to value, where a value is a string, an array of strings for multi-value flags, or true for flags that take no value. A value may not begin with "-".

Example:
{ "service": "ec2", "operation": "describe-instances", "region": "us-east-1", "profile": "nucleus_agent_...", "params": { "--instance-ids": ["i-1", "i-2"], "--no-paginate": true } }

Only an explicit allowlist of services and operations is permitted. If you need one that is refused, say so in your findings rather than trying to work around it — mutations and credential-returning operations are deliberately unavailable, and the main agent will carry out any change under human approval.`,
            schema: z.object({
                service: z.string().describe('AWS service, e.g. "ec2", "rds", "cloudwatch"'),
                operation: z.string().describe('Read-only operation, e.g. "describe-instances"'),
                region: z.string().optional().describe('AWS region'),
                profile: z.string().optional().describe('Profile name from get_aws_credentials'),
                params: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.literal(true)]))
                    .optional()
                    .describe('Flags: string, string[] for multi-value, or true for valueless flags'),
            }),
        },
    );
}
