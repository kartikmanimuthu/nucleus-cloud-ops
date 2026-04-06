// workers/src/jobs/discovery/services/pg-writer.ts
import type { PoolClient } from 'pg';
import type { Resource } from '../types.js';
import { getPool } from './db.js';

// ---------------------------------------------------------------------------
// writeResourcesToPg — batch upsert with deduplication
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

export async function writeResourcesToPg(
  resources: Resource[],
  tenantId: string,
  accountId: string,
  jobRunId: string,
): Promise<number> {
  if (!resources.length) return 0;

  // Deduplicate on (resourceType, resourceId) — last wins
  const seen = new Map<string, Resource>();
  for (const r of resources) {
    const key = `${r.resourceType}::${r.resourceId}`;
    seen.set(key, r);
  }
  const deduped = Array.from(seen.values());

  const client: PoolClient = await getPool().connect();
  let total = 0;

  try {
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE);
      const placeholders: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      for (const r of batch) {
        const metadata = extractMetadata(r);
        const tagsJson = JSON.stringify(r.tags || {});
        const metadataJson = JSON.stringify(metadata);
        const id = `res-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        placeholders.push(
          `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}::jsonb, $${paramIdx + 9}::jsonb, $${paramIdx + 10}, NOW(), NOW())`,
        );
        params.push(
          id,
          tenantId,
          accountId,
          r.region,
          r.resourceType,
          r.resourceId,
          r.name || null,
          r.state || null,
          tagsJson,
          metadataJson,
          jobRunId,
        );
        paramIdx += 11;
      }

      const sql = `
        INSERT INTO inventory_resources
          (id, "tenantId", "accountId", region, "resourceType", "resourceId",
           name, status, tags, metadata, "jobRunId", "discoveredAt", "updatedAt")
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId")
        DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
          "jobRunId" = EXCLUDED."jobRunId",
          "discoveredAt" = EXCLUDED."discoveredAt",
          "updatedAt" = NOW()
      `;

      await client.query(sql, params);
      total += batch.length;
    }
  } catch (error) {
    console.error('[discovery/pg-writer] Error writing resources:', error);
    throw error;
  } finally {
    client.release();
  }

  return total;
}

// ---------------------------------------------------------------------------
// saveSyncStatus — upsert inventory_sync_status
// ---------------------------------------------------------------------------

export async function saveSyncStatus(
  scanId: string,
  tenantId: string,
  totalResources: number,
  accountsSynced: number,
): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO inventory_sync_status
         ("scanId", "totalResources", "accountsSynced", "syncedAt", "createdAt")
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT ("scanId")
       DO UPDATE SET
         "totalResources" = EXCLUDED."totalResources",
         "accountsSynced" = EXCLUDED."accountsSynced",
         "syncedAt" = NOW()`,
      [scanId, totalResources, accountsSynced],
    );
  } catch (error) {
    console.error('[discovery/pg-writer] Error saving sync status:', error);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// extractMetadata — type-specific metadata extraction from rawData
// ---------------------------------------------------------------------------

export function extractMetadata(resource: Resource): Record<string, unknown> {
  // rawData can be a string (e.g. ECS cluster ARNs from list_clusters) — guard against non-objects
  const raw = (resource.rawData && typeof resource.rawData === 'object' ? resource.rawData : {}) as Record<string, any>;
  const type = resource.resourceType;

  if (type === 'ec2_instances') {
    return pick(raw, {
      instanceType: 'InstanceType', platform: 'Platform',
      privateIpAddress: 'PrivateIpAddress', publicIpAddress: 'PublicIpAddress',
      vpcId: 'VpcId', subnetId: 'SubnetId', launchTime: 'LaunchTime',
      imageId: 'ImageId', architecture: 'Architecture', keyName: 'KeyName',
    });
  }

  if (type === 'rds_db_instances') {
    const meta = pick(raw, {
      engine: 'Engine', engineVersion: 'EngineVersion', dbInstanceClass: 'DBInstanceClass',
      allocatedStorage: 'AllocatedStorage', multiAZ: 'MultiAZ', storageType: 'StorageType',
      storageEncrypted: 'StorageEncrypted', publiclyAccessible: 'PubliclyAccessible',
    });
    if (raw.Endpoint?.Address) {
      meta.endpoint = raw.Endpoint.Address;
      meta.port = raw.Endpoint.Port;
    }
    return meta;
  }

  if (type === 'rds_db_clusters' || type === 'docdb_db_clusters') {
    return pick(raw, {
      engine: 'Engine', engineVersion: 'EngineVersion',
      allocatedStorage: 'AllocatedStorage', multiAZ: 'MultiAZ',
      storageEncrypted: 'StorageEncrypted', dbClusterMembers: 'DBClusterMembers',
    });
  }

  if (type === 'lambda_functions') {
    return pick(raw, {
      runtime: 'Runtime', memorySize: 'MemorySize', timeout: 'Timeout',
      handler: 'Handler', codeSize: 'CodeSize', lastModified: 'LastModified',
      architectures: 'Architectures', packageType: 'PackageType',
    });
  }

  if (type === 'ecs_services' || type === 'ecs_describe_services') {
    return pick(raw, {
      desiredCount: 'desiredCount', runningCount: 'runningCount',
      pendingCount: 'pendingCount', launchType: 'launchType',
      clusterArn: 'ClusterArn', taskDefinition: 'taskDefinition',
    });
  }

  if (type === 'ecs_clusters') {
    return pick(raw, {
      status: 'status', registeredContainerInstancesCount: 'registeredContainerInstancesCount',
      runningTasksCount: 'runningTasksCount', pendingTasksCount: 'pendingTasksCount',
      activeServicesCount: 'activeServicesCount',
    });
  }

  if (type === 's3_buckets') {
    return pick(raw, { creationDate: 'CreationDate', locationConstraint: 'LocationConstraint' });
  }

  if (type === 'elbv2_load_balancers') {
    return pick(raw, {
      type: 'Type', scheme: 'Scheme', dnsName: 'DNSName',
      vpcId: 'VpcId', ipAddressType: 'IpAddressType',
    });
  }

  if (type === 'ec2_vpcs') {
    return pick(raw, { cidrBlock: 'CidrBlock', isDefault: 'IsDefault', dhcpOptionsId: 'DhcpOptionsId' });
  }

  if (type === 'ec2_subnets') {
    return pick(raw, {
      cidrBlock: 'CidrBlock', vpcId: 'VpcId', availabilityZone: 'AvailabilityZone',
      mapPublicIpOnLaunch: 'MapPublicIpOnLaunch', availableIpAddressCount: 'AvailableIpAddressCount',
    });
  }

  if (type === 'ec2_security_groups') {
    return pick(raw, {
      vpcId: 'VpcId', description: 'Description',
      ipPermissionsCount: raw.IpPermissions?.length,
      ipPermissionsEgressCount: raw.IpPermissionsEgress?.length,
    });
  }

  if (type === 'ec2_volumes') {
    return pick(raw, {
      volumeType: 'VolumeType', size: 'Size', encrypted: 'Encrypted',
      availabilityZone: 'AvailabilityZone', iops: 'Iops',
    });
  }

  if (type === 'autoscaling_auto_scaling_groups') {
    return pick(raw, {
      minSize: 'MinSize', maxSize: 'MaxSize', desiredCapacity: 'DesiredCapacity',
      launchConfigurationName: 'LaunchConfigurationName', healthCheckType: 'HealthCheckType',
    });
  }

  if (type === 'dynamodb_tables') {
    return pick(raw, {
      tableStatus: 'TableStatus', tableSizeBytes: 'TableSizeBytes',
      itemCount: 'ItemCount', billingModeSummary: 'BillingModeSummary',
    });
  }

  if (type === 'eks_clusters') {
    return pick(raw, { version: 'version', platformVersion: 'platformVersion', status: 'status', endpoint: 'endpoint' });
  }

  if (type === 'cloudfront_distributions') {
    return pick(raw, {
      domainName: 'DomainName', status: 'Status', enabled: 'Enabled',
      httpVersion: 'HttpVersion', priceClass: 'PriceClass',
    });
  }

  if (type === 'elasticache_cache_clusters') {
    return pick(raw, {
      cacheNodeType: 'CacheNodeType', engine: 'Engine',
      engineVersion: 'EngineVersion', numCacheNodes: 'NumCacheNodes',
    });
  }

  if (type === 'kms_keys') {
    return pick(raw, {
      keyState: 'KeyState', keyUsage: 'KeyUsage', keyManager: 'KeyManager',
      description: 'Description', creationDate: 'CreationDate',
    });
  }

  if (type === 'acm_certificates') {
    return pick(raw, {
      domainName: 'DomainName', status: 'Status', type: 'Type',
      issuer: 'Issuer', notAfter: 'NotAfter', notBefore: 'NotBefore',
    });
  }

  if (type === 'ecr_repositories') {
    return pick(raw, {
      repositoryUri: 'repositoryUri', imageTagMutability: 'imageTagMutability',
      imageScanningConfiguration: 'imageScanningConfiguration',
    });
  }

  if (type === 'iam_roles') {
    return pick(raw, { path: 'Path', createDate: 'CreateDate', maxSessionDuration: 'MaxSessionDuration' });
  }

  if (type === 'iam_users') {
    return pick(raw, { path: 'Path', createDate: 'CreateDate', passwordLastUsed: 'PasswordLastUsed' });
  }

  if (type === 'ec2_nat_gateways') {
    return pick(raw, { natGatewayId: 'NatGatewayId', state: 'State', vpcId: 'VpcId', subnetId: 'SubnetId' });
  }

  if (type === 'ec2_addresses') {
    return pick(raw, { publicIp: 'PublicIp', allocationId: 'AllocationId', instanceId: 'InstanceId', domain: 'Domain' });
  }

  if (type === 'ec2_network_interfaces') {
    return pick(raw, {
      networkInterfaceId: 'NetworkInterfaceId', status: 'Status',
      vpcId: 'VpcId', subnetId: 'SubnetId', privateIpAddress: 'PrivateIpAddress',
    });
  }

  if (type === 'sns_topics') {
    return pick(raw, { topicArn: 'TopicArn' });
  }

  if (type === 'sqs_queues') {
    return pick(raw, { queueUrl: 'QueueUrl' });
  }

  if (type === 'secretsmanager_secrets') {
    return pick(raw, { arn: 'ARN', name: 'Name', lastChangedDate: 'LastChangedDate', rotationEnabled: 'RotationEnabled' });
  }

  if (type === 'efs_file_systems') {
    return pick(raw, {
      fileSystemId: 'FileSystemId', lifeCycleState: 'LifeCycleState',
      numberOfMountTargets: 'NumberOfMountTargets', sizeInBytes: 'SizeInBytes',
    });
  }

  if (type === 'ssm_parameters') {
    return pick(raw, { name: 'Name', type: 'Type', lastModifiedDate: 'LastModifiedDate', version: 'Version' });
  }

  if (type === 'cloudwatch_alarms') {
    return pick(raw, { alarmName: 'AlarmName', stateValue: 'StateValue', metricName: 'MetricName', namespace: 'Namespace' });
  }

  if (type === 'events_rules') {
    return pick(raw, { name: 'Name', state: 'State', scheduleExpression: 'ScheduleExpression', eventPattern: 'EventPattern' });
  }

  if (type === 'codepipeline_pipelines') {
    return pick(raw, { name: 'name', version: 'version' });
  }

  if (type === 'backup_backup_plans') {
    return pick(raw, { backupPlanId: 'BackupPlanId', backupPlanName: 'BackupPlanName', versionId: 'VersionId' });
  }

  if (type === 'wafv2_web_acls') {
    return pick(raw, { id: 'Id', name: 'Name', arn: 'ARN', scope: 'Scope' });
  }

  if (type === 'ec2_transit_gateways') {
    return pick(raw, { transitGatewayId: 'TransitGatewayId', state: 'State', ownerId: 'OwnerId' });
  }

  if (type === 'ec2_transit_gateway_attachments') {
    return pick(raw, { transitGatewayAttachmentId: 'TransitGatewayAttachmentId', state: 'State', resourceType: 'ResourceType' });
  }

  if (type === 'ec2_vpc_peering_connections') {
    return pick(raw, { vpcPeeringConnectionId: 'VpcPeeringConnectionId', status: 'Status' });
  }

  return {};
}

// ---------------------------------------------------------------------------
// pick helper — extract named keys from raw AWS response
// ---------------------------------------------------------------------------

function pick(
  raw: Record<string, any>,
  mapping: Record<string, string | number | undefined>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [outKey, rawKey] of Object.entries(mapping)) {
    if (rawKey === undefined) continue;
    if (typeof rawKey === 'number') {
      result[outKey] = rawKey;
      continue;
    }
    if (rawKey in raw && raw[rawKey] !== undefined) {
      result[outKey] = raw[rawKey];
    }
  }
  return result;
}
