/**
 * IKnowledgeBaseRepository
 *
 * Contract for knowledge base persistence.
 * Implemented by KnowledgeBaseDynamoRepository and KnowledgeBasePostgresRepository.
 * The feature flag USE_PG_KB controls which implementation is active.
 */
import type { KnowledgeBase, CreateKBInput } from '@/lib/knowledge-base/types';

export interface IKnowledgeBaseRepository {
    listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]>;
    getKnowledgeBase(kbId: string, tenantId: string): Promise<KnowledgeBase | null>;
    createKnowledgeBase(data: CreateKBInput, tenantId: string, createdBy?: string): Promise<KnowledgeBase>;
    updateKnowledgeBase(kbId: string, data: Partial<CreateKBInput>, tenantId: string): Promise<void>;
    deleteKnowledgeBase(kbId: string, tenantId: string): Promise<void>;
    updateDataSourceCount(kbId: string, delta: number, tenantId: string): Promise<void>;
    updateVectorCount(kbId: string, delta: number, tenantId: string): Promise<void>;
}
