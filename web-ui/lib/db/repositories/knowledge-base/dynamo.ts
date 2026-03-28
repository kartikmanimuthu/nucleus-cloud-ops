/**
 * KnowledgeBaseDynamoRepository
 *
 * DynamoDB implementation of IKnowledgeBaseRepository.
 * Logic extracted from KnowledgeBaseService static class.
 *
 * DynamoDB single-table access pattern:
 *   PK = TENANT#<tenantId>
 *   SK = KB#<kbId>
 *   GSI1: gsi1pk = TYPE#KNOWLEDGE_BASE
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
import type { KnowledgeBase, CreateKBInput } from '@/lib/knowledge-base/types';
import type { IKnowledgeBaseRepository } from './interface';

const tenantPK = (tenantId: string) => `TENANT#${tenantId}`;
const kbSK = (kbId: string) => `KB#${kbId}`;

function itemToKB(item: Record<string, unknown>, tenantId: string): KnowledgeBase {
    return {
        id: item.id as string,
        tenantId: (item.tenantId as string) || tenantId,
        name: item.name as string,
        description: item.description as string | undefined,
        status: (item.status as KnowledgeBase['status']) || 'active',
        vectorCount: (item.vectorCount as number) ?? 0,
        dataSourceCount: (item.dataSourceCount as number) ?? 0,
        createdAt: item.createdAt as string,
        updatedAt: item.updatedAt as string,
        createdBy: item.createdBy as string | undefined,
    };
}

export class KnowledgeBaseDynamoRepository implements IKnowledgeBaseRepository {
    async listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]> {
        try {
            const response = await getDynamoDBDocumentClient().send(
                new QueryCommand({
                    TableName: APP_TABLE_NAME,
                    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
                    ExpressionAttributeValues: {
                        ':pk': tenantPK(tenantId),
                        ':skPrefix': 'KB#',
                    },
                }),
            );
            return (response.Items || []).map((item) => itemToKB(item as Record<string, unknown>, tenantId));
        } catch (error: unknown) {
            console.error('[KnowledgeBaseDynamoRepository] Error listing knowledge bases:', error);
            throw new Error(`Failed to list knowledge bases: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async getKnowledgeBase(kbId: string, tenantId: string): Promise<KnowledgeBase | null> {
        try {
            const response = await getDynamoDBDocumentClient().send(
                new GetCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: tenantPK(tenantId), sk: kbSK(kbId) },
                }),
            );
            if (!response.Item) return null;
            return itemToKB(response.Item as Record<string, unknown>, tenantId);
        } catch (error: unknown) {
            console.error('[KnowledgeBaseDynamoRepository] Error getting knowledge base:', error);
            throw new Error(`Failed to get knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async createKnowledgeBase(data: CreateKBInput, tenantId: string, createdBy?: string): Promise<KnowledgeBase> {
        try {
            const id = randomUUID();
            const now = new Date().toISOString();

            const item = {
                pk: tenantPK(tenantId),
                sk: kbSK(id),
                gsi1pk: 'TYPE#KNOWLEDGE_BASE',
                gsi1sk: data.name,
                type: 'knowledge_base',
                id,
                tenantId,
                name: data.name,
                description: data.description,
                status: 'active' as const,
                vectorCount: 0,
                dataSourceCount: 0,
                createdAt: now,
                updatedAt: now,
                createdBy,
            };

            await getDynamoDBDocumentClient().send(
                new PutCommand({ TableName: APP_TABLE_NAME, Item: item }),
            );

            return itemToKB(item, tenantId);
        } catch (error: unknown) {
            console.error('[KnowledgeBaseDynamoRepository] Error creating knowledge base:', error);
            throw new Error(`Failed to create knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateKnowledgeBase(kbId: string, data: Partial<CreateKBInput>, tenantId: string): Promise<void> {
        try {
            const expressionParts: string[] = ['#updatedAt = :updatedAt'];
            const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
            const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };

            if (data.name !== undefined) {
                expressionParts.push('#name = :name');
                names['#name'] = 'name';
                values[':name'] = data.name;
            }
            if (data.description !== undefined) {
                expressionParts.push('#description = :description');
                names['#description'] = 'description';
                values[':description'] = data.description;
            }

            await getDynamoDBDocumentClient().send(
                new UpdateCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: tenantPK(tenantId), sk: kbSK(kbId) },
                    UpdateExpression: `SET ${expressionParts.join(', ')}`,
                    ExpressionAttributeNames: names,
                    ExpressionAttributeValues: values,
                }),
            );
        } catch (error: unknown) {
            console.error('[KnowledgeBaseDynamoRepository] Error updating knowledge base:', error);
            throw new Error(`Failed to update knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async deleteKnowledgeBase(kbId: string, tenantId: string): Promise<void> {
        try {
            await getDynamoDBDocumentClient().send(
                new DeleteCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: tenantPK(tenantId), sk: kbSK(kbId) },
                }),
            );
        } catch (error: unknown) {
            console.error('[KnowledgeBaseDynamoRepository] Error deleting knowledge base:', error);
            throw new Error(`Failed to delete knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateDataSourceCount(kbId: string, delta: number, tenantId: string): Promise<void> {
        try {
            await getDynamoDBDocumentClient().send(
                new UpdateCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: tenantPK(tenantId), sk: kbSK(kbId) },
                    UpdateExpression:
                        'SET dataSourceCount = if_not_exists(dataSourceCount, :zero) + :delta, #updatedAt = :now',
                    ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
                    ExpressionAttributeValues: {
                        ':delta': delta,
                        ':zero': 0,
                        ':now': new Date().toISOString(),
                    },
                }),
            );
        } catch (error: unknown) {
            console.error('[KnowledgeBaseDynamoRepository] Error updating data source count:', error);
            throw new Error(`Failed to update data source count: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateVectorCount(kbId: string, delta: number, tenantId: string): Promise<void> {
        try {
            await getDynamoDBDocumentClient().send(
                new UpdateCommand({
                    TableName: APP_TABLE_NAME,
                    Key: { pk: tenantPK(tenantId), sk: kbSK(kbId) },
                    UpdateExpression:
                        'SET vectorCount = if_not_exists(vectorCount, :zero) + :delta, #updatedAt = :now',
                    ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
                    ExpressionAttributeValues: {
                        ':delta': delta,
                        ':zero': 0,
                        ':now': new Date().toISOString(),
                    },
                }),
            );
        } catch (error: unknown) {
            console.error('[KnowledgeBaseDynamoRepository] Error updating vector count:', error);
            throw new Error(`Failed to update vector count: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
