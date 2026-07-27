/**
 * Redaction at the persistence boundary.
 *
 * `aws_read` permits `lambda get-function-configuration`, which returns
 * Environment.Variables in PLAINTEXT (see the NOTE in aws-read-tool.ts). Task 11
 * persists sub-agent transcripts to Postgres for 30 days, so those values must be
 * scrubbed before the write — not at the tool, and not at the call site.
 */
import { describe, it, expect } from 'vitest';

import { REDACTED, redactTranscript } from '../subagent-redact';

type Entry = { kind: 'ai' | 'tool'; name?: string; text: string };

const entry = (text: string, name = 'aws_read'): Entry => ({ kind: 'tool', name, text });

/** Everything the redactor produced, flattened, so a leak anywhere is caught. */
const flatten = (value: unknown) => JSON.stringify(value);

describe('redactTranscript — Environment.Variables (redact by location)', () => {
    const lambdaConfig = JSON.stringify({
        FunctionName: 'api-worker',
        Environment: { Variables: { DB_PASSWORD: 'hunter2', LOG_LEVEL: 'debug' } },
    });

    it('replaces every value under Environment.Variables but keeps the keys', () => {
        const [out] = redactTranscript([entry(lambdaConfig)])!;
        const parsed = JSON.parse(out.text);

        expect(parsed.Environment.Variables.DB_PASSWORD).toBe(REDACTED);
        // Redacted by LOCATION: we cannot know which arbitrary env var name is a secret.
        expect(parsed.Environment.Variables.LOG_LEVEL).toBe(REDACTED);
        // The operator still needs to see that the variable exists.
        expect(Object.keys(parsed.Environment.Variables)).toEqual(['DB_PASSWORD', 'LOG_LEVEL']);
        expect(parsed.FunctionName).toBe('api-worker');
    });

    it('leaks the plaintext value nowhere in the output', () => {
        expect(flatten(redactTranscript([entry(lambdaConfig)]))).not.toContain('hunter2');
    });
});

describe('redactTranscript — secret-shaped keys anywhere in the document', () => {
    it.each([
        ['apiKey', '{"credentials":{"apiKey":"sk_live_abc"}}', 'sk_live_abc'],
        ['api_key', '{"api_key":"sk_live_abc"}', 'sk_live_abc'],
        ['api-key', '{"api-key":"sk_live_abc"}', 'sk_live_abc'],
        ['PASSWORD', '{"PASSWORD":"hunter2"}', 'hunter2'],
        ['passwd', '{"passwd":"hunter2"}', 'hunter2'],
        ['clientSecret', '{"clientSecret":"shh"}', 'shh'],
        ['authToken', '{"authToken":"abc123"}', 'abc123'],
        ['Credential', '{"Credential":"abc123"}', 'abc123'],
        ['private_key', '{"private_key":"-----BEGIN RSA-----"}', 'BEGIN RSA'],
        ['SessionToken', '{"SessionToken":"IQoJb3JpZ2lu"}', 'IQoJb3JpZ2lu'],
    ])('redacts %s case-insensitively', (_label, json, plaintext) => {
        expect(flatten(redactTranscript([entry(json)]))).not.toContain(plaintext);
    });

    it('walks nested arrays and objects', () => {
        const [out] = redactTranscript([entry('{"items":[{"token":"abc"}]}')])!;
        expect(JSON.parse(out.text).items[0].token).toBe(REDACTED);
    });
});

