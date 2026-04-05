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

// ---------------------------------------------------------------------------
// applyEnrichments — generic enrichment engine
// ---------------------------------------------------------------------------

export async function applyEnrichments(
  client: any,
  service: string,
  resources: any[],
  enrichments: EnrichmentStep[],
): Promise<any[]> {
  let current = [...resources];

  for (const enrichment of enrichments) {
    try {
      switch (enrichment.type) {
        case 'tags':
          current = await applyTagEnrichment(client, service, current, enrichment);
          break;
        case 'describe':
          current = await applyDescribeEnrichment(client, service, current, enrichment);
          break;
        case 'detail':
          current = await applyDetailEnrichment(client, service, current, enrichment);
          break;
      }
    } catch (error) {
      console.warn(
        `[discovery/scanner] Enrichment ${enrichment.type}:${enrichment.method} failed for ${service}, continuing:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return current;
}

async function applyTagEnrichment(
  client: any,
  service: string,
  resources: any[],
  enrichment: EnrichmentStep,
): Promise<any[]> {
  const { method, arnKey, nameKey, inputKey, batchSize } = enrichment;
  const CommandClass = await getCommandClass(service, toCommandName(method));

  if (batchSize && arnKey && inputKey) {
    const arnMap = new Map<string, any>();
    for (const r of resources) {
      if (typeof r === 'object' && r[arnKey]) {
        arnMap.set(r[arnKey], r);
      }
    }
    const arns = Array.from(arnMap.keys());

    for (let i = 0; i < arns.length; i += batchSize) {
      const batch = arns.slice(i, i + batchSize);
      try {
        const command = new CommandClass({ [inputKey]: batch });
        const response = await client.send(command);
        const tagDescs = response.TagDescriptions || [];
        for (const td of tagDescs) {
          const arn = td.ResourceArn;
          if (arn && arnMap.has(arn)) {
            arnMap.get(arn).Tags = td.Tags || [];
          }
        }
      } catch (error) {
        console.warn(`[discovery/scanner] Batch tag enrichment failed for ${service}:`, error instanceof Error ? error.message : error);
      }
    }
    return resources;
  }

  for (const resource of resources) {
    if (typeof resource !== 'object') continue;
    const key = arnKey ? resource[arnKey] : nameKey ? resource[nameKey] : null;
    if (!key) continue;
    try {
      const paramKey = inputKey || (arnKey ? 'ResourceArn' : 'ResourceName');
      const command = new CommandClass({ [paramKey]: key });
      const response = await client.send(command);
      const tags = response.Tags || response.TagList || response.TagSet || response.tags || [];
      resource.Tags = Array.isArray(tags)
        ? tags
        : Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
    } catch (error) {
      console.warn(`[discovery/scanner] Tag fetch failed for ${key}:`, error instanceof Error ? error.message : error);
    }
  }

  return resources;
}

async function applyDescribeEnrichment(
  client: any,
  service: string,
  resources: any[],
  enrichment: EnrichmentStep,
): Promise<any[]> {
  const { method, inputKey, resultKey, batchSize, idKey } = enrichment;
  const CommandClass = await getCommandClass(service, toCommandName(method));

  const ids: any[] = resources.map((r) => {
    if (typeof r === 'string') return r;
    if (idKey && r[idKey]) return r[idKey];
    return r;
  });

  const allDescribed: any[] = [];
  const chunkSize = batchSize || ids.length;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const batch = ids.slice(i, i + chunkSize);
    try {
      if (!batchSize || batchSize === 1) {
        for (const id of batch) {
          const params = inputKey ? { [inputKey]: id } : {};
          const command = new CommandClass(params);
          const response = await client.send(command);
          const result = resultKey ? response[resultKey] : response;
          if (Array.isArray(result)) allDescribed.push(...result);
          else if (result) allDescribed.push(result);
        }
      } else {
        const params = inputKey ? { [inputKey]: batch } : {};
        const command = new CommandClass(params);
        const response = await client.send(command);
        const result = resultKey ? response[resultKey] : response;
        if (Array.isArray(result)) allDescribed.push(...result);
        else if (result) allDescribed.push(result);
      }
    } catch (error) {
      console.warn(`[discovery/scanner] Describe enrichment failed for ${service}.${method}:`, error instanceof Error ? error.message : error);
    }
  }

  return allDescribed.length > 0 ? allDescribed : resources;
}

async function applyDetailEnrichment(
  client: any,
  service: string,
  resources: any[],
  enrichment: EnrichmentStep,
): Promise<any[]> {
  const { method, nameKey, arnKey, inputKey, mergeKey } = enrichment;
  const CommandClass = await getCommandClass(service, toCommandName(method));

  for (const resource of resources) {
    if (typeof resource !== 'object') continue;
    const key = nameKey ? resource[nameKey] : arnKey ? resource[arnKey] : null;
    if (!key) continue;
    try {
      const paramKey = inputKey || 'ResourceName';
      const command = new CommandClass({ [paramKey]: key });
      const response = await client.send(command);
      const { ResponseMetadata, ...data } = response;
      if (mergeKey && data[mergeKey]) {
        Object.assign(resource, data[mergeKey]);
      } else {
        Object.assign(resource, data);
      }
    } catch (error) {
      console.warn(`[discovery/scanner] Detail enrichment failed for ${key}:`, error instanceof Error ? error.message : error);
    }
  }

  return resources;
}

// ---------------------------------------------------------------------------
// extractResourceIdentifiers — extract id/arn/name/state/tags from AWS response
// ---------------------------------------------------------------------------

export function extractResourceIdentifiers(
  resource: Record<string, any>,
  service: string,
): { resourceId: string; resourceArn: string; name: string; state: string; tags: Record<string, string> } {
  const identifiers = {
    resourceId: '',
    resourceArn: '',
    name: '',
    state: 'unknown',
    tags: {} as Record<string, string>,
  };

  const idKeys = [
    'InstanceId', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'ClusterIdentifier',
    'FunctionName', 'BucketName', 'Name',
    'VolumeId', 'NetworkInterfaceId', 'VpcId', 'SubnetId', 'GroupId',
    'KeyId', 'AutoScalingGroupName', 'LoadBalancerArn', 'TopicArn', 'QueueUrl',
    'FileSystemId', 'NatGatewayId', 'DistributionId', 'TableName', 'StreamName',
    'CacheClusterId', 'ReplicationGroupId', 'ClusterArn', 'ServiceArn', 'TaskArn',
    'TransitGatewayId', 'TransitGatewayAttachmentId', 'VpcPeeringConnectionId',
    'clusterArn', 'serviceArn',
    'clusterName', 'serviceName',
    'repositoryName',
    'CertificateId', 'CertificateArn',
    'RoleName', 'RoleId',
    'UserName', 'UserId',
    'id', 'name', 'Id',
  ];

  for (const key of idKeys) {
    if (key in resource) {
      identifiers.resourceId = resource[key];
      break;
    }
  }

  const arnKeys = [
    'Arn', 'ARN', 'FunctionArn', 'DBInstanceArn', 'DBClusterArn',
    'LoadBalancerArn', 'TopicArn', 'QueueArn', 'FileSystemArn',
    'KeyArn', 'ClusterArn', 'ServiceArn', 'TaskArn', 'TableArn',
    'TransitGatewayArn',
    'clusterArn', 'serviceArn',
    'CertificateArn',
    'repositoryArn',
  ];

  for (const key of arnKeys) {
    if (key in resource) {
      identifiers.resourceArn = resource[key];
      break;
    }
  }

  const nameKeys = [
    'Name', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'FunctionName',
    'BucketName', 'AutoScalingGroupName', 'LoadBalancerName', 'FileSystemId',
    'TableName', 'TopicName', 'QueueName',
    'clusterName', 'serviceName',
    'repositoryName',
    'DomainName',
    'CertificateId',
  ];

  for (const key of nameKeys) {
    if (key in resource) {
      identifiers.name = resource[key];
      break;
    }
  }

  if (!identifiers.name) {
    const tags = resource.Tags || resource.TagList || [];
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (typeof tag === 'object' && tag.Key === 'Name') {
          identifiers.name = tag.Value || '';
          break;
        }
      }
    }
  }

  const state = resource.State ?? resource.DBInstanceStatus ?? resource.Status ?? resource.InstanceStatus ?? resource.status;
  if (typeof state === 'object' && state !== null) {
    identifiers.state = state.Name ?? state.Code ?? 'unknown';
  } else if (typeof state === 'string') {
    identifiers.state = state;
  }

  const rawTags = resource.Tags ?? resource.TagList ?? resource.tags ?? [];
  if (Array.isArray(rawTags)) {
    identifiers.tags = {};
    for (const tag of rawTags) {
      if (typeof tag === 'object' && 'Key' in tag) {
        identifiers.tags[tag.Key] = tag.Value ?? '';
      }
    }
  } else if (typeof rawTags === 'object') {
    identifiers.tags = rawTags as Record<string, string>;
  }

  if (!identifiers.name) {
    identifiers.name = identifiers.resourceId;
  }

  return identifiers;
}

// ---------------------------------------------------------------------------
// normalizeResources — convert raw AWS response items to Resource[]
// ---------------------------------------------------------------------------

export function normalizeResources(
  rawData: any,
  service: string,
  functionName: string,
  region: string,
): Resource[] {
  if (!rawData) return [];

  const items: any[] = Array.isArray(rawData) ? rawData : [rawData];
  if (items.length === 0) return [];

  const resourceType = `${service}_${functionName}`
    .replace('describe_', '')
    .replace('list_', '')
    .replace('get_', '');

  const resources: Resource[] = [];

  for (const item of items) {
    if (typeof item === 'string') {
      const id = item.includes('/') ? item.split('/').pop()! : item.split(':').pop()!;
      resources.push({
        resourceType,
        region,
        service,
        resourceId: id,
        resourceArn: item.startsWith('arn:') ? item : '',
        name: id,
        state: 'unknown',
        tags: {},
        rawData: item,
      });
    } else if (typeof item === 'object' && item !== null) {
      const ids = extractResourceIdentifiers(item, service);
      resources.push({
        resourceType,
        region,
        service,
        resourceId: ids.resourceId,
        resourceArn: ids.resourceArn,
        name: ids.name,
        state: ids.state,
        tags: ids.tags,
        rawData: item,
      });
    }
  }

  return resources;
}
