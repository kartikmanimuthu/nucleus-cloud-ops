// workers/src/jobs/discovery/services/custom-scanners.ts
import type { ScanConfig } from '../types.js';
import { Scope } from '@aws-sdk/client-wafv2';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('discovery/custom');

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
    DescribeTaskDefinitionCommand,
  } = await import('@aws-sdk/client-ecs');

  const allServices: any[] = [];

  // Paginate clusters (max 100 per page)
  const clusterArns: string[] = [];
  let clusterNextToken: string | undefined;
  do {
    const resp = await client.send(new ListClustersCommand({ nextToken: clusterNextToken }));
    clusterArns.push(...(resp.clusterArns || []));
    clusterNextToken = resp.nextToken;
  } while (clusterNextToken);

  for (const clusterArn of clusterArns) {
    // Paginate services per cluster (max 100 per page)
    const serviceArns: string[] = [];
    let svcNextToken: string | undefined;
    do {
      const resp = await client.send(new ListServicesCommand({ cluster: clusterArn, nextToken: svcNextToken }));
      serviceArns.push(...(resp.serviceArns || []));
      svcNextToken = resp.nextToken;
    } while (svcNextToken);

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
          allServices.push(svc);
        }
      } catch (error) {
        log.error('ECS describe failed', { clusterArn, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const imagesByTaskDef = new Map<string, string[]>();
  // Endpoints a task is configured to talk to. The describe call already happens for images;
  // keeping the env/secret references is what lets the graph record application dependencies
  // (an ECS service -> its database), which no describe response states directly.
  const endpointsByTaskDef = new Map<string, string[]>();
  const distinctTaskDefArns = [...new Set(allServices.map((svc) => svc.taskDefinition).filter(Boolean))];

  for (const taskDefArn of distinctTaskDefArns) {
    try {
      const resp = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }));
      const containers = resp.taskDefinition?.containerDefinitions || [];
      imagesByTaskDef.set(taskDefArn, containers.map((c: any) => c.image).filter(Boolean));
      endpointsByTaskDef.set(taskDefArn, collectTaskDefReferences(containers));
    } catch (error) {
      log.warn('DescribeTaskDefinition failed', { taskDefArn, error: error instanceof Error ? error.message : String(error) });
      imagesByTaskDef.set(taskDefArn, []);
      endpointsByTaskDef.set(taskDefArn, []);
    }
  }

  for (const svc of allServices) {
    svc._images = imagesByTaskDef.get(svc.taskDefinition) || [];
    svc._endpointRefs = endpointsByTaskDef.get(svc.taskDefinition) || [];
  }

  return allServices;
}


// Values in a task definition that name another AWS resource: hostnames from environment
// variables (a DATABASE_URL, a queue URL) and the ARNs of secrets/parameters it reads.
// Only the reference is kept — never the value of a secret, which is not returned here anyway.
function collectTaskDefReferences(containers: any[]): string[] {
  const refs = new Set<string>();

  for (const container of containers || []) {
    for (const env of container?.environment || []) {
      const value = typeof env?.value === 'string' ? env.value : '';
      if (!value) continue;
      for (const host of value.matchAll(/[A-Za-z0-9._-]+\.(?:rds|cache|es|elasticache)\.amazonaws\.com/g)) {
        refs.add(host[0].toLowerCase());
      }
      for (const url of value.matchAll(/https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d+\/[A-Za-z0-9_-]+/g)) {
        refs.add(url[0]);
      }
    }
    for (const secret of container?.secrets || []) {
      if (typeof secret?.valueFrom === 'string' && secret.valueFrom) refs.add(secret.valueFrom);
    }
  }

  return [...refs];
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

  const scopes: Scope[] = [Scope.REGIONAL];
  if (region === 'us-east-1') {
    scopes.push(Scope.CLOUDFRONT);
  }

  for (const scope of scopes) {
    let nextMarker: string | undefined;
    do {
      try {
        const response = await client.send(new ListWebACLsCommand({ Scope: scope, NextMarker: nextMarker }));
        for (const acl of response.WebACLs || []) {
          acl._scope = scope;
          allAcls.push(acl);
        }
        nextMarker = response.NextMarker;
      } catch (error) {
        log.warn('WAFv2 list failed', { scope, region, error: error instanceof Error ? error.message : String(error) });
        nextMarker = undefined;
      }
    } while (nextMarker);
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
// ELBv2 Target Groups — paginate target groups, then describe target health
// ---------------------------------------------------------------------------

async function targetGroupsWithHealth(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const { DescribeTargetGroupsCommand, DescribeTargetHealthCommand } = await import(
    '@aws-sdk/client-elastic-load-balancing-v2'
  );

  const groups: any[] = [];
  let marker: string | undefined;
  do {
    const resp = await client.send(new DescribeTargetGroupsCommand({ Marker: marker }));
    groups.push(...(resp.TargetGroups || []));
    marker = resp.NextMarker;
  } while (marker);

  for (const group of groups) {
    try {
      const health = await client.send(
        new DescribeTargetHealthCommand({ TargetGroupArn: group.TargetGroupArn }),
      );
      group._targetHealth = health.TargetHealthDescriptions || [];
    } catch (error) {
      log.warn('Target health lookup failed', {
        region,
        targetGroupArn: group.TargetGroupArn,
        error: error instanceof Error ? error.message : String(error),
      });
      group._targetHealth = [];
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// EventBridge Rules — list rules, then list targets per rule
// ---------------------------------------------------------------------------

async function eventsRulesWithTargets(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const { ListRulesCommand, ListTargetsByRuleCommand } = await import('@aws-sdk/client-eventbridge');

  const rules: any[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new ListRulesCommand({ NextToken: nextToken }));
    rules.push(...(resp.Rules || []));
    nextToken = resp.NextToken;
  } while (nextToken);

  for (const rule of rules) {
    try {
      const targets: any[] = [];
      let targetsNextToken: string | undefined;
      do {
        const resp = await client.send(
          new ListTargetsByRuleCommand({
            Rule: rule.Name,
            EventBusName: rule.EventBusName,
            NextToken: targetsNextToken,
          }),
        );
        targets.push(...(resp.Targets || []));
        targetsNextToken = resp.NextToken;
      } while (targetsNextToken);
      rule._targets = targets;
    } catch (error) {
      log.warn('EventBridge target lookup failed', {
        region,
        rule: rule.Name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Dispatch map — keyed by "service:function"
// ---------------------------------------------------------------------------

export const CUSTOM_SCANNERS: Record<string, CustomScannerFn> = {
  'ec2:describe_instances': flattenEC2Reservations,
  'ecs:list_services': ecsServicesDeep,
  'wafv2:list_web_acls': wafv2Deep,
  'cloudfront:list_distributions': cloudfrontDeep,
  'elbv2:describe_target_groups': targetGroupsWithHealth,
  'events:list_rules': eventsRulesWithTargets,
};