describe('redactTranscript — sibling name/value pairs', () => {
    // `cloudformation describe-stacks` is allowlisted in aws-read-tool.ts and is
    // exactly what an audit sub-agent gets pointed at. Its secret lives in a
    // `ParameterValue` — a key that is not secret-shaped — named by a SIBLING
    // field, so key-name matching is structurally blind to it. CloudFormation
    // masks `NoEcho: true` parameters, but a non-NoEcho `DBPassword` is common
    // and is the very misconfiguration the audit is looking for.
    const describeStacks = JSON.stringify({
        Stacks: [{
            StackName: 'payments-prod',
            Parameters: [
                { ParameterKey: 'DBPassword', ParameterValue: 'hunter2' },
                { ParameterKey: 'InstanceType', ParameterValue: 't3.medium' },
            ],
            Outputs: [{ OutputKey: 'DbUrl', OutputValue: 'postgres://u:s3cr3t!@db.internal:5432/x' }],
        }],
    });

    const stack = () => JSON.parse(redactTranscript([entry(describeStacks)])![0].text).Stacks[0];

    it('redacts ParameterValue when the sibling ParameterKey names a secret', () => {
        expect(stack().Parameters[0].ParameterValue).toBe(REDACTED);
    });

    it('keeps the sibling name so the operator sees WHICH parameter was withheld', () => {
        expect(stack().Parameters.map((p: { ParameterKey: string }) => p.ParameterKey))
            .toEqual(['DBPassword', 'InstanceType']);
        expect(stack().Outputs[0].OutputKey).toBe('DbUrl');
        expect(stack().StackName).toBe('payments-prod');
    });

    it('leaves an ordinary parameter untouched', () => {
        // A redactor that eats `t3.medium` fails the operator as badly as one that leaks.
        expect(stack().Parameters[1].ParameterValue).toBe('t3.medium');
    });

    it('leaks neither secret anywhere in the output', () => {
        const flat = flatten(redactTranscript([entry(describeStacks)]));
        expect(flat).not.toContain('hunter2');
        expect(flat).not.toContain('s3cr3t!');
    });

    it('handles the lowercase {name,value} form used by container env definitions', () => {
        const payload = JSON.stringify({
            environment: [
                { name: 'DB_PASSWORD', value: 'hunter2' },
                { name: 'LOG_LEVEL', value: 'debug' },
            ],
        });
        const out = JSON.parse(redactTranscript([entry(payload)])![0].text);

        expect(out.environment[0].value).toBe(REDACTED);
        expect(out.environment[0].name).toBe('DB_PASSWORD');
        // Named by the operator, not secret-shaped: it must survive.
        expect(out.environment[1].value).toBe('debug');
    });

    it('handles the bare {Key,Value} form', () => {
        const out = JSON.parse(redactTranscript([entry('{"Key":"ApiToken","Value":"abc123"}')])![0].text);
        expect(out.Value).toBe(REDACTED);
        expect(out.Key).toBe('ApiToken');
    });

    it('does not redact a Value whose sibling name is innocuous', () => {
        // Tags are the highest-traffic {Key,Value} shape in AWS responses.
        const payload = JSON.stringify({ Tags: [{ Key: 'Name', Value: 'web-1' }, { Key: 'Owner', Value: 'platform' }] });
        expect(redactTranscript([entry(payload)])![0].text).toBe(payload);
    });

    it('applies the sibling rule inside the regex fallback path', () => {
        // Truncated JSON never parses, so the structural walk cannot run.
        const truncated = '{"Parameters":[{"ParameterKey":"DBPassword","ParameterValue":"hunter2"},{"Param';
        expect(flatten(redactTranscript([entry(truncated)]))).not.toContain('hunter2');
    });
});

describe('redactTranscript — credentials embedded in URLs', () => {
    it('rewrites scheme://user:password@host, keeping user and host', () => {
        const out = JSON.parse(redactTranscript([entry('{"DbUrl":"postgres://admin:letmein@db.internal:5432/app"}')])![0].text);
        expect(out.DbUrl).toBe(`postgres://admin:${REDACTED}@db.internal:5432/app`);
    });

    it('rewrites a credential URL in prose that never parsed as JSON', () => {
        // This is the report path: LLM-authored prose, no key to match on.
        const out = redactTranscript('The worker uses mongodb://svc:p4ssw0rd@cluster0.mongodb.net/prod');
        expect(out).not.toContain('p4ssw0rd');
        expect(out).toContain('cluster0.mongodb.net/prod');
    });

    it('handles an empty user segment', () => {
        expect(redactTranscript('redis://:t0psecret@cache.internal:6379')).not.toContain('t0psecret');
    });

    it('leaves credential-free URLs and ARNs alone', () => {
        const payload = JSON.stringify({
            Endpoint: 'https://console.aws.amazon.com/ec2/home?region=us-east-1',
            Repo: 'ssh://git@github.com/acme/infra.git',
            Bucket: 's3://nucleus-artifacts/builds/1.2.3',
            Arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf',
        });
        expect(redactTranscript([entry(payload)])![0].text).toBe(payload);
    });
});

