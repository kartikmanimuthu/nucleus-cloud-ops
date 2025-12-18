import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { streamText, convertToCoreMessages } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

const bedrock = createAmazonBedrock({
    region: 'us-east-1',
});

export async function POST(req: Request) {
    const body = await req.json();
    const { messages } = body;

    if (!messages || !Array.isArray(messages)) {
        return new Response('Missing or invalid messages', { status: 400 });
    }

    try {
        const result = await streamText({
            model: bedrock('global.anthropic.claude-haiku-4-5-20251001-v1:0'),
            messages: convertToCoreMessages(messages),
            system: `You are an expert DevOps Agent for the Nucleus Platform.
            
            Currently, your tool capabilities are disabled for maintenance. 
            You can answer general questions about AWS, DevOps best practices, and help the user plan their specific cost optimization strategies.
            
            If the user asks to list resources or perform actions, politely explain that your direct access to their AWS account is currently paused, but you can help them draft the CLI commands or code they would need to run themselves.
            `,
            providerOptions: {
                bedrock: {
                    reasoningConfig: { type: 'enabled', budgetTokens: 1024 },
                },
            },
        } as any);

        // Robust fallback for stream response generation across AI SDK versions
        const streamResult = result as any;

        if (typeof streamResult.toDataStreamResponse === 'function') {
            return streamResult.toDataStreamResponse();
        }

        if (typeof streamResult.toUIMessageStreamResponse === 'function') {
            return streamResult.toUIMessageStreamResponse();
        }

        if (typeof streamResult.toTextStreamResponse === 'function') {
            console.warn('toDataStreamResponse/toUIMessageStreamResponse missing, using toTextStreamResponse (tools may not stream correctly)');
            return streamResult.toTextStreamResponse();
        }

        console.error("StreamText Result missing standard stream methods. Keys:", Object.keys(streamResult));
        throw new Error('AI SDK Compatibility: No valid stream response method found.');

    } catch (error) {
        console.error("Chat API Error:", error);
        console.error("Note: This often indicates MISSING AWS CREDENTIALS or Invalid Region.");
        if (JSON.stringify(error).includes("CredentialsProviderError")) {
            return new Response(JSON.stringify({
                error: 'Configuration Error',
                details: 'AWS Credentials Missing',
                hint: "Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env.local"
            }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            error: 'Internal Server Error',
            details: String(error)
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}
