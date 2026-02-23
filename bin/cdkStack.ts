#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
// import { CdkStack } from '../lib/cdkStack';
// import { WebUIStack } from '../lib/webUIStack';
import { NetworkingStack } from '../lib/networkingStack';
import { ComputeStack } from '../lib/computeStack';

import { getConfig } from '../lib/config';

const app = new cdk.App();

// Read configuration from config.ts
const config = getConfig();
const appName = config.appName;
const awsAccountId = config.awsAccountId;
const awsRegion = config.awsRegion;

console.log(`Deploying to App: ${appName}, Account: ${awsAccountId}, Region: ${awsRegion}`);

// ============================================================================
// EXISTING STACKS (retained for backward compatibility)
// ============================================================================

// const costEfficientSchedulerStack = new CdkStack(app, `${appName}-CostEfficientSchedulerStack`, {
//   env: { account: awsAccountId, region: awsRegion },
// });

// new WebUIStack(app, `${appName}-WebUIStack`, {
//   env: { account: awsAccountId, region: awsRegion },
//   schedulerLambdaArn: costEfficientSchedulerStack.schedulerLambdaFunctionArn,
// });

// ============================================================================
// NEW STACKS (Networking + Compute with ECS)
// ============================================================================

const networkingStack = new NetworkingStack(app, `${appName}-NetworkingStack`, {
  env: { account: awsAccountId, region: awsRegion },
  vpcCidr: config.networking.vpcCidr,
  maxAzs: config.networking.maxAzs,
  natGateways: config.networking.natGateways,
});

new ComputeStack(app, `${appName}-ComputeStack`, {
  env: { account: awsAccountId, region: awsRegion },
  vpc: networkingStack.vpc,
});