/**
 * Cognito Identity Provider client singleton.
 *
 * Usage: import { getCognitoClient, COGNITO_USER_POOL_ID } from '@/lib/cognito-client'
 */

import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { env } from "@/env";

let cognitoClient: CognitoIdentityProviderClient | null = null;

export function getCognitoClient(): CognitoIdentityProviderClient {
    if (!cognitoClient) {
        cognitoClient = new CognitoIdentityProviderClient({
            region: env.AWS_REGION || "us-east-1",
        });
    }
    return cognitoClient;
}

export const COGNITO_USER_POOL_ID = env.COGNITO_USER_POOL_ID;
