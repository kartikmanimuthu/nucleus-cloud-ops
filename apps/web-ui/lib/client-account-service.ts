// Client-safe account service that uses API routes instead of direct AWS SDK calls
import { UIAccount, AccountMetadata } from './types';

export class ClientAccountService {
    private static baseUrl = '/api/accounts';

    /**
     * Fetch all accounts via API route
     */
    static async getAccounts(filters?: {
        statusFilter?: string;
        connectionFilter?: string;
        searchTerm?: string;
        limit?: number;
        page?: number;
    }): Promise<{ accounts: UIAccount[], totalCount: number }> {
        try {
            console.log('ClientAccountService - Fetching accounts via API route', filters);

            // Build query parameters
            const params = new URLSearchParams();
            if (filters?.statusFilter) {
                params.append('status', filters.statusFilter);
            }
            if (filters?.connectionFilter) {
                params.append('connection', filters.connectionFilter);
            }
            if (filters?.searchTerm) {
                params.append('search', filters.searchTerm);
            }
            if (filters?.limit) {
                params.append('limit', filters.limit.toString());
            }
            if (filters?.page) {
                params.append('page', filters.page.toString());
            }

            const url = params.toString() ? `${this.baseUrl}?${params.toString()}` : this.baseUrl;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch accounts');
            }

            console.log('ClientAccountService - Successfully fetched accounts:', result.data.length);
            return {
                accounts: result.data,
                totalCount: result.totalCount || 0
            };
        } catch (error) {
            console.error('ClientAccountService - Error fetching accounts:', error);
            throw error;
        }
    }

    /**
     * Fetch account by ID via API route
     */
    static async getAccount(accountId: string): Promise<UIAccount | null> {
        try {
            console.log('ClientAccountService - Fetching account by ID via API route:', accountId);

            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(accountId)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (response.status === 404) {
                console.log('ClientAccountService - Account not found:', accountId);
                return null;
            }

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch account');
            }

            console.log('ClientAccountService - Successfully fetched account:', accountId);
            return result.data;
        } catch (error) {
            console.error('ClientAccountService - Error fetching account:', error);
            throw error;
        }
    }

    /**
     * Create a new account via API route
     */
    static async createAccount(accountData: {
        name: string;
        accountId: string;
        roleArn: string;
        externalId?: string;
        regions: string[];
        active: boolean;
        description?: string;
        createdBy?: string;
        updatedBy?: string;
    }): Promise<void> {
        try {
            console.log('ClientAccountService - Creating account via API route');

            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(accountData),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to create account');
            }

            console.log('ClientAccountService - Successfully created account');
        } catch (error) {
            console.error('ClientAccountService - Error creating account:', error);
            throw error;
        }
    }

    /**
     * Update an account via API route
     */
    static async updateAccount(accountId: string, updateData: Partial<{
        name: string;
        roleArn: string;
        regions: string[];
        active: boolean;
        description?: string;
        createdBy?: string;
        updatedBy?: string;
    }>): Promise<void> {
        try {
            console.log('ClientAccountService - Updating account via API route:', accountId);

            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(accountId)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(updateData),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to update account');
            }

            console.log('ClientAccountService - Successfully updated account:', accountId);
        } catch (error) {
            console.error('ClientAccountService - Error updating account:', error);
            throw error;
        }
    }

    /**
     * Delete an account via API route
     */
    static async deleteAccount(accountId: string): Promise<void> {
        try {
            console.log('ClientAccountService - Deleting account via API route:', accountId);

            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(accountId)}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to delete account');
            }

            console.log('ClientAccountService - Successfully deleted account:', accountId);
        } catch (error) {
            console.error('ClientAccountService - Error deleting account:', error);
            throw error;
        }
    }

    /**
     * Validate account connection via API route
     */
    static async validateAccount(accountData: {
        accountId: string;
        region: string;
        roleArn?: string;
        externalId?: string;
    }): Promise<{ isValid: boolean; error?: string }> {
        try {
            console.log('ClientAccountService - Validating account via API route');

            let url = `${this.baseUrl}/${encodeURIComponent(accountData.accountId)}/validate`;
            let body = {};

            // If we have credentials, use the global validation endpoint (for Create/Edit forms with unsaved changes)
            if (accountData.roleArn) {
                console.log('ClientAccountService - Using Global Validation Endpoint with provided credentials');
                url = `${this.baseUrl}/validate`; // /api/accounts/validate
                body = {
                    accountId: accountData.accountId,
                    roleArn: accountData.roleArn,
                    externalId: accountData.externalId,
                    region: accountData.region
                };
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            const result = await response.json();

            if (!response.ok) {
                return {
                    isValid: false,
                    error: result.error || `HTTP error! status: ${response.status}`
                };
            }

            console.log('ClientAccountService - Account validation result raw:', result);

            // If the response follows the persistent endpoint structure
            if (result.valid !== undefined) {
                return {
                    isValid: result.valid,
                    error: result.data?.connectionError !== 'None' ? result.data?.connectionError : undefined
                };
            }

            // Fallback for global/ephemeral endpoint structure
            return result.data || { isValid: false, error: 'Unknown validation error' };
        } catch (error) {
            console.error('ClientAccountService - Error validating account:', error);
            return {
                isValid: false,
                error: error instanceof Error ? error.message : 'Validation failed'
            };
        }
    }
    /**
     * Scan resources for an account via API route
     */
    static async scanResources(accountId: string): Promise<Array<{ id: string; type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb'; name: string; arn: string }>> {
        try {
            console.log('ClientAccountService - Scanning resources for account:', accountId);
            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(accountId)}/scan`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to scan resources');
            }

            console.log('ClientAccountService - Successfully scanned resources:', result.data.length);
            return result.data;
        } catch (error) {
            console.error('ClientAccountService - Error scanning resources:', error);
            throw error;
        }
    }
}
