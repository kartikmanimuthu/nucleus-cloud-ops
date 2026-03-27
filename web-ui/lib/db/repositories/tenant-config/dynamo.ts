/**
 * TenantConfigDynamoRepository
 *
 * DynamoDB implementation of ITenantConfigRepository.
 * Logic extracted from the original TenantConfigService static class.
 *
 * DynamoDB single-table access pattern:
 *   PK = TENANT#<tenantId>
 *   SK = CONFIG#<configKey>
 *   GSI1PK = TYPE#CONFIG, GSI1SK = <configKey>
 */
import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME } from '@/lib/aws-config';
import type { ITenantConfigRepository } from './interface';

const buildPK = (tenantId: string) => `TENANT#${tenantId}`;
const buildSK = (configKey: string) => `CONFIG#${configKey}`;

export class TenantConfigDynamoRepository implements ITenantConfigRepository {
    async getConfig<T = unknown>(configKey: string, tenantId: string): Promise<T | null> {
        try {
            const command = new GetCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildPK(tenantId),
                    sk: buildSK(configKey),
                },
            });
            const response = await getDynamoDBDocumentClient().send(command);
            if (!response.Item) return null;
            return response.Item.data as T;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[TenantConfigDynamoRepository] Error getting config "${configKey}":`, error);
            throw new Error(`Failed to get config: ${msg}`);
        }
    }

    async saveConfig<T = unknown>(
        configKey: string,
        data: T,
        tenantId: string,
        updatedBy = 'system'
    ): Promise<void> {
        try {
            const now = new Date().toISOString();
            const command = new PutCommand({
                TableName: APP_TABLE_NAME,
                Item: {
                    pk: buildPK(tenantId),
                    sk: buildSK(configKey),
                    gsi1pk: 'TYPE#CONFIG',
                    gsi1sk: configKey,
                    type: 'config',
                    configKey,
                    tenantId,
                    data,
                    updatedAt: now,
                    updatedBy,
                },
            });
            await getDynamoDBDocumentClient().send(command);
            console.log(`[TenantConfigDynamoRepository] Saved config "${configKey}" for tenant "${tenantId}"`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[TenantConfigDynamoRepository] Error saving config "${configKey}":`, error);
            throw new Error(`Failed to save config: ${msg}`);
        }
    }

    async deleteConfig(configKey: string, tenantId: string): Promise<void> {
        try {
            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildPK(tenantId),
                    sk: buildSK(configKey),
                },
            });
            await getDynamoDBDocumentClient().send(command);
            console.log(`[TenantConfigDynamoRepository] Deleted config "${configKey}" for tenant "${tenantId}"`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[TenantConfigDynamoRepository] Error deleting config "${configKey}":`, error);
            throw new Error(`Failed to delete config: ${msg}`);
        }
    }

    async listConfigs(tenantId: string): Promise<Array<{ configKey: string; updatedAt: string }>> {
        try {
            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
                ExpressionAttributeValues: {
                    ':pk': buildPK(tenantId),
                    ':skPrefix': 'CONFIG#',
                },
            });
            const response = await getDynamoDBDocumentClient().send(command);
            return (response.Items ?? []).map((item: Record<string, unknown>) => ({
                configKey: item.configKey as string,
                updatedAt: item.updatedAt as string,
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[TenantConfigDynamoRepository] Error listing configs:', error);
            throw new Error(`Failed to list configs: ${msg}`);
        }
    }
}
