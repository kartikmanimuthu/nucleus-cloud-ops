import { describe, it, expect } from 'vitest';
import { extractEdges } from '../services/edge-extractor.js';
import { EDGE_SPECS } from '../services/edge-spec.js';
import { CUSTOM_DERIVERS } from '../services/edge-derivers.js';
import type { Resource } from '../types.js';

// Resource types are the discovery-native `${service}_${function}` form built in
// scanner.ts, NOT CloudFormation `AWS::EC2::Instance` names. EDGE_SPECS is keyed
// the same way, so any test using CFN names silently matches no spec and passes
// while asserting nothing.
function r(resourceType: string, resourceId: string, rawData: unknown, region = 'us-east-1'): Resource {
    return {
        resourceType,
        resourceId,
        region,
        service: resourceType.split('_')[0],
        tags: {},
        rawData,
    };
}

describe('extractEdges', () => {
    it('extracts every spec edge from one EC2 instance', () => {
        const resources: Resource[] = [
            r('ec2_instances', 'i-123', {
                VpcId: 'vpc-1',
                SubnetId: 'subnet-1',
                SecurityGroups: [{ GroupId: 'sg-1' }, { GroupId: 'sg-2' }],
                BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-1' } }, { Ebs: { VolumeId: 'vol-2' } }],
                NetworkInterfaces: [{ NetworkInterfaceId: 'eni-1' }],
                IamInstanceProfile: { Arn: 'arn:aws:iam::123456789012:instance-profile/my-profile' },
            }),
        ];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(8);
        expect(edges).toContainEqual({
            fromType: 'ec2_instances',
            fromId: 'i-123',
            relation: 'in_vpc',
            toType: 'ec2_vpcs',
            toId: 'vpc-1',
            region: 'us-east-1',
        });
        expect(edges).toContainEqual({
            fromType: 'ec2_instances',
            fromId: 'i-123',
            relation: 'in_subnet',
            toType: 'ec2_subnets',
            toId: 'subnet-1',
            region: 'us-east-1',
        });
        expect(edges).toContainEqual({
            fromType: 'ec2_instances',
            fromId: 'i-123',
            relation: 'uses_security_group',
            toType: 'ec2_security_groups',
            toId: 'sg-2',
            region: 'us-east-1',
        });
        expect(edges).toContainEqual({
            fromType: 'ec2_instances',
            fromId: 'i-123',
            relation: 'has_volume',
            toType: 'ec2_volumes',
            toId: 'vol-2',
            region: 'us-east-1',
        });
        expect(edges).toContainEqual({
            fromType: 'ec2_instances',
            fromId: 'i-123',
            relation: 'has_network_interface',
            toType: 'ec2_network_interfaces',
            toId: 'eni-1',
            region: 'us-east-1',
        });
        // DescribeInstances exposes only the instance PROFILE arn. The profile name is
        // not the role name — they merely coincide most of the time — and the role name
        // is not present in the response at all, so this edge names the profile.
        expect(edges).toContainEqual({
            fromType: 'ec2_instances',
            fromId: 'i-123',
            relation: 'uses_instance_profile',
            toType: 'iam_instance_profiles',
            toId: 'my-profile',
            region: 'us-east-1',
        });
    });

    // Target.Id is only an instance id when the group's TargetType is 'instance'. For
    // ip-type groups (ECS awsvpc / Fargate) it is a private IP, which matches no
    // ec2_instances resourceId — observed live as edges pointing at 10.0.141.59.
    it('routes_to_instance only for instance-type target groups', () => {
        const byInstance = extractEdges([
            r('elbv2_targroups', 'arn:tg/inst', {
                TargetType: 'instance',
                _targetHealth: [{ Target: { Id: 'i-777' } }],
            }),
        ], 'test-account');

        expect(byInstance).toHaveLength(1);
        expect(byInstance[0]).toMatchObject({ relation: 'routes_to_instance', toId: 'i-777' });

        const byIp = extractEdges([
            r('elbv2_targroups', 'arn:tg/ip', {
                TargetType: 'ip',
                _targetHealth: [{ Target: { Id: '10.0.141.59' } }],
            }),
        ], 'test-account');

        expect(byIp.some((e) => e.relation === 'routes_to_instance')).toBe(false);
    });

    it('applies the csv transform to the ASG subnet list', () => {
        const resources: Resource[] = [
            r('autoscaling_auto_scaling_groups', 'asg-1', {
                VPCZoneIdentifier: 'subnet-a, subnet-b,subnet-c',
            }),
        ];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(3);
        expect(edges.map((e) => e.toId).sort()).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);
        expect(edges.every((e) => e.relation === 'in_subnet' && e.toType === 'ec2_subnets')).toBe(true);
    });

    it('honors the when condition on transit gateway attachments', () => {
        // DescribeTransitGatewayAttachments returns ResourceId + ResourceType, so the
        // vpc edge is only valid when ResourceType === 'vpc'.
        const resources: Resource[] = [
            r('ec2_transit_gateway_attachments', 'tgw-attach-1', {
                TransitGatewayId: 'tgw-1',
                ResourceId: 'vpc-99',
                ResourceType: 'vpc',
            }),
            r('ec2_transit_gateway_attachments', 'tgw-attach-2', {
                TransitGatewayId: 'tgw-1',
                ResourceId: 'dxgw-1',
                ResourceType: 'direct-connect-gateway',
            }),
        ];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(3);
        expect(edges).toContainEqual({
            fromType: 'ec2_transit_gateway_attachments',
            fromId: 'tgw-attach-1',
            relation: 'attaches_vpc',
            toType: 'ec2_vpcs',
            toId: 'vpc-99',
            region: 'us-east-1',
        });
        expect(edges).toContainEqual({
            fromType: 'ec2_transit_gateway_attachments',
            fromId: 'tgw-attach-2',
            relation: 'attached_to_tgw',
            toType: 'ec2_transit_gateways',
            toId: 'tgw-1',
            region: 'us-east-1',
        });
        expect(edges.some((e) => e.fromId === 'tgw-attach-2' && e.relation === 'attaches_vpc')).toBe(false);
    });

    it('runs custom derivers and stamps them with the resource region', () => {
        const resources: Resource[] = [
            r('cloudwatch_alarms', 'alarm-1', {
                Dimensions: [
                    { Name: 'InstanceId', Value: 'i-999' },
                    { Name: 'AutoScalingGroupName', Value: 'asg-99' },
                ],
                AlarmActions: ['arn:aws:sns:us-east-1:123456789012:ops-alerts'],
            }),
        ];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(3);
        expect(edges).toContainEqual({
            fromType: 'cloudwatch_alarms',
            fromId: 'alarm-1',
            relation: 'monitors',
            toType: 'ec2_instances',
            toId: 'i-999',
            region: 'us-east-1',
        });
        expect(edges).toContainEqual({
            fromType: 'cloudwatch_alarms',
            fromId: 'alarm-1',
            relation: 'monitors',
            toType: 'autoscaling_auto_scaling_groups',
            toId: 'asg-99',
            region: 'us-east-1',
        });
        expect(edges).toContainEqual({
            fromType: 'cloudwatch_alarms',
            fromId: 'alarm-1',
            relation: 'notifies',
            toType: 'sns_topics',
            toId: 'arn:aws:sns:us-east-1:123456789012:ops-alerts',
            region: 'us-east-1',
        });
    });

    it('passes the scanning account id and the resource region to custom derivers', () => {
        const resources: Resource[] = [
            r('cloudwatch_alarms', 'alarm-alb', {
                Dimensions: [{ Name: 'LoadBalancer', Value: 'app/my-alb/50dc6c495c0c9188' }],
            }, 'ap-south-1'),
        ];

        const edges = extractEdges(resources, '072097020844');

        expect(edges).toContainEqual({
            fromType: 'cloudwatch_alarms',
            fromId: 'alarm-alb',
            relation: 'monitors',
            toType: 'elbv2_load_balancers',
            toId: 'arn:aws:elasticloadbalancing:ap-south-1:072097020844:loadbalancer/app/my-alb/50dc6c495c0c9188',
            region: 'ap-south-1',
        });
    });

    it('stamps each edge with its own source resource region', () => {
        const resources: Resource[] = [
            r('ec2_instances', 'i-east', { VpcId: 'vpc-east' }, 'us-east-1'),
            r('ec2_instances', 'i-west', { VpcId: 'vpc-west' }, 'eu-west-1'),
        ];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(2);
        expect(edges.find((e) => e.fromId === 'i-east')?.region).toBe('us-east-1');
        expect(edges.find((e) => e.fromId === 'i-west')?.region).toBe('eu-west-1');
    });

    it('deduplicates identical edges', () => {
        const resources: Resource[] = [
            r('ec2_instances', 'i-1', { VpcId: 'vpc-1' }),
            r('ec2_instances', 'i-1', { VpcId: 'vpc-1' }),
        ];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(1);
        expect(edges[0]).toEqual({
            fromType: 'ec2_instances',
            fromId: 'i-1',
            relation: 'in_vpc',
            toType: 'ec2_vpcs',
            toId: 'vpc-1',
            region: 'us-east-1',
        });
    });

    it('drops self-edges while keeping sibling edges from the same path', () => {
        const resources: Resource[] = [
            r('ec2_security_groups', 'sg-1', {
                GroupId: 'sg-1',
                VpcId: 'vpc-1',
                IpPermissions: [{ UserIdGroupPairs: [{ GroupId: 'sg-1' }, { GroupId: 'sg-2' }] }],
            }),
        ];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(2);
        expect(edges.some((e) => e.toId === 'sg-1')).toBe(false);
        expect(edges).toContainEqual({
            fromType: 'ec2_security_groups',
            fromId: 'sg-1',
            relation: 'allows_ingress_from',
            toType: 'ec2_security_groups',
            toId: 'sg-2',
            region: 'us-east-1',
        });
    });

    it('ignores resource types with no spec and no deriver', () => {
        // Guard the premise: this test is vacuous if sns_topics ever gains a spec.
        expect(EDGE_SPECS.sns_topics).toBeUndefined();
        expect(CUSTOM_DERIVERS.sns_topics).toBeUndefined();

        const resources: Resource[] = [
            r('sns_topics', 'arn:aws:sns:us-east-1:123456789012:my-topic', { TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic' }),
        ];

        expect(extractEdges(resources, 'test-account')).toHaveLength(0);
    });

    it('skips resources with a blank resourceId', () => {
        const resources: Resource[] = [r('ec2_instances', '', { VpcId: 'vpc-1' })];

        expect(extractEdges(resources, 'test-account')).toHaveLength(0);
    });

    it('tolerates non-object rawData', () => {
        const resources: Resource[] = [r('ec2_instances', 'i-1', 'not-an-object')];

        expect(extractEdges(resources, 'test-account')).toHaveLength(0);
    });

    it('coerces non-string path values to strings', () => {
        const resources: Resource[] = [r('ec2_instances', 'i-1', { SubnetId: 12345 })];

        const edges = extractEdges(resources, 'test-account');

        expect(edges).toHaveLength(1);
        expect(edges[0].toId).toBe('12345');
    });

    it('stamps toAccountId when the peer VPC is owned by another account', () => {
        const edges = extractEdges([
            r('ec2_vpc_peering_connections', 'pcx-1', {
                RequesterVpcInfo: { VpcId: 'vpc-req', OwnerId: '111111111111' },
                AccepterVpcInfo: { VpcId: 'vpc-acc', OwnerId: '222222222222' },
            }),
        ], '111111111111');

        const accepter = edges.find((e) => e.toId === 'vpc-acc');
        const requester = edges.find((e) => e.toId === 'vpc-req');
        expect(accepter?.toAccountId).toBe('222222222222');
        expect(requester?.toAccountId).toBeUndefined();
    });

    it('stamps toAccountId on a shared transit gateway attachment', () => {
        const edges = extractEdges([
            r('ec2_transit_gateway_attachments', 'tgw-attach-1', {
                TransitGatewayId: 'tgw-1',
                ResourceType: 'vpc',
                ResourceId: 'vpc-9',
                ResourceOwnerId: '333333333333',
            }),
        ], '111111111111');

        expect(edges.find((e) => e.toId === 'vpc-9')?.toAccountId).toBe('333333333333');
    });

    it('leaves toAccountId unset when the spec declares no accountPath', () => {
        const edges = extractEdges([
            r('ec2_instances', 'i-9', { VpcId: 'vpc-1' }),
        ], '111111111111');

        expect(edges[0].toAccountId).toBeUndefined();
    });

    it('links an attached elastic ip to its instance and interface', () => {
        const edges = extractEdges([
            r('ec2_addresses', 'eipalloc-1', {
                AllocationId: 'eipalloc-1',
                InstanceId: 'i-1',
                NetworkInterfaceId: 'eni-1',
            }),
        ], '111111111111');

        expect(edges).toContainEqual(expect.objectContaining({
            fromType: 'ec2_addresses', fromId: 'eipalloc-1',
            relation: 'attached_to', toType: 'ec2_instances', toId: 'i-1',
        }));
        expect(edges.some((e) => e.toType === 'ec2_network_interfaces' && e.toId === 'eni-1')).toBe(true);
    });

    it('emits no edges for an unattached elastic ip', () => {
        const edges = extractEdges([
            r('ec2_addresses', 'eipalloc-2', { AllocationId: 'eipalloc-2', PublicIp: '52.1.2.3' }),
        ], '111111111111');

        expect(edges).toHaveLength(0);
    });
});
