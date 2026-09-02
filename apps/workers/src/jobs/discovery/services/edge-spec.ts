// workers/src/jobs/discovery/services/edge-spec.ts
import type { EdgeSpec } from '../types.js';

export const EDGE_SPECS: Record<string, EdgeSpec[]> = {
    ec2_instances: [
        { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'SecurityGroups[].GroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'BlockDeviceMappings[].Ebs.VolumeId', relation: 'has_volume', toType: 'ec2_volumes' },
        { path: 'NetworkInterfaces[].NetworkInterfaceId', relation: 'has_network_interface', toType: 'ec2_network_interfaces' },
        // The instance carries only the instance-profile arn; its last segment is the
        // profile name, not the role name (they usually match, but not always) and the
        // role is absent from the response. Naming it a role would be a guess.
        { path: 'IamInstanceProfile.Arn', relation: 'uses_instance_profile', toType: 'iam_instance_profiles', transform: 'arn-last-segment' },
    ],

    ec2_subnets: [
        { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    ],

    ec2_security_groups: [
        { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'IpPermissions[].UserIdGroupPairs[].GroupId', relation: 'allows_ingress_from', toType: 'ec2_security_groups' },
        { path: 'IpPermissionsEgress[].UserIdGroupPairs[].GroupId', relation: 'allows_egress_to', toType: 'ec2_security_groups' },
    ],

    ec2_volumes: [
        { path: 'Attachments[].InstanceId', relation: 'attached_to', toType: 'ec2_instances' },
        { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    ec2_network_interfaces: [
        { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'Groups[].GroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'Attachment.InstanceId', relation: 'attached_to', toType: 'ec2_instances' },
    ],

    ec2_addresses: [
        { path: 'InstanceId', relation: 'attached_to', toType: 'ec2_instances' },
        { path: 'NetworkInterfaceId', relation: 'attached_to', toType: 'ec2_network_interfaces' },
    ],

    ec2_nat_gateways: [
        { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'NatGatewayAddresses[].NetworkInterfaceId', relation: 'has_network_interface', toType: 'ec2_network_interfaces' },
    ],

    ec2_vpc_peering_connections: [
        { path: 'RequesterVpcInfo.VpcId', relation: 'peers_vpc', toType: 'ec2_vpcs', accountPath: 'RequesterVpcInfo.OwnerId' },
        { path: 'AccepterVpcInfo.VpcId', relation: 'peers_vpc', toType: 'ec2_vpcs', accountPath: 'AccepterVpcInfo.OwnerId' },
    ],

    ec2_transit_gateway_attachments: [
        { path: 'TransitGatewayId', relation: 'attached_to_tgw', toType: 'ec2_transit_gateways' },
        { path: 'ResourceId', relation: 'attaches_vpc', toType: 'ec2_vpcs', when: { path: 'ResourceType', equals: 'vpc' }, accountPath: 'ResourceOwnerId' },
    ],

    rds_db_instances: [
        { path: 'DBSubnetGroup.VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'DBSubnetGroup.Subnets[].SubnetIdentifier', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'VpcSecurityGroups[].VpcSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
        { path: 'DBClusterIdentifier', relation: 'member_of_cluster', toType: 'rds_db_clusters' },
    ],

    rds_db_clusters: [
        { path: 'VpcSecurityGroups[].VpcSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'DBClusterMembers[].DBInstanceIdentifier', relation: 'has_member', toType: 'rds_db_instances' },
        { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    docdb_db_clusters: [
        { path: 'VpcSecurityGroups[].VpcSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'DBClusterMembers[].DBInstanceIdentifier', relation: 'has_member', toType: 'rds_db_instances' },
        { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    elbv2_load_balancers: [
        { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'AvailabilityZones[].SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'SecurityGroups[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    ],

    // Not a typo: normalizeResources strips 'get_' anywhere in the string, so
    // elbv2 describe_target_groups emits "elbv2_targroups". Renaming this to the
    // spelling that reads correctly silently kills every target-group edge.
    elbv2_targroups: [
        { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'LoadBalancerArns[]', relation: 'attached_to_load_balancer', toType: 'elbv2_load_balancers' },
        // Target.Id is an instance id only for instance-type groups; ip-type groups
        // (ECS awsvpc / Fargate) put a private IP here, which is not an inventory id.
        { path: '_targetHealth[].Target.Id', relation: 'routes_to_instance', toType: 'ec2_instances', when: { path: 'TargetType', equals: 'instance' } },
    ],

    autoscaling_auto_scaling_groups: [
        { path: 'Instances[].InstanceId', relation: 'has_member', toType: 'ec2_instances' },
        { path: 'VPCZoneIdentifier', relation: 'in_subnet', toType: 'ec2_subnets', transform: 'csv' },
        { path: 'TargetGroupARNs[]', relation: 'registers_with_target_group', toType: 'elbv2_targroups' },
    ],

    lambda_functions: [
        { path: 'VpcConfig.SubnetIds[]', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'VpcConfig.SecurityGroupIds[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'Role', relation: 'uses_iam_role', toType: 'iam_roles', transform: 'arn-last-segment' },
        { path: 'KMSKeyArn', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    ecs_services: [
        { path: 'clusterArn', relation: 'in_cluster', toType: 'ecs_clusters' },
        { path: 'networkConfiguration.awsvpcConfiguration.subnets[]', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'networkConfiguration.awsvpcConfiguration.securityGroups[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'loadBalancers[].targetGroupArn', relation: 'registers_with_target_group', toType: 'elbv2_targroups' },
    ],

    eks_clusters: [
        { path: 'resourcesVpcConfig.vpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
        { path: 'resourcesVpcConfig.subnetIds[]', relation: 'in_subnet', toType: 'ec2_subnets' },
        { path: 'resourcesVpcConfig.securityGroupIds[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'resourcesVpcConfig.clusterSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
        { path: 'roleArn', relation: 'uses_iam_role', toType: 'iam_roles', transform: 'arn-last-segment' },
        { path: 'encryptionConfig[].provider.keyArn', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    elasticache_cache_clusters: [
        { path: 'SecurityGroups[].SecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    ],

    efs_file_systems: [
        { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    dynamodb_tables: [
        { path: 'SSEDescription.KMSMasterKeyArn', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    ecr_repositories: [
        { path: 'encryptionConfiguration.kmsKey', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    secretsmanager_secrets: [
        { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    ssm_parameters: [
        { path: 'KeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],

    cloudfront_distributions: [
        { path: 'ViewerCertificate.ACMCertificateArn', relation: 'uses_certificate', toType: 'acm_certificates' },
    ],

    // GetBucketEncryption's detail enrichment merges flat (no wrapper key), so the
    // path starts at ServerSideEncryptionConfiguration, not a namespaced prefix.
    // AES256 (SSE-S3) buckets have no KMSMasterKeyID at all, so they resolve no edge.
    s3_buckets: [
        { path: 'ServerSideEncryptionConfiguration.Rules[].ApplyServerSideEncryptionByDefault.KMSMasterKeyID', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment', accountFromArn: true },
    ],
};
