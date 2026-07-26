import { describe, it, expect } from 'vitest';
import { validateAwsReadRequest, buildAwsReadArgv } from './aws-read-tool';

const ok = { service: 'ec2', operation: 'describe-instances' };

describe('validateAwsReadRequest', () => {
    it('accepts a read operation', () => {
        expect(validateAwsReadRequest(ok)).toBeNull();
    });

    it('refuses a mutating operation', () => {
        for (const operation of ['terminate-instances', 'delete-bucket', 'sync', 'cp', 'run-instances']) {
            expect(validateAwsReadRequest({ ...ok, operation })).toMatch(/not a read-only operation/);
        }
    });

    it('refuses credential-minting reads that match the read prefix', () => {
        for (const operation of [
            'get-session-token', 'get-federation-token', 'get-login-password',
            'get-token', 'get-password-data', 'get-cluster-credentials',
        ]) {
            expect(validateAwsReadRequest({ ...ok, service: 'sts', operation }))
                .toMatch(/credentials or mutates/);
        }
    });

    it('refuses flags that reach outside the request', () => {
        for (const flag of ['--endpoint-url', '--cli-input-json', '--outfile', '--no-sign-request']) {
            expect(validateAwsReadRequest({ ...ok, params: { [flag]: 'x' } }))
                .toMatch(/not available to sub-agents/);
        }
    });

    it('refuses malformed identifiers rather than passing them through', () => {
        expect(validateAwsReadRequest({ ...ok, service: 'ec2; rm -rf /' })).toMatch(/not a valid AWS service/);
        expect(validateAwsReadRequest({ ...ok, operation: 'describe-instances && pulumi destroy' })).toMatch(/not a valid operation/);
        expect(validateAwsReadRequest({ ...ok, region: 'us-east-1$(id)' })).toMatch(/invalid region/);
        expect(validateAwsReadRequest({ ...ok, profile: '../../etc/passwd' })).toMatch(/invalid profile/);
        expect(validateAwsReadRequest({ ...ok, params: { 'notaflag': 'x' } })).toMatch(/not a valid --flag/);
    });
});

describe('buildAwsReadArgv', () => {
    it('emits service, operation, flags and json output — never a shell string', () => {
        expect(buildAwsReadArgv({
            service: 'ec2', operation: 'describe-instances',
            region: 'us-east-1', profile: 'nucleus_agent_1',
            params: { '--instance-ids': 'i-123' },
        })).toEqual([
            'ec2', 'describe-instances', '--region', 'us-east-1',
            '--profile', 'nucleus_agent_1', '--instance-ids', 'i-123',
            '--output', 'json',
        ]);
    });

    it('emits no positional arguments, so an outfile cannot be supplied', () => {
        const argv = buildAwsReadArgv({ service: 's3api', operation: 'get-object', params: { '--bucket': 'b', '--key': 'k' } });
        // Every element after the leading service+operation is a flag or a flag's value.
        expect(argv.slice(2).filter((t, i, a) => !t.startsWith('--') && !a[i - 1]?.startsWith('--'))).toEqual([]);
    });

    it('treats injection attempts as inert argv data', () => {
        // These never reach a shell, so they are values — not code. Validation
        // refuses them anyway; this pins that argv construction does not concatenate.
        const argv = buildAwsReadArgv({ service: 'ec2', operation: 'describe-instances', params: { '--filters': 'a; rm -rf /' } });
        expect(argv).toContain('a; rm -rf /');
        expect(argv.join(' ')).not.toContain('&&');
    });
});
