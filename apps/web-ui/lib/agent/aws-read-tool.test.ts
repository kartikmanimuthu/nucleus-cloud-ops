import { describe, it, expect, afterEach } from 'vitest';
import { buildCommandEnv } from './tools';
import {
    validateAwsReadRequest, buildAwsReadArgv, normalizeParams, ALLOWED_FLAGS, ALLOWED_OPS, VALUE_SHAPES,
    type ParamValue, type ValueShape,
} from './aws-read-tool';
import { markSubagentReadOnlyTool } from './subagent-tool-marker';
import { isReadOnlyForSubagent, filterReadOnlyTools } from './subagent';

const ok = { service: 'ec2', operation: 'describe-instances' };

describe('validateAwsReadRequest — service/operation allowlist', () => {
    it('accepts a permitted pair', () => expect(validateAwsReadRequest(ok)).toBeNull());

    it('refuses a service that is not allowlisted', () => {
        for (const service of ['redshift', 'sso', 'cognito-identity', 'secretsmanager', 'ssm', 'gamelift', 'configure', 'ddb']) {
            expect(validateAwsReadRequest({ service, operation: 'get-x' })).toMatch(/not available to sub-agents|not a permitted/);
        }
    });

    it('refuses credential-returning operations even on allowlisted services', () => {
        // These defeated the previous denylist by simply not being on it.
        expect(validateAwsReadRequest({ service: 'sts', operation: 'get-session-token' })).toMatch(/not a permitted/);
        expect(validateAwsReadRequest({ service: 'sts', operation: 'get-federation-token' })).toMatch(/not a permitted/);
        expect(validateAwsReadRequest({ service: 'ec2', operation: 'get-console-output' })).toMatch(/not a permitted/);
        expect(validateAwsReadRequest({ service: 'ec2', operation: 'get-password-data' })).toMatch(/not a permitted/);
        expect(validateAwsReadRequest({ service: 'iam', operation: 'get-credential-report' })).toMatch(/not a permitted/);
    });

    it('refuses the file-write primitive', () => {
        expect(validateAwsReadRequest({ service: 's3api', operation: 'get-object' })).toMatch(/not a permitted/);
    });

    it('refuses mutations', () => {
        for (const operation of ['terminate-instances', 'delete-bucket', 'run-instances', 'sync', 'cp']) {
            expect(validateAwsReadRequest({ ...ok, operation })).toMatch(/not a permitted/);
        }
    });

    it('refuses malformed identifiers rather than passing them through', () => {
        expect(validateAwsReadRequest({ service: 'ec2; rm -rf /', operation: 'describe-instances' })).toMatch(/not a permitted AWS service/);
        expect(validateAwsReadRequest({ ...ok, region: 'us-east-1$(id)' })).toMatch(/invalid region/);
        expect(validateAwsReadRequest({ ...ok, profile: '../../etc/passwd' })).toMatch(/invalid profile/);
    });

    it('refuses a service name that resolves to an inherited Object property', () => {
        // ALLOWED_OPS is a plain object, so a bare index would return the Object
        // constructor here — truthy, with no .has — and throw a TypeError out of a
        // function whose contract is to RETURN a refusal. validate() is called
        // outside the tool's try/catch, so that turned a refusal into a crash.
        expect(validateAwsReadRequest({ service: 'constructor', operation: 'get-x' })).toMatch(/not available to sub-agents/);
    });

    it('refuses an operation that is not a string', () => {
        expect(validateAwsReadRequest({ ...ok, operation: undefined as never })).toMatch(/not a permitted read-only operation/);
    });
});

