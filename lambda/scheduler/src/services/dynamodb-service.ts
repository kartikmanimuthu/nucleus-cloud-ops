// DynamoDB service for the scheduler Lambda
// Uses AWS SDK v3 with separate app and audit tables

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand,
    type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '../utils/logger.js';
import type { Schedule, Account, AuditLogEntry } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { calculateTTL } from '../utils/time-utils.js';

// Environment variables
const APP_TABLE_NAME = process.env.APP_TABLE_NAME || 'cost-optimization-scheduler-app-table';
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME || 'cost-optimization-scheduler-audit-table';
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

// Singleton DynamoDB client
let docClient: DynamoDBDocumentClient | null = null;

export function getDynamoDBClient(): DynamoDBDocumentClient {
    if (!docClient) {
        const clientConfig: any = { region: AWS_REGION };

        // Use defaultProvider which correctly handles environment, shared config, and SSO
        // We pass the profile explicitly if it's set in the environment to be extra safe
        clientConfig.credentials = defaultProvider({
            profile: process.env.AWS_PROFILE,
        });

        const client = new DynamoDBClient(clientConfig);
        docClient = DynamoDBDocumentClient.from(client, {
            marshallOptions: {
                removeUndefinedValues: true,
            },
        });
    }
    return docClient;
}

/**
 * Fetch all active schedules from the app table
 * Uses GSI3: STATUS#active
 */
export async function fetchActiveSchedules(): Promise<Schedule[]> {
    const client = getDynamoDBClient();

    const params: QueryCommandInput = {
        TableName: APP_TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :statusVal',
        ExpressionAttributeValues: {
            ':statusVal': 'STATUS#active',
        },
    };

    try {
        const response = await client.send(new QueryCommand(params));
        logger.debug(`Fetched ${response.Items?.length || 0} active schedules via GSI3`);
        return (response.Items || []) as Schedule[];
    } catch (error) {
        logger.error('Error fetching schedules from DynamoDB via GSI3', error);
        // Fallback to GSI1 + Filter if GSI3 fails or is not yet populated correctly
        try {
            const fallbackParams: QueryCommandInput = {
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :typeVal',
                FilterExpression: 'active = :activeVal',
                ExpressionAttributeValues: {
                    ':typeVal': 'TYPE#SCHEDULE',
                    ':activeVal': true,
                },
            };
            const fallbackResponse = await client.send(new QueryCommand(fallbackParams));
            logger.warn('Fallback: Fetched schedules via GSI1');
            return (fallbackResponse.Items || []) as Schedule[];
        } catch (fallbackError) {
            logger.error('Fallback fetch also failed', fallbackError);
            return [];
        }
    }
}

/**
 * Fetch a specific schedule by ID
 * Since we don't know the accountId in partial scan mode (from UI trigger),
 * we must use GSI3 to find the record by scheduleId.
 */
export async function fetchScheduleById(scheduleId: string, tenantId = 'default'): Promise<Schedule | null> {
    const client = getDynamoDBClient();

    // Strategy: Search GSI3 for both active and inactive status
    const statuses = ['active', 'inactive'];

    for (const status of statuses) {
        try {
            const response = await client.send(new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI3',
                KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk = :gsi3sk',
                ExpressionAttributeValues: {
                    ':gsi3pk': `STATUS#${status}`,
                    ':gsi3sk': `TENANT#${tenantId}#SCHEDULE#${scheduleId}`,
                },
            }));

            if (response.Items && response.Items.length > 0) {
                return response.Items[0] as Schedule;
            }
        } catch (error) {
            logger.error(`Error searching GSI3 for status: ${status}`, error, { scheduleId });
        }
    }

    logger.warn('Schedule not found in GSI3', { scheduleId, tenantId });
    return null;
}

/**
 * Fetch all active accounts from the app table
 * Uses GSI3: STATUS#active
 */
export async function fetchActiveAccounts(): Promise<Account[]> {
    const client = getDynamoDBClient();

    const params: QueryCommandInput = {
        TableName: APP_TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :statusVal',
        FilterExpression: '#type = :typeVal',
        ExpressionAttributeNames: {
            '#type': 'type',
        },
        ExpressionAttributeValues: {
            ':statusVal': 'STATUS#active',
            ':typeVal': 'account',
        },
    };

    try {
        const response = await client.send(new QueryCommand(params));
        logger.debug(`Fetched ${response.Items?.length || 0} active accounts via GSI3`);
        return (response.Items || []) as Account[];
    } catch (error) {
        logger.error('Error fetching accounts from DynamoDB via GSI3', error);
        // Fallback to GSI1
        try {
            const fallbackParams: QueryCommandInput = {
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :typeVal',
                FilterExpression: 'active = :activeVal',
                ExpressionAttributeValues: {
                    ':typeVal': 'TYPE#ACCOUNT',
                    ':activeVal': true,
                },
            };
            const response = await client.send(new QueryCommand(fallbackParams));
            return (response.Items || []) as Account[];
        } catch (fallbackError) {
            logger.error('Fallback account fetch failed', fallbackError);
            return [];
        }
    }
}

/**
 * Create an audit log entry in the audit table
 * Used for system cron events and scheduler lifecycle logs
 */
export async function createAuditLog(entry: AuditLogEntry): Promise<void> {
    if (!AUDIT_TABLE_NAME) {
        logger.warn('AUDIT_TABLE_NAME not configured, skipping audit log');
        return;
    }

    const client = getDynamoDBClient();
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    const ttl = calculateTTL(90); // Audit logs kept for 90 days

    const item = {
        pk: `LOG#${id}`,
        sk: timestamp,
        gsi1pk: 'TYPE#LOG',
        gsi1sk: timestamp,
        ttl,
        id,
        timestamp,
        ...entry,
    };

    try {
        await client.send(new PutCommand({
            TableName: AUDIT_TABLE_NAME,
            Item: item,
        }));
        logger.debug('Audit log created', { id, eventType: entry.eventType });
    } catch (error) {
        logger.error('Failed to create audit log', error);
    }
}

export { APP_TABLE_NAME, AUDIT_TABLE_NAME, AWS_REGION };
