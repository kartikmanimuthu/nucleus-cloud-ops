/**
 * IDataSourceRepository
 *
 * Contract for data source persistence.
 * Implemented by DataSourceDynamoRepository and DataSourcePostgresRepository.
 * The feature flag USE_PG_KB controls which implementation is active (same flag as KB — they're a unit).
 */
import type { DataSource, CreateDataSourceInput } from '@/lib/knowledge-base/types';

export interface IDataSourceRepository {
    listDataSources(kbId: string, tenantId: string): Promise<DataSource[]>;
    getDataSource(kbId: string, dsId: string, tenantId: string): Promise<DataSource | null>;
    createDataSource(kbId: string, data: CreateDataSourceInput, tenantId: string): Promise<DataSource>;
    updateDataSource(kbId: string, dsId: string, updates: Partial<DataSource>, tenantId: string): Promise<void>;
    deleteDataSource(kbId: string, dsId: string, tenantId: string): Promise<void>;
    getDataSourceContent(kbId: string, dsId: string, tenantId: string): Promise<string | null>;
}
