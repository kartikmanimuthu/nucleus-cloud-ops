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
 *
 * THE VALUE AXIS. That invariant is still a denylist ("must not start with -"), and
 * it was escaped by a value that starts with a letter: `file://…`, which the CLI
 * dereferences and echoes back on a parse error. Values are therefore validated
 * POSITIVELY — every flag declares the SHAPE its values must match — with the
 * dash rule and an explicit URI-scheme rule kept as cheap backstops. See
 * ValueShape below for why no shape can match a scheme.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildCommandEnv } from './tools';
import { Semaphore } from './concurrency';
import { markSubagentReadOnlyTool } from './subagent-tool-marker';
import { AuditService } from '@/lib/audit-service';

// Re-exported so the marker reads as part of this tool's contract; it lives in its
// own module so subagent.ts can check it without importing the AWS SDK.
export { SUBAGENT_READ_ONLY_TOOL, hasSubagentReadOnlyMarker } from './subagent-tool-marker';

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
        'describe-network-acls', 'describe-vpc-peering-connections', 'describe-transit-gateways',
        // NOT describe-instance-attribute: --attribute userData returns the instance's
        // user-data script, which routinely carries bootstrap credentials. Permanently out.
    ]),
    rds: new Set([
        'describe-db-instances', 'describe-db-clusters', 'describe-db-snapshots',
        'describe-db-cluster-snapshots', 'describe-db-subnet-groups', 'describe-events',
    ]),
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
        'get-bucket-logging', 'list-objects-v2', 'list-object-versions',
        'get-bucket-lifecycle-configuration',
        // NOT get-object: its outfile is a POSITIONAL, i.e. an arbitrary local file write.
    ]),
    cloudwatch: new Set([
        'get-metric-statistics', 'get-metric-data', 'list-metrics', 'describe-alarms',
        'describe-alarm-history',
    ]),
    logs: new Set([
        'describe-log-groups', 'describe-log-streams', 'filter-log-events', 'get-log-events',
        // start-query reads: it submits a Logs Insights query over existing log data and
        // returns a query id. Despite the "start-" prefix it creates no durable resource
        // and mutates nothing; get-query-results collects the rows.
        'start-query', 'get-query-results',
    ]),
    cloudformation: new Set(['list-stacks', 'describe-stacks', 'describe-stack-resources']),
    cloudtrail: new Set(['lookup-events']),
    iam: new Set([
        'list-roles', 'list-policies', 'get-role', 'get-policy', 'list-attached-role-policies',
        'get-policy-version', 'list-role-policies', 'get-role-policy', 'list-users',
        'list-attached-user-policies', 'get-user', 'list-user-policies', 'get-user-policy',
        'list-access-keys', 'list-mfa-devices', 'get-account-summary',
        'get-account-password-policy', 'list-groups',
        // NOT get-credential-report. list-access-keys returns key IDs and status only —
        // never the secret, which AWS does not expose through any API.
    ]),
    // Compliance and security-posture reads. Findings can be verbose but carry no
    // credentials; every entry here is a list/describe/get over existing findings.
    config: new Set([
        'describe-config-rules', 'describe-compliance-by-config-rule',
        'get-compliance-details-by-config-rule',
    ]),
    guardduty: new Set(['list-detectors', 'list-findings', 'get-findings']),
    securityhub: new Set(['get-findings', 'describe-hub']),
    accessanalyzer: new Set(['list-analyzers', 'list-findings']),
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
 * THE VALUE AXIS. Arity and the flag allowlist together fix WHICH tokens argv may
 * contain and WHERE; neither says anything about what a value may CONTAIN, and the
 * only content rule used to be a denylist ("must not start with `-`"). That was
 * escaped: the AWS CLI dereferences a `file://` prefix on every SERVICE parameter,
 * reads the target, and on a JSON parse failure echoes the FULL file contents in its
 * error — which this tool returns to the model verbatim. Measured:
 *
 *     { service: 'ce', operation: 'get-cost-and-usage',
 *       params: { '--time-period': 'file:///etc/passwd' } }
 *
 * turned into `Error parsing parameter '--time-period': Invalid JSON:` followed by
 * the file. In the ECS task the reachable targets are the tenant credentials file
 * (live STS credentials for every assumed customer role) and /proc/1/environ
 * (DATABASE_URL, NEXTAUTH_SECRET, COGNITO_APP_CLIENT_SECRET). `fileb://` is the same
 * handler; `http(s)://` differs only by `cli_follow_urlparam`, a config default we
 * inherit rather than enforce (see buildCommandEnv, which now pins AWS_CONFIG_FILE).
 *
 * A denylist over a parser nobody enumerated is the same structural mistake that
 * argparse's `allow_abbrev` already punished twice. So every flag now declares the
 * SHAPE its values must MATCH, and a value is refused unless it matches. The shapes
 * are chosen so that **no shape can match a leading URI scheme**:
 *
 *  - id / name / timestamp / int / token contain no ":" at all;
 *  - code allows ":" but no segment may contain "/";
 *  - arn must begin with the literal "arn:";
 *  - filter must contain "=" before any "/", or be a JSON document;
 *  - jmespath contains no "/";
 *  - expr (free-text query bodies, which genuinely need both ":" and "/") carries
 *    the scheme exclusion in its own pattern.
 *
 * That property is asserted over every shape in the tests, and the standalone scheme
 * check in validateAwsReadRequest is a redundant backstop, not the mechanism.
 */
