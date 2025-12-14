// DynamoDB service for account metadata operations
import { ScanCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, handleDynamoDBError } from './aws-config';
import { AccountMetadata, UIAccount } from './types';
import { AuditService } from './audit-service';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ECSClient, ListClustersCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

// Define handleDynamoDBError if it's not properly imported
const handleError = (error: any, operation: string) => {
    console.error(`AccountService - Error during ${operation}:`, error);

    // Re-throw with a more user-friendly message
    if (error.name === 'ConditionalCheckFailedException') {
        throw new Error('Account with this ID already exists');
    } else if (error.name === 'ValidationException') {
        throw new Error(`Validation error: ${error.message}`);
    } else {
        throw new Error(`Failed to ${operation}`);
    }
};

export class AccountService {
    /**
     * Fetch all accounts from DynamoDB with optional filtering
     */
    static async getAccounts(filters?: {
        statusFilter?: string;
        connectionFilter?: string;
        searchTerm?: string;
        limit?: number;
        nextToken?: string;
    }): Promise<{ accounts: UIAccount[], nextToken?: string }> {
        try {
            console.log('AccountService - Attempting to fetch accounts from DynamoDB', filters ? `with filters: ${JSON.stringify(filters)}` : '');

            const limit = filters?.limit || 50;
            let exclusiveStartKey;

            if (filters?.nextToken) {
                try {
                    exclusiveStartKey = JSON.parse(Buffer.from(filters.nextToken, 'base64').toString('utf-8'));
                } catch (e) {
                    console.error('Invalid nextToken:', e);
                }
            }

            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pkVal',
                ExpressionAttributeValues: {
                    ':pkVal': 'TYPE#ACCOUNT',
                },
                Limit: limit,
                ExclusiveStartKey: exclusiveStartKey,
            });

            const response = await getDynamoDBDocumentClient().send(command);
            console.log('AccountService - Successfully fetched accounts:', response.Items?.length || 0);

            let accounts = (response.Items || []).map(item => this.transformToUIAccount(item));

            if (filters?.searchTerm && filters.searchTerm.trim() !== '') {
                const searchTerm = filters.searchTerm.toLowerCase();
                accounts = accounts.filter(account =>
                    account.name.toLowerCase().includes(searchTerm) ||
                    account.accountId.toLowerCase().includes(searchTerm) ||
                    (account.description && account.description.toLowerCase().includes(searchTerm)) ||
                    (account.createdBy && account.createdBy.toLowerCase().includes(searchTerm))
                );
            }

            if (filters?.statusFilter && filters.statusFilter !== 'all') {
                const isActive = filters.statusFilter === 'active';
                accounts = accounts.filter(account => account.active === isActive);
            }

            if (filters?.connectionFilter && filters.connectionFilter !== 'all') {
                if (filters.connectionFilter === 'connected') {
                    accounts = accounts.filter(account => account.connectionStatus === 'connected');
                }
            }

            let nextToken: string | undefined = undefined;
            if (response.LastEvaluatedKey) {
                nextToken = Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64');
            }

