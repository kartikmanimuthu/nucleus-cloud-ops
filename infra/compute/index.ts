import * as pulumi from "@pulumi/pulumi";

// Phase 6: Empty scaffold — no AWS resources yet.
// Phase 8+ will add DynamoDB, Cognito, S3, SQS, Lambda, ECS, CloudFront.

// StackReference to networking project.
// Format for S3 backend: "organization/<project>/<stack>" (literal "organization" required)
const networking = new pulumi.StackReference("organization/nucleus-networking/prod");

// Read networking outputs — these will be real VPC/subnet IDs after Phase 7.
// Using getOutput() (not requireOutput()) during scaffold phase because
// networking stack may not have real values yet.
const vpcId = networking.getOutput("vpcId");
const privateSubnetIds = networking.getOutput("privateSubnetIds");
const publicSubnetIds = networking.getOutput("publicSubnetIds");
const databaseSubnetIds = networking.getOutput("databaseSubnetIds");

// Placeholder exports — will be replaced with real resource outputs in later phases.
export const stackStatus = pulumi.output("scaffold");
export const networkingVpcId = vpcId;
