// Confirms the AWS credential chain resolves and can reach the Cognito pool the
// invite flow uses. Read-only: DescribeUserPool, no writes.
import { CognitoIdentityProviderClient, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
try {
    const r = await client.send(new DescribeUserPoolCommand({ UserPoolId: process.env.COGNITO_USER_POOL_ID }));
    console.log('OK  pool:', r.UserPool?.Name, '| status:', r.UserPool?.Status ?? 'n/a');
} catch (e) {
    console.log('FAIL', (e as Error).name + ':', (e as Error).message.slice(0, 140));
}
