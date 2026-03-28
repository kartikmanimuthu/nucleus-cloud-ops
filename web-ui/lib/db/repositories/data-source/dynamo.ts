/**
 * DataSourceDynamoRepository
 *
 * DynamoDB implementation of IDataSourceRepository.
 * Logic extracted from KnowledgeBaseService static class.
 *
 * DynamoDB single-table access pattern:
 *   PK = KB#<kbId>
 *   SK = DATASOURCE#<dsId>
 *   GSI1: gsi1pk = TYPE#KB_DATASOURCE, gsi1sk = KB#<kbId>#<name>
 *
 * Note: tenantId is accepted for interface compatibility but DynamoDB key pattern
 * uses KB# PK — the kbId already scopes the data source to a specific KB.
 */
import { randomUUID } from 'crypto';
import {
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME } from '@/lib/aws-config';
import type { DataSource, CreateDataSourceInput } from '@/lib/knowledge-base/types';
import type { IDataSourceRepository } from './interface';

const kbPK = (kbId: string) => `KB#${kbId}`;
const dsSK = (dsId: string) => `DATASOURCE#${dsId}`;

function itemToDS(item: Record<string, unknown>): DataSource {
    return {
        id: item.id as string,
        knowledgeBaseId: item.knowledgeBaseId as string,
        name: item.name as string,
        sourceType: item.sourceType as DataSource['sourceType'],
        status: (item.status as DataSource['status']) || 'pending',
        config: (item.config as DataSource['config']) || ({} as DataSource['config']),
        vectorCount: (item.vectorCount as number) ?? 0,
        vectorKeys: (item.vectorKeys as string[]) || [],
        lastSyncAt: item.lastSyncAt as string | undefined,
        lastSyncError: item.lastSyncError as string | undefined,
        createdAt: item.createdAt as string,
        updatedAt: item.updatedAt as string,
    };
}

export class DataSourceDynamoRepository implements IDataSourceRepository {
    async listDataSources(kbId: string, _tenantId: string): Promise<DataSource[]> {
        try {
            const response = await getDynamoDBDocumentClient().send(
                new QueryCommand({
                    TableName: APP_TABLE_NAME,
                    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
                    ExpressionAttributeValues: {
                        ':pk': kbPK(kbId),
                        ':skPrefix': 'DATASOURCE#',
                    },
                }),
            );
            return (response.Items || []).map((item) => itemToDS(item as Record<string, unknown>));
        } catch (error: unknown) {
            console.error('[DataSourceDynamoRepository] Error listing data sources:', error);
            throw new Error(`Failed to list data sources: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async getDataSource(kbId: string, dsId: string, _tenantId: string): Promise<DataSource | null> {
        try {
            const response = await getDynamoDBDocumentClient().send(
                new GetCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
                }),
            );
            if (!response.Item) return null;
            return itemToDS(response.Item as Record<string, unknown>);
        } catch (error: unknown) {
            console.error('[DataSourceDynamoRepository] Error getting data source:', error);
            throw new Error(`Failed to get data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async createDataSource(kbId: string, data: CreateDataSourceInput, _tenantId: string): Promise<DataSource> {
        try {
            const id = randomUUID();
            const now = new Date().toISOString();

            const item = {
                pk: kbPK(kbId),
                sk: dsSK(id),
                gsi1pk: 'TYPE#KB_DATASOURCE',
                gsi1sk: `KB#${kbId}#${data.name}`,
                type: 'kb_datasource',
                id,
                knowledgeBaseId: kbId,
                name: data.name,
                sourceType: data.sourceType,
                status: 'pending' as const,
                config: data.config,
                vectorCount: 0,
                vectorKeys: [] as string[],
                createdAt: now,
                updatedAt: now,
            };

            await getDynamoDBDocumentClient().send(
                new PutCommand({ TableName: APP_TABLE_NAME, Item: item }),
            );

            return itemToDS(item);
        } catch (error: unknown) {
            console.error('[DataSourceDynamoRepository] Error creating data source:', error);
            throw new Error(`Failed to create data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateDataSource(kbId: string, dsId: string, updates: Partial<DataSource>, _tenantId: string): Promise<void> {
        try {
            const expressionParts: string[] = ['#updatedAt = :updatedAt'];
            const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
            const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };

            const allowedFields = [
                'name',
                'status',
                'config',
                'vectorCount',
                'vectorKeys',
                'lastSyncAt',
                'lastSyncError',
            ] as const;

            for (const field of allowedFields) {
                if (updates[field] !== undefined) {
                    const placeholder = `:${field}`;
                    const nameAlias = `#${field}`;
                    expressionParts.push(`${nameAlias} = ${placeholder}`);
                    names[nameAlias] = field;
                    values[placeholder] = updates[field];
                }
            }

            await getDynamoDBDocumentClient().send(
                new UpdateCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
                    UpdateExpression: `SET ${expressionParts.join(', ')}`,
                    ExpressionAttributeNames: names,
                    ExpressionAttributeValues: values,
                }),
            );
        } catch (error: unknown) {
            console.error('[DataSourceDynamoRepository] Error updating data source:', error);
            throw new Error(`Failed to update data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async deleteDataSource(kbId: string, dsId: string, _tenantId: string): Promise<void> {
        try {
            await getDynamoDBDocumentClient().send(
                new DeleteCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
                }),
            );
        } catch (error: unknown) {
            console.error('[DataSourceDynamoRepository] Error deleting data source:', error);
            throw new Error(`Failed to delete data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
