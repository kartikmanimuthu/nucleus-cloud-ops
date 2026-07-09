import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { AccountService } from '../account-service';
import { createSessionProfile } from './session-manager';
import { env } from '@/env';

/**
 * AWS Credentials Tool
 *
 * This tool fetches temporary AWS credentials for a specific account
 * by assuming the IAM role stored in the database for that account.
 *
 * The credentials are returned to the model so it can execute AWS CLI
 * commands or SDK calls against the target account.
 */

interface AWSCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    region: string;
    accountId: string;
    accountName: string;
    expiresAt: string;
}

/**
 * Assume role and get temporary credentials
 */
export async function assumeRoleForAccount(
    roleArn: string,
    externalId?: string,
    sessionName: string = 'NucleusDevOpsAgentSession'
): Promise<{ credentials: any; expiration: Date }> {
    const stsClient = new STSClient({
        region: env.AWS_REGION || env.NEXT_PUBLIC_AWS_REGION || 'us-east-1'
    });

    const assumeRoleCommand = new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        ExternalId: externalId,
        DurationSeconds: 900, // 15 minutes
    });

    const response = await stsClient.send(assumeRoleCommand);

    if (!response.Credentials) {
        throw new Error('Failed to obtain temporary credentials from STS');
    }

    return {
        credentials: response.Credentials,
        expiration: response.Credentials.Expiration || new Date(Date.now() + 3600000)
    };
}

/**
 * Factory: creates a tenant-scoped get_aws_credentials tool.
 * All account lookups go through AccountService (repository pattern, tenant-isolated).
 */
export function createGetAwsCredentialsTool(tenantId: string) {
    return tool(
        async ({ accountId }: { accountId: string }): Promise<string> => {
            console.log(`[Tool] Getting AWS credentials for account: ${accountId} (tenant: ${tenantId})`);

            if (!accountId || accountId.trim() === '') {
                return JSON.stringify({
                    error: 'No account ID provided. Please select an AWS account before performing AWS operations.',
                    success: false
                });
            }

            try {
                // 1. Fetch account details via tenant-scoped AccountService
                const account = await AccountService.getAccount(accountId, tenantId);

                if (!account) {
                    return JSON.stringify({
                        error: `Account ${accountId} not found in the system. Please ensure the account is registered.`,
                        success: false
                    });
                }

                if (!account.roleArn) {
                    return JSON.stringify({
                        error: `Account ${accountId} does not have an IAM Role ARN configured. Please update the account configuration.`,
                        success: false
                    });
                }

                if (!account.active) {
                    return JSON.stringify({
                        error: `Account ${accountId} is currently inactive. Please activate the account before use.`,
                        success: false
                    });
                }

                // 2. Assume the role to get temporary credentials
                const { credentials, expiration } = await assumeRoleForAccount(
                    account.roleArn,
                    account.externalId
                );

                // 3. Determine region (use first region from account, or default)
                const region = account.regions?.[0] || env.AWS_REGION || env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';

                // 4. Create session profile in the tenant-isolated credentials file
                const profile = await createSessionProfile(
                    accountId,
                    {
                        accessKeyId: credentials.AccessKeyId!,
                        secretAccessKey: credentials.SecretAccessKey!,
                        sessionToken: credentials.SessionToken!,
                        region: region
                    },
                    tenantId
                );

                console.log(`[Tool] Created profile: ${profile.profileName} for account: ${accountId}`);
                console.log(`[Tool] Profile expires at: ${profile.expiresAt.toISOString()}`);

                return JSON.stringify({
                    success: true,
                    profileName: profile.profileName,
                    region: region,
                    accountId: accountId,
                    accountName: account.name || accountId,
                    expiresAt: profile.expiresAt.toISOString(),
                    message: `Created AWS profile "${profile.profileName}" for account "${account.name || accountId}". Profile valid until ${profile.expiresAt.toISOString()}.`,
                    usage: `AWS CLI commands will automatically use this profile. For manual use: --profile ${profile.profileName} OR AWS_PROFILE=${profile.profileName}`
                });

            } catch (error: any) {
                console.error(`[Tool] Error getting credentials for account ${accountId}:`, error);

                let errorMessage = error.message || 'Unknown error occurred';

                if (error.name === 'AccessDenied' || errorMessage.includes('AccessDenied')) {
                    errorMessage = `Access denied when assuming role for account ${accountId}. Verify that the trust policy allows this role to be assumed.`;
                } else if (error.name === 'MalformedPolicyDocument') {
                    errorMessage = `Invalid role configuration for account ${accountId}. Check the IAM role ARN format.`;
                }

                return JSON.stringify({
                    error: errorMessage,
                    success: false
                });
            }
        },
        {
            name: 'get_aws_credentials',
            description: `Fetch temporary AWS credentials for a specific AWS account and create a session profile.
This tool retrieves the IAM role from the account configuration and uses STS AssumeRole to obtain temporary credentials.
A temporary AWS profile is created that can be used with AWS CLI commands using the --profile flag.
IMPORTANT: You MUST call this tool before executing any AWS CLI commands if an account is selected.
The returned profile name should be used with all subsequent AWS CLI commands.`,
            schema: z.object({
                accountId: z.string().describe('The AWS account ID (12-digit number) to get credentials for'),
            }),
        }
    );
}

/**
 * Factory: creates a tenant-scoped list_aws_accounts tool.
 */
export function createListAwsAccountsTool(tenantId: string) {
    return tool(
        async (): Promise<string> => {
            console.log(`[Tool] Listing connected AWS accounts for tenant: ${tenantId}`);

            try {
                const { accounts } = await AccountService.getAccounts({
                    statusFilter: 'active',
                    connectionFilter: 'connected',
                    limit: 100,
                    tenantId,
                });

                if (!accounts || accounts.length === 0) {
                    return JSON.stringify({
                        success: true,
                        accounts: [],
                        message: 'No active connected AWS accounts found. Please configure accounts first.',
                    });
                }

                const accountList = accounts.map(a => ({
                    accountId: a.accountId,
                    accountName: a.name,
                    regions: a.regions || [],
                }));

                console.log(`[Tool] Found ${accountList.length} connected accounts`);

                return JSON.stringify({
                    success: true,
                    accounts: accountList,
                    message: `Found ${accountList.length} connected AWS account(s). Use get_aws_credentials with the desired accountId to obtain temporary credentials.`,
                });
            } catch (error: any) {
                console.error(`[Tool] Error listing accounts:`, error);
                return JSON.stringify({
                    error: error.message || 'Failed to list AWS accounts',
                    success: false,
                });
            }
        },
        {
            name: 'list_aws_accounts',
            description: `List all active and connected AWS accounts available in the system.
Use this tool FIRST to discover which AWS accounts are available before calling get_aws_credentials.
Returns account IDs, names, and regions. You can then match the user's request to the correct account
by fuzzy-matching the account name or ID from the user's prompt.`,
            schema: z.object({}),
        }
    );
}

/**
 * Utility function to generate AWS CLI prefix with credentials
 */
export function generateAwsCredentialPrefix(credentials: AWSCredentials): string {
    return `AWS_ACCESS_KEY_ID="${credentials.accessKeyId}" AWS_SECRET_ACCESS_KEY="${credentials.secretAccessKey}" AWS_SESSION_TOKEN="${credentials.sessionToken}" AWS_REGION="${credentials.region}"`;
}
