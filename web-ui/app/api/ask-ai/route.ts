import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, QueryVectorsCommand } from "@aws-sdk/client-s3vectors";
import { streamText } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Message } from 'ai';

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

// In-memory conversation store (keyed by conversationId)
// For production, replace with DynamoDB-backed store
const conversationStore = new Map<string, Message[]>();
const MAX_CONVERSATION_TURNS = 10; // Keep last 10 user+assistant pairs

// ============================================================================
// Helper: Generate embedding from Bedrock Titan
// ============================================================================

async function getEmbedding(text: string): Promise<number[]> {
    const response = await bedrockClient.send(
        new InvokeModelCommand({
            modelId: EMBEDDING_MODEL_ID,
            body: JSON.stringify({ inputText: text.slice(0, 8000) }),
            contentType: "application/json",
            accept: "application/json",
        })
    );
    const bodyString = new TextDecoder().decode(response.body);
    return JSON.parse(bodyString).embedding;
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
    distance: number;
}

async function searchVectors(
    queryVector: number[],
    topK: number = 10,
    filters?: { accountId?: string; region?: string; resourceType?: string }
): Promise<VectorSearchResult[]> {
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

    const result = await s3VectorsClient.send(searchCommand);

    const vectors = (result.vectors || [])
        .filter(v => {
            // Apply relevance threshold — discard low-quality matches
            if (v.distance !== undefined && v.distance > 0.7) return false;
            // Apply metadata filters
            const meta = (v.metadata || {}) as Record<string, string>;
            if (filters?.accountId && meta.accountId !== filters.accountId) return false;
            if (filters?.region && meta.region !== filters.region) return false;
            if (filters?.resourceType && meta.resourceType !== filters.resourceType) return false;
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
                distance: v.distance ?? 1,
            };
        });

    return vectors;
}

// ============================================================================
// Helper: Build RAG system prompt
// ============================================================================

function buildSystemPrompt(
    context: VectorSearchResult[],
    filters?: { accountId?: string; region?: string; resourceType?: string }
): string {
    const filterDesc = [
        filters?.accountId ? `Account: ${filters.accountId}` : null,
        filters?.region ? `Region: ${filters.region}` : null,
        filters?.resourceType ? `Resource type: ${filters.resourceType}` : null,
    ].filter(Boolean).join(", ");

    const contextText = context.length > 0
        ? context.map((r, i) =>
            `[${i + 1}] ${r.name} (${r.resourceType})\n` +
            `    ID: ${r.resourceId} | Region: ${r.region} | Account: ${r.accountId} | State: ${r.state}\n` +
            `    ${r.text_content}`
        ).join("\n\n")
        : "No matching resources found in the vector index.";

    return `You are an expert AWS cloud operations assistant for the Nucleus Platform.
You help engineers understand and manage their AWS resources across multiple accounts.

${filterDesc ? `The user is currently filtering by: ${filterDesc}\n\n` : ""}Context — Relevant AWS Resources:
${contextText}

Guidelines:
- Answer based strictly on the provided context. Do not hallucinate resource details.
- Cite resources by name and ID (e.g., "my-ec2-instance (i-1234567890abcdef0)").
- Use markdown tables for listing multiple resources.
- For count/aggregate questions, count only the resources listed in the context.
- If the answer is not in the context, say so clearly and suggest using filters or running a new sync.
- Keep answers concise and actionable for a cloud operations engineer.`;
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

        if (!prompt) {
            return NextResponse.json({ error: "Query is required" }, { status: 400 });
        }

        if (!VECTOR_BUCKET_NAME || !VECTOR_INDEX_NAME) {
            console.error("Missing vector configuration", { VECTOR_BUCKET_NAME, VECTOR_INDEX_NAME });
            return NextResponse.json(
                { error: "Vector search is not configured. Run a sync first or check deployment." },
                { status: 503 }
            );
        }

        // 1. Generate embedding for the user query
        const queryVector = await getEmbedding(prompt);

        // 2. Vector search — find semantically relevant resources
        const searchResults = await searchVectors(queryVector, 10, filters);
        console.log(`[AskAI] Found ${searchResults.length} relevant resources for: "${prompt.slice(0, 80)}"`);

        // 3. Build conversation history (multi-turn support)
        let conversationHistory: Message[] = [];
        if (conversationId) {
            conversationHistory = conversationStore.get(conversationId) || [];
        }
        // useChat sends full history — use it (all except the latest user message)
        if (userMessages.length > 1) {
            conversationHistory = userMessages.slice(0, -1);
        }

        // Map to CoreMessage format (role + content only, skip empty assistant messages)
        const coreHistory = conversationHistory
            .slice(-(MAX_CONVERSATION_TURNS * 2))
            .filter(m => m.content && typeof m.content === 'string' && (m.content as string).trim())
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

        // 4. Build system prompt with RAG context
        const systemPrompt = buildSystemPrompt(searchResults, filters);

        // 5. Stream response via Bedrock
        const result = streamText({
            model: getBedrockClient()(GENERATION_MODEL_ID),
            system: systemPrompt,
            messages: [
                ...coreHistory,
                { role: 'user', content: prompt },
            ],
            maxTokens: 1500,
            temperature: 0.1,
            onFinish: async ({ text }) => {
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
                }
            },
        });

        // 6. Return streaming response with source citations as data annotations
        const sourcesJson = JSON.stringify(
            searchResults.slice(0, 5).map(r => ({
                resourceId: r.resourceId,
                name: r.name,
                resourceType: r.resourceType,
                region: r.region,
                accountId: r.accountId,
                state: r.state,
                resourceArn: r.resourceArn,
                relevanceScore: Math.round((1 - r.distance) * 100),
            }))
        );

        const response = result.toTextStreamResponse({
            headers: {
                "X-AI-Sources": encodeURIComponent(sourcesJson),
            },
        });

        return response;

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        console.error("[AskAI] Error:", error);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
