// Account service — delegates persistence to the repository layer
// Persistence operations route through getAccountRepository() which reads
// USE_PG_ACCOUNTS to select DynamoDB or PostgreSQL backend.
import { UIAccount } from './types';
import { AuditService } from './audit-service';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand, DescribeCapacityProvidersCommand, ListClustersCommandOutput, ListServicesCommandOutput, DescribeCapacityProvidersCommandOutput, DescribeServicesCommandOutput } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBInstancesCommandOutput, DescribeDBClustersCommand, DescribeDBClustersCommandOutput } from '@aws-sdk/client-rds';
import { EC2Client, DescribeInstancesCommand, DescribeInstancesCommandOutput } from '@aws-sdk/client-ec2';
import { AutoScalingClient, DescribeAutoScalingGroupsCommand, DescribeAutoScalingGroupsCommandOutput } from '@aws-sdk/client-auto-scaling';
import { getAccountRepository } from '@/lib/db/repository-factory';

export class AccountService {
    /**
     * Fetch accounts with optional filtering.
     * Delegates to the active IAccountRepository (DynamoDB or PostgreSQL).
     */
    static async getAccounts(filters?: {
        statusFilter?: string;
        connectionFilter?: string;
        searchTerm?: string;
        limit?: number;
        page?: number;
        tenantId?: string;
    }): Promise<{ accounts: UIAccount[], totalCount: number }> {
        console.log('AccountService - Fetching accounts', filters ? `with filters: ${JSON.stringify(filters)}` : '');
        return getAccountRepository().getAccounts({
            searchTerm: filters?.searchTerm,
            statusFilter: filters?.statusFilter,
            connectionFilter: filters?.connectionFilter,
            page: filters?.page,
            limit: filters?.limit,
            tenantId: filters?.tenantId,
        });
    }

    /**
     * Get a specific account by account ID.
     */
    static async getAccount(accountId: string, tenantId: string): Promise<UIAccount | null> {
        return getAccountRepository().getAccount(accountId, tenantId);
    }

    /**
     * Create a new account and emit an audit log entry.
     */
    static async createAccount(account: Omit<UIAccount, 'id'>, tenantId: string): Promise<UIAccount> {
        const result = await getAccountRepository().createAccount(account, tenantId);
        await AuditService.logUserAction({
            eventType: 'account.account.created',
            action: 'Created Account',
            resourceType: 'Account',
            resourceId: account.accountId,
            resourceName: account.name,
            user: account.createdBy || 'system',
            userType: 'user',
            status: 'success',
            severity: 'high',
            details: `Created AWS account "${account.name}" (${account.accountId})`,
            tenantId,
            dataClassification: 'infrastructure',
            metadata: {
                tenantId,
                accountId: account.accountId,
                roleArn: account.roleArn,
            },
        });
        return result;
    }

    /**
     * Update an existing account and emit an audit log entry.
     * Pass skipAudit=true when called internally from validateAccount/toggleAccountStatus
     * to avoid duplicate audit entries.
     */
    static async updateAccount(accountId: string, updates: Partial<Omit<UIAccount, 'id' | 'accountId'>>, tenantId: string, skipAudit = false): Promise<UIAccount> {
        const result = await getAccountRepository().updateAccount(accountId, updates, tenantId);
        if (!skipAudit) {
            await AuditService.logUserAction({
                eventType: 'account.account.updated',
                action: 'Updated Account',
                resourceType: 'Account',
                resourceId: accountId,
                resourceName: result.name,
                user: updates.updatedBy || 'system',
                userType: 'user',
                status: 'success',
                severity: 'medium',
                details: `Updated AWS account "${result.name}" (${accountId})`,
                tenantId,
                dataClassification: 'infrastructure',
                metadata: { tenantId, updates },
            });
        }
        return result;
    }

    /**
     * Delete an account and emit an audit log entry.
     */
    static async deleteAccount(accountId: string, deletedBy = 'system', tenantId: string): Promise<void> {
        await getAccountRepository().deleteAccount(accountId, tenantId);
        await AuditService.logUserAction({
            eventType: 'account.account.deleted',
            action: 'Deleted Account',
            resourceType: 'Account',
            resourceId: accountId,
            resourceName: accountId,
            user: deletedBy,
            userType: 'user',
            status: 'success',
            severity: 'high',
            details: `Deleted AWS account (${accountId})`,
            tenantId,
            dataClassification: 'infrastructure',
            metadata: { tenantId, accountId },
        });
    }

