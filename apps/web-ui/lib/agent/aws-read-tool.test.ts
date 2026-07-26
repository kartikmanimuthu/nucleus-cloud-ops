import { describe, it, expect } from 'vitest';
import { validateAwsReadRequest, buildAwsReadArgv, ALLOWED_FLAGS, ALLOWED_OPS } from './aws-read-tool';
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
                const arity = builderFlags.has(token) ? 'one' : ALLOWED_FLAGS[token];
                expect(arity, `unexpected flag ${token}`).toBeDefined();
                owner = arity === 'none' ? null : token;
                continue;
            }
            expect(owner, `orphan positional "${token}"`).not.toBeNull();
        }
    });

    it('treats injection attempts as inert argv data', () => {
        const argv = buildAwsReadArgv({ ...ok, params: { '--query': 'a; rm -rf /' } });
        expect(argv).toContain('a; rm -rf /');
    });

    it('does not read an arity from an inherited Object property', () => {
        // Validation refuses this first, but the builder is exported and independently
        // callable — "cannot emit a positional" must hold without trusting its caller.
        const argv = buildAwsReadArgv({ ...ok, params: { 'constructor': 'x' } as never });
        expect(argv).toEqual(['ec2', 'describe-instances', 'constructor', 'x', '--output', 'json']);
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

describe('the jail permits aws_read and still refuses shell', () => {
    it('allows aws_read — without this the tool is refused on every call', () => {
        expect(isReadOnlyForSubagent('aws_read').allowed).toBe(true);
    });

    it('keeps aws_read through the filter alongside other read-only tools', () => {
        expect(filterReadOnlyTools([
            { name: 'aws_read' }, { name: 'get_aws_credentials' },
            { name: 'execute_command' }, { name: 'dispatch_agent' },
        ]).map(t => t.name)).toEqual(['aws_read', 'get_aws_credentials']);
    });
});