describe('validateAwsReadRequest — flag allowlist and arity', () => {
    it('refuses any flag that is not allowlisted, including abbreviations', () => {
        // argparse has allow_abbrev=True, which defeated the previous denylist:
        // --endpoint was accepted for the denied --endpoint-url and turned the CLI
        // into an unauthenticated downloader.
        for (const flag of ['--endpoint-url', '--endpoint', '--endpoint-ur', '--cli-input-json',
                            '--cli-input-jso', '--no-sign-request', '--no-sign-reques', '--debug',
                            '--debu', '--ca-bundle', '--ca-bundl', '--profile', '--region', '--output']) {
            expect(validateAwsReadRequest({ ...ok, params: { [flag]: 'x' } })).toMatch(/not a permitted flag/);
        }
    });

    it('refuses a value for a zero-arity flag — the positional-smuggling vector', () => {
        expect(validateAwsReadRequest({ ...ok, params: { '--no-paginate': '/app/config.json' } }))
            .toMatch(/takes no value/);
    });

    it('accepts true for a zero-arity flag', () => {
        expect(validateAwsReadRequest({ ...ok, params: { '--no-paginate': true } })).toBeNull();
    });

    it('accepts multi-value flags', () => {
        expect(validateAwsReadRequest({ ...ok, params: { '--instance-ids': ['i-1', 'i-2'] } })).toBeNull();
    });

    it('refuses multiple values for a single-value flag, and empty values', () => {
        expect(validateAwsReadRequest({ ...ok, params: { '--query': ['a', 'b'] } })).toMatch(/exactly one value/);
        expect(validateAwsReadRequest({ ...ok, params: { '--query': [] } })).toMatch(/requires a value/);
        expect(validateAwsReadRequest({ ...ok, params: { '--query': '' } })).toMatch(/non-empty strings/);
    });

    it('is not fooled by inherited Object properties', () => {
        expect(validateAwsReadRequest({ ...ok, params: { 'constructor': 'x' } as never })).toMatch(/not a permitted flag/);
        // Built with JSON.parse, not an object literal: a quoted __proto__ key in a
        // literal SETS THE PROTOTYPE rather than creating an own property (spec
        // B.3.1), so `{ '__proto__': 'x' }` is simply `{}` and would vacuously pass.
        // Real tool args arrive as parsed JSON, where __proto__ IS an own property —
        // which is the case worth pinning.
        const params = JSON.parse('{"__proto__": "x"}');
        expect(Object.prototype.hasOwnProperty.call(params, '__proto__')).toBe(true);
        expect(validateAwsReadRequest({ ...ok, params })).toMatch(/not a permitted flag/);
    });
});

describe('validateAwsReadRequest — the argv invariant (no value may look like a flag)', () => {
    it('refuses a value that would be parsed as a flag, defeating the flag allowlist', () => {
        // The flag allowlist constrains the KEYS of params; argparse decides what is
        // a flag by looking at the TOKEN. A 'many' flag emits each array element as
        // its own argv token, so this would have the CLI stop consuming
        // --instance-ids at "--endpoint-url" and parse it as a flag — reaching every
        // flag the allowlist exists to exclude.
        expect(validateAwsReadRequest({ ...ok, params: { '--instance-ids': ['i-1', '--endpoint-url', 'https://attacker.example'] } }))
            .toMatch(/must not begin with "-"/);
        expect(validateAwsReadRequest({ ...ok, params: { '--query': '--cli-input-json' } }))
            .toMatch(/must not begin with "-"/);
        // "--" is the end-of-options marker: every token after it becomes a positional.
        expect(validateAwsReadRequest({ ...ok, params: { '--filters': ['--'] } }))
            .toMatch(/must not begin with "-"/);
    });

    it('refuses region and profile values that look like flags', () => {
        // /^[a-z0-9-]+$/ matches the literal string "--endpoint-url", so the previous
        // region pattern admitted an option-looking token into argv.
        expect(validateAwsReadRequest({ ...ok, region: '--endpoint-url' })).toMatch(/invalid region/);
        expect(validateAwsReadRequest({ ...ok, profile: '--profile' })).toMatch(/invalid profile/);
    });

    it('still accepts ordinary AWS values', () => {
        expect(validateAwsReadRequest({
            ...ok, region: 'us-gov-west-1', profile: 'nucleus_agent_111111111111_ro',
            params: {
                '--filters': ['Name=instance-state-name,Values=running', 'Name=tag:env,Values=prod'],
                '--query': 'Reservations[].Instances[].InstanceId',
                '--start-time': '2026-07-01T00:00:00Z',
            },
        })).toBeNull();
    });

    it('does not reject any of the legitimate value shapes', () => {
        // The invariant is only free if no real AWS value begins with "-". Each of
        // these is a shape a sub-agent will actually produce.
        const cases: Array<[string, ParamValue]> = [
            ['--filters', 'Name=instance-state-name,Values=running'],
            ['--query', 'Reservations[].Instances[]'],
            ['--start-time', '2026-07-01T00:00:00Z'],
            ['--start-time', '1751328000'],
            ['--instance-ids', ['i-1', 'i-2']],
            ['--no-paginate', true],
            ['--log-group-name', '/aws/lambda/my-fn'],
            ['--bucket', 'my-bucket'],
            ['--policy-arn', 'arn:aws:iam::111111111111:policy/ReadOnlyAccess'],
        ];
        for (const [flag, value] of cases) {
            expect(validateAwsReadRequest({ ...ok, params: { [flag]: value } }), `${flag} ${JSON.stringify(value)}`).toBeNull();
        }
    });
});