    /**
     * Validate credentials directly (without DB update).
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
            const ecsClient = new ECSClient({ region, credentials });
            await ecsClient.send(new ListClustersCommand({ maxResults: 1 }));
            console.log('AccountService - ECS ListClusters successful');

            // 3. Verify EC2 Access
            const ec2Client = new EC2Client({ region, credentials });
            await ec2Client.send(new DescribeInstancesCommand({ MaxResults: 5 }));
            console.log('AccountService - EC2 DescribeInstances successful');

            // 4. Verify RDS Access
            const rdsClient = new RDSClient({ region, credentials });
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
     * Validate account connection — updates status in DB, emits audit log.
     */
    static async validateAccount(accountId: string, tenantId: string): Promise<UIAccount> {
        try {
            console.log(`AccountService - Validating account: ${accountId}`);

            const account = await this.getAccount(accountId, tenantId);
            if (!account) {
                throw new Error(`Account ${accountId} not found`);
            }

            if (!account.roleArn) {
                throw new Error('No Role ARN configured for this account');
            }

            await this.updateAccount(accountId, {
                connectionStatus: 'validating',
                connectionError: 'None',
            }, tenantId, true);

            const now = new Date().toISOString();

            const validationDetails = await this.validateCredentials({
                roleArn: account.roleArn,
                externalId: account.externalId,
                region: account.regions?.[0] || process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
            });

            const finalStatus: 'connected' | 'error' = validationDetails.isValid ? 'connected' : 'error';

            const updates: Partial<Omit<UIAccount, 'id' | 'accountId'>> = {
                connectionStatus: finalStatus,
                lastValidated: now,
                connectionError: validationDetails.error || 'None',
            };

            if (validationDetails.error) {
                console.warn(`Validation failed for ${accountId}: ${validationDetails.error}`);
            }

            const updatedAccount = await this.updateAccount(accountId, updates, tenantId, true);

            await AuditService.logUserAction({
                eventType: 'account.account.validated',
                action: 'Validated Account',
                resourceType: 'Account',
                resourceId: accountId,
                resourceName: account.name,
                user: updatedAccount.updatedBy || 'system',
                userType: 'user',
                status: finalStatus === 'connected' ? 'success' : 'error',
                severity: finalStatus === 'connected' ? 'low' : 'high',
                details: finalStatus === 'connected'
                    ? `Account connection validated successfully`
                    : `Account connection validation failed: ${validationDetails.error}`,
                tenantId,
                dataClassification: 'credentials',
                metadata: {
                    tenantId,
                    accountId,
                    roleArn: account.roleArn,
                    error: validationDetails.error,
                },
            });

            return updatedAccount;

        } catch (error: any) {
            console.error('AccountService - Error during validateAccount wrapper:', error);
            throw new Error(`Failed to validate account: ${error.message}`);
        }
    }

    /**
     * Toggle the active status of an AWS account.
     */
    static async toggleAccountStatus(accountId: string, tenantId: string): Promise<UIAccount> {
        const account = await this.getAccount(accountId, tenantId);
        if (!account) {
            throw new Error(`Account ${accountId} not found`);
        }

        const result = await this.updateAccount(accountId, {
            active: !account.active,
            updatedBy: 'system',
        }, tenantId, true);

        await AuditService.logUserAction({
            eventType: 'account.account.toggled',
            action: 'Toggled Account',
            resourceType: 'Account',
            resourceId: accountId,
            resourceName: account.name,
            user: result.updatedBy || 'system',
            userType: 'user',
            status: 'success',
            severity: 'medium',
            details: `Toggled account "${account.name}" to ${!account.active ? 'active' : 'inactive'}`,
            tenantId,
            changeSet: { before: { active: account.active }, after: { active: !account.active } },
            metadata: { tenantId, accountId, active: !account.active },
        });

        return result;
    }

