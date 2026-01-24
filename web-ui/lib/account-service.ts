// DynamoDB service for account metadata operations
import { ScanCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, handleDynamoDBError, DEFAULT_TENANT_ID } from './aws-config';
import { AccountMetadata, UIAccount } from './types';
import { AuditService } from './audit-service';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand, DescribeCapacityProvidersCommand, ListClustersCommandOutput, ListServicesCommandOutput, DescribeCapacityProvidersCommandOutput, DescribeServicesCommandOutput } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBInstancesCommandOutput, DescribeDBClustersCommand, DescribeDBClustersCommandOutput } from '@aws-sdk/client-rds';
import { EC2Client, DescribeInstancesCommand, DescribeInstancesCommandOutput } from '@aws-sdk/client-ec2';
import { AutoScalingClient, DescribeAutoScalingGroupsCommand, DescribeAutoScalingGroupsCommandOutput } from '@aws-sdk/client-auto-scaling';

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

// Helper to build PK/SK for accounts
const buildAccountPK = (tenantId: string) => `TENANT#${tenantId}`;
const buildAccountSK = (accountId: string) => `ACCOUNT#${accountId}`;

export class AccountService {
    /**
     * Fetch all accounts from DynamoDB with optional filtering
     * Uses GSI1: gsi1pk = TYPE#ACCOUNT
     * 
     * When filters (search, status, connection) are applied, we fetch ALL records
     * to ensure filtering works correctly, then apply client-side pagination.
     * When no filters are applied, we use DynamoDB pagination for efficiency.
     */
    /**
     * Fetch all accounts from DynamoDB with optional filtering
     * Uses GSI1: gsi1pk = TYPE#ACCOUNT
     * 
     * We fetch ALL records to ensure filtering works correctly and to provide accurate total counts,
     * then apply client-side pagination. This is suitable for the expected scale (< 1000 accounts).
     */
    static async getAccounts(filters?: {
        statusFilter?: string;
        connectionFilter?: string;
        searchTerm?: string;
        limit?: number;
        page?: number;
        tenantId?: string;
    }): Promise<{ accounts: UIAccount[], totalCount: number }> {
        try {
            console.log('AccountService - Attempting to fetch accounts from DynamoDB', filters ? `with filters: ${JSON.stringify(filters)}` : '');

            const pageSize = filters?.limit || 10;
            const page = filters?.page || 1;

            // Fetch ALL accounts first (no limit) using recursive pagination
            let allAccounts: UIAccount[] = [];
            let lastEvaluatedKey: Record<string, any> | undefined = undefined;

            do {
                const fetchCommand = new QueryCommand({
                    TableName: APP_TABLE_NAME,
                    IndexName: 'GSI1',
                    KeyConditionExpression: 'gsi1pk = :pkVal',
                    ExpressionAttributeValues: {
                        ':pkVal': 'TYPE#ACCOUNT',
                    },
                    ExclusiveStartKey: lastEvaluatedKey as Record<string, any> | undefined,
                });
                const fetchResponse = await getDynamoDBDocumentClient().send(fetchCommand) as { Items?: any[], LastEvaluatedKey?: Record<string, any> };
                const pageAccounts = (fetchResponse.Items || []).map((item: any) => this.transformToUIAccount(item));
                allAccounts = allAccounts.concat(pageAccounts);
                lastEvaluatedKey = fetchResponse.LastEvaluatedKey;
            } while (lastEvaluatedKey);

            console.log('AccountService - Fetched all accounts:', allAccounts.length);

            // Apply filters in memory
            let filteredAccounts = allAccounts;

            if (filters?.searchTerm && filters.searchTerm.trim() !== '') {
                const searchTerm = filters.searchTerm.toLowerCase();
                filteredAccounts = filteredAccounts.filter(account =>
                    account.name.toLowerCase().includes(searchTerm) ||
                    account.accountId.toLowerCase().includes(searchTerm) ||
                    (account.description && account.description.toLowerCase().includes(searchTerm)) ||
                    (account.createdBy && account.createdBy.toLowerCase().includes(searchTerm))
                );
            }

            if (filters?.statusFilter && filters.statusFilter !== 'all') {
                const isActive = filters.statusFilter === 'active';
                filteredAccounts = filteredAccounts.filter(account => account.active === isActive);
            }

            if (filters?.connectionFilter && filters.connectionFilter !== 'all') {
                filteredAccounts = filteredAccounts.filter(account =>
                    account.connectionStatus === filters.connectionFilter
                );
            }

            const totalCount = filteredAccounts.length;
            console.log('AccountService - Filtered count:', totalCount);

            // Apply pagination on filtered results
            const startIndex = (page - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            const paginatedAccounts = filteredAccounts.slice(startIndex, endIndex);

            return {
                accounts: paginatedAccounts,
                totalCount: totalCount
            };
        } catch (error: any) {
            console.error('AccountService - Error fetching accounts:', error);
            throw new Error('Failed to fetch accounts from database');
        }
    }

    /**
     * Get a specific account by account ID
     * PK: TENANT#<tenantId>, SK: ACCOUNT#<accountId>
     */
    static async getAccount(accountId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount | null> {
        try {
            const command = new GetCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildAccountPK(tenantId),
                    sk: buildAccountSK(accountId)
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
     * PK: TENANT#<tenantId>, SK: ACCOUNT#<accountId>
     */
    static async createAccount(account: Omit<UIAccount, 'id'>, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount> {
        try {
            const now = new Date().toISOString();
            const statusText = account.active ? 'active' : 'inactive';

            const dbItem = {
                // Primary Keys (new hierarchical design)
                pk: buildAccountPK(tenantId),
                sk: buildAccountSK(account.accountId),

                // GSI1: TYPE#ACCOUNT -> accountId (list all accounts)
                gsi1pk: 'TYPE#ACCOUNT',
                gsi1sk: account.accountId,

                // GSI2: ACCOUNT#<id> -> ACCOUNT#<id> (direct lookup without tenant)
                gsi2pk: `ACCOUNT#${account.accountId}`,
                gsi2sk: `ACCOUNT#${account.accountId}`,

                // GSI3: STATUS#active/inactive -> TENANT#...#ACCOUNT#...
                gsi3pk: `STATUS#${statusText}`,
                gsi3sk: `TENANT#${tenantId}#ACCOUNT#${account.accountId}`,

                // Entity type
                type: 'account',

                // IDs
                tenantId: tenantId,
                accountId: account.accountId,

                // Attributes
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
                    tenantId,
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
    static async updateAccount(accountId: string, updates: Partial<Omit<UIAccount, 'id' | 'accountId'>>, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount> {
        try {
            const now = new Date().toISOString();

            // Build update expression
            const updateExpressions: string[] = [];
            const expressionAttributeNames: Record<string, string> = {};
            const expressionAttributeValues: Record<string, any> = {};

            // Map UI fields to DB fields
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
                lastValidated: 'updatedAt' // Hack for validation update
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

                    // Update GSI3 if active status changes
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

            if (updateExpressions.length === 0) return await this.getAccount(accountId, tenantId) as UIAccount;

            // Updated At
            if (!updateExpressions.some(e => e.includes('#updatedAt'))) {
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

            // Log audit event
            await AuditService.logUserAction({
                action: 'Update Account',
                resourceType: 'account',
                resourceId: accountId,
                resourceName: response.Attributes?.accountName || 'unknown',
                user: updates.updatedBy || 'system',
                userType: 'user',
                status: 'success',
                details: `Updated AWS account "${response.Attributes?.accountName}" (${accountId})`,
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
    static async deleteAccount(accountId: string, deletedBy: string = 'system', tenantId: string = DEFAULT_TENANT_ID): Promise<void> {
        try {
            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildAccountPK(tenantId),
                    sk: buildAccountSK(accountId),
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
                metadata: { accountId, tenantId },
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
            const stsClient = new STSClient({ region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null' });
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
    static async validateAccount(accountId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount> {
        try {
            console.log(`AccountService - Validating account: ${accountId}`);

            // 1. Get Account Details
            const account = await this.getAccount(accountId, tenantId);
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
            }, tenantId);

            const now = new Date().toISOString();

            // 2. Validate using shared logic
            const validationDetails = await this.validateCredentials({
                roleArn: account.roleArn,
                externalId: account.externalId,
                region: account.regions?.[0] || process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null'
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

            const updatedAccount = await this.updateAccount(accountId, updates, tenantId);

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
            id: item.accountId || item.sk?.replace('ACCOUNT#', ''),
            accountId: item.accountId || item.sk?.replace('ACCOUNT#', ''),
            name: item.accountName || item.account_name || item.gsi1sk,
            roleArn: item.roleArn || item.role_arn,
            externalId: item.externalId || item.external_id,
            regions: item.regions || [],
            active: item.active,
            description: item.description || '',
            connectionStatus: item.connectionStatus || item.connection_status || 'unknown',
            connectionError: item.connectionError || item.connection_error,
            lastValidated: item.updatedAt || item.updated_at,
            resourceCount: 0, // Placeholder
            schedulesCount: 0, // Placeholder
            monthlySavings: 0, // Placeholder
            createdAt: item.createdAt || item.created_at,
            updatedAt: item.updatedAt || item.updated_at,
            createdBy: item.createdBy || item.created_by,
            updatedBy: item.updatedBy || item.updated_by,
            tags: [],
        };
    }

    /**
     * Toggle the active status of an AWS account
     */
    static async toggleAccountStatus(accountId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount> {
        try {
            // Get the current account
            const account = await this.getAccount(accountId, tenantId);
            if (!account) {
                throw new Error(`Account ${accountId} not found`);
            }

            // Toggle active status using the updateAccount method
            const updatedAccount = await this.updateAccount(accountId, {
                active: !account.active,
                updatedBy: 'system' // Set to authenticated user in real app
            }, tenantId);

            return updatedAccount;
        } catch (error) {
            handleError(error, 'toggle account status');
            throw error;
        }
    }

    /**
     * Scan resources (EC2, ECS, RDS, ASG) for a given account
     */
    static async scanResources(accountId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<Array<{ id: string; type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb'; name: string; arn: string; clusterArn?: string }>> {
        try {
            console.log(`AccountService - Scanning resources for account: ${accountId}`);

            const account = await this.getAccount(accountId, tenantId);
            if (!account || !account.roleArn) {
                throw new Error('Account or Role ARN not found');
            }

            const region = account.regions?.[0] || process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null';

            // 1. Assume Role
            const stsClient = new STSClient({ region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null' });
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

            const resources: Array<{ id: string; type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb'; name: string; arn: string; clusterArn?: string }> = [];

            // 2. Scan EC2 (excluding ASG-managed instances)
            try {
                const ec2Client = new EC2Client({ region, credentials });
                let nextToken: string | undefined = undefined;

                do {
                    const ec2Response: DescribeInstancesCommandOutput = await ec2Client.send(new DescribeInstancesCommand({ NextToken: nextToken }));
                    ec2Response.Reservations?.forEach(reservation => {
                        reservation.Instances?.forEach(instance => {
                            if (instance.InstanceId && instance.State?.Name !== 'terminated') {
                                // Filter out instances that are part of an Auto Scaling Group
                                // ASG-managed instances have the 'aws:autoscaling:groupName' tag
                                const asgTag = instance.Tags?.find(t => t.Key === 'aws:autoscaling:groupName');
                                if (asgTag) {
                                    // Skip instances managed by ASG - they should be managed via ASG tab
                                    return;
                                }

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
                    nextToken = ec2Response.NextToken;
                } while (nextToken);

            } catch (e) {
                console.error('Error scanning EC2:', e);
            }

            // 3. Scan ECS Services (not clusters)
            try {
                const ecsClient = new ECSClient({ region, credentials });

                // First, get all clusters
                let clusterArns: string[] = [];
                let nextToken: string | undefined = undefined;

                do {
                    const clustersResponse: ListClustersCommandOutput = await ecsClient.send(new ListClustersCommand({ nextToken }));
                    if (clustersResponse.clusterArns) {
                        clusterArns = [...clusterArns, ...clustersResponse.clusterArns];
                    }
                    nextToken = clustersResponse.nextToken;
                } while (nextToken);

                // For each cluster, list its services
                for (const clusterArn of clusterArns) {
                    const clusterName = clusterArn.split('/').pop() || clusterArn;
                    let serviceArns: string[] = [];
                    let servicesNextToken: string | undefined = undefined;

                    try {
                        // List all services in cluster
                        do {
                            const servicesResponse: ListServicesCommandOutput = await ecsClient.send(new ListServicesCommand({
                                cluster: clusterArn,
                                nextToken: servicesNextToken
                            }));
                            if (servicesResponse.serviceArns) {
                                serviceArns = [...serviceArns, ...servicesResponse.serviceArns];
                            }
                            servicesNextToken = servicesResponse.nextToken;
                        } while (servicesNextToken);

                        // Describe services in batches of 10 (API limit)
                        const batchSize = 10;
                        for (let i = 0; i < serviceArns.length; i += batchSize) {
                            const batch = serviceArns.slice(i, i + batchSize);
                            if (batch.length > 0) {
                                const describeResponse: DescribeServicesCommandOutput = await ecsClient.send(new DescribeServicesCommand({
                                    cluster: clusterArn,
                                    services: batch,
                                }));

                                describeResponse.services?.forEach(service => {
                                    if (service.serviceArn && service.serviceName) {
                                        resources.push({
                                            id: service.serviceName,
                                            type: 'ecs',
                                            name: `${clusterName}/${service.serviceName}`,
                                            arn: service.serviceArn,
                                            clusterArn: clusterArn, // Include cluster ARN for scheduler
                                        });
                                    }
                                });
                            }
                        }
                    } catch (serviceError) {
                        console.error(`Error scanning ECS services in cluster ${clusterName}:`, serviceError);
                    }
                }
            } catch (e) {
                console.error('Error scanning ECS clusters:', e);
            }

            // 4. Scan RDS
            try {
                const rdsClient = new RDSClient({ region, credentials });
                let marker: string | undefined = undefined;

                do {
                    const rdsResponse: DescribeDBInstancesCommandOutput = await rdsClient.send(new DescribeDBInstancesCommand({ Marker: marker }));
                    rdsResponse.DBInstances?.forEach(instance => {
                        // Filter out DocumentDB instances (Engine = 'docdb')
                        if (instance.Engine === 'docdb') {
                            return;
                        }

                        if (instance.DBInstanceIdentifier) {
                            resources.push({
                                id: instance.DBInstanceIdentifier,
                                type: 'rds',
                                name: instance.DBInstanceIdentifier,
                                arn: instance.DBInstanceArn || `arn:aws:rds:${region}:${accountId}:db:${instance.DBInstanceIdentifier}`
                            });
                        }
                    });
                    marker = rdsResponse.Marker;
                } while (marker);

                // Scan DocumentDB Clusters
                let clusterMarker: string | undefined = undefined;
                do {
                    const docDbResponse: DescribeDBClustersCommandOutput = await rdsClient.send(new DescribeDBClustersCommand({
                        Marker: clusterMarker,
                        Filters: [{ Name: 'engine', Values: ['docdb'] }]
                    }));

                    docDbResponse.DBClusters?.forEach(cluster => {
                        if (cluster.DBClusterIdentifier) {
                            resources.push({
                                id: cluster.DBClusterIdentifier,
                                type: 'docdb',
                                name: cluster.DBClusterIdentifier,
                                arn: cluster.DBClusterArn || `arn:aws:rds:${region}:${accountId}:cluster:${cluster.DBClusterIdentifier}`
                            });
                        }
                    });
                    clusterMarker = docDbResponse.Marker;
                } while (clusterMarker);

            } catch (e) {
                console.error('Error scanning RDS:', e);
            }

            // 5. Scan ASG (excluding ECS capacity provider ASGs)
            try {
                // First, get ASGs that are ECS capacity providers (to exclude them)
                const ecsCapacityProviderAsgArns = new Set<string>();
                try {
                    const ecsClientForCp = new ECSClient({ region, credentials });
                    let nextTokenCp: string | undefined = undefined;

                    do {
                        const capacityProvidersResponse: DescribeCapacityProvidersCommandOutput = await ecsClientForCp.send(
                            new DescribeCapacityProvidersCommand({ nextToken: nextTokenCp })
                        );
                        capacityProvidersResponse.capacityProviders?.forEach(cp => {
                            if (cp.autoScalingGroupProvider?.autoScalingGroupArn) {
                                ecsCapacityProviderAsgArns.add(cp.autoScalingGroupProvider.autoScalingGroupArn);
                            }
                        });
                        nextTokenCp = capacityProvidersResponse.nextToken;
                    } while (nextTokenCp);

                    console.log(`Found ${ecsCapacityProviderAsgArns.size} ECS capacity provider ASGs to exclude`);
                } catch (ecsErr) {
                    console.error('Error fetching ECS capacity providers:', ecsErr);
                    // Continue with ASG scan even if capacity provider check fails
                }

                const asgClient = new AutoScalingClient({ region, credentials });
                let nextToken: string | undefined = undefined;

                do {
                    const asgResponse: DescribeAutoScalingGroupsCommandOutput = await asgClient.send(new DescribeAutoScalingGroupsCommand({ NextToken: nextToken }));
                    asgResponse.AutoScalingGroups?.forEach(asg => {
                        if (asg.AutoScalingGroupName) {
                            // Filter out ASGs that are ECS capacity providers
                            if (asg.AutoScalingGroupARN && ecsCapacityProviderAsgArns.has(asg.AutoScalingGroupARN)) {
                                // Skip ASGs used as ECS capacity providers
                                return;
                            }

                            resources.push({
                                id: asg.AutoScalingGroupName,
                                type: 'asg',
                                name: asg.AutoScalingGroupName,
                                arn: asg.AutoScalingGroupARN || `arn:aws:autoscaling:${region}:${accountId}:autoScalingGroup:uuid:autoScalingGroupName/${asg.AutoScalingGroupName}`
                            });
                        }
                    });
                    nextToken = asgResponse.NextToken;
                } while (nextToken);

            } catch (e) {
                console.error('Error scanning ASG:', e);
            }

            // Update resource count in metadata
            await this.updateAccount(accountId, {
                resourceCount: resources.length,
                lastValidated: new Date().toISOString()
            }, tenantId);

            return resources;

        } catch (error) {
            console.error('AccountService - Error scanning resources:', error);
            throw handleError(error, 'scan resources');
        }
    }
}

