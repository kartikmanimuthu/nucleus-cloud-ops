/**
 * Dynamoose Configuration
 * 
 * Initializes Dynamoose with AWS region and table configuration.
 * This module should be imported before any model usage.
 */

import * as dynamoose from 'dynamoose';

const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'ap-south-1';

// Configure Dynamoose with the AWS SDK DynamoDB instance
const ddb = new dynamoose.aws.ddb.DynamoDB({
    region,
});
dynamoose.aws.ddb.set(ddb);

// Table name from environment
export const AGENT_OPS_TABLE_NAME = process.env.AGENT_OPS_TABLE_NAME || 'AgentOpsTable';

// Shared TTL: 30 days
export const TTL_30_DAYS = () => Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

export default dynamoose;
