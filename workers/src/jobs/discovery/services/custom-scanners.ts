// workers/src/jobs/discovery/services/custom-scanners.ts
import type { ScanConfig } from '../types.js';

type CustomScannerFn = (client: any, region: string, config: ScanConfig) => Promise<any[]>;

// ---------------------------------------------------------------------------
// EC2 — flatten Reservations[].Instances[]
// ---------------------------------------------------------------------------

async function flattenEC2Reservations(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const { DescribeInstancesCommand } = await import('@aws-sdk/client-ec2');
  const allInstances: any[] = [];
  let nextToken: string | undefined;

  do {
    const command = new DescribeInstancesCommand({ NextToken: nextToken });
    const response = await client.send(command);

    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        allInstances.push(instance);
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return allInstances;
}

// ---------------------------------------------------------------------------
// ECS Services — list clusters → list services per cluster → describe batch 10
// ---------------------------------------------------------------------------

async function ecsServicesDeep(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const {
    ListClustersCommand,
    ListServicesCommand,
    DescribeServicesCommand,
  } = await import('@aws-sdk/client-ecs');

  const allServices: any[] = [];

  const clustersResp = await client.send(new ListClustersCommand({}));
  const clusterArns: string[] = clustersResp.clusterArns || [];

  for (const clusterArn of clusterArns) {
    const svcResp = await client.send(new ListServicesCommand({ cluster: clusterArn }));
    const serviceArns: string[] = svcResp.serviceArns || [];

    for (let i = 0; i < serviceArns.length; i += 10) {
      const batch = serviceArns.slice(i, i + 10);
      if (!batch.length) continue;

      try {
        const descResp = await client.send(
          new DescribeServicesCommand({
            cluster: clusterArn,
            services: batch,
            include: ['TAGS'],
          }),
        );

        for (const svc of descResp.services || []) {
          svc.ClusterArn = clusterArn;
          allServices.push(svc);
        }
      } catch (error) {
        console.error(
          `[discovery/custom] Error describing ECS services in ${clusterArn}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return allServices;
}

// ---------------------------------------------------------------------------
// WAFv2 — scan both REGIONAL and CLOUDFRONT scopes
// ---------------------------------------------------------------------------

async function wafv2Deep(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const { ListWebACLsCommand } = await import('@aws-sdk/client-wafv2');
  const allAcls: any[] = [];

  const scopes = ['REGIONAL'];
  if (region === 'us-east-1') {
    scopes.push('CLOUDFRONT');
  }

  for (const scope of scopes) {
    try {
      const response = await client.send(new ListWebACLsCommand({ Scope: scope }));
      for (const acl of response.WebACLs || []) {
        acl._scope = scope;
        allAcls.push(acl);
      }
    } catch (error) {
      console.warn(
        `[discovery/custom] WAFv2 list_web_acls scope=${scope} region=${region}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return allAcls;
}

// ---------------------------------------------------------------------------
// CloudFront — unwrap DistributionList.Items, us-east-1 only
// ---------------------------------------------------------------------------

async function cloudfrontDeep(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  if (region !== 'us-east-1') {
    return [];
  }

  const { ListDistributionsCommand } = await import('@aws-sdk/client-cloudfront');
  const allDists: any[] = [];
  let marker: string | undefined;

  do {
    const command = new ListDistributionsCommand({ Marker: marker });
    const response = await client.send(command);
    const distList = response.DistributionList;

    if (distList && distList.Items) {
      allDists.push(...distList.Items);
    }

    marker = distList?.IsTruncated ? distList.NextMarker : undefined;
  } while (marker);

  return allDists;
}

// ---------------------------------------------------------------------------
// Dispatch map — keyed by "service:function"
// ---------------------------------------------------------------------------

export const CUSTOM_SCANNERS: Record<string, CustomScannerFn> = {
  'ec2:describe_instances': flattenEC2Reservations,
  'ecs:list_services': ecsServicesDeep,
  'wafv2:list_web_acls': wafv2Deep,
  'cloudfront:list_distributions': cloudfrontDeep,
};
