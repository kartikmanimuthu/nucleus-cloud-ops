import { describe, it, expect } from 'vitest';
import { describeToolCall } from './describe-step';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

function call(toolName: string, toolArgs: Record<string, unknown>): AgentOpsEvent {
    return { PK: '', SK: '', runId: 'run-1', eventType: 'tool_call', node: 'agent', toolName, toolArgs, createdAt: '', ttl: 0 };
}

const cmd = (command: string) => call('execute_command', { command });

describe('describeToolCall — AWS CLI commands', () => {
    // Verbatim from a real Agent Ops run: multi-line with backslash continuations,
    // a --query holding a `|` inside quotes, and a piped jq tail.
    it('names a describe-instances call with its region', () => {
        const command = `aws ec2 describe-instances \\
  --region us-east-1 \\
  --profile nucleus_agent_970547372609_1785305321942 \\
  --output json \\
  --query 'Reservations[*].Instances[*].{
    InstanceId: InstanceId,
    Name: Tags[?Key==\`Name\`]|[0].Value,
    State: State.Name
  }' | jq '.[][]'`;

        expect(describeToolCall(cmd(command))).toEqual({
            active: 'Listing EC2 instances in us-east-1...',
            done: 'Listed EC2 instances in us-east-1',
        });
    });

    it('reads a status operation as a health check', () => {
        const command = 'aws ec2 describe-instance-status --region ap-south-1 --profile p --output json';
        expect(describeToolCall(cmd(command))).toEqual({
            active: 'Checking EC2 instance health in ap-south-1...',
            done: 'Checked EC2 instance health in ap-south-1',
        });
    });

    it('names Elastic IPs rather than the raw "addresses" noun', () => {
        const command = 'aws ec2 describe-addresses --profile p --region ap-south-1 --output json';
        expect(describeToolCall(cmd(command))).toEqual({
            active: 'Listing Elastic IPs in ap-south-1...',
            done: 'Listed Elastic IPs in ap-south-1',
        });
    });

    it('finds the region when it trails a quoted --query containing a pipe', () => {
        const command = `aws ec2 describe-instances --output json --query "Reservations[*].Instances[*].{Name: Tags[?Key=='Name']|[0].Value}" --region eu-west-2`;
        expect(describeToolCall(cmd(command))?.done).toBe('Listed EC2 instances in eu-west-2');
    });

    it('accepts the --region=value form', () => {
        expect(describeToolCall(cmd('aws ec2 describe-instances --region=ap-south-1'))?.done)
            .toBe('Listed EC2 instances in ap-south-1');
    });

    it('omits the region clause when no region is given', () => {
        expect(describeToolCall(cmd('aws s3 ls s3://bucket'))?.done).toBe('Listed S3 objects');
    });

    it('uses a mutating verb for a mutating operation', () => {
        const command = 'aws ec2 release-address --allocation-id eipalloc-123 --region ap-south-1 --profile p';
        expect(describeToolCall(cmd(command))).toEqual({
            active: 'Releasing EC2 address in ap-south-1...',
            done: 'Released EC2 address in ap-south-1',
        });
    });

    it('humanises an unmapped service by upper-casing it', () => {
        expect(describeToolCall(cmd('aws kinesis list-streams --region us-east-1'))?.done)
            .toBe('Listed KINESIS streams in us-east-1');
    });

    it('picks the first aws invocation out of a chained command', () => {
        const command = 'mkdir -p /tmp/out && aws ec2 describe-instances --region us-east-1 > /tmp/out/i.json';
        expect(describeToolCall(cmd(command))?.done).toBe('Listed EC2 instances in us-east-1');
    });

    it('returns null for a non-aws command so the generic phrase is used', () => {
        expect(describeToolCall(cmd('kubectl get pods -n default'))).toBeNull();
        expect(describeToolCall(cmd('ls -la /tmp'))).toBeNull();
    });

    it('returns null when the aws command has no operation', () => {
        expect(describeToolCall(cmd('aws ec2'))).toBeNull();
        expect(describeToolCall(cmd('aws'))).toBeNull();
    });

    it('returns null when the command arg is missing or not a string', () => {
        expect(describeToolCall(call('execute_command', {}))).toBeNull();
        expect(describeToolCall(call('execute_command', { command: 42 }))).toBeNull();
    });
});

describe('describeToolCall — get_aws_credentials', () => {
    it('names the account when the run knows it', () => {
        expect(describeToolCall(call('get_aws_credentials', { accountId: '970547372609' }), 'STX-CLOUD-PLATFORM'))
            .toEqual({
                active: 'Connecting to STX-CLOUD-PLATFORM...',
                done: 'Connected to STX-CLOUD-PLATFORM',
            });
    });

    it('falls back to the account id when the name is unknown', () => {
        expect(describeToolCall(call('get_aws_credentials', { accountId: '970547372609' }))?.done)
            .toBe('Connected to 970547372609');
    });

    it('returns null with neither a name nor an id, leaving the generic phrase', () => {
        expect(describeToolCall(call('get_aws_credentials', {}))).toBeNull();
    });
});

describe('describeToolCall — out of scope tools', () => {
    it('returns null for tools it does not specialise', () => {
        expect(describeToolCall(call('read_file', { path: '/tmp/x' }))).toBeNull();
        expect(describeToolCall(call('mcp_custom_thing', { anything: true }))).toBeNull();
    });

    // toolArgs is model-authored, so a prototype key must not resolve off the chain.
    it('ignores prototype-chain properties on toolArgs', () => {
        expect(describeToolCall(call('execute_command', Object.create({ command: 'aws ec2 describe-instances' })))).toBeNull();
    });
});
