/**
 * KnowledgeBasePostgresRepository
 *
 * PostgreSQL implementation of IKnowledgeBaseRepository using Prisma ORM.
 * Reads/writes the `knowledge_bases` table (defined in libs/prisma/schema.prisma).
 *
 * Multi-tenant safety: every query is scoped by tenantId.
 * Atomic counter updates use Prisma increment/decrement (no read-modify-write).
 */
import { getTenantClient } from '@/lib/db/pg-config';
import type { KnowledgeBase, CreateKBInput, KnowledgeBaseStatus } from '@/lib/knowledge-base/types';
import type { IKnowledgeBaseRepository } from './interface';

function rowToKB(row: {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    status: string;
    vectorCount: number;
    dataSourceCount: number;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string | null;
}): KnowledgeBase {
    return {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        description: row.description ?? undefined,
        status: row.status as KnowledgeBase['status'],
        vectorCount: row.vectorCount,
        dataSourceCount: row.dataSourceCount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        createdBy: row.createdBy ?? undefined,
    };
}

export class KnowledgeBasePostgresRepository implements IKnowledgeBaseRepository {
    async listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]> {
        try {
            const rows = await getTenantClient(tenantId).knowledgeBase.findMany({
                where: { tenantId },
                orderBy: { createdAt: 'desc' },
            });
            return rows.map(rowToKB);
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error listing knowledge bases:', error);
            throw new Error(`Failed to list knowledge bases: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async getKnowledgeBase(kbId: string, tenantId: string): Promise<KnowledgeBase | null> {
        try {
            const row = await getTenantClient(tenantId).knowledgeBase.findFirst({
                where: { id: kbId, tenantId },
            });
            if (!row) return null;
            return rowToKB(row);
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error getting knowledge base:', error);
            throw new Error(`Failed to get knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async createKnowledgeBase(data: CreateKBInput, tenantId: string, createdBy?: string): Promise<KnowledgeBase> {
        try {
            const row = await getTenantClient(tenantId).knowledgeBase.create({
                data: {
                    tenantId,
                    name: data.name,
                    description: data.description,
                    status: 'active',
                    vectorCount: 0,
                    dataSourceCount: 0,
                    createdBy: createdBy ?? null,
                },
            });
            return rowToKB(row);
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error creating knowledge base:', error);
            throw new Error(`Failed to create knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateKnowledgeBase(kbId: string, data: Partial<CreateKBInput>, tenantId: string): Promise<void> {
        try {
            await getTenantClient(tenantId).knowledgeBase.updateMany({
                where: { id: kbId, tenantId },
                data: {
                    ...(data.name !== undefined && { name: data.name }),
                    ...(data.description !== undefined && { description: data.description }),
                },
            });
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error updating knowledge base:', error);
            throw new Error(`Failed to update knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async setKnowledgeBaseStatus(kbId: string, tenantId: string, status: KnowledgeBaseStatus): Promise<void> {
        try {
            await getTenantClient(tenantId).knowledgeBase.updateMany({
                where: { id: kbId, tenantId },
                data: { status },
            });
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error setting knowledge base status:', error);
            throw new Error(`Failed to set knowledge base status: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async deleteKnowledgeBase(kbId: string, tenantId: string): Promise<void> {
        try {
            await getTenantClient(tenantId).knowledgeBase.deleteMany({
                where: { id: kbId, tenantId },
            });
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error deleting knowledge base:', error);
            throw new Error(`Failed to delete knowledge base: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateDataSourceCount(kbId: string, delta: number, tenantId: string): Promise<void> {
        try {
            await getTenantClient(tenantId).knowledgeBase.updateMany({
                where: { id: kbId, tenantId },
                data: { dataSourceCount: { increment: delta } },
            });
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error updating data source count:', error);
            throw new Error(`Failed to update data source count: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async updateVectorCount(kbId: string, delta: number, tenantId: string): Promise<void> {
        try {
            await getTenantClient(tenantId).knowledgeBase.updateMany({
                where: { id: kbId, tenantId },
                data: { vectorCount: { increment: delta } },
            });
        } catch (error: unknown) {
            console.error('[KnowledgeBasePostgresRepository] Error updating vector count:', error);
            throw new Error(`Failed to update vector count: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
