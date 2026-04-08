/**
 * DataSourcePostgresRepository
 *
 * PostgreSQL implementation of IDataSourceRepository using Prisma ORM.
 * Reads/writes the `data_sources` table (defined in prisma/schema.prisma).
 *
 * Multi-tenant safety: every query is scoped by tenantId.
 */
import { getTenantClient } from '@/lib/db/pg-config';
import type { DataSource, CreateDataSourceInput } from '@/lib/knowledge-base/types';
import type { IDataSourceRepository } from './interface';

function rowToDS(row: {
    id: string;
    tenantId: string;
    knowledgeBaseId: string;
    name: string;
    sourceType: string;
    status: string;
    config: unknown;
    vectorCount: number;
    vectorKeys: string[];
    lastSyncAt: Date | null;
    lastSyncError: string | null;
    lastErrorMessage: string | null;
    lastErrorDetail: string | null;
    createdAt: Date;
    updatedAt: Date;
}): DataSource {
    return {
        id: row.id,
        knowledgeBaseId: row.knowledgeBaseId,
        name: row.name,
        sourceType: row.sourceType as DataSource['sourceType'],
        status: row.status as DataSource['status'],
        config: row.config as DataSource['config'],
        vectorCount: row.vectorCount,
        vectorKeys: row.vectorKeys,
        lastSyncAt: row.lastSyncAt?.toISOString(),
        lastSyncError: row.lastSyncError ?? undefined,
        lastErrorMessage: row.lastErrorMessage ?? undefined,
        lastErrorDetail: row.lastErrorDetail ?? undefined,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export class DataSourcePostgresRepository implements IDataSourceRepository {
    async listDataSources(kbId: string, tenantId: string): Promise<DataSource[]> {
        try {
            const rows = await getTenantClient(tenantId).dataSource.findMany({
                where: { knowledgeBaseId: kbId, tenantId },
                orderBy: { createdAt: 'asc' },
            });
            return rows.map(rowToDS);
        } catch (error: unknown) {
            console.error('[DataSourcePostgresRepository] Error listing data sources:', error);
            throw new Error(`Failed to list data sources: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async getDataSource(kbId: string, dsId: string, tenantId: string): Promise<DataSource | null> {
        try {
            const row = await getTenantClient(tenantId).dataSource.findFirst({
                where: { id: dsId, knowledgeBaseId: kbId, tenantId },
            });
            if (!row) return null;
            return rowToDS(row);
        } catch (error: unknown) {
            console.error('[DataSourcePostgresRepository] Error getting data source:', error);
            throw new Error(`Failed to get data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async createDataSource(kbId: string, data: CreateDataSourceInput, tenantId: string): Promise<DataSource> {
        try {
            const row = await getTenantClient(tenantId).dataSource.create({
                data: {
                    tenantId,
                    knowledgeBaseId: kbId,
                    name: data.name,
                    sourceType: data.sourceType,
                    status: 'pending',
                    config: data.config as object,
                    vectorCount: 0,
                    vectorKeys: [],
                },
            });
            return rowToDS(row);
        } catch (error: unknown) {
            console.error('[DataSourcePostgresRepository] Error creating data source:', error);
            throw new Error(`Failed to create data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateDataSource(kbId: string, dsId: string, updates: Partial<DataSource>, tenantId: string): Promise<void> {
        try {
            const allowedFields = [
                'name',
                'status',
                'config',
                'vectorCount',
                'vectorKeys',
                'lastSyncAt',
                'lastSyncError',
                'lastErrorMessage',
                'lastErrorDetail',
            ] as const;

            const data: Record<string, unknown> = {};
            for (const field of allowedFields) {
                if (updates[field] !== undefined) {
                    if (field === 'lastSyncAt' && typeof updates[field] === 'string') {
                        data[field] = new Date(updates[field] as string);
                    } else {
                        data[field] = updates[field];
                    }
                }
            }

            await getTenantClient(tenantId).dataSource.updateMany({
                where: { id: dsId, knowledgeBaseId: kbId, tenantId },
                data,
            });
        } catch (error: unknown) {
            console.error('[DataSourcePostgresRepository] Error updating data source:', error);
            throw new Error(`Failed to update data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async deleteDataSource(kbId: string, dsId: string, tenantId: string): Promise<void> {
        try {
            await getTenantClient(tenantId).dataSource.deleteMany({
                where: { id: dsId, knowledgeBaseId: kbId, tenantId },
            });
        } catch (error: unknown) {
            console.error('[DataSourcePostgresRepository] Error deleting data source:', error);
            throw new Error(`Failed to delete data source: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
