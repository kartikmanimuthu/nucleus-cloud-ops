/**
 * Agent Ops Run — Dynamoose Model
 *
 * Single-table design with multi-tenancy.
 * PK: TENANT#<tenantId>  |  SK: RUN#<runId>
 * GSI1PK: SOURCE#<source> | GSI1SK: <timestamp>#<runId>
 */

import dynamoose from '../dynamoose-config';
import { AGENT_OPS_TABLE_NAME } from '../dynamoose-config';

// ─── Exported Interfaces ───────────────────────────────────────────────

export interface SlackTriggerMeta {
    userId: string;
    userName?: string;
    channelId: string;
    channelName?: string;
    responseUrl: string;
    teamId?: string;
    threadTs?: string;
}

export interface AgentOpsRun {
    PK: string;                  // TENANT#<tenantId>
    SK: string;                  // RUN#<runId>
    GSI1PK: string;              // SOURCE#<source>
    GSI1SK: string;              // <timestamp>#<runId>
    runId: string;               // UUID v4
    tenantId: string;            // Slack team_id
    source: 'slack' | 'jira' | 'api';
    status: 'queued' | 'in_progress' | 'awaiting_input' | 'completed' | 'failed';
    taskDescription: string;
    mode: 'plan' | 'fast';
    threadId: string;            // agent-ops-<runId>
    trigger: SlackTriggerMeta;
    result?: {
        summary: string;
        toolsUsed: string[];
        iterations: number;
    };
    clarification?: {
        question: string;
        missingInfo: string;
    };
    error?: string;
    createdAt: string;           // ISO 8601
    updatedAt: string;
    completedAt?: string;
    durationMs?: number;
    ttl: number;                 // Unix epoch + 30 days
}

// ─── Dynamoose Schema ──────────────────────────────────────────────────

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
            enum: ['queued', 'in_progress', 'awaiting_input', 'completed', 'failed'],
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
        threadId: {
            type: String,
            required: true,
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
        mcpServerIds: {
            type: Array,
            schema: [String],
        },
        trigger: {
            type: Object,
            // Flexible schema — supports SlackTriggerMeta, JiraTriggerMeta, and ApiTriggerMeta
            schema: {
                // Slack fields
                userId: String,
                userName: String,
                channelId: String,
                channelName: String,
                responseUrl: String,
                teamId: String,
                threadTs: String,   // Slack thread timestamp for HIL reply correlation
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
        clarification: {
            type: Object,
            schema: {
                question: String,
                missingInfo: String,
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
        ttl: {
            type: Number,
            required: true,
        },
    },
    {
        timestamps: false,
        saveUnknown: false,
    }
);

// ─── Model ─────────────────────────────────────────────────────────────

export const AgentOpsRunModel = dynamoose.model(
    AGENT_OPS_TABLE_NAME,
    AgentOpsRunSchema,
    {
        create: false, // Table is created by CDK
        tableName: AGENT_OPS_TABLE_NAME,
    }
);