export type ValueShape =
    | 'id' | 'name' | 'code' | 'arn' | 'filter'
    | 'jmespath' | 'expr' | 'timestamp' | 'int' | 'token';

/** `Name=k,Values=v1,v2` shorthand — a key, "=", then values. */
const SHORTHAND = /^[A-Za-z0-9:._-]+=[A-Za-z0-9:._*\/, +-]*(,[A-Za-z0-9:._-]+=[A-Za-z0-9:._*\/, +-]*)*$/;

export const VALUE_SHAPES: Record<ValueShape, (v: string) => boolean> = {
    /** Resource identifiers, bucket names, log-group names. No ":" — so no scheme. */
    id: v => /^[A-Za-z0-9\/][A-Za-z0-9._\/-]*$/.test(v),
    /**
     * Human-ish names: security groups, log streams (`2026/07/26/[$LATEST]abc`),
     * S3 prefixes, namespaces. Spaces and brackets allowed; ":" is not.
     */
    name: v => /^[A-Za-z0-9\/][A-Za-z0-9 ._\/\[\]$*@+=,-]*$/.test(v),
    /**
     * API enum values and colon-qualified type codes (`RUNNING`, `ec2:instance`,
     * `tag:env`). Colons separate segments; no segment may contain "/", so "://"
     * is unrepresentable.
     */
    code: v => /^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9._*-]*)*$/.test(v),
    /**
     * An ARN, or the bare identifier the same API accepts in its place
     * (`--cluster prod`, `--key-id alias/aws/s3`). Both alternatives are anchored.
     */
    arn: v => /^arn:[A-Za-z0-9-]*:[A-Za-z0-9-]*:[A-Za-z0-9-]*:[0-9]*:[A-Za-z0-9._\/:+=@-]+$/.test(v)
        || VALUE_SHAPES.id(v),
    /**
     * Structured parameters: `Name=…,Values=…` shorthand, or a JSON document. The
     * JSON branch demands a leading "[" or "{" AND that it actually parses, which is
     * a positive test rather than a prefix guess.
     */
    filter: v => SHORTHAND.test(v) || (/^[\[{]/.test(v) && jsonParses(v)),
    /**
     * JMESPath: `Reservations[?State.Name=='running'].[InstanceId,Tags[?Key=='Name']]`.
     * Needs "?", quotes, braces and ":" (slices, multiselect hashes); deliberately no
     * "/", which is what keeps a scheme unrepresentable.
     */
    jmespath: v => /^[A-Za-z0-9_.\[\]|*()@'"?{}!=<>&,$: `-]+$/.test(v),
    /**
     * Free-text query bodies that genuinely need both ":" and "/" — CloudWatch Logs
     * filter patterns (`{ $.errorCode = "*Unauthorized*" }`) and Logs Insights query
     * strings (`fields @message | filter @message like /ERROR/`). Printable text that
     * does not BEGIN with a URI scheme; the CLI only expands a scheme at position 0.
     */
    expr: v => /^(?![A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\x00-\x1f]+$/.test(v),
    /** ISO-8601, or epoch seconds/milliseconds. */
    timestamp: v => /^([0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.+Z-]*)?|[0-9]{1,19})$/.test(v),
    int: v => /^[0-9]{1,10}$/.test(v),
    /** Opaque pagination tokens — base64url and friends. No ":". */
    token: v => /^[A-Za-z0-9+\/=_.-]+$/.test(v),
};

function jsonParses(v: string): boolean {
    try { JSON.parse(v); return true; } catch { return false; }
}

interface FlagSpec {
    /**
     *  - 'none' — a boolean flag. Value MUST be `true`; the flag is emitted alone, so
     *    no value token exists to be mistaken for a positional.
     *  - 'one'  — exactly one value.
     *  - 'many' — one or more values (e.g. --instance-ids i-1 i-2).
     */
    arity: 'none' | 'one' | 'many';
    /** Omitted only for 'none', which has no value to shape. */
    shape?: ValueShape;
}

const none: FlagSpec = { arity: 'none' };
const one = (shape: ValueShape): FlagSpec => ({ arity: 'one', shape });
const many = (shape: ValueShape): FlagSpec => ({ arity: 'many', shape });

/**
 * Permitted flags, each with its arity and the shape its values must match.
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
export const ALLOWED_FLAGS: Record<string, FlagSpec> = {
    // Filters, queries and pagination (cross-service)
    '--filters': many('filter'),
    '--filter': many('filter'),
    '--query': one('jmespath'),
    '--max-items': one('int'),
    '--max-results': one('int'),
    '--max-keys': one('int'),
    '--limit': one('int'),
    '--starting-token': one('token'),
    '--continuation-token': one('token'),
    '--next-page-token': one('token'),
    '--page-size': one('int'),
    '--no-paginate': none,
    '--include-deleted': none,

    // EC2
    '--instance-ids': many('id'),
    '--instance-types': many('id'),
    '--volume-ids': many('id'),
    '--snapshot-ids': many('id'),
    '--owner-ids': many('id'),
    '--owners': many('id'),
    '--image-ids': many('id'),
    '--group-ids': many('id'),
    '--group-names': many('name'),
    '--vpc-ids': many('id'),
    '--subnet-ids': many('id'),
    '--route-table-ids': many('id'),
    '--network-interface-ids': many('id'),
    '--nat-gateway-ids': many('id'),
    '--internet-gateway-ids': many('id'),
    '--vpc-endpoint-ids': many('id'),
    '--flow-log-ids': many('id'),
    '--allocation-ids': many('id'),
    '--public-ips': many('id'),
    '--region-names': many('id'),
    '--zone-names': many('id'),
    '--network-acl-ids': many('id'),
    '--vpc-peering-connection-ids': many('id'),
    '--transit-gateway-ids': many('id'),
    '--include-all-instances': none,

    // RDS
    '--db-instance-identifier': one('id'),
    '--db-cluster-identifier': one('id'),
    '--db-snapshot-identifier': one('id'),
    '--db-subnet-group-name': one('id'),
    '--snapshot-type': one('code'),
    '--source-identifier': one('id'),
    '--source-type': one('code'),
    '--event-categories': many('name'),
    '--duration': one('int'),

    // ELBv2
    '--load-balancer-arn': one('arn'),
    '--load-balancer-arns': many('arn'),
    '--target-group-arn': one('arn'),
    '--target-group-arns': many('arn'),
    '--listener-arn': one('arn'),
    '--listener-arns': many('arn'),
    '--rule-arns': many('arn'),

    // Auto Scaling / ECS / EKS
    '--auto-scaling-group-names': many('name'),
    '--cluster': one('arn'),
    '--clusters': many('arn'),
    '--cluster-name': one('id'),
    '--nodegroup-name': one('id'),
    '--service': one('arn'),
    '--services': many('arn'),
    '--tasks': many('arn'),
    '--name': one('id'),
    '--names': many('name'),

    // Lambda
    '--function-name': one('arn'),
    '--qualifier': one('id'),

    // S3 (s3api)
    '--bucket': one('id'),
    '--prefix': one('name'),
    '--delimiter': one('name'),
    '--key-marker': one('name'),
    '--version-id-marker': one('token'),

    // CloudWatch
    '--metric-name': one('name'),
    '--metric': one('name'),
    '--namespace': one('name'),
    '--dimensions': many('filter'),
    '--statistics': many('code'),
    '--period': one('int'),
    '--metric-data-queries': many('filter'),
    '--scan-by': one('code'),
    '--alarm-names': many('name'),
    '--alarm-name': one('name'),
    '--history-item-type': one('code'),
    '--state-value': one('code'),
    '--start-date': one('timestamp'),
    '--end-date': one('timestamp'),

    // Logs / CloudTrail
    '--log-group-name': one('id'),
    '--log-group-names': many('id'),
    '--log-group-identifiers': many('arn'),
    '--log-group-name-prefix': one('id'),
    '--log-stream-name': one('name'),
    '--log-stream-names': many('name'),
    '--filter-pattern': one('expr'),
    '--query-string': one('expr'),
    '--query-id': one('id'),
    '--start-from-head': none,
    '--lookup-attributes': many('filter'),

    // CloudFormation
    '--stack-name': one('id'),

    // IAM
    '--role-name': one('id'),
    '--user-name': one('id'),
    '--policy-arn': one('arn'),
    '--policy-name': one('id'),
    '--version-id': one('id'),
    '--path-prefix': one('name'),

    // Organizations / ACM / KMS / Route 53
    '--parent-id': one('id'),
    '--resource-id': one('arn'),
    '--certificate-arn': one('arn'),
    '--certificate-statuses': many('code'),
    '--key-id': one('arn'),
    '--hosted-zone-id': one('id'),
    '--start-record-name': one('name'),

    // Config / GuardDuty / Security Hub / IAM Access Analyzer
    '--config-rule-names': many('name'),
    '--config-rule-name': one('name'),
    '--compliance-types': many('code'),
    '--detector-id': one('id'),
    '--finding-ids': many('id'),
    '--finding-criteria': one('filter'),
    '--analyzer-arn': one('arn'),
    '--hub-arn': one('arn'),
    '--type': one('code'),

    // Time windows and Cost Explorer
    '--start-time': one('timestamp'),
    '--end-time': one('timestamp'),
    '--time-period': one('filter'),
    '--granularity': one('code'),
    '--metrics': many('code'),
    '--group-by': many('filter'),
    '--dimension': one('code'),
    '--search-string': one('name'),

    // Resource Groups Tagging
    '--resource-type-filters': many('code'),
    '--tag-filters': many('filter'),
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
        const spec = own(ALLOWED_FLAGS, flag);
        if (!spec) return `parameter "${flag}" is not a permitted flag`;

        if (spec.arity === 'none') {
            // A value here is exactly the positional-smuggling vector.
            if (value !== true) return `parameter "${flag}" takes no value — pass true`;
            continue;
        }
        const values = Array.isArray(value) ? value : [value];
        if (values.length === 0) return `parameter "${flag}" requires a value`;
        if (spec.arity === 'one' && values.length !== 1) return `parameter "${flag}" takes exactly one value`;
        const shape = spec.shape ?? 'id';
        for (const v of values) {
            if (typeof v !== 'string' || v.length === 0) return `parameter "${flag}" values must be non-empty strings`;
            // The argv invariant. A 'many' flag emits each element as its own
            // token, so a value beginning with "-" would be parsed by the CLI as a
            // FLAG — which is how the flag allowlist gets bypassed through the one
            // axis it does not constrain.
            if (v.startsWith('-')) {
                return `parameter "${flag}" values must not begin with "-" (a value starting with a dash would be parsed as a flag)`;
            }
            // The AWS CLI dereferences file://, fileb:// and (when
            // cli_follow_urlparam is enabled) http(s):// on every SERVICE parameter,
            // reads the target, and echoes its contents in the parse error — which
            // this tool returns verbatim to the model. No shape below can match a
            // scheme either; this is the redundant backstop, stated explicitly so a
            // future shape cannot quietly re-open it.
            if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v)) {
                return `parameter "${flag}" values must not carry a URI scheme (the AWS CLI would dereference it and echo the contents)`;
            }
            // Positive validation: the value must MATCH the declared shape. Anything
            // the shape does not describe is refused, rather than anything a denylist
            // happened to enumerate.
            if (!VALUE_SHAPES[shape](v)) {
                return `parameter "${flag}" value does not match the expected ${shape} form`;
            }
        }
    }
    return null;
}

/**
 * Build argv. Exported so tests can assert the exact array without executing.
 * Every emitted token is either a flag or a value belonging to a flag of declared
 * non-zero arity — so a positional argument cannot be produced.
 *
 * That property is enforced HERE, not assumed: the builder is exported and
 * independently callable, and it used to emit whatever it was handed — an unknown
 * key became a positional (`{'--bucket': ['b', '/tmp/pwn']}` emitted `/tmp/pwn` as
 * `s3api get-object`'s outfile) whenever a caller skipped validation. Arity is now
 * applied to the OUTPUT: unknown flags are dropped, a zero-arity flag emits the flag
 * alone, and a 'one' flag emits at most one value, whatever the input says.
 */
export function buildAwsReadArgv(input: AwsReadRequest): string[] {
    const argv = [input.service, input.operation];
    if (input.region) argv.push('--region', input.region);
    if (input.profile) argv.push('--profile', input.profile);
    for (const [flag, value] of Object.entries(input.params ?? {})) {
        // own(): a bare index would read an arity off Object.prototype
        // ('constructor' → the Object constructor, which is not 'none').
        const spec = own(ALLOWED_FLAGS, flag);
        if (!spec) continue;                                  // not a flag → cannot become a positional
        if (spec.arity === 'none') { argv.push(flag); continue; }

        const values = (Array.isArray(value) ? value : [value]).filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
        );
        const emitted = spec.arity === 'one' ? values.slice(0, 1) : values;
        if (emitted.length === 0) continue;                   // a lone flag with no value would consume the next token
        argv.push(flag, ...emitted);
    }
    argv.push('--output', 'json');
    return argv;
}

export function createAwsReadTool(tenantId: string, userId?: string) {
    // markSubagentReadOnlyTool: the sub-agent jail exempts this tool by IDENTITY.
    // Exempting it by the string "aws_read" let any tool that merely claimed the name
    // through — remote MCP tool names are unprefixed, so a tenant-configured MCP
    // server could both bypass the jail and shadow the real tool.
    return markSubagentReadOnlyTool(tool(
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

Give the service and operation separately; never write a command line. Parameters are a map of flag to value, where a value is a string, an array of strings for multi-value flags, or true for flags that take no value.

Values must be plain AWS values — resource ids, names, ARNs, Name=…,Values=… filters, JMESPath expressions, ISO timestamps or epoch seconds. A value may not begin with "-" and may not carry a URI scheme (no file://, http://): a parameter is never a path or a URL to be fetched.

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
    ));
}
