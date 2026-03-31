#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WebUIStack } from '../lib/webUIStack';
import { getConfig } from '../lib/config';

const app = new cdk.App();
const config = getConfig();
const appName = config.appName || 'nucleus-cloud-ops';

new WebUIStack(app, `${appName}-WebUIStack`, {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
});
