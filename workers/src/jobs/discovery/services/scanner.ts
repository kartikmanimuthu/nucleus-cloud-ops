// workers/src/jobs/discovery/services/scanner.ts
import type { ScanConfig, Resource, ScanResult, EnrichmentStep, AssumedCredentials } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;
const RETRYABLE_ERROR_NAMES = new Set(['ThrottlingException', 'RequestLimitExceeded', 'Throttling', 'TooManyRequestsException']);

const CONCURRENT_REGIONS = parseInt(process.env.CONCURRENT_REGIONS || '5', 10);
const CONCURRENT_SERVICES = parseInt(process.env.CONCURRENT_SERVICES || '10', 10);

// ---------------------------------------------------------------------------
// SERVICE_REGISTRY — maps scanfile service name → AWS SDK v3 client constructor
// ---------------------------------------------------------------------------

import { EC2Client } from '@aws-sdk/client-ec2';
import { RDSClient } from '@aws-sdk/client-rds';
import { ECSClient } from '@aws-sdk/client-ecs';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { KMSClient } from '@aws-sdk/client-kms';
import { ECRClient } from '@aws-sdk/client-ecr';
import { EKSClient } from '@aws-sdk/client-eks';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ACMClient } from '@aws-sdk/client-acm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SNSClient } from '@aws-sdk/client-sns';
import { IAMClient } from '@aws-sdk/client-iam';
import { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { EFSClient } from '@aws-sdk/client-efs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { WAFV2Client } from '@aws-sdk/client-wafv2';
import { BackupClient } from '@aws-sdk/client-backup';
import { CodePipelineClient } from '@aws-sdk/client-codepipeline';

export const SERVICE_REGISTRY: Record<string, new (config: any) => any> = {
  ec2: EC2Client,
  rds: RDSClient,
  ecs: ECSClient,
  lambda: LambdaClient,
  s3: S3Client,
  elbv2: ElasticLoadBalancingV2Client,
  kms: KMSClient,
  ecr: ECRClient,
  eks: EKSClient,
  cloudfront: CloudFrontClient,
  apigateway: APIGatewayClient,
  acm: ACMClient,
  dynamodb: DynamoDBClient,
  sqs: SQSClient,
  sns: SNSClient,
  iam: IAMClient,
  autoscaling: AutoScalingClient,
  elasticache: ElastiCacheClient,
  efs: EFSClient,
  secretsmanager: SecretsManagerClient,
  ssm: SSMClient,
  cloudwatch: CloudWatchClient,
  events: EventBridgeClient,
  wafv2: WAFV2Client,
  backup: BackupClient,
  codepipeline: CodePipelineClient,
  docdb: RDSClient, // DocDB uses RDS client
};

// ---------------------------------------------------------------------------
// toCommandName — converts snake_case function to PascalCase + "Command"
// ---------------------------------------------------------------------------

export function toCommandName(fn: string): string {
  return (
    fn
      .split('_')
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join('') + 'Command'
  );
}

// ---------------------------------------------------------------------------
// sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// isRetryable — check if an error is retryable
// ---------------------------------------------------------------------------

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    return RETRYABLE_ERROR_NAMES.has((error as any).name) || RETRYABLE_ERROR_NAMES.has((error as any).Code);
  }
  return false;
}

// ---------------------------------------------------------------------------
// invokeService — generic API caller with retry
// ---------------------------------------------------------------------------

export async function invokeService(
  client: any,
  region: string,
  scanConfig: ScanConfig,
): Promise<any[]> {
  const commandName = toCommandName(scanConfig.function);
  const params = scanConfig.parameters || {};

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const CommandClass = await getCommandClass(scanConfig.service, commandName);
      const command = new CommandClass(params);
      const response = await client.send(command);

      const items = response[scanConfig.result_key];
      if (!items) return [];
      return Array.isArray(items) ? items : [items];
    } catch (error) {
      if (isRetryable(error) && attempt < MAX_RETRIES) {
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[discovery/scanner] Throttled on ${scanConfig.service}.${scanConfig.function} in ${region}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// getCommandClass — dynamically import the command class from the right package
// ---------------------------------------------------------------------------

const COMMAND_CACHE = new Map<string, any>();

async function getCommandClass(service: string, commandName: string): Promise<any> {
  const cacheKey = `${service}:${commandName}`;
  if (COMMAND_CACHE.has(cacheKey)) {
    return COMMAND_CACHE.get(cacheKey);
  }

  const packageMap: Record<string, string> = {
    ec2: '@aws-sdk/client-ec2',
    rds: '@aws-sdk/client-rds',
    ecs: '@aws-sdk/client-ecs',
    lambda: '@aws-sdk/client-lambda',
    s3: '@aws-sdk/client-s3',
    elbv2: '@aws-sdk/client-elastic-load-balancing-v2',
    kms: '@aws-sdk/client-kms',
    ecr: '@aws-sdk/client-ecr',
    eks: '@aws-sdk/client-eks',
    cloudfront: '@aws-sdk/client-cloudfront',
    apigateway: '@aws-sdk/client-api-gateway',
    acm: '@aws-sdk/client-acm',
    dynamodb: '@aws-sdk/client-dynamodb',
    sqs: '@aws-sdk/client-sqs',
    sns: '@aws-sdk/client-sns',
    iam: '@aws-sdk/client-iam',
    autoscaling: '@aws-sdk/client-auto-scaling',
    elasticache: '@aws-sdk/client-elasticache',
    efs: '@aws-sdk/client-efs',
    secretsmanager: '@aws-sdk/client-secrets-manager',
    ssm: '@aws-sdk/client-ssm',
    cloudwatch: '@aws-sdk/client-cloudwatch',
    events: '@aws-sdk/client-eventbridge',
    wafv2: '@aws-sdk/client-wafv2',
    backup: '@aws-sdk/client-backup',
    codepipeline: '@aws-sdk/client-codepipeline',
    docdb: '@aws-sdk/client-rds',
  };

  const pkg = packageMap[service];
  if (!pkg) {
    throw new Error(`Unknown service: ${service}`);
  }

  const mod = await import(pkg);
  const CommandCls = mod[commandName];
  if (!CommandCls) {
    throw new Error(`Command ${commandName} not found in ${pkg}`);
  }

  COMMAND_CACHE.set(cacheKey, CommandCls);
  return CommandCls;
}
