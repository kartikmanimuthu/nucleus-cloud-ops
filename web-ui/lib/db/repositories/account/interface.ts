/**
 * IAccountRepository
 *
 * Contract for account persistence.
 * Implemented by AccountDynamoRepository and AccountPostgresRepository.
 * The feature flag USE_PG_ACCOUNTS controls which implementation is active.
 */
import type { UIAccount } from '@/lib/types';

export interface AccountFilters {
    searchTerm?: string;
    statusFilter?: string;     // 'all' | 'active' | 'inactive'
    connectionFilter?: string; // 'all' | 'connected' | 'error' | 'warning' | 'unknown'
    page?: number;
    limit?: number;
    tenantId?: string;
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
