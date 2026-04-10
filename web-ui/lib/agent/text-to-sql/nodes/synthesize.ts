import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildSynthesisPrompt } from '../prompts';
import type { TextToSQLState } from '../state';

export async function synthesizeNode(state: TextToSQLState): Promise<Partial<TextToSQLState>> {
    // If no results (all retries failed), return error message
    if (!state.sqlResult) {
        const errorMsg = state.sqlError
            ? `I wasn't able to query your inventory data. Error: ${state.sqlError}`
            : 'I wasn\'t able to find an answer to your question. Please try rephrasing it.';
        return { finalAnswer: errorMsg };
    }

    const region = process.env.AWS_REGION || 'us-east-1';
    const modelId = process.env.ASK_AI_GENERATION_MODEL || 'us.anthropic.claude-sonnet-4-6-20250514';

    const model = new ChatBedrockConverse({
        region,
        model: modelId,
        temperature: 0.1,
        maxTokens: 4096,
    });

    const wasRetried = state.iteration > 1;
    const prompt = buildSynthesisPrompt(
        state.question,
        state.generatedSQL,
        state.sqlResult,
        wasRetried
    );

    const response = await model.invoke([
        new SystemMessage('You are an AWS cloud operations assistant. Answer questions about AWS inventory resources clearly and concisely.'),
        new HumanMessage(prompt),
    ]);

    const finalAnswer = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    console.log(`[TextToSQL] Synthesized answer: ${finalAnswer.length} chars`);

    return { finalAnswer };
}
