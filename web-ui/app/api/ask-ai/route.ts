import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, QueryVectorsCommand } from "@aws-sdk/client-s3vectors";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { streamText, Message } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

// ============================================================================
// AWS Clients
// ============================================================================

// Shared credential provider — supports IAM roles, SSO, env vars, ~/.aws/credentials
const credentialProvider = fromNodeProviderChain();

const bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION,
    credentials: credentialProvider,
});
const s3VectorsClient = new S3VectorsClient({
    region: process.env.AWS_REGION,
    credentials: credentialProvider,
});
const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: credentialProvider,
});

function getBedrockClient() {
    return createAmazonBedrock({
        region: process.env.AWS_REGION,
        credentialProvider: async () => {
            const creds = await credentialProvider();
            return {
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                sessionToken: creds.sessionToken,
            };
        },
    });
}

// ============================================================================
// Config
// ============================================================================

const EMBEDDING_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.titan-embed-text-v2:0";
const GENERATION_MODEL_ID = process.env.ASK_AI_GENERATION_MODEL || "global.anthropic.claude-sonnet-4-6";
const VECTOR_BUCKET_NAME = process.env.VECTOR_BUCKET_NAME;
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME;
const INVENTORY_TABLE_NAME = process.env.INVENTORY_TABLE_NAME || 'nucleus-app-inventory-table';

// In-memory conversation store (keyed by conversationId)
// For production, replace with DynamoDB-backed store
const conversationStore = new Map<string, Message[]>();
const MAX_CONVERSATION_TURNS = 10; // Keep last 10 user+assistant pairs

// Detect exhaustive listing queries — these need DynamoDB direct scan, not vector search
const EXHAUSTIVE_PATTERNS = /\b(list all|show all|all the|every|all accounts|all vpcs|all ec2|all rds|all resources|all subnets|all instances|give me all|fetch all|get all|display all|enumerate)\b/i;

function isExhaustiveQuery(prompt: string): boolean {
    return EXHAUSTIVE_PATTERNS.test(prompt);
}

// Detect which resource type the exhaustive query is about
function detectResourceType(prompt: string): string | undefined {
    const lower = prompt.toLowerCase();
    if (/vpc/.test(lower)) return 'ec2_vpcs';
    if (/subnet/.test(lower)) return 'ec2_subnets';
    if (/ec2|instance/.test(lower)) return 'ec2_instances';
    if (/rds|database/.test(lower)) return 'rds_instances';
    if (/lambda|function/.test(lower)) return 'lambda_functions';
    if (/s3|bucket/.test(lower)) return 's3_buckets';
    if (/security.?group/.test(lower)) return 'ec2_security_groups';
    if (/load.?balanc|alb|elb/.test(lower)) return 'elbv2_load_balancers';
    if (/nat.?gateway/.test(lower)) return 'ec2_nat_gateways';
    if (/transit.?gateway/.test(lower)) return 'ec2_transit_gateways';
    return undefined;
}

// ============================================================================
// Helper: DynamoDB exhaustive query — bypasses vector search topK=100 limit
// Used for "list all X" queries that need complete results across all accounts
// ============================================================================

interface DynamoResource {
    resourceId: string;
    resourceType: string;
    name: string;
    region: string;
    accountId: string;
    accountName?: string;
    state: string;
    service?: string;
    resourceArn: string;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
    text_content: string;
    distance: number;
}

