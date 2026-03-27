/**
 * RbacDynamoRepository
 *
 * DynamoDB implementation of IRbacRepository.
 * Logic extracted from web-ui/lib/rbac/role-service.ts.
 *
 * DynamoDB single-table access pattern (DYNAMODB_USERS_TEAMS_TABLE):
 *   PK = USER#<userId>
 *   SK = TENANT#<tenantId>
 *   EntityType = 'UserTenantRole'
 *   GSI: EntityTypeIndex (KeyConditionExpression: EntityType = 'UserTenantRole')
 *
 * Uses getDynamoDBDocumentClient() shared singleton instead of creating
 * a new DynamoDBClient instance as the original role-service.ts does.
 */
import { GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import type { TenantRole, UserTenantRole } from '@/lib/rbac/types';
import type { IRbacRepository } from './interface';

const USERS_TEAMS_TABLE =
    process.env.DYNAMODB_USERS_TEAMS_TABLE || 'nucleus-app-web-ui-users-teams';

export class RbacDynamoRepository implements IRbacRepository {
    async getUserTenantRole(userId: string, tenantId: string): Promise<TenantRole | null> {
        try {
            const result = await getDynamoDBDocumentClient().send(
                new GetCommand({
                    TableName: USERS_TEAMS_TABLE,
                    Key: {
                        PK: `USER#${userId}`,
                        SK: `TENANT#${tenantId}`,
                    },
                })
            );
            return (result.Item?.role as TenantRole) || null;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacDynamoRepository] Error fetching user tenant role:', error);
            throw new Error(`Failed to get user tenant role: ${msg}`);
        }
    }

    async getUserAllRoles(userId: string): Promise<UserTenantRole[]> {
        try {
            const result = await getDynamoDBDocumentClient().send(
                new QueryCommand({
                    TableName: USERS_TEAMS_TABLE,
                    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
                    ExpressionAttributeValues: {
                        ':pk': `USER#${userId}`,
                        ':sk': 'TENANT#',
                    },
                })
            );
            return (result.Items as UserTenantRole[]) || [];
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacDynamoRepository] Error fetching user roles:', error);
            throw new Error(`Failed to get user roles: ${msg}`);
        }
    }

    async assignUserRole(
        userId: string,
        email: string,
        tenantId: string,
        role: TenantRole,
        assignedBy: string
    ): Promise<void> {
        try {
            await getDynamoDBDocumentClient().send(
                new PutCommand({
                    TableName: USERS_TEAMS_TABLE,
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
                })
            );
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacDynamoRepository] Error assigning user role:', error);
            throw new Error(`Failed to assign user role: ${msg}`);
        }
    }

    async getTenantUsers(tenantId: string): Promise<UserTenantRole[]> {
        try {
            const result = await getDynamoDBDocumentClient().send(
                new QueryCommand({
                    TableName: USERS_TEAMS_TABLE,
                    IndexName: 'EntityTypeIndex',
                    KeyConditionExpression: 'EntityType = :entityType',
                    FilterExpression: 'tenantId = :tenantId',
                    ExpressionAttributeValues: {
                        ':entityType': 'UserTenantRole',
                        ':tenantId': tenantId,
                    },
                })
            );
            return (result.Items as UserTenantRole[]) || [];
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacDynamoRepository] Error fetching tenant users:', error);
            throw new Error(`Failed to get tenant users: ${msg}`);
        }
    }
}