describe('redactTranscript — ordinary values survive', () => {
    it('leaves a realistic non-secret payload byte-identical', () => {
        const payload = JSON.stringify({
            FunctionName: 'api-worker',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:api-worker',
            Runtime: 'nodejs20.x',
            MemorySize: 512,
            Timeout: 30,
            LastModified: '2026-07-26T10:15:00.000+0000',
            Instances: [{ InstanceId: 'i-0abc123def4567890', State: 'running' }],
            Tags: { Environment: 'prod', Owner: 'platform' },
        });

        const input: Entry[] = [{ kind: 'tool', name: 'aws_read', text: payload }];
        const [out] = redactTranscript(input)!;

        expect(out.text).toBe(payload);
        expect(out).toEqual(input[0]);
    });

    it('does not touch an `Environment` that has no `Variables`', () => {
        const payload = JSON.stringify({ Environment: { Region: 'us-east-1' } });
        expect(redactTranscript([entry(payload)])![0].text).toBe(payload);
    });

    it('leaves plain narration alone', () => {
        const text = 'Checked 3 accounts; 2 instances are oversized in us-east-1.';
        expect(redactTranscript([{ kind: 'ai', text }])![0].text).toBe(text);
    });
});

describe('redactTranscript — non-JSON text', () => {
    it('scrubs shell-style KEY=value assignments', () => {
        const out = redactTranscript([entry('export DB_PASSWORD=hunter2 && ./run.sh')])!;
        expect(out[0].text).not.toContain('hunter2');
        expect(out[0].text).toContain('DB_PASSWORD');
    });

    it('scrubs `key: value` prose', () => {
        expect(flatten(redactTranscript([entry('api_key: sk_live_abc')]))).not.toContain('sk_live_abc');
    });

    it('scrubs quoted JSON-ish fragments that never parsed', () => {
        expect(flatten(redactTranscript([entry('trailing junk "secret": "shh" more')])))
            .not.toContain('shh');
    });
});

describe('redactTranscript — malformed and hostile input', () => {
    it('does not throw and does not pass a secret through truncated JSON', () => {
        let out: Entry[] | null = null;
        expect(() => { out = redactTranscript([entry('{"password":"hunter2"')]); }).not.toThrow();
        expect(flatten(out)).not.toContain('hunter2');
    });

    it('returns null for null and undefined for undefined', () => {
        expect(redactTranscript(null)).toBeNull();
        expect(redactTranscript(undefined)).toBeUndefined();
    });

    it('returns an empty transcript unchanged', () => {
        expect(redactTranscript([])).toEqual([]);
    });

    it('survives a self-referential object without hanging', () => {
        const cyclic: Record<string, unknown> = { password: 'hunter2' };
        cyclic.self = cyclic;

        let out: unknown;
        expect(() => { out = redactTranscript(cyclic); }).not.toThrow();
        // The cycle must have been broken, so the result is serialisable...
        expect(() => JSON.stringify(out)).not.toThrow();
        // ...and the secret must not be in it.
        expect(JSON.stringify(out)).not.toContain('hunter2');
    });

    it('survives pathologically deep nesting', () => {
        let deep: Record<string, unknown> = { token: 'abc' };
        for (let i = 0; i < 500; i++) deep = { nested: deep };

        expect(() => redactTranscript([entry(JSON.stringify(deep))])).not.toThrow();
        expect(flatten(redactTranscript([entry(JSON.stringify(deep))]))).not.toContain('"abc"');
    });
});
