// workers/src/jobs/discovery/services/sts-service.ts
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AssumedCredentials } from '../types.js';
import { env } from '../../../env.js';

const AWS_REGION = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-south-1';

let stsClient: STSClient | null = null;

function getSTSClient(): STSClient {
  if (!stsClient) {
    stsClient = new STSClient({ region: AWS_REGION });
  }
  return stsClient;
}

export async function assumeRole(
  roleArn: string,
  accountId: string,
  region: string,
  externalId?: string,
): Promise<AssumedCredentials> {
  const client = getSTSClient();
  const roleSessionName = `NucleusDiscovery-${accountId}-${region}`;

  const response = await client.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: roleSessionName,
      DurationSeconds: 3600,
      ExternalId: externalId,
    }),
  );

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
}
