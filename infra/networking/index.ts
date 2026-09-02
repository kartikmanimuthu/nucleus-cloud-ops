import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// ============================================================================
// CONFIG
// ============================================================================

const config = new pulumi.Config();
// Use vpcCidrConfig to avoid duplicate identifier with the vpcCidr export below.
const vpcCidrConfig = config.get("vpcCidr") ?? "10.0.0.0/16";
const appName = config.get("appName") ?? "nucleus";
const natStrategy = config.get("natStrategy") === "single" ? "Single" : "OnePerAz";
const region = aws.config.region ?? "us-east-1";
// Optional resource-name suffix. Empty for a stack that has never set it —
// byte-for-byte the same names as if this key didn't exist.
const nameSuffix = config.get("networkSuffix") ?? "";

const vpcName = `${appName}-vpc${nameSuffix}`;
const dbSubnetGroupLiteral = `${appName}-db-subnet-group${nameSuffix}`;
const endpointName = `${appName}-endpoint-s3${nameSuffix}`;

// ============================================================================
// SEPARATE DATABASE vs INTRA SUBNET IDs
// awsx.ec2.Vpc merges ALL Isolated subnets into isolatedSubnetIds — we cannot
// use that output directly. Filter vpc.subnets by Name tag instead.
// awsx names subnets as "<component>-<spec-name>-<index>":
//   nucleus-vpc-database-0, nucleus-vpc-database-1
//   nucleus-vpc-intra-0, nucleus-vpc-intra-1
// ============================================================================

function tierSubnetIds(v: awsx.ec2.Vpc, needle: string): pulumi.Output<string[]> {
    return v.subnets.apply(subnets =>
        pulumi.all(
            subnets.map(s =>
                pulumi.all([s.id, s.tags] as const).apply(([id, tags]) => ({
                    id,
                    name: (tags ?? {})["Name"] ?? "",
                }))
            )
        )
    ).apply(items =>
        items.filter(item => item.name.includes(needle)).map(item => item.id)
    );
}

// ============================================================================
// VPC GATEWAY ENDPOINT
// awsx.ec2.Vpc does NOT support addGatewayEndpoint — use raw aws.ec2.VpcEndpoint.
// Route table IDs: look up route table for each private + isolated subnet,
// then deduplicate (private subnets in same AZ share a route table).
// ============================================================================

function makeS3Endpoint(
    name: string,
    vpc: awsx.ec2.Vpc,
    privateSubnetIds: pulumi.Output<string[]>,
    databaseSubnetIds: pulumi.Output<string[]>,
    intraSubnetIds: pulumi.Output<string[]>,
): aws.ec2.VpcEndpoint {
    const routeTableIds = pulumi.all([privateSubnetIds, databaseSubnetIds, intraSubnetIds])
        .apply(([privateIds, dbIds, intraIds]) => {
            const allSubnetIds = [...privateIds, ...dbIds, ...intraIds];
            const routeTableOutputs = allSubnetIds.map(subnetId =>
                aws.ec2.getRouteTableOutput({ subnetId }).routeTableId
            );
            return pulumi.all(routeTableOutputs).apply(ids => [...new Set(ids)]);
        });

    return new aws.ec2.VpcEndpoint(name, {
        vpcId: vpc.vpcId,
        serviceName: pulumi.interpolate`com.amazonaws.${region}.s3`,
        vpcEndpointType: "Gateway",
        routeTableIds,
        tags: { Name: name },
    });
}

// ============================================================================
// VPC — 4-tier subnets. cidrMask (not literal cidrBlocks) lets awsx compute
// non-overlapping subnet placement itself, regardless of the VPC's CIDR size.
// ============================================================================

const vpc = new awsx.ec2.Vpc(vpcName, {
    cidrBlock: vpcCidrConfig,
    availabilityZoneNames: ["ap-south-1a", "ap-south-1b"],
    enableDnsHostnames: true,
    enableDnsSupport: true,
    natGateways: { strategy: natStrategy },
    subnetSpecs: [
        { type: "Private", name: "private", cidrMask: 24 },
        { type: "Public", name: "public", cidrMask: 26 },
        { type: "Isolated", name: "database", cidrMask: 28 },
        { type: "Isolated", name: "intra", cidrMask: 28 },
    ],
    tags: { Name: vpcName },
});

