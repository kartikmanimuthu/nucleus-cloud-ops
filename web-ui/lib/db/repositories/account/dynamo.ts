/**
 * AccountDynamoRepository
 *
 * DynamoDB implementation of IAccountRepository.
 * Logic extracted from the original AccountService static class.
 *
 * DynamoDB single-table access pattern:
 *   PK = TENANT#<tenantId>
 *   SK = ACCOUNT#<accountId>
 *   GSI1: gsi1pk = TYPE#ACCOUNT (list all accounts)
 *
 * Note: getAccounts preserves the existing GSI1 query + client-side filter pattern
 * to maintain identical DynamoDB path behaviour.
 * Audit logging is NOT included — that belongs in the service layer (account-service.ts).
 */
import { PutCommand, DeleteCommand, UpdateCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, DEFAULT_TENANT_ID } from '@/lib/aws-config';
import type { UIAccount } from '@/lib/types';
import type { IAccountRepository, AccountFilters, AccountPage } from './interface';

const buildAccountPK = (tenantId: string) => `TENANT#${tenantId}`;
const buildAccountSK = (accountId: string) => `ACCOUNT#${accountId}`;

export class AccountDynamoRepository implements IAccountRepository {
    async getAccounts(filters: AccountFilters): Promise<AccountPage> {
        try {
            const {
                searchTerm,
                statusFilter,
                connectionFilter,
                page = 1,
                limit = 10,
            } = filters;

            console.log('[AccountDynamoRepository] Fetching accounts from DynamoDB', filters);

            // Fetch ALL accounts using recursive GSI1 pagination
            let allAccounts: UIAccount[] = [];
            let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

            do {
                const fetchCommand = new QueryCommand({
                    TableName: APP_TABLE_NAME,
                    IndexName: 'GSI1',
                    KeyConditionExpression: 'gsi1pk = :pkVal',
                    ExpressionAttributeValues: {
                        ':pkVal': 'TYPE#ACCOUNT',
                    },
                    ExclusiveStartKey: lastEvaluatedKey,
                });
                const fetchResponse = await getDynamoDBDocumentClient().send(fetchCommand) as {
                    Items?: Record<string, unknown>[];
                    LastEvaluatedKey?: Record<string, unknown>;
                };
                const pageAccounts = (fetchResponse.Items || []).map((item) =>
                    this.transformToUIAccount(item)
                );
                allAccounts = allAccounts.concat(pageAccounts);
                lastEvaluatedKey = fetchResponse.LastEvaluatedKey;
            } while (lastEvaluatedKey);

            console.log('[AccountDynamoRepository] Fetched all accounts:', allAccounts.length);

            // Apply filters in memory (preserving existing DynamoDB path behaviour)
            let filteredAccounts = allAccounts;

            if (searchTerm && searchTerm.trim() !== '') {
                const term = searchTerm.toLowerCase();
                filteredAccounts = filteredAccounts.filter(
                    (account) =>
                        account.name.toLowerCase().includes(term) ||
                        account.accountId.toLowerCase().includes(term) ||
                        (account.description && account.description.toLowerCase().includes(term)) ||
                        (account.createdBy && account.createdBy.toLowerCase().includes(term))
                );
            }

            if (statusFilter && statusFilter !== 'all') {
                const isActive = statusFilter === 'active';
                filteredAccounts = filteredAccounts.filter((account) => account.active === isActive);
            }

            if (connectionFilter && connectionFilter !== 'all') {
                filteredAccounts = filteredAccounts.filter(
                    (account) => account.connectionStatus === connectionFilter
                );
            }

            const totalCount = filteredAccounts.length;

            // Apply pagination on filtered results
            const startIndex = (page - 1) * limit;
            const paginatedAccounts = filteredAccounts.slice(startIndex, startIndex + limit);

            return { accounts: paginatedAccounts, totalCount };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountDynamoRepository] Error fetching accounts:', error);
            throw new Error(`Failed to get accounts: ${msg}`);
        }
    }

    async getAccount(accountId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount | null> {
        try {
            const command = new GetCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildAccountPK(tenantId),
                    sk: buildAccountSK(accountId),
                },
            });
            const response = await getDynamoDBDocumentClient().send(command);
            if (!response.Item) return null;
            return this.transformToUIAccount(response.Item);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountDynamoRepository] Error fetching account:', error);
            throw new Error(`Failed to get account: ${msg}`);
        }
    }

    async createAccount(account: Omit<UIAccount, 'id'>, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount> {
        try {
            const now = new Date().toISOString();
            const statusText = account.active ? 'active' : 'inactive';

            const dbItem = {
                pk: buildAccountPK(tenantId),
                sk: buildAccountSK(account.accountId),
                gsi1pk: 'TYPE#ACCOUNT',
                gsi1sk: account.accountId,
                gsi2pk: `ACCOUNT#${account.accountId}`,
                gsi2sk: `ACCOUNT#${account.accountId}`,
                gsi3pk: `STATUS#${statusText}`,
                gsi3sk: `TENANT#${tenantId}#ACCOUNT#${account.accountId}`,
                type: 'account',
                tenantId,
                accountId: account.accountId,
                accountName: account.name,
                roleArn: account.roleArn,
                externalId: account.externalId,
                regions: account.regions,
                active: account.active,
                description: account.description,
                connectionStatus: 'unknown',
                createdAt: now,
                updatedAt: now,
                createdBy: account.createdBy || 'system',
                updatedBy: account.updatedBy || 'system',
            };

            const command = new PutCommand({
                TableName: APP_TABLE_NAME,
                Item: dbItem,
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            });

            await getDynamoDBDocumentClient().send(command);
            return this.transformToUIAccount(dbItem);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountDynamoRepository] Error creating account:', error);
            if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
                throw new Error('Account with this ID already exists');
            }
            throw new Error(`Failed to create account: ${msg}`);
        }
    }

    async updateAccount(
        accountId: string,
        updates: Partial<Omit<UIAccount, 'id' | 'accountId'>>,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<UIAccount> {
        try {
            const now = new Date().toISOString();

            const updateExpressions: string[] = [];
            const expressionAttributeNames: Record<string, string> = {};
            const expressionAttributeValues: Record<string, unknown> = {};

            const fieldMapping: Record<string, string> = {
                name: 'accountName',
                roleArn: 'roleArn',
                externalId: 'externalId',
                active: 'active',
                description: 'description',
                connectionStatus: 'connectionStatus',
                connectionError: 'connectionError',
                updatedBy: 'updatedBy',
                regions: 'regions',
                lastValidated: 'updatedAt',
            };

            Object.entries(updates).forEach(([key, value]) => {
                const dbField = fieldMapping[key] || key;
                if (value !== undefined && key !== 'id' && key !== 'accountId') {
                    if (key === 'name') {
                        updateExpressions.push('#gsi1sk = :gsi1sk');
                        expressionAttributeNames['#gsi1sk'] = 'gsi1sk';
                        expressionAttributeValues[':gsi1sk'] = value;
                    }
                    if (key === 'active') {
                        const statusText = value ? 'active' : 'inactive';
                        updateExpressions.push('#gsi3pk = :gsi3pk');
                        expressionAttributeNames['#gsi3pk'] = 'gsi3pk';
                        expressionAttributeValues[':gsi3pk'] = `STATUS#${statusText}`;
                    }
                    updateExpressions.push(`#${dbField} = :${dbField}`);
                    expressionAttributeNames[`#${dbField}`] = dbField;
                    expressionAttributeValues[`:${dbField}`] = value;
                }
            });

            if (updateExpressions.length === 0) {
                const existing = await this.getAccount(accountId, tenantId);
                if (!existing) throw new Error(`Account ${accountId} not found`);
                return existing;
            }

            if (!updateExpressions.some((e) => e.includes('#updatedAt'))) {
                updateExpressions.push('#updatedAt = :updatedAt');
                expressionAttributeNames['#updatedAt'] = 'updatedAt';
                expressionAttributeValues[':updatedAt'] = now;
            }

            const command = new UpdateCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildAccountPK(tenantId),
                    sk: buildAccountSK(accountId),
                },
                UpdateExpression: `SET ${updateExpressions.join(', ')}`,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
                ReturnValues: 'ALL_NEW',
            });

            const response = await getDynamoDBDocumentClient().send(command);
            return this.transformToUIAccount(response.Attributes as Record<string, unknown>);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountDynamoRepository] Error updating account:', error);
            throw new Error(`Failed to update account: ${msg}`);
        }
    }

    async deleteAccount(accountId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<void> {
        try {
            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildAccountPK(tenantId),
                    sk: buildAccountSK(accountId),
                },
            });
            await getDynamoDBDocumentClient().send(command);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountDynamoRepository] Error deleting account:', error);
            throw new Error(`Failed to delete account: ${msg}`);
        }
    }

    private transformToUIAccount(item: Record<string, unknown>): UIAccount {
        return {
            id: (item.accountId as string) || (item.sk as string | undefined)?.replace('ACCOUNT#', '') || '',
            accountId: (item.accountId as string) || (item.sk as string | undefined)?.replace('ACCOUNT#', '') || '',
            name: (item.accountName as string) || (item.account_name as string) || (item.gsi1sk as string) || '',
            roleArn: (item.roleArn as string) || (item.role_arn as string) || '',
            externalId: (item.externalId as string | undefined) || (item.external_id as string | undefined),
            regions: (item.regions as string[]) || [],
            active: item.active as boolean,
            description: (item.description as string) || '',
            connectionStatus: (item.connectionStatus as UIAccount['connectionStatus']) ||
                (item.connection_status as UIAccount['connectionStatus']) ||
                'unknown',
            connectionError: (item.connectionError as string | undefined) || (item.connection_error as string | undefined),
            lastValidated: (item.updatedAt as string | undefined) || (item.updated_at as string | undefined),
            resourceCount: 0,
            schedulesCount: 0,
            monthlySavings: 0,
            createdAt: (item.createdAt as string | undefined) || (item.created_at as string | undefined),
            updatedAt: (item.updatedAt as string | undefined) || (item.updated_at as string | undefined),
            createdBy: (item.createdBy as string | undefined) || (item.created_by as string | undefined),
            updatedBy: (item.updatedBy as string | undefined) || (item.updated_by as string | undefined),
            tags: [],
        };
    }
}
