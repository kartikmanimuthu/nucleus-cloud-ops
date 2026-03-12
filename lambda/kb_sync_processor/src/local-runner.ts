/**
 * KB Sync Processor — Local Runner
 *
 * Runs the Lambda handler locally for testing without deploying.
 *
 * USAGE
 * ─────
 * Install deps (first time):
 *   cd lambda/kb_sync_processor && npm install
 *
 * Run with a specific job type:
 *   npm run dev -- --type=file-upload --kbId=<kbId> --dsId=<dsId> --stagingKey=<s3Key> --fileName=test.txt --mimeType=text/plain
 *   npm run dev -- --type=s3-sync    --kbId=<kbId> --dsId=<dsId> --bucket=<bucketName> --prefix=docs/
 *   npm run dev -- --type=confluence-sync --kbId=<kbId> --dsId=<dsId> --baseUrl=https://your.atlassian.net --spaceKey=ENG
 *   npm run dev -- --type=bitbucket-sync  --kbId=<kbId> --dsId=<dsId> --workspace=myws --email=you@co.com --apiToken=<token> [--repo=myrepo] [--project=MYPROJ] [--branch=main]
 *
 * AWS auth:
 *   export AWS_PROFILE=AWS_PROFILE
 *   (or pass inline: AWS_PROFILE=AWS_PROFILE npm run dev -- ...)
 *
 * Environment variables are pre-configured for the deployed nucleus-app stack.
 * Override any of them by setting them before running, e.g.:
 *   APP_TABLE_NAME=my-table npm run dev -- ...
 */

// Force AWS SDK to load ~/.aws/config (needed for SSO profiles)
process.env.AWS_SDK_LOAD_CONFIG = '1';

// ── Pre-configure env vars from the deployed nucleus-app stack ──────────────
// IMPORTANT: These must be set BEFORE importing index.ts because the Lambda
// clients are initialized at module load time.
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'ap-south-1';
if (!process.env.APP_TABLE_NAME) process.env.APP_TABLE_NAME = 'nucleus-app-app-table';
if (!process.env.KB_VECTOR_BUCKET_NAME) process.env.KB_VECTOR_BUCKET_NAME = 'nucleus-app-vectors-970547372609-ap-south-1';
if (!process.env.KB_VECTOR_INDEX_NAME) process.env.KB_VECTOR_INDEX_NAME = 'knowledge-base-embeddings';
if (!process.env.KB_STAGING_BUCKET_NAME) process.env.KB_STAGING_BUCKET_NAME = 'nucleus-app-kb-staging-970547372609-ap-south-1';
if (!process.env.BEDROCK_MODEL_ID) process.env.BEDROCK_MODEL_ID = 'amazon.titan-embed-text-v2:0';
if (!process.env.DEFAULT_TENANT_ID) process.env.DEFAULT_TENANT_ID = 'org-default';
// ────────────────────────────────────────────────────────────────────────────

import type { SQSEvent, SQSRecord, Context } from 'aws-lambda';
import type { KBSyncJob } from './index.js';

// ── Parse CLI args ───────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=')];
    })
);

function require_arg(name: string): string {
  if (!args[name]) { console.error(`Missing required arg: --${name}`); process.exit(1); }
  return args[name];
}