const databaseSubnetIds = tierSubnetIds(vpc, "-database-");
const intraSubnetIds = tierSubnetIds(vpc, "-intra-");
makeS3Endpoint(endpointName, vpc, vpc.privateSubnetIds, databaseSubnetIds, intraSubnetIds);

// ============================================================================
// SUBNET GROUP
// Database tier subnets. Explicit name= required: without it Pulumi appends a
// 7-char suffix which breaks any existing RDS/ElastiCache clusters
// referencing the group by name.
// ============================================================================

const dbSubnetGroup = new aws.rds.SubnetGroup(dbSubnetGroupLiteral, {
    name: dbSubnetGroupLiteral,
    description: "Subnet group for RDS databases",
    subnetIds: databaseSubnetIds,
    tags: { Name: dbSubnetGroupLiteral },
});

// ============================================================================
// TRANSIT GATEWAY ATTACHMENT (optional, config-driven)
// Attaches this VPC to a Transit Gateway already shared into this account via
// AWS RAM. Empty transitGatewayId (the default) is a no-op — a stack that
// hasn't opted in is unaffected. Uses the intra (isolated, no NAT/IGW route)
// subnets — the AWS-recommended placement for TGW attachment ENIs, since
// they need no internet access of their own.
//
// Route table association/propagation on the Transit Gateway's own route
// tables is intentionally NOT managed here: the provider does not support
// configuring or drift-detecting that for a RAM-shared (cross-account) TGW —
// it must be done by the account that owns the Transit Gateway.
// ============================================================================

const transitGatewayId = config.get("transitGatewayId");
// Comma-separated CIDR blocks reachable through the Transit Gateway, routed
// from this VPC's private-tier route tables (where application/worker
// traffic to the other account originates).
const transitGatewayRouteCidrs = (config.get("transitGatewayRouteCidrs") ?? "")
    .split(",")
    .map(cidr => cidr.trim())
    .filter(cidr => cidr.length > 0);

let transitGatewayAttachment: aws.ec2transitgateway.VpcAttachment | undefined;

if (transitGatewayId) {
    transitGatewayAttachment = new aws.ec2transitgateway.VpcAttachment(`${appName}-tgw-attachment`, {
        transitGatewayId,
        vpcId: vpc.vpcId,
        subnetIds: intraSubnetIds,
        tags: { Name: `${appName}-tgw-attachment` },
    });

    const privateRouteTableIds = [
        aws.ec2.getRouteTableOutput({ subnetId: vpc.privateSubnetIds.apply(ids => ids[0]) }).routeTableId,
        aws.ec2.getRouteTableOutput({ subnetId: vpc.privateSubnetIds.apply(ids => ids[1]) }).routeTableId,
    ];

    privateRouteTableIds.forEach((routeTableId, azIndex) => {
        transitGatewayRouteCidrs.forEach((cidr, cidrIndex) => {
            new aws.ec2.Route(`${appName}-tgw-route-${azIndex}-${cidrIndex}`, {
                routeTableId,
                destinationCidrBlock: cidr,
                transitGatewayId,
            }, { dependsOn: [transitGatewayAttachment!] });
        });
    });
}

// ============================================================================
// STACK OUTPUTS — match CDK CfnOutput keys exactly
// ============================================================================

export const vpcId = vpc.vpcId;
export const vpcCidr = vpc.vpc.cidrBlock;
export const publicSubnetIds = vpc.publicSubnetIds;
export const privateSubnetIds = vpc.privateSubnetIds;
export { databaseSubnetIds };
export { intraSubnetIds };
export const availabilityZones = pulumi.output(["ap-south-1a", "ap-south-1b"]);
export const dbSubnetGroupName = dbSubnetGroup.name;
export const transitGatewayAttachmentId = transitGatewayAttachment?.id;
