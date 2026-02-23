import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import { Construct } from "constructs";
import { getConfig } from "./config";

export interface NetworkingStackProps extends cdk.StackProps {
    // VPC Configuration from cdk.context.json
    vpcCidr?: string;
    maxAzs?: number;
    natGateways?: number;
}

export class NetworkingStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly publicSubnets: ec2.ISubnet[];
    public readonly privateSubnets: ec2.ISubnet[];
    public readonly databaseSubnets: ec2.ISubnet[];
    public readonly intraSubnets: ec2.ISubnet[];

    constructor(scope: Construct, id: string, props: NetworkingStackProps) {
        super(scope, id, props);

        // Load configuration from env via config.ts
        const config = getConfig();
        const appName = config.appName;

        const vpcCidr = props.vpcCidr || config.networking.vpcCidr;
        const maxAzs = props.maxAzs || config.networking.maxAzs;
        const natGatewayCount = props.natGateways || config.networking.natGateways;

        // Create a four-tier VPC architecture following AWS best practices
        this.vpc = new ec2.Vpc(this, `${appName}-VPC`, {
            vpcName: `${appName}-vpc`,
            ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
            maxAzs: maxAzs,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            natGateways: natGatewayCount,
            natGatewayProvider: ec2.NatProvider.gateway(),
            subnetConfiguration: [
                // Tier 1: Public Subnets - For load balancers, NAT gateways, bastion hosts
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                    mapPublicIpOnLaunch: false,
                },
                // Tier 2: Private Subnets - For application servers, ECS
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 22,
                },
                // Tier 3: Database Subnets - For RDS, ElastiCache
                {
                    name: 'Database',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
                // Tier 4: Intra Subnets - For internal services
                {
                    name: 'Intra',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 26,
                }
            ],
            createInternetGateway: true,
            restrictDefaultSecurityGroup: true,
        });

        // Store subnet references for easy access
        this.publicSubnets = this.vpc.publicSubnets;
        this.privateSubnets = this.vpc.privateSubnets;
        this.databaseSubnets = this.vpc.isolatedSubnets.filter(subnet =>
            subnet.node.id.includes('Database'));
        this.intraSubnets = this.vpc.isolatedSubnets.filter(subnet =>
            subnet.node.id.includes('Intra'));

        // ============================================================================
        // VPC ENDPOINTS (Gateway only - free tier)
        // ============================================================================

        // S3 Gateway Endpoint (free)
        this.vpc.addGatewayEndpoint(`${appName}-S3GatewayEndpoint`, {
            service: ec2.GatewayVpcEndpointAwsService.S3,
            subnets: [
                { subnets: this.privateSubnets },
                { subnets: this.databaseSubnets },
                { subnets: this.intraSubnets }
            ]
        });

        // DynamoDB Gateway Endpoint (free)
        this.vpc.addGatewayEndpoint(`${appName}-DynamoDBGatewayEndpoint`, {
            service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
            subnets: [
                { subnets: this.privateSubnets },
                { subnets: this.databaseSubnets },
                { subnets: this.intraSubnets }
            ]
        });

        // ============================================================================
        // SUBNET GROUPS
        // ============================================================================

        // Create Database Subnet Group for RDS
        const dbSubnetGroup = new rds.CfnDBSubnetGroup(this, `${appName}-DatabaseSubnetGroup`, {
            dbSubnetGroupDescription: 'Subnet group for RDS databases',
            dbSubnetGroupName: `${appName}-db-subnet-group`,
            subnetIds: this.databaseSubnets.map(subnet => subnet.subnetId),
            tags: [{ key: 'Name', value: `${appName}-db-subnet-group` }]
        });

        // Create ElastiCache Subnet Group
        const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, `${appName}-CacheSubnetGroup`, {
            description: 'Subnet group for ElastiCache clusters',
            cacheSubnetGroupName: `${appName}-cache-subnet-group`,
            subnetIds: this.databaseSubnets.map(subnet => subnet.subnetId)
        });

        // ============================================================================
        // STACK OUTPUTS
        // ============================================================================

        new cdk.CfnOutput(this, "VpcId", {
            value: this.vpc.vpcId,
            description: "Main VPC ID",
        });

        new cdk.CfnOutput(this, "VpcCidr", {
            value: this.vpc.vpcCidrBlock,
            description: "VPC CIDR Block",
        });

        new cdk.CfnOutput(this, "PublicSubnetIds", {
            value: this.publicSubnets.map(subnet => subnet.subnetId).join(','),
            description: "Public Subnet IDs (Tier 1)",
        });

        new cdk.CfnOutput(this, "PrivateSubnetIds", {
            value: this.privateSubnets.map(subnet => subnet.subnetId).join(','),
            description: "Private Subnet IDs (Tier 2)",
        });

        new cdk.CfnOutput(this, "DatabaseSubnetIds", {
            value: this.databaseSubnets.map(subnet => subnet.subnetId).join(','),
            description: "Database Subnet IDs (Tier 3)",
        });

        new cdk.CfnOutput(this, "DatabaseSubnetGroupName", {
            value: dbSubnetGroup.dbSubnetGroupName!,
            description: "RDS Database Subnet Group Name",
        });

        new cdk.CfnOutput(this, "IntraSubnetIds", {
            value: this.intraSubnets.map(subnet => subnet.subnetId).join(','),
            description: "Intra Subnet IDs (Tier 4)",
        });

        new cdk.CfnOutput(this, "CacheSubnetGroupName", {
            value: cacheSubnetGroup.cacheSubnetGroupName!,
            description: "ElastiCache Subnet Group Name",
        });

        new cdk.CfnOutput(this, "AvailabilityZones", {
            value: this.vpc.availabilityZones.join(','),
            description: "Availability Zones used by the VPC",
        });
    }
}
