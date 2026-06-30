import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildSQLGenerationPrompt } from '../prompts';
import { type TextToSQLState, requireModelConfig } from '../state';
import { createAgentModels } from '@/lib/agent/model-factory';

export async function generateSQLNode(state: TextToSQLState): Promise<Partial<TextToSQLState>> {
    const model = createAgentModels({ ...requireModelConfig(state), maxTokens: 1024 }).reflector;

    const systemPrompt = buildSQLGenerationPrompt(
        state.schemaDescription,
        state.sampleRows,
        state.filters
    );

    // Build user message with question + retry context
    let userContent = state.question;
    if (state.conversationHistory.length > 0) {
        const historyText = state.conversationHistory
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');
        userContent = `Conversation history:\n${historyText}\n\nCurrent question: ${state.question}`;
    }
    if (state.reflectionFeedback) {
        userContent += `\n\nPrevious attempt feedback: ${state.reflectionFeedback}`;
    }
    if (state.sqlError) {
        userContent += `\n\nPrevious SQL error: ${state.sqlError}`;
    }

    const response = await model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userContent),
    ]);

    // Extract SQL — strip markdown fences if present
    let sql = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    sql = sql.replace(/```sql\n?/gi, '').replace(/```\n?/g, '').trim();

    console.log(`[TextToSQL] Generated SQL (iteration ${state.iteration + 1}): ${sql}`);

    return { generatedSQL: sql, sqlError: null };
}