    /**
     * Scan resources (EC2, ECS, RDS, ASG) for a given account.
     */
    static async scanResources(accountId: string, tenantId: string): Promise<Array<{ id: string; type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb'; name: string; arn: string; clusterArn?: string }>> {
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
                                const asgTag = instance.Tags?.find(t => t.Key === 'aws:autoscaling:groupName');
                                if (asgTag) return;

                                const nameTag = instance.Tags?.find(t => t.Key === 'Name')?.Value;
                                resources.push({
                                    id: instance.InstanceId,
                                    type: 'ec2',
                                    name: nameTag || instance.InstanceId,
                                    arn: `arn:aws:ec2:${region}:${accountId}:instance/${instance.InstanceId}`,
                                });
                            }
                        });
                    });
                    nextToken = ec2Response.NextToken;
                } while (nextToken);

            } catch (e) {
                console.error('Error scanning EC2:', e);
            }

            // 3. Scan ECS Services
            try {
                const ecsClient = new ECSClient({ region, credentials });
                let clusterArns: string[] = [];
                let nextToken: string | undefined = undefined;

                do {
                    const clustersResponse: ListClustersCommandOutput = await ecsClient.send(new ListClustersCommand({ nextToken }));
                    if (clustersResponse.clusterArns) {
                        clusterArns = [...clusterArns, ...clustersResponse.clusterArns];
                    }
                    nextToken = clustersResponse.nextToken;
                } while (nextToken);

                for (const clusterArn of clusterArns) {
                    const clusterName = clusterArn.split('/').pop() || clusterArn;
                    let serviceArns: string[] = [];
                    let servicesNextToken: string | undefined = undefined;

                    try {
                        do {
                            const servicesResponse: ListServicesCommandOutput = await ecsClient.send(new ListServicesCommand({
                                cluster: clusterArn,
                                nextToken: servicesNextToken,
                            }));
                            if (servicesResponse.serviceArns) {
                                serviceArns = [...serviceArns, ...servicesResponse.serviceArns];
                            }
                            servicesNextToken = servicesResponse.nextToken;
                        } while (servicesNextToken);

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
                                            clusterArn,
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
                        if (instance.Engine === 'docdb') return;

                        if (instance.DBInstanceIdentifier) {
                            resources.push({
                                id: instance.DBInstanceIdentifier,
                                type: 'rds',
                                name: instance.DBInstanceIdentifier,
                                arn: instance.DBInstanceArn || `arn:aws:rds:${region}:${accountId}:db:${instance.DBInstanceIdentifier}`,
                            });
                        }
                    });
                    marker = rdsResponse.Marker;
                } while (marker);

                let clusterMarker: string | undefined = undefined;
                do {
                    const docDbResponse: DescribeDBClustersCommandOutput = await rdsClient.send(new DescribeDBClustersCommand({
                        Marker: clusterMarker,
                        Filters: [{ Name: 'engine', Values: ['docdb'] }],
                    }));

                    docDbResponse.DBClusters?.forEach(cluster => {
                        if (cluster.DBClusterIdentifier) {
                            resources.push({
                                id: cluster.DBClusterIdentifier,
                                type: 'docdb',
                                name: cluster.DBClusterIdentifier,
                                arn: cluster.DBClusterArn || `arn:aws:rds:${region}:${accountId}:cluster:${cluster.DBClusterIdentifier}`,
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
                }

                const asgClient = new AutoScalingClient({ region, credentials });
                let nextToken: string | undefined = undefined;

                do {
                    const asgResponse: DescribeAutoScalingGroupsCommandOutput = await asgClient.send(new DescribeAutoScalingGroupsCommand({ NextToken: nextToken }));
                    asgResponse.AutoScalingGroups?.forEach(asg => {
                        if (asg.AutoScalingGroupName) {
                            if (asg.AutoScalingGroupARN && ecsCapacityProviderAsgArns.has(asg.AutoScalingGroupARN)) {
                                return;
                            }

                            resources.push({
                                id: asg.AutoScalingGroupName,
                                type: 'asg',
                                name: asg.AutoScalingGroupName,
                                arn: asg.AutoScalingGroupARN || `arn:aws:autoscaling:${region}:${accountId}:autoScalingGroup:uuid:autoScalingGroupName/${asg.AutoScalingGroupName}`,
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
                lastValidated: new Date().toISOString(),
            }, tenantId, true);

            return resources;

        } catch (error: any) {
            console.error('AccountService - Error scanning resources:', error);
            throw new Error(`Failed to scan resources: ${error.message}`);
        }
    }
}
