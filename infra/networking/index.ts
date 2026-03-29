import * as pulumi from "@pulumi/pulumi";

// Phase 6: Empty scaffold — no AWS resources yet.
// Phase 7 will add VPC, subnets, NAT gateway, VPC endpoints.

// Placeholder exports — downstream StackReference consumers expect these keys.
// Values will be replaced with real resource outputs in Phase 7.
export const vpcId = pulumi.output("placeholder-vpc-id");
export const vpcCidr = pulumi.output("10.0.0.0/16");
export const publicSubnetIds = pulumi.output([] as string[]);
export const privateSubnetIds = pulumi.output([] as string[]);
export const databaseSubnetIds = pulumi.output([] as string[]);
export const intraSubnetIds = pulumi.output([] as string[]);
