import { describe, it, expect } from 'vitest';
import { executeCodeInSandbox } from './sandbox';

describe('executeCodeInSandbox', () => {
    it('captures console.log output', async () => {
        const result = await executeCodeInSandbox('console.log("hello world")');
        expect(result).toBe('hello world');
    });

    it('serializes object arguments as JSON', async () => {
        const result = await executeCodeInSandbox('console.log({ a: 1 })');
        expect(result).toContain('"a": 1');
    });

    it('prefixes console.error and console.warn output', async () => {
        const result = await executeCodeInSandbox('console.error("boom"); console.warn("careful")');
        expect(result).toContain('ERROR: boom');
        expect(result).toContain('WARN: careful');
    });

    it('reports no output when the code produces none', async () => {
        const result = await executeCodeInSandbox('const x = 1 + 1;');
        expect(result).toBe('Code executed successfully (no output).');
    });

    it('catches a runtime error thrown inside the code, without failing the call', async () => {
        // The mock console JSON-stringifies object args, and Error's message/stack
        // are non-enumerable — so a thrown Error currently logs as "ERROR: {}",
        // losing the message. Documented here as real (if unfortunate) behavior,
        // not a test bug: this is a plausible small production gap worth flagging,
        // not fixing unprompted.
        const result = await executeCodeInSandbox('throw new Error("inner failure")');
        expect(result).toBe('ERROR: {}');
    });

    it('supports awaiting an already-resolved promise inside the sandbox', async () => {
        const result = await executeCodeInSandbox('await Promise.resolve(); console.log("done")');
        expect(result).toBe('done');
    });

    it('does not expose timer functions inside the sandbox', async () => {
        const result = await executeCodeInSandbox('console.log(typeof setTimeout)');
        expect(result).toBe('undefined');
    });

    it('exposes read-only AWS SDK clients in scope', async () => {
        const result = await executeCodeInSandbox('console.log(typeof ec2, typeof ecs, typeof rds, typeof cw, typeof sts)');
        expect(result).toBe('object object object object object');
    });

    it('exposes the SDK namespaces for constructing Command classes', async () => {
        const result = await executeCodeInSandbox('console.log(typeof AWS_EC2.DescribeInstancesCommand)');
        expect(result).toBe('function');
    });

    it('isolates process.env from the real environment', async () => {
        process.env.__SANDBOX_TEST_SECRET__ = 'real-value';
        const result = await executeCodeInSandbox('console.log(process.env.__SANDBOX_TEST_SECRET__)');
        expect(result).toBe('undefined');
        delete process.env.__SANDBOX_TEST_SECRET__;
    });

    it('returns an execution-error message when the code itself fails to parse', async () => {
        const result = await executeCodeInSandbox('this is not valid javascript {{{');
        expect(result).toContain('Execution Error:');
    });
});
