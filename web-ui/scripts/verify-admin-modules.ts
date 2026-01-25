
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

// Initialize clients (will use AWS_PROFILE from environment)
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-south-1' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1' }));

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID; // Need to set this env var or hardcode for test
// Hardcoding table name based on previous context if env var not set
const TABLE_NAME = process.env.DYNAMODB_USERS_TEAMS_TABLE || 'nucleus-app-web-ui-users-teams-kartikmanimuthu-nucleus-platform';

// We need the User Pool ID. Let's try to find it or ask user.
// Based on previous outputs, it was outputted in CDK stack. 
// I will attempt to list user pools if ID is missing or just assume the user provides it/we find it.
// Actually, I can use the one from .env.local if it exists or just fail if not.

async function verifyUserManagement() {
    console.log('--- Starting User Management Verification ---');

    if (!USER_POOL_ID) {
        console.warn('⚠️  COGNITO_USER_POOL_ID env var is missing. Please set it or checking if I can list users without it (unlikely).');
        // For test script, I'll try to proceed or just fail.
    } else {
        console.log(`Using User Pool ID: ${USER_POOL_ID}`);
    }

    // 1. Test Cognito List Users
    try {
        console.log('\n1. Testing Cognito ListUsers...');
        // If UserPoolID is missing, we can't really list. 
        // BUT the user's profile is for the whole account.
        // Let's assume we need to pass it.

        if (USER_POOL_ID) {
            const command = new ListUsersCommand({
                UserPoolId: USER_POOL_ID,
                Limit: 5
            });
            const users = await cognito.send(command);
            console.log(`✅ Successfully listed ${users.Users?.length} users.`);
            if (users.Users && users.Users.length > 0) {
                console.log('Sample User:', users.Users[0].Username);
            }
        } else {
            console.log('⏭️  Skipping Cognito test (No User Pool ID).');
        }

    } catch (error) {
        console.error('❌ Cognito ListUsers Failed:', error);
    }

    // 2. Test DynamoDB Write (Role Assignment)
    try {
        console.log('\n2. Testing DynamoDB Role Assignment...');
        const testUserId = 'test-user-verification-script';
        const tenantId = 'default';

        await ddb.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                PK: `USER#${testUserId}`,
                SK: `TENANT#${tenantId}`,
                EntityType: 'UserTenantRole',
                userId: testUserId,
                role: 'TenantViewer',
                assignedAt: new Date().toISOString(),
                assignedBy: 'verification-script'
            }
        }));
        console.log(`✅ Successfully wrote role for ${testUserId} to table ${TABLE_NAME}`);

        // 3. Test DynamoDB Read
        console.log('\n3. Testing DynamoDB Role Read...');
        const result = await ddb.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `USER#${testUserId}`,
                SK: `TENANT#${tenantId}`
            }
        }));

        if (result.Item && result.Item.role === 'TenantViewer') {
            console.log('✅ Successfully read back the assigned role:', result.Item.role);
        } else {
            console.error('❌ Failed to read back the role or role mismatch.');
            console.log('Item:', result.Item);
        }

    } catch (error) {
        console.error('❌ DynamoDB Operations Failed:', error);
        console.log('Table Name used:', TABLE_NAME);
    }

    console.log('\n--- Verification Complete ---');
}

verifyUserManagement();
