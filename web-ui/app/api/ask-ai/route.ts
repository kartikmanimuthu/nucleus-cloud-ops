
import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, QueryVectorsCommand } from "@aws-sdk/client-s3vectors";
import { streamText } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

// Initialize Clients
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const s3VectorsClient = new S3VectorsClient({ region: process.env.AWS_REGION });

// Bedrock Provider for AI SDK
const bedrock = createAmazonBedrock({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
});

const EMBEDDING_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.titan-embed-text-v2:0";
const GENERATION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0";
const VECTOR_BUCKET_NAME = process.env.VECTOR_BUCKET_NAME;
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME;

// Helper to generate embedding
async function getEmbedding(text: string): Promise<number[]> {
    const command = new InvokeModelCommand({
        modelId: EMBEDDING_MODEL_ID,
        body: JSON.stringify({ inputText: text.slice(0, 8000) }),
        contentType: "application/json",
        accept: "application/json",
    });

    const response = await bedrockClient.send(command);
    const bodyString = new TextDecoder().decode(response.body);
    const responseBody = JSON.parse(bodyString);
    return responseBody.embedding;
}

export async function POST(req: NextRequest) {
    try {
        const { query, prompt } = await req.json();
        const userInput = prompt || query;

        if (!userInput) {
            return NextResponse.json({ error: "Query/Prompt is required" }, { status: 400 });
        }

        if (!VECTOR_BUCKET_NAME || !VECTOR_INDEX_NAME) {
            console.error("Missing Vector Configuration", { VECTOR_BUCKET_NAME, VECTOR_INDEX_NAME });
            return NextResponse.json({ error: "Vector search is not configured" }, { status: 503 });
        }

        // 1. Generate Embedding
        const queryVector = await getEmbedding(userInput);
        console.log("Vector Configuration", { VECTOR_BUCKET_NAME, VECTOR_INDEX_NAME });

        // 2. Query S3 Vectors
        // Note: s3vectors is in preview, verify command signature if it fails
        const searchCommand = new QueryVectorsCommand({
            vectorBucketName: VECTOR_BUCKET_NAME,
            indexName: VECTOR_INDEX_NAME,
            queryVector: { float32: queryVector },
            topK: 5,
            returnMetadata: true,
            returnDistance: true
        });

        const searchResult = await s3VectorsClient.send(searchCommand);

        // 3. Construct Context
        const contextParts = searchResult.vectors?.map(v => {
            const meta = (v.metadata || {}) as any;
            return `[Resource: ${meta.title || meta.name || 'Unknown'} (${meta.resourceType || 'Unknown'})]\n${meta.text_content || ''}`;
        }) || [];

        const context = contextParts.join("\n\n---\n\n");
        console.log("Context>>>>>>>>>>:", context);
        // 4. Generate Response with Stream
        const systemPrompt = `You are a helpful AI assistant for the Nucleus Platform inventory system. 
You have access to a knowledge base of AWS resources (EC2, RDS, S3, etc.) and their configurations.
Answer the user's question based strictly on the provided context.
The context contains details about resources, their tags, region, and status.
If the answer is not in the context, politely say so.
Keep the answer concise and relevant to cloud operations.

Context:
${context}
`;

        const result = streamText({
            model: bedrock(GENERATION_MODEL_ID),
            system: systemPrompt,
            messages: [{ role: 'user', content: userInput }],
            maxTokens: 1000,
            temperature: 0.1,
        });

        return result.toDataStreamResponse();

    } catch (error: any) {
        console.error("Ask AI Error:", error);
        return NextResponse.json(
            { error: error.message || "Internal Server Error" },
            { status: 500 }
        );
    }
}
