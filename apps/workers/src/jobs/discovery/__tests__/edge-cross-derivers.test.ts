import { describe, it, expect } from 'vitest';
import { deriveCrossResourceEdges } from '../services/edge-cross-derivers.js';
import type { Resource } from '../types.js';

const resource = (resourceType: string, resourceId: string, rawData: unknown): Resource => ({
    resourceType,
    resourceId,
    region: 'ap-south-1',
    service: 'test',
    tags: {},
    rawData,
});

const vpc = resource('ec2_vpcs', 'vpc-1', { VpcId: 'vpc-1', CidrBlock: '10.182.20.0/22' });
const subnetA = resource('ec2_subnets', 'subnet-a', { SubnetId: 'subnet-a', VpcId: 'vpc-1', CidrBlock: '10.182.20.0/24' });
const subnetB = resource('ec2_subnets', 'subnet-b', { SubnetId: 'subnet-b', VpcId: 'vpc-1', CidrBlock: '10.182.21.0/24' });

describe('ecs_services in_vpc', () => {
    // An ECS service names its subnets and never its VPC, so "what is in this VPC" used to
    // omit the services actually running in it.
    it('derives the VPC from the subnets the service runs in', () => {
        const svc = resource('ecs_services', 'svc-arn', {
            networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-a', 'subnet-b'] } },
        });

        const edges = deriveCrossResourceEdges([vpc, subnetA, subnetB, svc]);

        expect(edges).toContainEqual({
            fromType: 'ecs_services',
            fromId: 'svc-arn',
            relation: 'in_vpc',
            toType: 'ec2_vpcs',
            toId: 'vpc-1',
            region: 'ap-south-1',
        });
        // Two subnets in one VPC is still one membership.
        expect(edges.filter((e) => e.relation === 'in_vpc')).toHaveLength(1);
    });

    it('emits nothing when the subnets were not discovered', () => {
        const svc = resource('ecs_services', 'svc-arn', {
            networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-unknown'] } },
        });
        expect(deriveCrossResourceEdges([vpc, svc])).toHaveLength(0);
    });
});

describe('security group CIDR ingress', () => {
    // The rule form that made blast radius report a live database as having zero dependents:
    // ingress written as a CIDR rather than a security group reference.
    it('links a rule covering the whole VPC to the VPC, not to each subnet', () => {
        const sg = resource('ec2_security_groups', 'sg-db', {
            IpPermissions: [{ FromPort: 5432, IpRanges: [{ CidrIp: '10.182.20.0/22' }], UserIdGroupPairs: [] }],
        });

        const edges = deriveCrossResourceEdges([vpc, subnetA, subnetB, sg]);
        const ingress = edges.filter((e) => e.relation === 'allows_ingress_from');

        expect(ingress).toHaveLength(1);
        expect(ingress[0]).toMatchObject({ toType: 'ec2_vpcs', toId: 'vpc-1' });
    });

    it('links a subnet-sized rule to that subnet only', () => {
        const sg = resource('ec2_security_groups', 'sg-db', {
            IpPermissions: [{ IpRanges: [{ CidrIp: '10.182.20.0/24' }] }],
        });

        const ingress = deriveCrossResourceEdges([vpc, subnetA, subnetB, sg])
            .filter((e) => e.relation === 'allows_ingress_from');

        expect(ingress).toHaveLength(1);
        expect(ingress[0]).toMatchObject({ toType: 'ec2_subnets', toId: 'subnet-a' });
    });

    it('ignores 0.0.0.0/0 so the internet does not link every network together', () => {
        const sg = resource('ec2_security_groups', 'sg-open', {
            IpPermissions: [{ IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
        });
        expect(deriveCrossResourceEdges([vpc, subnetA, sg])).toHaveLength(0);
    });

    it('ignores a CIDR that covers nothing discovered', () => {
        const sg = resource('ec2_security_groups', 'sg-other', {
            IpPermissions: [{ IpRanges: [{ CidrIp: '192.168.0.0/16' }] }],
        });
        expect(deriveCrossResourceEdges([vpc, subnetA, sg])).toHaveLength(0);
    });
});

describe('task definition references', () => {
    // The application dependency no describe response states: the database is a hostname in
    // an environment variable.
    it('connects a service to the database named in its task definition', () => {
        const db = resource('rds_db_instances', 'sbx-postgres', {
            Endpoint: { Address: 'sbx-postgres.abc123.ap-south-1.rds.amazonaws.com' },
        });
        const svc = resource('ecs_services', 'svc-arn', {
            _endpointRefs: ['SBX-POSTGRES.abc123.ap-south-1.rds.amazonaws.com'],
        });

        expect(deriveCrossResourceEdges([db, svc])).toContainEqual({
            fromType: 'ecs_services',
            fromId: 'svc-arn',
            relation: 'connects_to',
            toType: 'rds_db_instances',
            toId: 'sbx-postgres',
            region: 'ap-south-1',
        });
    });

    it('links a secret reference back to the secret, suffix and all', () => {
        const secret = resource('secretsmanager_secrets', 'sbx/database-url', {
            ARN: 'arn:aws:secretsmanager:ap-south-1:111:secret:sbx/database-url-AbCdEf',
        });
        const svc = resource('ecs_services', 'svc-arn', {
            _endpointRefs: ['arn:aws:secretsmanager:ap-south-1:111:secret:sbx/database-url-AbCdEf'],
        });

        expect(deriveCrossResourceEdges([secret, svc])).toContainEqual({
            fromType: 'ecs_services',
            fromId: 'svc-arn',
            relation: 'reads_secret',
            toType: 'secretsmanager_secrets',
            toId: 'sbx/database-url',
            region: 'ap-south-1',
        });
    });

    it('emits nothing for an endpoint that matches no discovered resource', () => {
        const svc = resource('ecs_services', 'svc-arn', {
            _endpointRefs: ['someone-else.xyz.ap-south-1.rds.amazonaws.com'],
        });
        expect(deriveCrossResourceEdges([svc])).toHaveLength(0);
    });
});
