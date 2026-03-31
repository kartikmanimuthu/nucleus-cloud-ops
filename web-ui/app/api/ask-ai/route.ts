import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { streamText, Message } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getInventoryRepository } from '@/lib/db/repository-factory';
import type { InventoryResource } from '@/lib/db/repositories/inventory/interface';

// ============================================================================
// AWS Clients
// ============================================================================

// Shared credential provider — supports IAM roles, SSO, env vars, ~/.aws/credentials
const credentialProvider = fromNodeProviderChain();

const bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION,
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

// In-memory conversation store (keyed by conversationId)
// For production, replace with DynamoDB-backed store
const conversationStore = new Map<string, Message[]>();
const MAX_CONVERSATION_TURNS = 10; // Keep last 10 user+assistant pairs

// Detect exhaustive listing queries — these use listResources (no topK limit), not vector search
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
// Helper: Build RAG system prompt
// ============================================================================

function buildSystemPrompt(
    resources: InventoryResource[],
    filters?: { accountId?: string; region?: string; resourceType?: string }
): string {
    const contextText = resources.length > 0
        ? resources.map((r, i) => {
            const metaText = Object.entries(r.metadata || {})
                .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')
                .slice(0, 500);
            return `[${i + 1}] ${r.name || r.resourceId} (${r.resourceType}) | ID: ${r.resourceId} | Region: ${r.region} | Account: ${r.accountId} | Status: ${r.status || 'unknown'}${metaText ? `\n    ${metaText}` : ''}`;
        }).join("\n")
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

        const repo = getInventoryRepository();
        const exhaustive = isExhaustiveQuery(prompt);
        let resources: InventoryResource[];

        if (exhaustive) {
            // 1. Exhaustive query — list all resources of detected type (no vector needed)
            const detectedType = detectResourceType(prompt);
            console.log("[AskAI] Step 1+2: Exhaustive listResources query", { detectedType, filters });
            const page = await repo.listResources({
                tenantId: 'default',
                accountId: filters?.accountId,
                region: filters?.region,
                resourceType: detectedType,
                limit: 2000,
            });
            resources = page.resources;
            console.log("[AskAI] Exhaustive query complete", { totalResults: resources.length });
        } else {
            // 1. Generate embedding for semantic search
            console.log("[AskAI] Step 1: Generating embedding");
            const queryVector = await getEmbedding(prompt);

            // 2. Semantic vector search via pgvector
            console.log("[AskAI] Step 2: Searching vectors via pgvector", { topK: 50 });
            const vectorResults = await repo.searchByVector('default', queryVector, 50, {
                accountId: filters?.accountId,
                region: filters?.region,
            });
            resources = vectorResults.map((r) => r.resource);
            console.log("[AskAI] Vector search complete", { totalResults: resources.length });
        }

        console.log("[AskAI] Resource retrieval complete", {
            exhaustive,
            totalResults: resources.length,
            resourceTypes: [...new Set(resources.map(r => r.resourceType))],
            accounts: [...new Set(resources.map(r => r.accountId))],
            regions: [...new Set(resources.map(r => r.region))],
        });

        if (resources.length === 0) {
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
        const systemPrompt = buildSystemPrompt(resources, filters);
        console.log("[AskAI] System prompt built", { promptLength: systemPrompt.length, contextResources: resources.length });

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

        // 6. Return streaming response with source citations
        console.log("[AskAI] Step 6: Preparing response with sources");
        const sourcesLimit = exhaustive ? resources.length : 15;
        const sourcesJson = JSON.stringify(
            resources.slice(0, sourcesLimit).map(r => ({
                resourceId: r.resourceId,
                name: r.name || r.resourceId,
                resourceType: r.resourceType,
                region: r.region,
                accountId: r.accountId,
                state: r.status,
                relevanceScore: exhaustive ? 100 : undefined,
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