async function queryDynamoExhaustive(
    resourceType: string | undefined,
    filters?: { accountId?: string; region?: string }
): Promise<DynamoResource[]> {
    const results: DynamoResource[] = [];
    let lastKey: Record<string, unknown> | undefined;
    const MAX_PAGES = 20; // cap at 20 pages × 100 items = 2000 resources max
    let pages = 0;

    console.log("[AskAI] DynamoDB exhaustive query", { resourceType, filters });

    do {
        let queryInput: Record<string, unknown>;

        if (resourceType) {
            // GSI3: RESOURCE_TYPE#{resourceType} → all items of that type
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                IndexName: 'GSI3',
                KeyConditionExpression: 'gsi3pk = :pk',
                ExpressionAttributeValues: { ':pk': { S: `RESOURCE_TYPE#${resourceType}` }, ':activeStatus': { S: 'active' } },
                FilterExpression: 'discoveryStatus = :activeStatus',
                Limit: 100,
            };
            if (filters?.accountId) {
                (queryInput.KeyConditionExpression as string) += ' AND begins_with(gsi3sk, :accountPrefix)';
                (queryInput.ExpressionAttributeValues as Record<string, unknown>)[':accountPrefix'] = { S: filters.accountId };
            }
        } else {
            // GSI1: all inventory items
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pk',
                ExpressionAttributeValues: { ':pk': { S: 'TYPE#INVENTORY' }, ':activeStatus': { S: 'active' } },
                FilterExpression: 'discoveryStatus = :activeStatus',
                Limit: 100,
            };
        }

        if (filters?.region) {
            queryInput.FilterExpression += ' AND #region = :region';
            (queryInput.ExpressionAttributeValues as Record<string, unknown>)[':region'] = { S: filters.region };
            queryInput.ExpressionAttributeNames = { '#region': 'region' };
        }

        if (lastKey) queryInput.ExclusiveStartKey = lastKey;

        const response = await dynamoClient.send(new QueryCommand(queryInput as Parameters<typeof dynamoClient.send>[0]['input']));
        const items = (response.Items || []).map(item => {
            const r = unmarshall(item);
            const meta = (r.Metadata || r.metadata || {}) as Record<string, unknown>;
            const metaText = Object.entries(meta)
                .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                .map(([k, v]) => `${k}=${v}`)
                .join(', ');
            return {
                resourceId: r.resourceId || '',
                resourceType: r.resourceType || '',
                name: r.name || r.resourceId || 'Unknown',
                region: r.region || '',
                accountId: r.accountId || '',
                accountName: r.accountName || '',
                state: r.state || '',
                service: r.service || '',
                resourceArn: r.resourceArn || '',
                metadata: meta,
                tags: r.tags || {},
                text_content: metaText.slice(0, 1000),
                distance: 0,
            };
        });

        results.push(...items);
        lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
        pages++;

        console.log("[AskAI] DynamoDB page", { page: pages, itemsThisPage: items.length, totalSoFar: results.length, hasMore: !!lastKey });
    } while (lastKey && pages < MAX_PAGES);

    console.log("[AskAI] DynamoDB exhaustive query complete", { totalResults: results.length, pages });
    return results;
}

// ============================================================================
// Helper: Generate embedding from Bedrock Titan
// ============================================================================

async function getEmbedding(text: string): Promise<number[]> {
    console.log("[AskAI] Embedding request", { textLength: text.length, textPreview: text.slice(0, 50) });
    const response = await bedrockClient.send(
        new InvokeModelCommand({
            modelId: EMBEDDING_MODEL_ID,
            body: JSON.stringify({ inputText: text.slice(0, 8000) }),
            contentType: "application/json",
            accept: "application/json",
        })
    );
    const bodyString = new TextDecoder().decode(response.body);
    const embedding = JSON.parse(bodyString).embedding;
    console.log("[AskAI] Embedding generated", { dimensions: embedding.length });
    return embedding;
}

// ============================================================================
// Helper: Query S3 Vectors for relevant resources
// ============================================================================

interface VectorSearchResult {
    resourceId: string;
    resourceType: string;
    name: string;
    region: string;
    accountId: string;
    state: string;
    service: string;
    resourceArn: string;
    text_content: string;
    accountName: string;
    distance: number;
}

async function searchVectors(
    queryVector: number[],
    topK: number = 50,
    filters?: { accountId?: string; region?: string; resourceType?: string },
    exhaustive: boolean = false
): Promise<VectorSearchResult[]> {
    // NOTE: resourceType is intentionally NOT used as a hard vector filter.
    // The grid's resourceType filter reflects what the user is viewing, not what they're asking about.
    // A user viewing EC2 instances may ask about VPCs — hard filtering would return 0 results.
    // resourceType is passed to the system prompt as context instead.
    const hardFilters = { accountId: filters?.accountId, region: filters?.region };

    console.log("[AskAI] Vector search starting", { topK, exhaustive, hardFilters, contextResourceType: filters?.resourceType, vectorDimensions: queryVector.length });

    if (!VECTOR_BUCKET_NAME || !VECTOR_INDEX_NAME) {
        throw new Error("Vector search is not configured (VECTOR_BUCKET_NAME or VECTOR_INDEX_NAME missing)");
    }

    const searchCommand = new QueryVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: VECTOR_INDEX_NAME,
        queryVector: { float32: queryVector },
        topK,
        returnMetadata: true,
        returnDistance: true,
    });

    console.log("[AskAI] Executing S3 Vectors query", { bucket: VECTOR_BUCKET_NAME, index: VECTOR_INDEX_NAME });
    const result = await s3VectorsClient.send(searchCommand);
    console.log("[AskAI] S3 Vectors query completed", { totalVectorsReturned: result.vectors?.length || 0 });

    const vectors = (result.vectors || [])
        .filter(v => {
            // For exhaustive queries, skip distance threshold — we want ALL matching resources
            if (!exhaustive) {
                const passesThreshold = !(v.distance !== undefined && v.distance > 0.9);
                if (!passesThreshold) {
                    console.log("[AskAI] Vector filtered by distance threshold", { distance: v.distance, threshold: 0.9 });
                    return false;
                }
            }
            // Only apply accountId and region as hard filters — resourceType is context only
            const meta = (v.metadata || {}) as Record<string, string>;
            if (hardFilters.accountId && meta.accountId !== hardFilters.accountId) {
                console.log("[AskAI] Vector filtered by accountId", { expected: hardFilters.accountId, actual: meta.accountId });
                return false;
            }
            if (hardFilters.region && meta.region !== hardFilters.region) {
                console.log("[AskAI] Vector filtered by region", { expected: hardFilters.region, actual: meta.region });
                return false;
            }
            return true;
        })
        .map(v => {
            const meta = (v.metadata || {}) as Record<string, string>;
            return {
                resourceId: meta.resourceId || "",
                resourceType: meta.resourceType || "",
                name: meta.name || meta.resourceId || "Unknown",
                region: meta.region || "",
                accountId: meta.accountId || "",
                state: meta.state || "",
                service: meta.service || "",
                resourceArn: meta.resourceArn || "",
                text_content: meta.text_content || "",
                accountName: meta.accountName || "",
                distance: v.distance ?? 1,
            };
        });

    console.log("[AskAI] Vector search filtering complete", {
        beforeFiltering: result.vectors?.length || 0,
        afterFiltering: vectors.length,
        avgDistance: vectors.length > 0 ? (vectors.reduce((sum, v) => sum + v.distance, 0) / vectors.length).toFixed(3) : "N/A",
        resourceTypes: [...new Set(vectors.map(v => v.resourceType))],
    });

    return vectors;
}

