/**
 * Tenant Configuration Service
 * 
 * Generic DynamoDB-backed service for storing per-tenant configuration.
 * Uses the existing APP_TABLE_NAME (Single Table Design).
 * 
 * Record structure:
 *   PK = TENANT#<tenantId>
 *   SK = CONFIG#<configKey>
 *   GSI1PK = TYPE#CONFIG
 *   GSI1SK = <configKey>
 */

import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, DEFAULT_TENANT_ID } from './aws-config';

const buildPK = (tenantId: string) => `TENANT#${tenantId}`;
const buildSK = (configKey: string) => `CONFIG#${configKey}`;

export class TenantConfigService {
    /**
     * Get a configuration item by key.
     * Returns the parsed data payload, or null if not found.
     */
    static async getConfig<T = any>(
        configKey: string,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<T | null> {
        try {
            const command = new GetCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildPK(tenantId),
                    sk: buildSK(configKey),
                },
            });

            const response = await getDynamoDBDocumentClient().send(command);
            if (!response.Item) {
                return null;
            }

            return response.Item.data as T;
        } catch (error: any) {
            console.error(`[TenantConfigService] Error getting config "${configKey}":`, error);
            throw new Error(`Failed to get config: ${error.message}`);
        }
    }

    /**
     * Save (put/overwrite) a configuration item.
     */
    static async saveConfig<T = any>(
        configKey: string,
        data: T,
        tenantId: string = DEFAULT_TENANT_ID,
        updatedBy: string = 'system'
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
            console.log(`[TenantConfigService] Saved config "${configKey}" for tenant "${tenantId}"`);
        } catch (error: any) {
            console.error(`[TenantConfigService] Error saving config "${configKey}":`, error);
            throw new Error(`Failed to save config: ${error.message}`);
        }
    }

    /**
     * Delete a configuration item (revert to defaults).
     */
    static async deleteConfig(
        configKey: string,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<void> {
        try {
            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildPK(tenantId),
                    sk: buildSK(configKey),
                },
            });

            await getDynamoDBDocumentClient().send(command);
            console.log(`[TenantConfigService] Deleted config "${configKey}" for tenant "${tenantId}"`);
        } catch (error: any) {
            console.error(`[TenantConfigService] Error deleting config "${configKey}":`, error);
            throw new Error(`Failed to delete config: ${error.message}`);
        }
    }

    /**
     * List all config keys for a tenant (via GSI1).
     */
    static async listConfigs(
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<Array<{ configKey: string; updatedAt: string }>> {
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
            return (response.Items || []).map((item: any) => ({
                configKey: item.configKey,
                updatedAt: item.updatedAt,
            }));
        } catch (error: any) {
            console.error(`[TenantConfigService] Error listing configs:`, error);
            throw new Error(`Failed to list configs: ${error.message}`);
        }
    }
}
