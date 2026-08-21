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
  // Optional, defaulting to the historical discovery name so every existing caller
  // keeps producing byte-identical CloudTrail session names.
  //
  // Added because Spot Guard reuses this helper (see jobs/spot-guard/services/ecs-client.ts)
  // and its mutations were therefore landing in CloudTrail as "NucleusDiscovery-...".
  // Spot Guard calls UpdateService with forceNewDeployment, so anyone asking "what
  // restarted my production service?" was pointed at the read-only discovery job.
  // Attribution has to name the subsystem that actually acted.
  sessionName?: string,
): Promise<AssumedCredentials> {
  const client = getSTSClient();
  const roleSessionName = sessionName ?? `NucleusDiscovery-${accountId}-${region}`;

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
