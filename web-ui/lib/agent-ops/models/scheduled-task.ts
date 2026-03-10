/**
 * Scheduled Task — Dynamoose Model
 *
 * Same AgentOpsTable, single-table design.
 * PK: TENANT#<tenantId>  |  SK: SCHED#<taskId>
 * GSI1PK: TYPE#SCHEDULED_TASK | GSI1SK: <tenantId>#<taskId>
 */

import dynamoose, { AGENT_OPS_TABLE_NAME } from '../dynamoose-config';

const ScheduledTaskSchema = new dynamoose.Schema(
    {
        PK: { type: String, hashKey: true },
        SK: { type: String, rangeKey: true },
        GSI1PK: {
            type: String,
            index: { name: 'GSI1', type: 'global', rangeKey: 'GSI1SK' },
        },
        GSI1SK: { type: String },
        taskId: { type: String, required: true },
        tenantId: { type: String, required: true },
        name: { type: String, required: true },
        description: { type: String, required: true },
        cronExpression: { type: String, required: true },
        timezone: { type: String, required: true },
        taskStatus: {
            type: String,
            enum: ['active', 'paused', 'deleted'],
            required: true,
            default: 'active',
        },
        mode: { type: String, enum: ['plan', 'fast'], required: true, default: 'plan' },
        autoApprove: { type: Boolean, required: true, default: false },
        model: { type: String },
        accountId: { type: String },
        accountName: { type: String },
        mcpServerIds: { type: Array, schema: [String] },
        notification: {
            type: Object,
            schema: {
                type: String,
                channelId: String,
                channelName: String,
                projectKey: String,
                issueKey: String,
            },
        },
        lastRunId: { type: String },
        lastRunAt: { type: String },
        lastRunStatus: { type: String },
        nextRunAt: { type: String },
        runCount: { type: Number, required: true, default: 0 },
        createdAt: { type: String, required: true },
        updatedAt: { type: String, required: true },
        createdBy: { type: String, required: true },
        ttl: { type: Number },
    },
    { timestamps: false, saveUnknown: false }
);

export const ScheduledTaskModel = dynamoose.model(
    AGENT_OPS_TABLE_NAME,
    ScheduledTaskSchema,
    { create: false, tableName: AGENT_OPS_TABLE_NAME }
);
