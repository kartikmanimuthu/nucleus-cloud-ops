import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TenantRole, UserTenantRole } from './types';

// Initialize DynamoDB client
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.DYNAMODB_USERS_TEAMS_TABLE || 'nucleus-app-web-ui-users-teams';

/**
 * Get the role of a user within a specific tenant.
 * 
 * @param userId - Cognito sub (user ID)
 * @param tenantId - Tenant ID
 * @returns The user's role in the tenant, or null if not assigned
 */
export async function getUserTenantRole(
    userId: string,
    tenantId: string
): Promise<TenantRole | null> {
    try {
        const result = await ddb.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `USER#${userId}`,
                SK: `TENANT#${tenantId}`,
            },
        }));

        return (result.Item?.role as TenantRole) || null;
    } catch (error) {
        console.error('Error fetching user tenant role:', error);
        return null;
    }
}

/**
 * Get all roles for a user across all tenants.
 * 
 * @param userId - Cognito sub (user ID)
 * @returns Array of user-tenant-role mappings
 */
export async function getUserAllRoles(userId: string): Promise<UserTenantRole[]> {
    try {
        const result = await ddb.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: {
                ':pk': `USER#${userId}`,
                ':sk': 'TENANT#',
            },
        }));

        return (result.Items as UserTenantRole[]) || [];
    } catch (error) {
        console.error('Error fetching user roles:', error);
        return [];
    }
}

/**
 * Assign a role to a user within a tenant.
 * 
 * @param userId - Cognito sub (user ID)
 * @param email - User's email
 * @param tenantId - Tenant ID
 * @param role - Role to assign
 * @param assignedBy - Email of the admin assigning the role
 */
export async function assignUserRole(
    userId: string,
    email: string,
    tenantId: string,
    role: TenantRole,
    assignedBy: string
): Promise<void> {
    await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
            PK: `USER#${userId}`,
            SK: `TENANT#${tenantId}`,
            EntityType: 'UserTenantRole',
            userId,
            email,
            tenantId,
            role,
            assignedAt: new Date().toISOString(),
            assignedBy,
        },
    }));
}

/**
 * Get all users in a tenant with their roles.
 * 
 * @param tenantId - Tenant ID
 * @returns Array of user-tenant-role mappings for the tenant
 */
export async function getTenantUsers(tenantId: string): Promise<UserTenantRole[]> {
    try {
        const result = await ddb.send(new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: 'EntityTypeIndex',
            KeyConditionExpression: 'EntityType = :entityType',
            FilterExpression: 'tenantId = :tenantId',
            ExpressionAttributeValues: {
                ':entityType': 'UserTenantRole',
                ':tenantId': tenantId,
            },
        }));

        return (result.Items as UserTenantRole[]) || [];
    } catch (error) {
        console.error('Error fetching tenant users:', error);
        return [];
    }
}