// ============================================================================
// Helper: Build RAG system prompt
// ============================================================================

function buildSystemPrompt(context: VectorSearchResult[], filters?: { accountId?: string; region?: string; resourceType?: string }): string {
    const contextText = context.length > 0
        ? context.map((r, i) =>
            `[${i + 1}] ${r.name} (${r.resourceType}) | ID: ${r.resourceId} | Region: ${r.region} | Account: ${r.accountName || r.accountId} (${r.accountId}) | State: ${r.state}\n    ${r.text_content}`
        ).join("\n")
        : "No matching resources found.";

    const activeFilters = [
        filters?.accountId ? `Account: ${filters.accountId}` : null,
        filters?.region ? `Region: ${filters.region}` : null,
        filters?.resourceType ? `Grid view filtered to: ${filters.resourceType}` : null,
    ].filter(Boolean).join(", ");

    return `You are an AWS cloud operations assistant for the Nucleus Platform. Answer questions about AWS resources using only the context below.
${activeFilters ? `\nUser's active inventory filters: ${activeFilters}\nNote: The user may ask about any resource type regardless of their current grid filter.\n` : ""}
Resources:
${contextText}

Rules:
- Use only the provided context. If the answer isn't there, say so.
- Cite resources by name and ID.
- Use markdown tables when listing multiple resources.
- For counts, count only listed resources.
- Be concise and actionable.`;
}

// ============================================================================
// POST /api/ask-ai
// ============================================================================

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // Support both useChat (messages array) and useCompletion (prompt string) formats
        const userMessages: Message[] = body.messages || [];
        const prompt: string = body.prompt || body.query || (userMessages.at(-1)?.content as string) || "";
        const conversationId: string = body.id || body.conversationId || "";
        const filters = body.filters as { accountId?: string; region?: string; resourceType?: string } | undefined;

        console.log("[AskAI] POST request received", {
            promptLength: prompt.length,
            promptPreview: prompt.slice(0, 80),
            conversationId: conversationId.slice(0, 20),
            filters,
            messageCount: userMessages.length,
            timestamp: new Date().toISOString(),
        });

        if (!prompt) {
            console.warn("[AskAI] Request rejected: empty prompt");
            return NextResponse.json({ error: "Query is required" }, { status: 400 });
        }

        if (!VECTOR_BUCKET_NAME || !VECTOR_INDEX_NAME) {
            console.error("[AskAI] Configuration error", { VECTOR_BUCKET_NAME, VECTOR_INDEX_NAME });
            return NextResponse.json(
                { error: "Vector search is not configured. Run a sync first or check deployment." },
                { status: 503 }
            );
        }

        // 1. Generate embedding for the user query
        console.log("[AskAI] Step 1: Generating embedding");
        const queryVector = await getEmbedding(prompt);

        // 2. Retrieve relevant resources
        // Exhaustive queries ("list all VPCs") → DynamoDB direct query (no topK limit)
        // Regular queries → S3 Vectors semantic search (topK=50)
        const exhaustive = isExhaustiveQuery(prompt);
        let searchResults: VectorSearchResult[];

        if (exhaustive) {
            const detectedType = detectResourceType(prompt);
            console.log("[AskAI] Step 2: Exhaustive DynamoDB query", { detectedType, filters });
            const dynamoResults = await queryDynamoExhaustive(detectedType, {
                accountId: filters?.accountId,
                region: filters?.region,
            });
            searchResults = dynamoResults as VectorSearchResult[];
        } else {
            console.log("[AskAI] Step 2: Searching vectors", { topK: 50 });
            searchResults = await searchVectors(queryVector, 50, filters, false);
        }

        console.log("[AskAI] Resource retrieval complete", {
            exhaustive,
            totalResults: searchResults.length,
            resourceTypes: [...new Set(searchResults.map(r => r.resourceType))],
            accounts: [...new Set(searchResults.map(r => r.accountId))],
            regions: [...new Set(searchResults.map(r => r.region))],
        });

        if (searchResults.length === 0) {
            console.warn("[AskAI] WARNING: No relevant resources found");
        }

        // 3. Build conversation history (multi-turn support)
        console.log("[AskAI] Step 3: Building conversation history");
        let conversationHistory: Message[] = [];
        if (conversationId) {
            conversationHistory = conversationStore.get(conversationId) || [];
            console.log("[AskAI] Retrieved stored conversation", { conversationId: conversationId.slice(0, 20), storedTurns: conversationHistory.length });
        }
        // useChat sends full history — use it (all except the latest user message)
        if (userMessages.length > 1) {
            conversationHistory = userMessages.slice(0, -1);
            console.log("[AskAI] Using useChat history", { userMessagesTurns: userMessages.length, historyTurns: conversationHistory.length });
        }

        // Map to CoreMessage format (role + content only, skip empty assistant messages)
        const coreHistory = conversationHistory
            .slice(-(MAX_CONVERSATION_TURNS * 2))
            .filter(m => m.content && typeof m.content === 'string' && (m.content as string).trim())
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

        console.log("[AskAI] Conversation history processed", { coreHistoryTurns: coreHistory.length, maxTurns: MAX_CONVERSATION_TURNS });

        // 4. Build system prompt with RAG context
        console.log("[AskAI] Step 4: Building system prompt");
        const systemPrompt = buildSystemPrompt(searchResults, filters);
        console.log("[AskAI] System prompt built", { promptLength: systemPrompt.length, contextResources: searchResults.length });

        // 5. Stream response via Bedrock
        console.log("[AskAI] Step 5: Starting LLM streaming", {
            model: GENERATION_MODEL_ID,
            temperature: 0.1,
            maxTokens: 4096,
            totalMessages: coreHistory.length + 1,
        });

        const result = streamText({
            model: getBedrockClient()(GENERATION_MODEL_ID),
            system: systemPrompt,
            messages: [
                ...coreHistory,
                { role: 'user', content: prompt },
            ],
            maxTokens: 4096,
            temperature: 0.1,
            onFinish: async ({ text }) => {
                console.log("[AskAI] LLM streaming finished", { responseLength: text.length, timestamp: new Date().toISOString() });
                if (conversationId) {
                    const now = Date.now();
                    const updatedHistory: Message[] = [
                        ...coreHistory.map((m, i) => ({ id: String(now - 1000 + i), role: m.role, content: m.content })),
                        { id: String(now), role: 'user', content: prompt },
                        { id: String(now + 1), role: 'assistant', content: text },
                    ];
                    conversationStore.set(
                        conversationId,
                        updatedHistory.slice(-(MAX_CONVERSATION_TURNS * 2))
                    );
                    console.log("[AskAI] Conversation stored", { conversationId: conversationId.slice(0, 20), totalTurns: updatedHistory.length });
                }
            },
        });

        // 6. Return streaming response with source citations as data annotations
        console.log("[AskAI] Step 6: Preparing response with sources");
        const sourcesLimit = exhaustive ? searchResults.length : 15;
        const sourcesJson = JSON.stringify(
            searchResults.slice(0, sourcesLimit).map(r => ({
                resourceId: r.resourceId,
                name: r.name,
                resourceType: r.resourceType,
                region: r.region,
                accountId: r.accountId,
                accountName: r.accountName,
                state: r.state,
                resourceArn: r.resourceArn,
                relevanceScore: Math.round((1 - r.distance) * 100),
            }))
        );

        console.log("[AskAI] Response prepared", { sourceCount: sourcesLimit, exhaustive, sourcesJsonLength: sourcesJson.length });

        const response = result.toTextStreamResponse({
            headers: {
                "X-AI-Sources": encodeURIComponent(sourcesJson),
            },
        });

        console.log("[AskAI] Response stream created and returned successfully");
        return response;

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        console.error("[AskAI] ERROR - Request failed", {
            message,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString(),
        });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
