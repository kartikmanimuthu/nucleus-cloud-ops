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
