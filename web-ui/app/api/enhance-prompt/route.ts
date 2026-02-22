import { NextResponse } from 'next/server';
import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function POST(req: Request) {
    try {
        const { prompt, model } = await req.json();

        if (!prompt) {
            return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
        }

        // Initialize Bedrock Client
        const llm = new ChatBedrockConverse({
            region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
            model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', // Force Haiku for speed
            maxTokens: 512,
            temperature: 0.5, // Less creative, more concise
        });

        const systemPrompt = new SystemMessage(
            `You are an expert prompt engineer for an advanced AI DevOps Agent.
Your task is to take a user's rough or brief prompt and enhance it into a clear, structured prompt that provides excellent context to the LLM.

IMPORTANT INSTRUCTIONS:
- Keep the enhanced prompt VERY SHORT and concise. Do NOT generate a massive list of requirements or verbose explanations. 
- Identify the core intent and clarify it briefly.
- Do NOT answer the prompt. ONLY output the enhanced prompt text itself. Do not include introductory or concluding remarks.`
        );

        const userMessage = new HumanMessage(`Here is the user's rough prompt to enhance:
<rough_prompt>
${prompt}
</rough_prompt>

Please provide the enhanced version.`);

        const response = await llm.invoke([systemPrompt, userMessage]);

        let enhancedPrompt = "";
        if (typeof response.content === "string") {
            enhancedPrompt = response.content;
        } else {
            enhancedPrompt = JSON.stringify(response.content);
        }

        // Clean up if the model included <enhanced_prompt> tags anyway
        enhancedPrompt = enhancedPrompt.replace(/<enhanced_prompt>/g, '').replace(/<\/enhanced_prompt>/g, '').trim();

        return NextResponse.json({ enhancedPrompt });

    } catch (error) {
        console.error('[Enhance Prompt API Error]:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500 }
        );
    }
}
