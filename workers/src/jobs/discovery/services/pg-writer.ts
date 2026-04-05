// workers/src/jobs/discovery/services/pg-writer.ts
import { Pool, type PoolClient } from 'pg';
import type { Resource } from '../types.js';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

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
          `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}::jsonb, $${paramIdx + 9}::jsonb, NOW(), NOW())`,
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
        );
        paramIdx += 10;
      }

      const sql = `
        INSERT INTO inventory_resources
          (id, "tenantId", "accountId", region, "resourceType", "resourceId",
           name, status, tags, metadata, "discoveredAt", "updatedAt")
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId")
        DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
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
         ("scanId", "tenantId", "totalResources", "accountsSynced", "completedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT ("tenantId")
       DO UPDATE SET
         "scanId" = EXCLUDED."scanId",
         "totalResources" = EXCLUDED."totalResources",
         "accountsSynced" = EXCLUDED."accountsSynced",
         "completedAt" = NOW(),
         "updatedAt" = NOW()`,
      [scanId, tenantId, totalResources, accountsSynced],
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
  const raw = (resource.rawData || {}) as Record<string, any>;
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
