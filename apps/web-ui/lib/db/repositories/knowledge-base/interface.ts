/**
 * IKnowledgeBaseRepository
 *
 * Contract for knowledge base persistence.
 * Implemented by KnowledgeBasePostgresRepository.
 */
import type { PrismaRowFilter } from '@/lib/db/pg-config';
import type { KnowledgeBase, CreateKBInput, KnowledgeBaseStatus } from '@/lib/knowledge-base/types';

export interface IKnowledgeBaseRepository {
    /**
     * @param rowFilter Gate 3 (RBAC row filtering): a Prisma `where` fragment
     * restricting the result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    listKnowledgeBases(tenantId: string, rowFilter?: PrismaRowFilter | null): Promise<KnowledgeBase[]>;
    getKnowledgeBase(kbId: string, tenantId: string): Promise<KnowledgeBase | null>;
    createKnowledgeBase(data: CreateKBInput, tenantId: string, createdBy?: string): Promise<KnowledgeBase>;
    updateKnowledgeBase(kbId: string, data: Partial<CreateKBInput>, tenantId: string): Promise<void>;
    deleteKnowledgeBase(kbId: string, tenantId: string): Promise<void>;
    updateDataSourceCount(kbId: string, delta: number, tenantId: string): Promise<void>;
    updateVectorCount(kbId: string, delta: number, tenantId: string): Promise<void>;
    setKnowledgeBaseStatus(kbId: string, tenantId: string, status: KnowledgeBaseStatus): Promise<void>;
}
