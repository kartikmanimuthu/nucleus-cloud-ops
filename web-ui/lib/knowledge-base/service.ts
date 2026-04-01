/**
 * Knowledge Base Service
 *
 * DynamoDB-backed CRUD for Knowledge Bases and Data Sources.
 * Follows the same single-table pattern as TenantConfigService.
 */

import { randomUUID } from 'crypto';
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME } from '../aws-config';
import type {
  KnowledgeBase,
  DataSource,
  CreateKBInput,
  CreateDataSourceInput,
} from './types';

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

const tenantPK = (tenantId: string) => `TENANT#${tenantId}`;
const kbSK = (kbId: string) => `KB#${kbId}`;
const kbPK = (kbId: string) => `KB#${kbId}`;
const dsSK = (dsId: string) => `DATASOURCE#${dsId}`;

// ---------------------------------------------------------------------------
// Knowledge Base CRUD
// ---------------------------------------------------------------------------

export class KnowledgeBaseService {
  // ---- List all KBs for a tenant ----------------------------------------
  static async listKnowledgeBases(
    tenantId: string,
  ): Promise<KnowledgeBase[]> {
    try {
      const command = new QueryCommand({
        TableName: APP_TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': tenantPK(tenantId),
          ':skPrefix': 'KB#',
        },
      });

      const response = await getDynamoDBDocumentClient().send(command);
      return (response.Items || []).map((item) => itemToKB(item, tenantId));
    } catch (error: unknown) {
      console.error('[KBService] Error listing knowledge bases:', error);
      throw new Error(`Failed to list knowledge bases: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Get a single KB ---------------------------------------------------
  static async getKnowledgeBase(
    kbId: string,
    tenantId: string,
  ): Promise<KnowledgeBase | null> {
    try {
      const command = new GetCommand({
        TableName: APP_TABLE_NAME,
        Key: { pk: tenantPK(tenantId), sk: kbSK(kbId) },
      });

      const response = await getDynamoDBDocumentClient().send(command);
      if (!response.Item) return null;
      return itemToKB(response.Item, tenantId);
    } catch (error: unknown) {
      console.error('[KBService] Error getting knowledge base:', error);
      throw new Error(`Failed to get knowledge base: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Create KB ---------------------------------------------------------
  static async createKnowledgeBase(
    data: CreateKBInput,
    tenantId: string,
    createdBy?: string,
  ): Promise<KnowledgeBase> {
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

      console.log(`[KBService] Created knowledge base "${data.name}" (${id})`);
      return itemToKB(item, tenantId);
    } catch (error: unknown) {
      console.error('[KBService] Error creating knowledge base:', error);
      throw new Error(`Failed to create knowledge base: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Update KB ---------------------------------------------------------
  static async updateKnowledgeBase(
    kbId: string,
    data: Partial<CreateKBInput>,
    tenantId: string,
  ): Promise<void> {
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

      console.log(`[KBService] Updated knowledge base ${kbId}`);
    } catch (error: unknown) {
      console.error('[KBService] Error updating knowledge base:', error);
      throw new Error(`Failed to update knowledge base: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Delete KB ---------------------------------------------------------
  /**
   * Delete a Knowledge Base record from DynamoDB.
   *
   * WARNING — cascade responsibility lies with the caller.
   * Before calling this method you MUST:
   *   1. `listDataSources(kbId)` to get all data sources.
   *   2. For each data source: call `deleteVectors(ds.vectorKeys)` (embedder)
   *      then `deleteDataSource(kbId, ds.id)`.
   * Skipping these steps will orphan DataSource records and S3 Vector entries.
   */
  static async deleteKnowledgeBase(
    kbId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      await getDynamoDBDocumentClient().send(
        new DeleteCommand({
          TableName: APP_TABLE_NAME,
          Key: { pk: tenantPK(tenantId), sk: kbSK(kbId) },
        }),
      );

      console.log(`[KBService] Deleted knowledge base ${kbId}`);
    } catch (error: unknown) {
      console.error('[KBService] Error deleting knowledge base:', error);
      throw new Error(`Failed to delete knowledge base: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Increment / decrement data source count ---------------------------
  static async updateDataSourceCount(
    kbId: string,
    delta: number,
    tenantId: string,
  ): Promise<void> {
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
      console.error('[KBService] Error updating data source count:', error);
      throw new Error(`Failed to update data source count: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Increment / decrement vector count --------------------------------
  static async updateVectorCount(
    kbId: string,
    delta: number,
    tenantId: string,
  ): Promise<void> {
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
      console.error('[KBService] Error updating vector count:', error);
      throw new Error(`Failed to update vector count: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // =========================================================================
  // Data Source CRUD
  // =========================================================================

  // ---- List data sources for a KB ----------------------------------------
  static async listDataSources(kbId: string): Promise<DataSource[]> {
    try {
      const command = new QueryCommand({
        TableName: APP_TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': kbPK(kbId),
          ':skPrefix': 'DATASOURCE#',
        },
      });

      const response = await getDynamoDBDocumentClient().send(command);
      return (response.Items || []).map((item) => itemToDS(item));
    } catch (error: unknown) {
      console.error('[KBService] Error listing data sources:', error);
      throw new Error(`Failed to list data sources: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Get a single data source ------------------------------------------
  static async getDataSource(
    kbId: string,
    dsId: string,
  ): Promise<DataSource | null> {
    try {
      const command = new GetCommand({
        TableName: APP_TABLE_NAME,
        Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
      });

      const response = await getDynamoDBDocumentClient().send(command);
      if (!response.Item) return null;
      return itemToDS(response.Item);
    } catch (error: unknown) {
      console.error('[KBService] Error getting data source:', error);
      throw new Error(`Failed to get data source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Create data source ------------------------------------------------
  static async createDataSource(
    kbId: string,
    data: CreateDataSourceInput,
  ): Promise<DataSource> {
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

      // Increment data source count on the parent KB
      // We don't know the tenantId here — the caller should handle that
      console.log(`[KBService] Created data source "${data.name}" (${id}) for KB ${kbId}`);
      return itemToDS(item);
    } catch (error: unknown) {
      console.error('[KBService] Error creating data source:', error);
      throw new Error(`Failed to create data source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Update data source ------------------------------------------------
  static async updateDataSource(
    kbId: string,
    dsId: string,
    updates: Partial<DataSource>,
  ): Promise<void> {
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

      console.log(`[KBService] Updated data source ${dsId}`);
    } catch (error: unknown) {
      console.error('[KBService] Error updating data source:', error);
      throw new Error(`Failed to update data source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Delete data source ------------------------------------------------
  static async deleteDataSource(
    kbId: string,
    dsId: string,
  ): Promise<void> {
    try {
      await getDynamoDBDocumentClient().send(
        new DeleteCommand({
          TableName: APP_TABLE_NAME,
          Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
        }),
      );

      console.log(`[KBService] Deleted data source ${dsId}`);
    } catch (error: unknown) {
      console.error('[KBService] Error deleting data source:', error);
      throw new Error(`Failed to delete data source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// DynamoDB item → typed object mappers
// ---------------------------------------------------------------------------

function itemToKB(item: Record<string, unknown>, tenantId: string): KnowledgeBase {
  return {
    id: item.id,
    tenantId: item.tenantId || tenantId,
    name: item.name,
    description: item.description,
    status: item.status || 'active',
    vectorCount: item.vectorCount ?? 0,
    dataSourceCount: item.dataSourceCount ?? 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    createdBy: item.createdBy,
  };
}

function itemToDS(item: Record<string, unknown>): DataSource {
  return {
    id: item.id,
    knowledgeBaseId: item.knowledgeBaseId,
    name: item.name,
    sourceType: item.sourceType,
    status: item.status || 'pending',
    config: item.config || {},
    vectorCount: item.vectorCount ?? 0,
    vectorKeys: item.vectorKeys || [],
    lastSyncAt: item.lastSyncAt,
    lastSyncError: item.lastSyncError,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