describe('validateAwsReadRequest — positive value shapes', () => {
    it('refuses a paramfile prefix on every service parameter', () => {
        // THE ESCAPE THIS CLOSES. The AWS CLI dereferences file:// on a service
        // parameter, reads the target, and echoes the whole file in its parse error —
        // which aws_read returns to the model verbatim (`stdout || stderr`). Measured
        // against the tenant credentials file:
        //   Error parsing parameter '--time-period': Invalid JSON:
        //   [nucleus_agent_t1]
        //   aws_access_key_id = AKIA…
        const targets = [
            'file:///etc/passwd',
            'file:///proc/1/environ',
            'file:///tmp/nucleus-agent-creds/t1/credentials',
            'fileb:///proc/self/environ',
            'http://169.254.170.2/v2/credentials',
            'https://attacker.example/x',
        ];
        // Every allowlisted service parameter, not a sample: the vector is the CLI's,
        // so it applies to whichever flag the model happens to choose.
        const valueFlags = Object.entries(ALLOWED_FLAGS).filter(([, spec]) => spec.arity !== 'none');
        expect(valueFlags.length).toBeGreaterThan(90);
        for (const [flag, spec] of valueFlags) {
            for (const target of targets) {
                const value = spec.arity === 'many' ? [target] : target;
                expect(
                    validateAwsReadRequest({ ...ok, params: { [flag]: value } }),
                    `${flag} ${target}`,
                ).toMatch(/URI scheme|does not match the expected/);
            }
        }
    });

    it('has no shape that can match a URI scheme — the shared check is a backstop, not the mechanism', () => {
        // Stated as a property over the shapes themselves so a future shape cannot
        // quietly re-open the hole by relying on the standalone scheme check.
        for (const [name, matches] of Object.entries(VALUE_SHAPES)) {
            for (const target of ['file:///etc/passwd', 'fileb://x', 'http://x/y', 'https://x/y', 's3://b/k']) {
                expect(matches(target), `${name} matched ${target}`).toBe(false);
            }
        }
    });

    it('accepts the legitimate form of each shape', () => {
        const cases: Array<[ValueShape, string[]]> = [
            ['id', ['i-0abc123', 'my-bucket', '/aws/lambda/my-fn', 'alias/aws/s3', 'Z1D633PJN98FT9']],
            ['name', ['My Security Group', '2026/07/26/[$LATEST]53f2a1', 'AWS/EC2', 'logs/', 'example.com.']],
            ['code', ['RUNNING', 'ec2:instance', 'tag:env', 'UnblendedCost', 'DIMENSION']],
            ['arn', ['arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tg/abc',
                     'arn:aws:iam::111111111111:policy/ReadOnlyAccess', 'prod-cluster']],
            ['filter', ['Name=instance-state-name,Values=running', 'Name=tag:env,Values=prod,staging',
                        'Start=2026-07-01,End=2026-07-02', '[{"Id":"m1","MetricStat":{"Period":300}}]']],
            ['jmespath', ["Reservations[].Instances[?State.Name=='running'].[InstanceId,Tags[?Key=='Name'].Value|[0]]",
                          'length(Reservations)', 'Buckets[0:5].Name', '{id: InstanceId}']],
            ['expr', ['{ $.errorCode = "*Unauthorized*" }', 'fields @timestamp, @message | filter @message like /ERROR/',
                      '?ERROR ?WARN']],
            ['timestamp', ['2026-07-01T00:00:00Z', '2026-07-01T00:00:00.000+05:30', '2026-07-01', '1751328000', '1751328000000']],
            ['int', ['1', '1000']],
            ['token', ['eyJ2IjoxfQ==', 'AAEA-abc_123.def']],
        ];
        for (const [shape, values] of cases) {
            for (const value of values) {
                expect(VALUE_SHAPES[shape](value), `${shape} rejected ${value}`).toBe(true);
            }
        }
    });

    it('refuses a value that does not match its flag\'s declared shape', () => {
        // Each of these is now caught by the SHAPE, not by a dash or a scheme.
        expect(validateAwsReadRequest({ ...ok, params: { '--max-results': 'all' } }))
            .toMatch(/expected int form/);
        expect(validateAwsReadRequest({ ...ok, params: { '--start-time': 'yesterday' } }))
            .toMatch(/expected timestamp form/);
        expect(validateAwsReadRequest({ ...ok, params: { '--instance-ids': ['i-1', 'i 2; whoami'] } }))
            .toMatch(/expected id form/);
        expect(validateAwsReadRequest({ ...ok, params: { '--query': 'Reservations[]/../../etc' } }))
            .toMatch(/expected jmespath form/);
        expect(validateAwsReadRequest({ service: 'ce', operation: 'get-cost-and-usage', params: { '--time-period': 'not-a-pair' } }))
            .toMatch(/expected filter form/);
        // A JSON-looking value that does not actually parse is not a JSON document.
        expect(validateAwsReadRequest({ ...ok, params: { '--filters': ['[{"Name":'] } }))
            .toMatch(/expected filter form/);
    });
});

