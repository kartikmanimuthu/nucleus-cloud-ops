/**
 * Cognito Identity Provider client singleton.
 * Mirrors the getDynamoDBDocumentClient() singleton pattern in aws-config.ts.
 *
 * Usage: import { getCognitoClient, COGNITO_USER_POOL_ID } from '@/lib/cognito-client'
 */

import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

let cognitoClient: CognitoIdentityProviderClient | null = null;

export function getCognitoClient(): CognitoIdentityProviderClient {
    if (!cognitoClient) {
        cognitoClient = new CognitoIdentityProviderClient({
            region: process.env.AWS_REGION || "us-east-1",
        });
    }
    return cognitoClient;
}

export const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
