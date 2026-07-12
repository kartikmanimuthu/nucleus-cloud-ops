/**
 * IKnowledgeBaseRepository
 *
 * Contract for knowledge base persistence.
 * Implemented by KnowledgeBasePostgresRepository.
 */
import type { KnowledgeBase, CreateKBInput, KnowledgeBaseStatus } from '@/lib/knowledge-base/types';

export interface IKnowledgeBaseRepository {
    listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]>;
    getKnowledgeBase(kbId: string, tenantId: string): Promise<KnowledgeBase | null>;
    createKnowledgeBase(data: CreateKBInput, tenantId: string, createdBy?: string): Promise<KnowledgeBase>;
    updateKnowledgeBase(kbId: string, data: Partial<CreateKBInput>, tenantId: string): Promise<void>;
    deleteKnowledgeBase(kbId: string, tenantId: string): Promise<void>;
    updateDataSourceCount(kbId: string, delta: number, tenantId: string): Promise<void>;
    updateVectorCount(kbId: string, delta: number, tenantId: string): Promise<void>;
    setKnowledgeBaseStatus(kbId: string, tenantId: string, status: KnowledgeBaseStatus): Promise<void>;
}
