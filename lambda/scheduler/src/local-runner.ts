// Local Development Runner
// Enables running the scheduler locally for testing and debugging

import 'dotenv/config';

// Force AWS_SDK_LOAD_CONFIG to true to ensure shared config files (~/.aws/config) are loaded
// This is often required for SSO profiles to work correctly
process.env.AWS_SDK_LOAD_CONFIG = '1';

// Set default table names for local dev if not present
if (!process.env.APP_TABLE_NAME) process.env.APP_TABLE_NAME = 'cost-optimization-scheduler-app-table';
if (!process.env.AUDIT_TABLE_NAME) process.env.AUDIT_TABLE_NAME = 'cost-optimization-scheduler-audit-table';

// Diagnostics for AWS environment
console.log(`[Local Runner] AWS_PROFILE: ${process.env.AWS_PROFILE || 'not set'}`);
console.log(`[Local Runner] AWS_REGION: ${process.env.AWS_REGION || 'not set'}`);
console.log(`[Local Runner] AWS_SDK_LOAD_CONFIG: ${process.env.AWS_SDK_LOAD_CONFIG}`);
if (process.env.AWS_ACCESS_KEY_ID) console.log(`[Local Runner] Static credentials detected`);


import { handler } from './index.js';
import type { SchedulerEvent } from './types/index.js';
import type { Context, Callback } from 'aws-lambda';

// Parse command line arguments
const args = process.argv.slice(2);
const argsMap = new Map<string, string>();

for (const arg of args) {
    const [key, value] = arg.replace('--', '').split('=');
    argsMap.set(key, value || '');
}

const mode = argsMap.get('mode') || 'full';
const scheduleId = argsMap.get('scheduleId');
const scheduleName = argsMap.get('scheduleName');
const tenantId = argsMap.get('tenantId');

// Build event based on mode
function buildEvent(): SchedulerEvent {
    if (mode === 'partial') {
        if (!scheduleId && !scheduleName) {
            console.error('Error: --scheduleId or --scheduleName required for partial mode');
            console.log('Usage: npm run dev -- --mode=partial --scheduleId=YOUR_SCHEDULE_ID [--tenantId=org-default]');
            process.exit(1);
        }
        return {
            scheduleId,
            scheduleName,
            tenantId,
            triggeredBy: 'web-ui',
        };
    }
    return {
        triggeredBy: 'web-ui',
    };
}

// Mock Lambda context
const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'cost-scheduler-lambda-local',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:local:000000000000:function:cost-scheduler-lambda',
    memoryLimitInMB: '256',
    awsRequestId: `local-${Date.now()}`,
    logGroupName: '/aws/lambda/cost-scheduler-lambda',
    logStreamName: `local-${new Date().toISOString().split('T')[0]}`,
    getRemainingTimeInMillis: () => 300000,
    done: () => { },
    fail: () => { },
    succeed: () => { },
};

async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║          Cost Scheduler Lambda - Local Development        ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log();

    // Display configuration
    console.log('Configuration:');
    console.log(`  Mode:          ${mode}`);
    console.log(`  Schedule ID:   ${scheduleId || 'N/A (full scan)'}`);
    console.log(`  Schedule Name: ${scheduleName || 'N/A (full scan)'}`);
    console.log(`  AWS Region:    ${process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'not set'}`);
    console.log(`  App Table:     ${process.env.APP_TABLE_NAME || 'not set'}`);
    console.log(`  Audit Table:   ${process.env.AUDIT_TABLE_NAME || 'not set'}`);
    console.log();

    const event = buildEvent();
    console.log('Event:', JSON.stringify(event, null, 2));
    console.log();
    console.log('Starting execution...');
    console.log('─'.repeat(60));
    console.log();

    const startTime = Date.now();

    try {
        const result = await handler(event, mockContext, (() => { }) as Callback);
        const duration = Date.now() - startTime;

        console.log();
        console.log('─'.repeat(60));
        console.log('Execution Complete!');
        console.log();
        console.log('Result:', JSON.stringify(result, null, 2));
        console.log();
        console.log(`Total Duration: ${duration}ms`);

        // Check for credential errors in result
        if (result && !result.success && result.errors?.some((e: string) =>
            e.includes('sso_region') ||
            e.includes('Credentials') ||
            e.includes('credentials')
        )) {
            console.log();
            console.log('\x1b[33mHint: This looks like an AWS authentication error.\x1b[0m');
            console.log('1. Ensure your SSO session is active: aws sso login --profile YOUR_PROFILE');
            console.log('2. Verify your AWS_PROFILE environment variable is correct.');
            console.log('3. Ensure your ~/.aws/config has the correct sso_region and sso_start_url.');
        }
    } catch (error: any) {
        console.error('Execution failed:', error);

        if (error.message && (error.message.includes('sso_region') || error.message.includes('Credentials'))) {
            console.log();
            console.log('Hint: This looks like an AWS authentication error.');
            console.log('1. Ensure your SSO session is active: aws sso login --profile YOUR_PROFILE');
            console.log('2. Verify your AWS_PROFILE environment variable is correct.');
            console.log('3. Ensure your ~/.aws/config has the correct sso_region and sso_start_url.');
        }

        process.exit(1);
    }
}

// Run
main().catch(console.error);
