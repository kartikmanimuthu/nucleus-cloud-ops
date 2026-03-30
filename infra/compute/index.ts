import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Phase 7+: Networking stack is deployed — use requireOutput() to enforce dependency.
// requireOutput() throws at preview time if networking stack is not deployed,
// preventing silent undefined values from propagating into compute resources.

// StackReference to networking project.
// Format for S3 backend: "organization/<project>/<stack>" (literal "organization" required)
const networking = new pulumi.StackReference("organization/nucleus-networking/prod");

// Networking outputs — all required (networking must be deployed before compute can preview)
const vpcId = networking.requireOutput("vpcId") as pulumi.Output<string>;
const vpcCidr = networking.requireOutput("vpcCidr") as pulumi.Output<string>;
const privateSubnetIds = networking.requireOutput("privateSubnetIds") as pulumi.Output<string[]>;
const publicSubnetIds = networking.requireOutput("publicSubnetIds") as pulumi.Output<string[]>;
const databaseSubnetIds = networking.requireOutput("databaseSubnetIds") as pulumi.Output<string[]>;
const intraSubnetIds = networking.requireOutput("intraSubnetIds") as pulumi.Output<string[]>;
const availabilityZones = networking.requireOutput("availabilityZones") as pulumi.Output<string[]>;
const dbSubnetGroupName = networking.requireOutput("dbSubnetGroupName") as pulumi.Output<string>;
const cacheSubnetGroupName = networking.requireOutput("cacheSubnetGroupName") as pulumi.Output<string>;

// ============================================================================
// DYNAMODB TABLES
// ============================================================================

const appName = "nucleus-cloud-ops";
const webUiStackName = "nucleus-cloud-ops-web-ui";

// 1. AppTable — single-table design (accounts, schedules, resources)
const appTable = new aws.dynamodb.Table("appTable", {
    name: "nucleus-cloud-ops-app-table",
    hashKey: "pk",
    rangeKey: "sk",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
        { name: "gsi1pk", type: "S" },
        { name: "gsi1sk", type: "S" },
        { name: "gsi2pk", type: "S" },
        { name: "gsi2sk", type: "S" },
        { name: "gsi3pk", type: "S" },
        { name: "gsi3sk", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
        },
        {
            name: "GSI2",
            hashKey: "gsi2pk",
            rangeKey: "gsi2sk",
            projectionType: "ALL",
        },
        {
            name: "GSI3",
            hashKey: "gsi3pk",
            rangeKey: "gsi3sk",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 2. AuditTable — immutable audit logs with 30-day TTL via expire_at
const auditTable = new aws.dynamodb.Table("auditTable", {
    name: "nucleus-cloud-ops-audit-table",
    hashKey: "pk",
    rangeKey: "sk",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
        { name: "gsi1pk", type: "S" },
        { name: "gsi1sk", type: "S" },
        { name: "gsi2pk", type: "S" },
        { name: "gsi2sk", type: "S" },
        { name: "gsi3pk", type: "S" },
        { name: "gsi3sk", type: "S" },
    ],
    ttl: { attributeName: "expire_at", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
        },
        {
            name: "GSI2",
            hashKey: "gsi2pk",
            rangeKey: "gsi2sk",
            projectionType: "ALL",
        },
        {
            name: "GSI3",
            hashKey: "gsi3pk",
            rangeKey: "gsi3sk",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 3. InventoryTable — auto-discovery single-table design
const inventoryTable = new aws.dynamodb.Table("inventoryTable", {
    name: "nucleus-cloud-ops-inventory-table",
    hashKey: "pk",
    rangeKey: "sk",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
        { name: "gsi1pk", type: "S" },
        { name: "gsi1sk", type: "S" },
        { name: "gsi2pk", type: "S" },
        { name: "gsi2sk", type: "S" },
        { name: "gsi3pk", type: "S" },
        { name: "gsi3sk", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
        },
        {
            name: "GSI2",
            hashKey: "gsi2pk",
            rangeKey: "gsi2sk",
            projectionType: "ALL",
        },
        {
            name: "GSI3",
            hashKey: "gsi3pk",
            rangeKey: "gsi3sk",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 4. UsersTeamsTable — RBAC users and teams (uppercase PK/SK)
const usersTeamsTable = new aws.dynamodb.Table("usersTeamsTable", {
    name: "nucleus-cloud-ops-web-ui-users-teams",
    hashKey: "PK",
    rangeKey: "SK",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "PK", type: "S" },
        { name: "SK", type: "S" },
        { name: "EntityType", type: "S" },
    ],
    globalSecondaryIndexes: [
        {
            name: "EntityTypeIndex",
            hashKey: "EntityType",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 5. CheckpointTable — LangGraph checkpoint state
const checkpointTable = new aws.dynamodb.Table("checkpointTable", {
    name: "nucleus-cloud-ops-checkpoints-table",
    hashKey: "thread_id",
    rangeKey: "checkpoint_id",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "thread_id", type: "S" },
        { name: "checkpoint_id", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 6. WritesTable — LangGraph pending writes (v2 schema)
const writesTable = new aws.dynamodb.Table("writesTable", {
    name: "nucleus-cloud-ops-checkpoint-writes-v2-table",
    hashKey: "thread_id_checkpoint_id_checkpoint_ns",
    rangeKey: "task_id_idx",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "thread_id_checkpoint_id_checkpoint_ns", type: "S" },
        { name: "task_id_idx", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 7. ChatHistoryTable — DynamoDBChatMessageHistory per user/session
const chatHistoryTable = new aws.dynamodb.Table("chatHistoryTable", {
    name: "nucleus-cloud-ops-chat-history",
    hashKey: "userId",
    rangeKey: "sessionId",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "userId", type: "S" },
        { name: "sessionId", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 8. MemoryTable — DynamoDBStore long-term agent memory
const memoryTable = new aws.dynamodb.Table("memoryTable", {
    name: "nucleus-cloud-ops-memory",
    hashKey: "user_id",
    rangeKey: "namespace_key",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "user_id", type: "S" },
        { name: "namespace_key", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 9. AgentOpsTable — background agent execution runs + events (uppercase PK/SK)
const agentOpsTable = new aws.dynamodb.Table("agentOpsTable", {
    name: "nucleus-cloud-ops-agent-ops",
    hashKey: "PK",
    rangeKey: "SK",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "PK", type: "S" },
        { name: "SK", type: "S" },
        { name: "GSI1PK", type: "S" },
        { name: "GSI1SK", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "GSI1PK",
            rangeKey: "GSI1SK",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// ============================================================================
// STACK OUTPUTS
// ============================================================================

export const networkingVpcId = vpcId;
export const networkingVpcCidr = vpcCidr;

// DynamoDB table name exports (for Phase 9/10 consumption via requireOutput)
export const appTableName = appTable.name;
export const auditTableName = auditTable.name;
export const inventoryTableName = inventoryTable.name;
export const usersTeamsTableName = usersTeamsTable.name;
export const checkpointTableName = checkpointTable.name;
export const writesTableName = writesTable.name;
export const chatHistoryTableName = chatHistoryTable.name;
export const memoryTableName = memoryTable.name;
export const agentOpsTableName = agentOpsTable.name;
