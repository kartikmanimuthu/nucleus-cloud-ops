/**
 * IAccountRepository
 *
 * Contract for account persistence.
 * Implemented by AccountDynamoRepository and AccountPostgresRepository.
 * The feature flag USE_PG_ACCOUNTS controls which implementation is active.
 */
import type { PrismaRowFilter } from '@/lib/db/pg-config';
import type { UIAccount } from '@/lib/types';

export interface AccountFilters {
    searchTerm?: string;
    statusFilter?: string;     // 'all' | 'active' | 'inactive'
    connectionFilter?: string; // 'all' | 'connected' | 'error' | 'warning' | 'unknown'
    page?: number;
    limit?: number;
    tenantId?: string;
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
}

export interface AccountPage {
    accounts: UIAccount[];
    totalCount: number;
}

export interface IAccountRepository {
    getAccounts(filters: AccountFilters): Promise<AccountPage>;
    getAccount(accountId: string, tenantId: string): Promise<UIAccount | null>;
    createAccount(account: Omit<UIAccount, 'id'>, tenantId: string): Promise<UIAccount>;
    updateAccount(
        accountId: string,
        updates: Partial<Omit<UIAccount, 'id' | 'accountId'>>,
        tenantId: string
    ): Promise<UIAccount>;
    deleteAccount(accountId: string, tenantId: string): Promise<void>;
}