// ── Build job payload from CLI args ─────────────────────────────────────────
function buildJob(): KBSyncJob {
  const type = (args['type'] || 'file-upload') as KBSyncJob['type'];
  const kbId = require_arg('kbId');
  const dsId = require_arg('dsId');

  switch (type) {
    case 'file-upload':
      return {
        type,
        kbId,
        dsId,
        stagingKey: require_arg('stagingKey'),
        fileName: args['fileName'] || 'test.txt',
        mimeType: args['mimeType'] || 'text/plain',
      };
    case 's3-sync':
      return {
        type,
        kbId,
        dsId,
        config: {
          bucketName: require_arg('bucket'),
          prefix: args['prefix'],
          filePatterns: args['patterns']?.split(','),
          region: args['srcRegion'],
        },
      };
    case 'confluence-sync':
      return {
        type,
        kbId,
        dsId,
        config: {
          baseUrl: require_arg('baseUrl'),
          spaceKey: args['spaceKey'] || '',
          pageIds: args['pageIds']?.split(','),
          email: args['email'],
          apiToken: args['apiToken'],
        },
      };
    case 'bitbucket-sync':
      return {
        type,
        kbId,
        dsId,
        config: {
          workspace: require_arg('workspace'),
          project: args['project'],
          repoSlug: args['repo'],
          branch: args['branch'],
          paths: args['paths']?.split(','),
          email: require_arg('email'),
          apiToken: require_arg('apiToken'),
          baseUrl: args['baseUrl'],
        },
      };
    default:
      console.error(`Unknown --type: ${type}. Valid: file-upload | s3-sync | confluence-sync | bitbucket-sync`);
      process.exit(1);
  }
}

// ── Mock Lambda context & SQS event ─────────────────────────────────────────
const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'kb-sync-processor-local',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:local:000000000000:function:kb-sync-processor',
  memoryLimitInMB: '1024',
  awsRequestId: `local-${Date.now()}`,
  logGroupName: '/aws/lambda/kb-sync-processor',
  logStreamName: `local-${new Date().toISOString().split('T')[0]}`,
  getRemainingTimeInMillis: () => 900_000,
  done: () => { },
  fail: () => { },
  succeed: () => { },
};

function buildSQSEvent(job: KBSyncJob): SQSEvent {
  return {
    Records: [{
      messageId: `local-${Date.now()}`,
      receiptHandle: 'local',
      body: JSON.stringify(job),
      attributes: { ApproximateReceiveCount: '1', SentTimestamp: String(Date.now()), SenderId: 'local', ApproximateFirstReceiveTimestamp: String(Date.now()) },
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:local:000000000000:kb-sync-queue',
      awsRegion: process.env.AWS_REGION!,
    } as SQSRecord],
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        KB Sync Processor — Local Runner                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();
  console.log('Config:');
  console.log(`  AWS_PROFILE:          ${process.env.AWS_PROFILE || 'default'}`);
  console.log(`  AWS_REGION:           ${process.env.AWS_REGION}`);
  console.log(`  APP_TABLE_NAME:       ${process.env.APP_TABLE_NAME}`);
  console.log(`  KB_VECTOR_BUCKET:     ${process.env.KB_VECTOR_BUCKET_NAME}`);
  console.log(`  KB_VECTOR_INDEX:      ${process.env.KB_VECTOR_INDEX_NAME}`);
  console.log(`  KB_STAGING_BUCKET:    ${process.env.KB_STAGING_BUCKET_NAME}`);
  console.log(`  BEDROCK_MODEL_ID:     ${process.env.BEDROCK_MODEL_ID}`);
  console.log();

  const job = buildJob();
  const event = buildSQSEvent(job);

  console.log('Job:', JSON.stringify(job, null, 2));
  console.log();
  console.log('Starting execution...');
  console.log('─'.repeat(60));

  const start = Date.now();
  try {
    // Dynamic import ensures env vars are set before AWS clients are initialized
    const { handler } = await import('./index.js');
    await handler(event);
    console.log();
    console.log('─'.repeat(60));
    console.log(`✅ Done in ${Date.now() - start}ms`);
  } catch (err: any) {
    console.error();
    console.error('─'.repeat(60));
    console.error('❌ Execution failed:', err?.message || err);
    if (err?.message?.includes('sso') || err?.message?.includes('Credentials') || err?.message?.includes('credentials')) {
      console.error('\nHint: AWS auth error — run: aws sso login --profile AWS_PROFILE');
    }
    process.exit(1);
  }
}

main().catch(console.error);