            return { accounts, nextToken };
        } catch (error: any) {
            console.error('AccountService - Error fetching accounts:', error);
            throw new Error('Failed to fetch accounts from database');
        }
    }

    /**
     * Get a specific account by account ID
     */
    static async getAccount(accountId: string): Promise<UIAccount | null> {
        try {
            // Get Item using Primary Key (PK, SK)
            const command = new GetCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: `ACCOUNT#${accountId}`,
                    sk: 'METADATA'
                }
            });

            const response = await getDynamoDBDocumentClient().send(command);
            if (!response.Item) {
                return null;
            }

            return this.transformToUIAccount(response.Item);
        } catch (error) {
            console.error('Error fetching account:', error);
            throw new Error('Failed to fetch account from database');
        }
    }

    /**
     * Create a new account
     */
    static async createAccount(account: Omit<UIAccount, 'id'>): Promise<UIAccount> {
        try {
            const now = new Date().toISOString();

            const dbItem = {
                pk: `ACCOUNT#${account.accountId}`,
                sk: 'METADATA',
                gsi1pk: 'TYPE#ACCOUNT',
                gsi1sk: account.name, // Sort by name

                // Attributes
                account_id: account.accountId, // Persist explicity
                account_name: account.name,
                role_arn: account.roleArn,
                external_id: account.externalId, // Persist externalId
                regions: account.regions,
                active: account.active,
                description: account.description,
                connection_status: 'unknown',
                created_at: now,
                updated_at: now,
                created_by: account.createdBy || 'system',
                updated_by: account.updatedBy || 'system',
                type: 'account', // Helper attribute
            };

            const command = new PutCommand({
                TableName: APP_TABLE_NAME,
                Item: dbItem,
                ConditionExpression: 'attribute_not_exists(pk)',
            });

            await getDynamoDBDocumentClient().send(command);

            // Log audit event
            await AuditService.logUserAction({
                action: 'Create Account',
                resourceType: 'account',
                resourceId: account.accountId,
                resourceName: account.name,
                user: account.createdBy || 'system',
                userType: 'user',
                status: 'success',
                details: `Created AWS account "${account.name}" (${account.accountId})`,
                metadata: {
                    accountId: account.accountId,
                    roleArn: account.roleArn,
                },
            });

            return this.transformToUIAccount(dbItem);
        } catch (error) {
            console.error('Error creating account:', error);
            // Log failed audit event 
            await AuditService.logUserAction({
                action: 'Create Account',
                resourceType: 'account',
                resourceId: account.accountId,
                resourceName: account.name,
                user: account.createdBy || 'system',
                userType: 'user',
                status: 'error',
                details: `Failed to create AWS account "${account.name}" (${account.accountId})`,
                metadata: { error: (error as any).message },
            });
            throw handleError(error, 'create account');
        }
    }

    /**
     * Update an existing account
     */
    static async updateAccount(accountId: string, updates: Partial<Omit<UIAccount, 'id' | 'accountId'>>): Promise<UIAccount> {
        try {
            const now = new Date().toISOString();

            // Build update expression
            const updateExpressions: string[] = [];
            const expressionAttributeNames: Record<string, string> = {};
            const expressionAttributeValues: Record<string, any> = {};

            // Map UI fields to DB fields
            const fieldMapping: Record<string, string> = {
                name: 'account_name',
                roleArn: 'role_arn',
                externalId: 'external_id',
                active: 'active',
                description: 'description',
                connectionStatus: 'connection_status',
                connectionError: 'connection_error',
                updatedBy: 'updated_by',
                regions: 'regions',
                lastValidated: 'updated_at' // Hack for validation update
            };

            Object.entries(updates).forEach(([key, value]) => {
                const dbField = fieldMapping[key] || key;
                if (value !== undefined && key !== 'id' && key !== 'accountId') {
                    // Update GSI1SK if name changes
                    if (key === 'name') {
                        updateExpressions.push('#gsi1sk = :gsi1sk');
                        expressionAttributeNames['#gsi1sk'] = 'gsi1sk';
                        expressionAttributeValues[':gsi1sk'] = value;
                    }

                    updateExpressions.push(`#${dbField} = :${dbField}`);
                    expressionAttributeNames[`#${dbField}`] = dbField;
                    expressionAttributeValues[`:${dbField}`] = value;
                }
            });

            if (updateExpressions.length === 0) return await this.getAccount(accountId) as UIAccount;

            // Updated At
            if (!updateExpressions.some(e => e.includes('#updated_at'))) {
                updateExpressions.push('#updated_at = :updated_at');
                expressionAttributeNames['#updated_at'] = 'updated_at';
                expressionAttributeValues[':updated_at'] = now;
            }

            const command = new UpdateCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: `ACCOUNT#${accountId}`,
                    sk: 'METADATA',
                },
                UpdateExpression: `SET ${updateExpressions.join(', ')}`,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
                ReturnValues: 'ALL_NEW',
            });

            const response = await getDynamoDBDocumentClient().send(command);

            // Log audit event
            await AuditService.logUserAction({
                action: 'Update Account',
                resourceType: 'account',
                resourceId: accountId,
                resourceName: response.Attributes?.account_name || 'unknown',
                user: updates.updatedBy || 'system',
                userType: 'user',
                status: 'success',
                details: `Updated AWS account "${response.Attributes?.account_name}" (${accountId})`,
                metadata: {
                    updates
                },
            });

            return this.transformToUIAccount(response.Attributes);

        } catch (error) {
            console.error('Error updating account:', error);
            throw handleError(error, 'update account');
        }
    }

    /**
     * Delete an account
     */
    static async deleteAccount(accountId: string, deletedBy: string = 'system'): Promise<void> {
        try {
            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: `ACCOUNT#${accountId}`,
                    sk: 'METADATA',
                },
            });

            await getDynamoDBDocumentClient().send(command);

            // Log audit event
            await AuditService.logUserAction({
                action: 'Delete Account',
                resourceType: 'account',
                resourceId: accountId,
                resourceName: accountId,
                user: deletedBy,
                userType: 'user',
                status: 'success',
                details: `Deleted AWS account (${accountId})`,
                metadata: { accountId },
            });

        } catch (error) {
            console.error('Error deleting account:', error);
            handleError(error, 'delete account');
        }
    }

    /**
    * Validate account connection 
    */
    /**
     * Validate credentials directly (without DB update)
     */
    static async validateCredentials({ roleArn, externalId, region }: { roleArn: string; externalId?: string; region: string }): Promise<{ isValid: boolean; error?: string }> {
        try {
            console.log(`AccountService - Validating credentials for ${roleArn} in ${region}`);

            // 1. Assume Role
            const stsClient = new STSClient({ region: 'us-east-1' });
            const assumeRoleCommand = new AssumeRoleCommand({
                RoleArn: roleArn,
                RoleSessionName: 'NucleusValidationSession',
                ExternalId: externalId,
            });

            const stsResponse = await stsClient.send(assumeRoleCommand);

            if (!stsResponse.Credentials) {
                throw new Error('Failed to obtain temporary credentials');
            }

            const credentials = {
                accessKeyId: stsResponse.Credentials.AccessKeyId!,
                secretAccessKey: stsResponse.Credentials.SecretAccessKey!,
                sessionToken: stsResponse.Credentials.SessionToken!,
            };

            // 2. Verify Access (List ECS Clusters)
            const ecsClient = new ECSClient({
                region: region,
                credentials
            });

            await ecsClient.send(new ListClustersCommand({ maxResults: 1 }));
            console.log('AccountService - ECS ListClusters successful');

            // 3. Verify EC2 Access (List Instances) - NEW
            const ec2Client = new EC2Client({
                region: region,
                credentials
            });
            await ec2Client.send(new DescribeInstancesCommand({ MaxResults: 5 }));
            console.log('AccountService - EC2 DescribeInstances successful');

            // 4. Verify RDS Access (Optional but good)
            const rdsClient = new RDSClient({
                region: region,
                credentials
            });
            await rdsClient.send(new DescribeDBInstancesCommand({ MaxRecords: 20 }));
            console.log('AccountService - RDS DescribeDBInstances successful');

            return { isValid: true };

        } catch (err: any) {
            console.error('AccountService - Validation Creds Failed:', err);
            let validationError = err.message || 'Unknown validation error';

            if (err.name === 'AccessDenied' || (err.message && err.message.includes('AccessDenied'))) {
                validationError = `Access Denied: ${err.message}`;
            }
            return { isValid: false, error: validationError };
        }
    }

    /**
    * Validate account connection 
    */
    static async validateAccount(accountId: string): Promise<UIAccount> {
        try {
            console.log(`AccountService - Validating account: ${accountId}`);

            // 1. Get Account Details
            const account = await this.getAccount(accountId);
            if (!account) {
                throw new Error(`Account ${accountId} not found`);
            }

            if (!account.roleArn) {
                throw new Error('No Role ARN configured for this account');
            }

            // Update status to validating
            await this.updateAccount(accountId, {
                connectionStatus: 'validating',
                connectionError: 'None' // Clear previous error
            });

            const now = new Date().toISOString();

            // 2. Validate using shared logic
            const validationDetails = await this.validateCredentials({
                roleArn: account.roleArn,
                externalId: account.externalId,
                region: account.regions?.[0] || 'us-east-1'
            });

            // 3. Update Account Status based on result
            let finalStatus: 'connected' | 'error' = validationDetails.isValid ? 'connected' : 'error';

            const updates: any = {
                connectionStatus: finalStatus,
                lastValidated: now,
                connectionError: validationDetails.error || 'None'
            };

            if (validationDetails.error) {
                console.warn(`Validation failed for ${accountId}: ${validationDetails.error}`);
            }

            const updatedAccount = await this.updateAccount(accountId, updates);

            // Log audit
            await AuditService.logUserAction({
                action: 'Validate Account',
                resourceType: 'account',
                resourceId: accountId,
                resourceName: account.name,
                user: updatedAccount.updatedBy || 'system',
                userType: 'user',
                status: finalStatus === 'connected' ? 'success' : 'error',
                details: finalStatus === 'connected'
                    ? `Account connection validated successfully`
                    : `Account connection validation failed: ${validationDetails.error}`,
                metadata: {
                    accountId,
                    roleArn: account.roleArn,
                    error: validationDetails.error
                },
            });

            return updatedAccount;

        } catch (error) {
            console.error('AccountService - Error during validateAccount wrapper:', error);
            // If we failed to even update status (e.g. DynamoDB error), rethrow
            throw handleError(error, 'validate account');
        }
    }



    /**
     * Transform DynamoDB item to UI account format
     */
    private static transformToUIAccount(item: any): UIAccount {
        return {
            id: item.account_id || item.pk.replace('ACCOUNT#', ''),
            accountId: item.account_id || item.pk.replace('ACCOUNT#', ''),
            name: item.account_name || item.gsi1sk,
            roleArn: item.role_arn,
            externalId: item.external_id, // Map from DB to UI
            regions: item.regions || [],
            active: item.active,
            description: item.description || '',
            connectionStatus: item.connection_status || 'unknown',
            connectionError: item.connection_error, // Map from DB
            lastValidated: item.updated_at,
            resourceCount: 0, // Placeholder
            schedulesCount: 0, // Placeholder
            monthlySavings: 0, // Placeholder
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            createdBy: item.created_by,
            updatedBy: item.updated_by,
            tags: [],
        };
    }

    /**
     * Toggle the active status of an AWS account
     */
    static async toggleAccountStatus(accountId: string): Promise<UIAccount> {
        try {
            // Get the current account
            const account = await this.getAccount(accountId);
            if (!account) {
                throw new Error(`Account ${accountId} not found`);
            }

            // Toggle active status using the updateAccount method
            const updatedAccount = await this.updateAccount(accountId, {
                active: !account.active,
                updatedBy: 'system' // Set to authenticated user in real app
            });

            return updatedAccount;
        } catch (error) {
            handleError(error, 'toggle account status');
            throw error;
        }
    }

    /**
     * Scan resources (EC2, ECS, RDS) for a given account
     */
    static async scanResources(accountId: string): Promise<Array<{ id: string; type: 'ec2' | 'ecs' | 'rds'; name: string; arn: string }>> {
        try {
            console.log(`AccountService - Scanning resources for account: ${accountId}`);

            const account = await this.getAccount(accountId);
            if (!account || !account.roleArn) {
                throw new Error('Account or Role ARN not found');
            }

            const region = account.regions?.[0] || 'us-east-1';

            // 1. Assume Role
            const stsClient = new STSClient({ region: 'us-east-1' });
            const assumeRoleCommand = new AssumeRoleCommand({
                RoleArn: account.roleArn,
                RoleSessionName: 'NucleusScanSession',
                ExternalId: account.externalId,
            });

            const stsResponse = await stsClient.send(assumeRoleCommand);
            if (!stsResponse.Credentials) {
                throw new Error('Failed to obtain temporary credentials');
            }

            const credentials = {
                accessKeyId: stsResponse.Credentials.AccessKeyId!,
                secretAccessKey: stsResponse.Credentials.SecretAccessKey!,
                sessionToken: stsResponse.Credentials.SessionToken!,
            };

            const resources: Array<{ id: string; type: 'ec2' | 'ecs' | 'rds'; name: string; arn: string }> = [];

            // 2. Scan EC2
            try {
                const ec2Client = new EC2Client({ region, credentials });
                const ec2Response = await ec2Client.send(new DescribeInstancesCommand({}));
                ec2Response.Reservations?.forEach(reservation => {
                    reservation.Instances?.forEach(instance => {
                        if (instance.InstanceId && instance.State?.Name !== 'terminated') {
                            const nameTag = instance.Tags?.find(t => t.Key === 'Name')?.Value;
                            resources.push({
                                id: instance.InstanceId,
                                type: 'ec2',
                                name: nameTag || instance.InstanceId,
                                arn: `arn:aws:ec2:${region}:${accountId}:instance/${instance.InstanceId}`
                            });
                        }
                    });
                });
            } catch (e) {
                console.error('Error scanning EC2:', e);
            }

            // 3. Scan ECS
            try {
                const ecsClient = new ECSClient({ region, credentials });
                // Note: ListClusters only returns ARNs
                const ecsResponse = await ecsClient.send(new ListClustersCommand({}));
                ecsResponse.clusterArns?.forEach(arn => {
                    const name = arn.split('/').pop() || arn;
                    resources.push({
                        id: name,
                        type: 'ecs',
                        name: name,
                        arn: arn // ListClusters returns full ARN
                    });
                });
            } catch (e) {
                console.error('Error scanning ECS:', e);
            }

            // 4. Scan RDS
            try {
                const rdsClient = new RDSClient({ region, credentials });
                const rdsResponse = await rdsClient.send(new DescribeDBInstancesCommand({}));
                rdsResponse.DBInstances?.forEach(instance => {
                    if (instance.DBInstanceIdentifier) {
                        resources.push({
                            id: instance.DBInstanceIdentifier,
                            type: 'rds',
                            name: instance.DBInstanceIdentifier,
                            arn: instance.DBInstanceArn || `arn:aws:rds:${region}:${accountId}:db:${instance.DBInstanceIdentifier}`
                        });
                    }
                });
            } catch (e) {
                console.error('Error scanning RDS:', e);
            }

            // Update resource count in metadata
            await this.updateAccount(accountId, {
                resourceCount: resources.length,
                lastValidated: new Date().toISOString()
            });

            return resources;

        } catch (error) {
            console.error('AccountService - Error scanning resources:', error);
            throw handleError(error, 'scan resources');
        }
    }
}

