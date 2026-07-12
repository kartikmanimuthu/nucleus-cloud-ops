/**
 * Knowledge Base Service
 *
 * Routes all persistence through the repository factory so the active
 * backend (DynamoDB or PostgreSQL) is controlled by USE_PG_KB env var.
 */

import { getKnowledgeBaseRepository, getDataSourceRepository } from '@/lib/db/repository-factory';
import type {
  KnowledgeBase,
  DataSource,
  CreateKBInput,
  CreateDataSourceInput,
  KnowledgeBaseStatus,
} from './types';

export class KnowledgeBaseService {
  static async listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]> {
    return getKnowledgeBaseRepository().listKnowledgeBases(tenantId);
  }

  static async getKnowledgeBase(kbId: string, tenantId: string): Promise<KnowledgeBase | null> {
    return getKnowledgeBaseRepository().getKnowledgeBase(kbId, tenantId);
  }

  static async createKnowledgeBase(
    data: CreateKBInput,
    tenantId: string,
    createdBy?: string,
  ): Promise<KnowledgeBase> {
    return getKnowledgeBaseRepository().createKnowledgeBase(data, tenantId, createdBy);
  }

  static async updateKnowledgeBase(
    kbId: string,
    data: Partial<CreateKBInput>,
    tenantId: string,
  ): Promise<void> {
    return getKnowledgeBaseRepository().updateKnowledgeBase(kbId, data, tenantId);
  }

  static async setKnowledgeBaseStatus(
    kbId: string,
    tenantId: string,
    status: KnowledgeBaseStatus,
  ): Promise<void> {
    return getKnowledgeBaseRepository().setKnowledgeBaseStatus(kbId, tenantId, status);
  }

  static async deleteKnowledgeBase(kbId: string, tenantId: string): Promise<void> {
    return getKnowledgeBaseRepository().deleteKnowledgeBase(kbId, tenantId);
  }

  static async updateDataSourceCount(kbId: string, delta: number, tenantId: string): Promise<void> {
    return getKnowledgeBaseRepository().updateDataSourceCount(kbId, delta, tenantId);
  }

  static async updateVectorCount(kbId: string, delta: number, tenantId: string): Promise<void> {
    return getKnowledgeBaseRepository().updateVectorCount(kbId, delta, tenantId);
  }

  // =========================================================================
  // Data Source CRUD
  // =========================================================================

  static async listDataSources(kbId: string, tenantId: string): Promise<DataSource[]> {
    return getDataSourceRepository().listDataSources(kbId, tenantId);
  }

  static async getDataSource(kbId: string, dsId: string, tenantId: string): Promise<DataSource | null> {
    return getDataSourceRepository().getDataSource(kbId, dsId, tenantId);
  }

  static async getDataSourceContent(kbId: string, dsId: string, tenantId: string): Promise<string | null> {
    return getDataSourceRepository().getDataSourceContent(kbId, dsId, tenantId);
  }

  static async createDataSource(
    kbId: string,
    data: CreateDataSourceInput,
    tenantId: string,
  ): Promise<DataSource> {
    return getDataSourceRepository().createDataSource(kbId, data, tenantId);
  }

  static async updateDataSource(
    kbId: string,
    dsId: string,
    updates: Partial<DataSource>,
    tenantId: string,
  ): Promise<void> {
    return getDataSourceRepository().updateDataSource(kbId, dsId, updates, tenantId);
  }

  static async deleteDataSource(kbId: string, dsId: string, tenantId: string): Promise<void> {
    return getDataSourceRepository().deleteDataSource(kbId, dsId, tenantId);
  }
}
