// STS Service for assuming cross-account roles
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { logger } from '../utils/logger.js';
import type { AssumedCredentials } from '../types/index.js';

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

// STS client singleton
let stsClient: STSClient | null = null;

function getSTSClient(): STSClient {
    if (!stsClient) {
        stsClient = new STSClient({ region: AWS_REGION });
    }
    return stsClient;
}

/**
 * Assume a role in another AWS account and return temporary credentials
 */
export async function assumeRole(
    roleArn: string,
    accountId: string,
    region: string,
    externalId?: string
): Promise<AssumedCredentials> {
    const client = getSTSClient();
    const roleSessionName = `scheduler-session-${accountId}-${region}`;

    logger.debug(`Assuming role ${roleArn} for account ${accountId}`, { accountId, region });

    try {
        logger.info(`Attempting to assume role: ${roleArn}`, {
            accountId,
            region,
            roleSessionName,
            hasExternalId: !!externalId
        });

        const response = await client.send(new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: roleSessionName,
            DurationSeconds: 3600, // 1 hour
            ExternalId: externalId,
        }));

        if (!response.Credentials) {
            throw new Error('No credentials returned from AssumeRole');
        }

        return {
            credentials: {
                accessKeyId: response.Credentials.AccessKeyId!,
                secretAccessKey: response.Credentials.SecretAccessKey!,
                sessionToken: response.Credentials.SessionToken!,
            },
            region,
        };
    } catch (error) {
        logger.error(`Failed to assume role ${roleArn}`, error, { accountId, region });
        throw error;
    }
}
