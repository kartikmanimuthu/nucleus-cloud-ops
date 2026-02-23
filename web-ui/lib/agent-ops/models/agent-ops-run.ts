/**
 * Agent Ops Run — Dynamoose Model
 * 
 * Single-table design with multi-tenancy.
 * PK: TENANT#<tenantId>  |  SK: RUN#<runId>
 * GSI1PK: SOURCE#<source> | GSI1SK: <timestamp>#<runId>
 */

import dynamoose from '../dynamoose-config';
import { AGENT_OPS_TABLE_NAME } from '../dynamoose-config';
import { Item } from 'dynamoose/dist/Item';

const AgentOpsRunSchema = new dynamoose.Schema(
    {
        PK: {
            type: String,
            hashKey: true,
        },
        SK: {
            type: String,
            rangeKey: true,
        },
        GSI1PK: {
            type: String,
            index: {
                name: 'GSI1',
                type: 'global',
                rangeKey: 'GSI1SK',
            },
        },
        GSI1SK: {
            type: String,
        },
        runId: {
            type: String,
            required: true,
        },
        tenantId: {
            type: String,
            required: true,
        },
        source: {
            type: String,
            enum: ['slack', 'jira', 'api'],
            required: true,
        },
        status: {
            type: String,
            enum: ['queued', 'in_progress', 'completed', 'failed'],
            required: true,
            default: 'queued',
        },
        taskDescription: {
            type: String,
            required: true,
        },
        mode: {
            type: String,
            enum: ['plan', 'fast'],
            required: true,
            default: 'plan',
        },
        accountId: {
            type: String,
        },
        accountName: {
            type: String,
        },
        selectedSkill: {
            type: String,
        },
        threadId: {
            type: String,
            required: true,
        },
        trigger: {
            type: Object,
            schema: {
                // Slack fields
                userId: String,
                userName: String,
                channelId: String,
                channelName: String,
                responseUrl: String,
                teamId: String,
                // Jira fields
                issueKey: String,
                projectKey: String,
                reporter: String,
                issueType: String,
                webhookId: String,
                // API fields
                apiKeyId: String,
                callbackUrl: String,
                clientId: String,
            },
        },
        result: {
            type: Object,
            schema: {
                summary: String,
                toolsUsed: {
                    type: Array,
                    schema: [String],
                },
                iterations: Number,
                artifacts: {
                    type: Array,
                    schema: [String],
                },
            },
        },
        error: {
            type: String,
        },
        createdAt: {
            type: String,
            required: true,
        },
        updatedAt: {
            type: String,
            required: true,
        },
        completedAt: {
            type: String,
        },
        durationMs: {
            type: Number,
        },
    },
    {
        timestamps: false,
        saveUnknown: false,
    }
);

export const AgentOpsRunModel = dynamoose.model(
    AGENT_OPS_TABLE_NAME,
    AgentOpsRunSchema,
    {
        create: false, // Table is created by CDK
        tableName: AGENT_OPS_TABLE_NAME,
    }
);
