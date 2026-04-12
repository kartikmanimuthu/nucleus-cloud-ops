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

    const wasRetried = state.iteration > 0;
    const prompt = buildSynthesisPrompt(
        state.question,
        state.generatedSQL,
        state.sqlResult,
        wasRetried
    );

    try {
        const response = await model.invoke([
            new SystemMessage('You are an AWS cloud operations assistant. Answer questions about AWS inventory resources clearly and concisely.'),
            new HumanMessage(prompt),
        ]);

        const finalAnswer = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);

        console.log(`[TextToSQL] Synthesized answer: ${finalAnswer.length} chars`);
        return { finalAnswer };
    } catch (err: unknown) {
        // Graceful degradation: return raw results as a formatted table
        console.warn(`[TextToSQL] Synthesis LLM failed, falling back to raw results: ${err instanceof Error ? err.message : err}`);
        const rows = state.sqlResult.rows.slice(0, 20);
        if (rows.length === 0) {
            return { finalAnswer: 'No matching resources found.' };
        }
        const cols = Object.keys(rows[0]);
        const header = `| ${cols.join(' | ')} |`;
        const separator = `| ${cols.map(() => '---').join(' | ')} |`;
        const body = rows.map(r => `| ${cols.map(c => String(r[c] ?? '')).join(' | ')} |`).join('\n');
        const fallback = `${header}\n${separator}\n${body}\n\n*Showing ${rows.length} of ${state.sqlResult.rowCount} results.*`;
        return { finalAnswer: fallback };
    }
}