describe('ALLOWED_OPS — the approved audit surface is callable', () => {
    it('covers the operations a multi-account audit needs', () => {
        const required: Array<[string, string]> = [
            ['organizations', 'list-accounts'], ['organizations', 'describe-organization'],
            ['cloudtrail', 'lookup-events'], ['cloudwatch', 'get-metric-data'],
            ['s3api', 'get-bucket-policy'], ['s3api', 'get-public-access-block'],
            ['s3api', 'list-objects-v2'], ['iam', 'get-policy-version'],
            ['iam', 'get-role-policy'], ['acm', 'describe-certificate'],
            ['kms', 'describe-key'], ['route53', 'list-resource-record-sets'],
            ['cloudfront', 'list-distributions'], ['ec2', 'describe-instance-status'],
            ['elbv2', 'describe-listeners'], ['rds', 'describe-db-cluster-snapshots'],
            ['logs', 'get-log-events'], ['ce', 'get-cost-forecast'],
        ];
        for (const [service, operation] of required) {
            expect(validateAwsReadRequest({ service, operation }), `${service} ${operation}`).toBeNull();
        }
    });

    it('gives every allowlisted operation its required parameters', () => {
        // An operation whose required flag is missing from ALLOWED_FLAGS is on the
        // list but not actually callable — the uselessness that pushes users back
        // toward a shell.
        const required: Array<[string, string, Record<string, ParamValue>]> = [
            ['elbv2', 'describe-target-health', { '--target-group-arn': 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tg/abc' }],
            ['elbv2', 'describe-rules', { '--listener-arn': 'arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/app/lb/abc/def' }],
            ['eks', 'describe-cluster', { '--name': 'prod' }],
            ['eks', 'describe-nodegroup', { '--cluster-name': 'prod', '--nodegroup-name': 'ng-1' }],
            ['iam', 'get-policy-version', { '--policy-arn': 'arn:aws:iam::111111111111:policy/p', '--version-id': 'v3' }],
            ['iam', 'get-role-policy', { '--role-name': 'r', '--policy-name': 'p' }],
            ['iam', 'get-user-policy', { '--user-name': 'alice', '--policy-name': 'p' }],
            ['iam', 'list-access-keys', { '--user-name': 'alice' }],
            ['route53', 'list-resource-record-sets', { '--hosted-zone-id': 'Z123' }],
            ['kms', 'describe-key', { '--key-id': 'alias/aws/s3' }],
            ['acm', 'describe-certificate', { '--certificate-arn': 'arn:aws:acm:us-east-1:111111111111:certificate/c' }],
            ['cloudtrail', 'lookup-events', { '--lookup-attributes': ['AttributeKey=EventName,AttributeValue=RunInstances'], '--max-results': '50' }],
            ['cloudwatch', 'get-metric-data', { '--metric-data-queries': ['[{"Id":"m1","MetricStat":{"Metric":{"Namespace":"AWS/EC2"},"Period":300,"Stat":"Average"}}]'], '--start-time': '2026-07-01T00:00:00Z', '--end-time': '2026-07-02T00:00:00Z' }],
            ['cloudwatch', 'describe-alarm-history', { '--alarm-name': 'high-cpu', '--history-item-type': 'StateUpdate' }],
            ['s3api', 'list-objects-v2', { '--bucket': 'b', '--prefix': 'logs/', '--max-keys': '100' }],
            ['s3api', 'list-object-versions', { '--bucket': 'b', '--key-marker': 'logs/2026', '--max-keys': '100' }],
            ['organizations', 'list-accounts-for-parent', { '--parent-id': 'ou-1234' }],
            ['logs', 'get-log-events', { '--log-group-name': '/aws/lambda/f', '--log-stream-name': 's', '--start-from-head': true }],
            ['logs', 'start-query', { '--log-group-names': ['/aws/lambda/f'], '--start-time': '1751328000', '--end-time': '1751414400', '--query-string': 'fields @timestamp, @message | filter @message like /ERROR/' }],
            ['logs', 'get-query-results', { '--query-id': 'abc123' }],
            ['ce', 'get-dimension-values', { '--time-period': 'Start=2026-07-01,End=2026-07-02', '--dimension': 'SERVICE' }],
            ['ce', 'get-cost-and-usage', { '--time-period': 'Start=2026-07-01,End=2026-07-02', '--granularity': 'DAILY', '--metrics': ['UnblendedCost'], '--next-page-token': 'eyJ2IjoxfQ==' }],
            ['ec2', 'describe-instance-status', { '--include-all-instances': true }],
            ['ec2', 'describe-network-acls', { '--network-acl-ids': ['acl-1'] }],
            ['rds', 'describe-events', { '--source-identifier': 'db-1', '--source-type': 'db-instance', '--duration': '1440' }],
            ['config', 'get-compliance-details-by-config-rule', { '--config-rule-name': 'required-tags', '--compliance-types': ['NON_COMPLIANT'] }],
            ['guardduty', 'list-findings', { '--detector-id': 'abc', '--finding-criteria': '{"Criterion":{"severity":{"Gte":7}}}' }],
            ['securityhub', 'get-findings', { '--filters': ['{"SeverityLabel":[{"Value":"CRITICAL","Comparison":"EQUALS"}]}'], '--max-results': '50' }],
            ['accessanalyzer', 'list-findings', { '--analyzer-arn': 'arn:aws:access-analyzer:us-east-1:111111111111:analyzer/a' }],
        ];
        for (const [service, operation, params] of required) {
            expect(validateAwsReadRequest({ service, operation, params }), `${service} ${operation}`).toBeNull();
        }
    });
});

describe('buildAwsReadArgv', () => {
    it('emits service, operation, validated region/profile and json output', () => {
        expect(buildAwsReadArgv({ ...ok, region: 'us-east-1', profile: 'nucleus_agent_1', params: { '--instance-ids': ['i-1', 'i-2'] } }))
            .toEqual(['ec2', 'describe-instances', '--region', 'us-east-1', '--profile', 'nucleus_agent_1',
                      '--instance-ids', 'i-1', 'i-2', '--output', 'json']);
    });

    it('emits a zero-arity flag alone, with no value token', () => {
        expect(buildAwsReadArgv({ ...ok, params: { '--no-paginate': true } }))
            .toEqual(['ec2', 'describe-instances', '--no-paginate', '--output', 'json']);
    });

    it('can never emit a positional argument (semantic, not shape-based)', () => {
        // The previous suite checked argv SHAPE, which a smuggled positional satisfies
        // by construction since it does follow a flag. Check the real property: every
        // non-flag token must belong to a flag of declared non-zero arity.
        const argv = buildAwsReadArgv({
            ...ok, region: 'us-east-1', profile: 'p',
            params: { '--instance-ids': ['i-1', 'i-2'], '--no-paginate': true, '--query': 'Reservations[]' },
        });
        const builderFlags = new Set(['--region', '--profile', '--output']);
        let owner: string | null = null;
        for (const token of argv.slice(2)) {
            if (token.startsWith('--')) {
                const arity = builderFlags.has(token) ? 'one' : ALLOWED_FLAGS[token]?.arity;
                expect(arity, `unexpected flag ${token}`).toBeDefined();
                owner = arity === 'none' ? null : token;
                continue;
            }
            expect(owner, `orphan positional "${token}"`).not.toBeNull();
        }
    });

    it('enforces arity itself, so it cannot emit a positional for an unvalidated caller', () => {
        // The builder is exported and independently callable. Called with input that
        // never passed validation it used to emit whatever it was handed — and the
        // second token of a 'one' flag is a POSITIONAL, which for `s3api get-object`
        // is the outfile (an arbitrary local file write).
        expect(buildAwsReadArgv({ service: 's3api', operation: 'get-object', params: { '--bucket': ['b', '/tmp/pwn'] } }))
            .toEqual(['s3api', 'get-object', '--bucket', 'b', '--output', 'json']);
        // A zero-arity flag never emits a value token, whatever the input claims.
        expect(buildAwsReadArgv({ ...ok, params: { '--no-paginate': '/tmp/pwn' as never } }))
            .toEqual(['ec2', 'describe-instances', '--no-paginate', '--output', 'json']);
        // A flag that is not on the allowlist is dropped entirely rather than passed
        // through as two bare tokens.
        expect(buildAwsReadArgv({ ...ok, params: { '--endpoint-url': 'https://attacker.example' } }))
            .toEqual(['ec2', 'describe-instances', '--output', 'json']);
        // Non-string values leave no token behind either.
        expect(buildAwsReadArgv({ ...ok, params: { '--query': { toString: () => 'x' } as never } }))
            .toEqual(['ec2', 'describe-instances', '--output', 'json']);
    });

    it('treats injection attempts as inert argv data', () => {
        const argv = buildAwsReadArgv({ ...ok, params: { '--query': 'a; rm -rf /' } });
        expect(argv).toContain('a; rm -rf /');
    });

    it('does not read an arity from an inherited Object property', () => {
        // A bare index would read ALLOWED_FLAGS['constructor'] as a defined spec.
        // own() makes it unknown, and an unknown flag is now dropped rather than
        // emitted as two bare tokens.
        const argv = buildAwsReadArgv({ ...ok, params: { 'constructor': 'x' } as never });
        expect(argv).toEqual(['ec2', 'describe-instances', '--output', 'json']);
    });
});

describe('ALLOWED_OPS contains no credential-returning or mutating entry', () => {
    it('excludes the operations that killed the previous design', () => {
        const forbidden = [
            ['sts', 'get-session-token'], ['sts', 'get-federation-token'],
            ['s3api', 'get-object'], ['ec2', 'get-password-data'],
            ['ec2', 'get-console-output'], ['iam', 'get-credential-report'],
            ['eks', 'get-token'], ['lambda', 'get-function'],
        ] as const;
        for (const [service, operation] of forbidden) {
            expect(ALLOWED_OPS[service]?.has(operation) ?? false, `${service} ${operation}`).toBe(false);
        }
        // Services whose read surface returns credentials are absent wholesale.
        for (const service of ['secretsmanager', 'ssm', 'sso', 'ecr', 'redshift', 'cognito-identity', 's3']) {
            expect(Object.prototype.hasOwnProperty.call(ALLOWED_OPS, service), service).toBe(false);
        }
    });
});

describe('buildCommandEnv — the environment aws_read runs in', () => {
    const AMBIENT = {
        AWS_CONFIG_FILE: '/attacker/config',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/creds',
        AWS_ACCESS_KEY_ID: 'AKIATASKROLE',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_SESSION_TOKEN: 'token',
        DATABASE_URL: 'postgres://x',
        NEXTAUTH_SECRET: 's',
    };

    afterEach(() => {
        for (const key of Object.keys(AMBIENT)) delete process.env[key];
    });

    it('pins the config file per tenant instead of inheriting an ambient one', () => {
        // An inherited ~/.aws/config can set cli_follow_urlparam (http:// parameter
        // values become fetches), credential_process (arbitrary command execution on
        // profile resolution) and sso_*.
        Object.assign(process.env, AMBIENT);
        const env = buildCommandEnv('tenant-1');
        expect(env.AWS_CONFIG_FILE).not.toBe('/attacker/config');
        expect(env.AWS_CONFIG_FILE).toContain('tenant-1');
        expect(env.AWS_SHARED_CREDENTIALS_FILE).toContain('tenant-1');
        // Not inherited even when there is no tenant to pin it to.
        expect(buildCommandEnv().AWS_CONFIG_FILE).toBeUndefined();
    });

    it('never hands the child the ECS task role — "no profile" must mean "no credentials"', () => {
        // Load-bearing omission: with these present, an aws_read call with no
        // --profile silently falls back to the PLATFORM's identity, outside every
        // tenant scoping and outside the assumed-role audit trail.
        Object.assign(process.env, AMBIENT);
        const env = buildCommandEnv('tenant-1');
        for (const key of ['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
                           'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
                           'DATABASE_URL', 'NEXTAUTH_SECRET']) {
            expect(env[key], key).toBeUndefined();
        }
    });
});

describe('the jail exempts aws_read by identity, not by name', () => {
    // A stand-in for the real tool: what matters is the marker, which only this
    // process can stamp (a unique Symbol, not Symbol.for).
    const realAwsRead = () => markSubagentReadOnlyTool({ name: 'aws_read' });

    it('allows the marked instance — without this the tool is refused on every call', () => {
        expect(isReadOnlyForSubagent('aws_read', {}, realAwsRead()).allowed).toBe(true);
    });

    it('refuses an impostor that merely claims the name', () => {
        // mcp-manager.ts keeps remote MCP tool names UNPREFIXED, so a tenant-configured
        // MCP server can expose a tool called `aws_read`. Under the old name-based
        // exemption it was waved through the fail-closed jail AND, being last into
        // toolsByName, shadowed the real tool.
        for (const name of ['aws_read', 'AWS_READ', 'Aws_Read']) {
            const verdict = isReadOnlyForSubagent(name, {}, { name });
            expect(verdict.allowed, name).toBe(false);
            expect(verdict.reason).toMatch(/not on the verified read-only list/);
        }
    });

    it('gives a bare name no exemption at all', () => {
        // isReadOnlyForSubagent(name) is called with a bare string in places; that
        // path must stay fail-closed, because a string is exactly the claim an
        // impostor can make.
        expect(isReadOnlyForSubagent('aws_read').allowed).toBe(false);
    });

    it('a marked impostor cannot re-enable a denylisted name', () => {
        // The denylist is checked BEFORE the marker, so marking cannot resurrect a
        // shell or a recursive dispatch.
        for (const name of ['execute_command', 'bash', 'dispatch_agent', 'ask_user']) {
            const verdict = isReadOnlyForSubagent(name, {}, markSubagentReadOnlyTool({ name }));
            expect(verdict.allowed, name).toBe(false);
        }
    });

    it('keeps the marked aws_read through the filter and drops the impostor', () => {
        expect(filterReadOnlyTools([
            realAwsRead(), { name: 'get_aws_credentials' },
            { name: 'aws_read' },            // impostor, unmarked
            { name: 'execute_command' }, { name: 'dispatch_agent' },
        ]).map(t => t.name)).toEqual(['aws_read', 'get_aws_credentials']);
    });
});

// Regression: the model emits JSON-document parameters as objects, not pre-serialised
// strings. Cost Explorer's --group-by killed a whole run with "Invalid input → at
// params['--group-by']" before it ever reached the CLI.
describe('normalizeParams — JSON-document parameters', () => {
    const ce = { service: 'ce', operation: 'get-cost-and-usage' };

    it('serialises an array of objects, and the request then validates', () => {
        const params = normalizeParams({
            '--time-period': 'Start=2026-07-01,End=2026-08-01',
            '--granularity': 'MONTHLY',
            '--metrics': ['BlendedCost'],
            '--group-by': [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        })!;
        expect(params['--group-by']).toEqual(['{"Type":"DIMENSION","Key":"SERVICE"}']);
        expect(validateAwsReadRequest({ ...ce, params })).toBeNull();
        expect(buildAwsReadArgv({ ...ce, params })).toContain('{"Type":"DIMENSION","Key":"SERVICE"}');
    });

    it('serialises a bare object', () => {
        expect(normalizeParams({ '--group-by': { Type: 'DIMENSION', Key: 'SERVICE' } })!['--group-by'])
            .toBe('{"Type":"DIMENSION","Key":"SERVICE"}');
    });

    it('leaves strings, string arrays and valueless flags untouched', () => {
        expect(normalizeParams({ a: 'x', b: ['y', 'z'], c: true })).toEqual({ a: 'x', b: ['y', 'z'], c: true });
    });

    it('cannot smuggle a URI scheme through a structured value', () => {
        // A serialised object always begins with "{" or "[", so it can never match a
        // leading scheme — the property the whole shape design rests on.
        for (const evil of [
            { '--group-by': [{ Type: 'file:///etc/passwd' }] },
            { '--group-by': { Key: 'http://169.254.169.254/latest/meta-data/' } },
        ]) {
            const params = normalizeParams(evil as never)!;
            for (const v of Object.values(params)) {
                for (const one of Array.isArray(v) ? v : [v]) {
                    expect(String(one)).toMatch(/^[[{]/);
                    expect(String(one)).not.toMatch(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//);
                }
            }
            expect(validateAwsReadRequest({ ...ce, params })).toBeNull();
        }
    });

    it('still refuses a raw string carrying a scheme', () => {
        const params = normalizeParams({ '--time-period': 'file:///etc/passwd' })!;
        expect(validateAwsReadRequest({ ...ce, params })).not.toBeNull();
    });
});

