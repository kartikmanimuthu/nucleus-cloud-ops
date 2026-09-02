import { describe, it, expect } from 'vitest';
import { getServiceName, getAwsConsoleUrl, RESOURCE_TYPE_OPTIONS, REGION_OPTIONS } from './resource-types';

describe('getServiceName', () => {
    it('maps a known resource type to its service name', () => {
        expect(getServiceName('ec2_instances')).toBe('EC2');
        expect(getServiceName('dynamodb_tables')).toBe('DynamoDB');
    });

    it('derives a fallback name for an unknown resource type', () => {
        expect(getServiceName('some_new_thing')).toBe('SOME NEW THING');
    });
});

describe('RESOURCE_TYPE_OPTIONS / REGION_OPTIONS', () => {
    it('prepends an "All" option to each list', () => {
        expect(RESOURCE_TYPE_OPTIONS[0]).toEqual({ value: 'all', label: 'All Types' });
        expect(REGION_OPTIONS[0]).toEqual({ value: 'all', label: 'All Regions' });
    });
});

describe('getAwsConsoleUrl', () => {
    const base = { region: 'us-east-1', resourceId: 'i-123', resourceArn: 'arn:aws:ec2:us-east-1:1:instance/i-123' };

    it('builds a console URL for a known resource type', () => {
        expect(getAwsConsoleUrl({ ...base, resourceType: 'ec2_instances' }))
            .toBe('https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Instances:instanceId=i-123');
    });

    it('parses cluster and service names out of the ARN for ecs_services', () => {
        const url = getAwsConsoleUrl({
            resourceType: 'ecs_services', region: 'us-east-1', resourceId: 'svc-1',
            resourceArn: 'arn:aws:ecs:us-east-1:1:cluster/my-cluster/service/my-service',
        });
        expect(url).toContain('/ecs/v2/clusters/my-cluster/services/my-service');
    });

    it('falls back to the clusters list when the ARN does not match the expected shape', () => {
        const url = getAwsConsoleUrl({ resourceType: 'ecs_services', region: 'us-east-1', resourceId: 'svc-1', resourceArn: 'not-a-valid-arn' });
        expect(url).toBe('https://us-east-1.console.aws.amazon.com/ecs/v2/clusters?region=us-east-1');
    });

    it('uses a global (us-east-1) console URL for IAM and CloudFront regardless of the resource region', () => {
        expect(getAwsConsoleUrl({ ...base, region: 'eu-west-1', resourceType: 'iam_roles' })).toContain('us-east-1.console.aws.amazon.com/iam');
        expect(getAwsConsoleUrl({ ...base, region: 'eu-west-1', resourceType: 'cloudfront_distributions' })).toContain('us-east-1.console.aws.amazon.com/cloudfront');
    });

    it('returns null for an unrecognized resource type', () => {
        expect(getAwsConsoleUrl({ ...base, resourceType: 'some_unknown_type' })).toBeNull();
    });

    it('URL-encodes resource identifiers that need it', () => {
        const url = getAwsConsoleUrl({ ...base, resourceType: 'secretsmanager_secrets', resourceId: 'my/secret name' });
        expect(url).toContain(encodeURIComponent('my/secret name'));
    });

    // Every remaining switch case (including the type-alias cases that share a branch,
    // e.g. rds_db_instances/rds_instances) — one assertion each, just enough to hit the branch.
    const cases: Array<[string, string]> = [
        ['rds_db_instances', '/rds/home'],
        ['rds_instances', '/rds/home'],
        ['ecs_clusters', '/ecs/v2/clusters/i-123'],
        ['autoscaling_auto_scaling_groups', '/ec2autoscaling/home'],
        ['asg_groups', '/ec2autoscaling/home'],
        ['dynamodb_tables', '/dynamodb/home'],
        ['docdb_db_clusters', '/docdb/home'],
        ['docdb_instances', '/docdb/home'],
        ['lambda_functions', '/lambda/home'],
        ['s3_buckets', 's3.console.aws.amazon.com/s3/buckets/i-123'],
        ['apigateway_rest_apis', '/apigateway/home'],
        ['ecr_repositories', '/ecr/repositories/private/i-123'],
        ['sns_topics', '/sns/v3/home'],
        ['sqs_queues', '/sqs/v3/home'],
        ['ec2_vpcs', '#vpcs:VpcId=i-123'],
        ['ec2_security_groups', '#SecurityGroups:groupId=i-123'],
        ['ec2_subnets', '#subnets:SubnetId=i-123'],
        ['kms_keys', '/kms/home'],
        ['acm_certificates', '/acm/home'],
        ['ec2_volumes', '#Volumes:volumeId=i-123'],
        ['ec2_network_interfaces', '#NetworkInterfaces:networkInterfaceId=i-123'],
        ['ec2_nat_gateways', '#NatGateways:natGatewayId=i-123'],
        ['ec2_transit_gateways', '#TransitGateways:transitGatewayId=i-123'],
        ['ec2_transit_gateway_attachments', '#TransitGatewayAttachments:transitGatewayAttachmentId=i-123'],
        ['ec2_vpc_peering_connections', '#PeeringConnections:vpcPeeringConnectionId=i-123'],
        ['wafv2_web_acls', '/wafv2/homev2/home'],
        ['elbv2_load_balancers', '#LoadBalancers:search=i-123'],
        ['elasticache_cache_clusters', '/elasticache/home'],
        ['efs_file_systems', '/efs/home'],
        ['rds_db_clusters', '/rds/home'],
        ['codepipeline_pipelines', '/codesuite/codepipeline/home'],
        ['ssm_parameters', '/systems-manager/parameters'],
        ['eks_clusters', '/eks/home'],
        ['cloudwatch_metric_alarms', '#alarmsV2:alarm/'],
        ['events_rules', '/events/home'],
        ['backup_backup_plans', '/backup/home'],
        ['iam_users', 'iam/home#/users/i-123'],
    ];

    it.each(cases)('builds a console URL for %s', (resourceType, expectedFragment) => {
        expect(getAwsConsoleUrl({ ...base, resourceType })).toContain(expectedFragment);
    });
});
