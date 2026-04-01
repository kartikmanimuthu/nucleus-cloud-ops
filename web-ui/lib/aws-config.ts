// AWS configuration for DynamoDB access
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

// Get AWS configuration from environment variables (server-side)
const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'ap-south-1';
export const APP_TABLE_NAME = process.env.APP_TABLE_NAME || process.env.NEXT_PUBLIC_APP_TABLE_NAME || 'cost-optimization-scheduler-app-table';
export const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME || process.env.NEXT_PUBLIC_AUDIT_TABLE_NAME || 'cost-optimization-scheduler-audit-table';
// Legacy support
export const DYNAMODB_TABLE_NAME = APP_TABLE_NAME;

// Check if we're running in AWS Lambda environment
const isLambdaEnvironment = () => {
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    console.log('Environment Check - AWS_LAMBDA_FUNCTION_NAME:', process.env.AWS_LAMBDA_FUNCTION_NAME);
    console.log('Environment Check - Is Lambda Environment:', isLambda);
    return isLambda;
};

// Create credentials object with validation
const createCredentials = () => {
    // In Lambda environment, use default credential provider chain
    if (isLambdaEnvironment()) {
        console.log('Running in Lambda environment - using default credential provider chain');
        return undefined; // Let AWS SDK use default provider chain
    }

    // In local development, use environment variables
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    console.log('AWS Config - Creating credentials for local development...');
    console.log('Access Key ID:', accessKeyId?.substring(0, 10) + '...');
    console.log('Has Secret Key:', !!secretAccessKey);
    console.log('Has Session Token:', !!sessionToken);

    // During local development, if credentials are not provided, use default provider chain
    if (!accessKeyId || !secretAccessKey) {
        console.warn('AWS credentials are missing in local environment - using default provider chain');
        return undefined;
    }

    const credentials: any = {
        accessKeyId,
        secretAccessKey,
    };

    // Only add sessionToken if it exists
    if (sessionToken) {
        credentials.sessionToken = sessionToken;
    }

    return credentials;
};

// Configure AWS SDK with better error handling
let dynamoDBClient: DynamoDBClient | null = null;
let dynamoDBDocumentClient: DynamoDBDocumentClient | null = null;

const initializeAWSClients = () => {
    if (dynamoDBDocumentClient) {
        console.log('Using existing DynamoDB document client');
        return dynamoDBDocumentClient;
    }

    try {
        console.log('Starting AWS client initialization...');
        console.log('AWS Region:', region);
        console.log('App Table Name:', APP_TABLE_NAME);
        console.log('Audit Table Name:', AUDIT_TABLE_NAME);

        // Check if we're in Lambda environment
        if (isLambdaEnvironment()) {
            // In Lambda, use the default credential provider chain
            console.log('Initializing AWS clients with default credential provider chain for Lambda');

            // Log additional Lambda environment details
            console.log('Lambda Environment Details:');
            console.log('  - AWS_REGION:', process.env.AWS_REGION);
            console.log('  - AWS_DEFAULT_REGION:', process.env.AWS_DEFAULT_REGION);
            console.log('  - AWS_EXECUTION_ENV:', process.env.AWS_EXECUTION_ENV);
            console.log('  - AWS_LAMBDA_FUNCTION_NAME:', process.env.AWS_LAMBDA_FUNCTION_NAME);

            dynamoDBClient = new DynamoDBClient({
                region,
                maxAttempts: 3,
                retryMode: "adaptive"
            });

            console.log('DynamoDB client created for Lambda environment');
        } else {
            // In local development, use environment variables
            const credentials = createCredentials();
            console.log('Initializing AWS clients with credentials for local development');
            dynamoDBClient = new DynamoDBClient({
                region,
                ...(credentials && { credentials }),
                maxAttempts: 3,
                retryMode: "adaptive"
            });
            console.log('DynamoDB client created for local development');
        }

        console.log('Creating DynamoDB Document Client from base client');
        dynamoDBDocumentClient = DynamoDBDocumentClient.from(dynamoDBClient, {
            marshallOptions: {
                removeUndefinedValues: true
            }
        });
        console.log('DynamoDB Document Client initialized successfully');

        return dynamoDBDocumentClient;
    } catch (error: any) {
        console.error('Failed to initialize AWS clients:', error);
        console.error('Error name:', error?.name);
        console.error('Error message:', error?.message);
        console.error('Error stack:', error?.stack);
        throw error;
    }
};

export const getDynamoDBDocumentClient = () => {
    console.log('getDynamoDBDocumentClient called');
    const client = initializeAWSClients();
    console.log('getDynamoDBDocumentClient returning client');
    return client;
};

/**
 * Utility function to handle DynamoDB errors consistently
 */
export function handleDynamoDBError(error: any, operation: string): void {
    console.error(`DynamoDB error during ${operation}:`, error);
    const errorDetails = {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        statusCode: error?.$metadata?.httpStatusCode
    };
    console.error('Error details:', errorDetails);

    // Log additional error information
    if (error?.$metadata) {
        console.error('Error metadata:', error.$metadata);
    }
    if (error?.$response) {
        console.error('Error response:', error.$response);
    }

    // Generate appropriate error based on the error type
    if (error?.name === 'ConditionalCheckFailedException') {
        throw new Error('A resource with this name already exists');
    } else if (error?.name === 'ValidationException') {
        throw new Error(`Validation error: ${error?.message}`);
    } else if (error?.name === 'ResourceNotFoundException') {
        throw new Error('The requested resource was not found');
    } else if (error?.name === 'ProvisionedThroughputExceededException') {
        throw new Error('Database capacity exceeded, please try again later');
    } else {
        throw new Error(`Failed to ${operation}: ${error?.message}`);
    }
}

/**
 * Test function to verify DynamoDB connection
 * This can be called to debug connection issues
 */
export async function testDynamoDBConnection(): Promise<boolean> {
    console.log('Testing DynamoDB connection...');
    try {
        const client = getDynamoDBDocumentClient();
        console.log('DynamoDB client obtained successfully');

        // Import the ListTablesCommand here to avoid importing it at the top level
        const { ListTablesCommand } = await import('@aws-sdk/client-dynamodb');

        // Try to list tables to verify connection
        console.log('Attempting to list DynamoDB tables...');
        const command = new ListTablesCommand({});
        const response = await client.send(command);
        console.log('DynamoDB tables:', response.TableNames);
        console.log('DynamoDB connection test completed successfully');
        return true;
    } catch (error: any) {
        console.error('DynamoDB connection test failed:', error);
        handleDynamoDBError(error, 'test connection');
        return false;
    }
}