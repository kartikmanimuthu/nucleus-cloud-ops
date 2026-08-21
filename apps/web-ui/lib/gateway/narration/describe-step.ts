// web-ui/lib/gateway/narration/describe-step.ts
import type { AgentOpsEvent } from '@/lib/agent-ops/types';
import type { StepPhrase } from './checklist';

/**
 * Name a tool call from its arguments, so a checklist reads as a log of what the
 * run actually did rather than a column of identical phrases. Every AWS action
 * goes through execute_command, so the tool name alone carries no information —
 * the command string does.
 *
 * Returns null whenever the arguments don't yield something better than the
 * static phrase in translate-event.ts; callers fall back to that.
 */

const SERVICE_LABELS: Record<string, string> = {
    ec2: 'EC2',
    s3: 'S3',
    rds: 'RDS',
    iam: 'IAM',
    sts: 'STS',
    ssm: 'SSM',
    acm: 'ACM',
    sns: 'SNS',
    sqs: 'SQS',
    ecs: 'ECS',
    eks: 'EKS',
    ecr: 'ECR',
    emr: 'EMR',
    lambda: 'Lambda',
    logs: 'CloudWatch Logs',
    cloudwatch: 'CloudWatch',
    cloudformation: 'CloudFormation',
    cloudfront: 'CloudFront',
    dynamodb: 'DynamoDB',
    autoscaling: 'Auto Scaling',
    elbv2: 'load balancer',
    route53: 'Route 53',
    ce: 'Cost Explorer',
    organizations: 'Organizations',
    secretsmanager: 'Secrets Manager',
};

/** Whole-subject overrides where "<service> <noun>" would read badly. */
const SUBJECT_OVERRIDES: Record<string, string> = {
    'ec2 describe-addresses': 'Elastic IPs',
    'ec2 describe-instance-status': 'EC2 instance health',
    's3 ls': 'S3 objects',
};

const VERB_RULES: Array<[RegExp, StepPhrase]> = [
    [/(^|-)(status|health)$/, { active: 'Checking', done: 'Checked' }],
    [/^(describe|list|ls)/, { active: 'Listing', done: 'Listed' }],
    [/^get/, { active: 'Fetching', done: 'Fetched' }],
    [/^start/, { active: 'Starting', done: 'Started' }],
    [/^(stop|shutdown)/, { active: 'Stopping', done: 'Stopped' }],
    [/^reboot/, { active: 'Rebooting', done: 'Rebooted' }],
    [/^terminate/, { active: 'Terminating', done: 'Terminated' }],
    [/^(run|launch)/, { active: 'Launching', done: 'Launched' }],
    [/^create/, { active: 'Creating', done: 'Created' }],
    [/^delete/, { active: 'Deleting', done: 'Deleted' }],
    [/^release/, { active: 'Releasing', done: 'Released' }],
    [/^(modify|update|put|set)/, { active: 'Updating', done: 'Updated' }],
    [/^(attach|associate|register)/, { active: 'Attaching', done: 'Attached' }],
    [/^(detach|disassociate|deregister)/, { active: 'Detaching', done: 'Detached' }],
    [/^(tag|untag)/, { active: 'Tagging', done: 'Tagged' }],
    [/^copy/, { active: 'Copying', done: 'Copied' }],
];

function verbFor(operation: string): StepPhrase {
    for (const [pattern, phrase] of VERB_RULES) {
        if (pattern.test(operation)) return phrase;
    }
    return { active: 'Running', done: 'Ran' };
}

/**
 * Tokenize on whitespace only. Quoted JMESPath (`--query "…|[0].Value"`) survives
 * as junk tokens, which is harmless: we match the exact `--region` token and the
 * first two bare words after `aws`, none of which can appear inside a query.
 */
function tokenize(command: string): string[] {
    return command.replace(/\\\s*\n/g, ' ').split(/\s+/).filter(Boolean);
}

function findRegion(tokens: string[]): string | null {
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith('--region=')) return token.slice('--region='.length) || null;
        if (token === '--region') return tokens[i + 1] ?? null;
    }
    return null;
}

function describeAwsCommand(command: string): StepPhrase | null {
    const tokens = tokenize(command);
    const awsIndex = tokens.indexOf('aws');
    if (awsIndex === -1) return null;

    const bare = tokens.slice(awsIndex + 1).filter((t) => !t.startsWith('-'));
    const [service, operation] = bare;
    if (!service || !operation) return null;

    const key = `${service} ${operation}`;
    const subject = Object.hasOwn(SUBJECT_OVERRIDES, key)
        ? SUBJECT_OVERRIDES[key]
        : `${SERVICE_LABELS[service] ?? service.toUpperCase()} ${operation.split('-').slice(1).join(' ')}`.trim();

    const verb = verbFor(operation);
    const region = findRegion(tokens);
    const where = region ? ` in ${region}` : '';

    return {
        active: `${verb.active} ${subject}${where}...`,
        done: `${verb.done} ${subject}${where}`,
    };
}

export function describeToolCall(event: AgentOpsEvent, accountName?: string): StepPhrase | null {
    const args = event.toolArgs;

    if (event.toolName === 'get_aws_credentials') {
        const accountId = args && Object.hasOwn(args, 'accountId') ? args.accountId : undefined;
        const target = accountName || (typeof accountId === 'string' ? accountId : '');
        if (!target) return null;
        return { active: `Connecting to ${target}...`, done: `Connected to ${target}` };
    }

    if (event.toolName !== 'execute_command') return null;
    // toolArgs is model-authored: own-property check keeps a `command` inherited
    // off the prototype chain from reaching the parser.
    const command = args && Object.hasOwn(args, 'command') ? args.command : undefined;
    if (typeof command !== 'string') return null;
    return describeAwsCommand(command);
}
