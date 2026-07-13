import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { extractTextContent } from '@/lib/agent/agent-shared';
import { buildReflectionPrompt } from '../prompts';
import { type TextToSQLState, requireModelConfig } from '../state';
import { createAgentModels } from '@/lib/agent/model-factory';

export async function reflectNode(state: TextToSQLState): Promise<Partial<TextToSQLState>> {
    const newIteration = state.iteration + 1;

    // If there was a SQL error, don't need LLM to tell us it failed
    if (state.sqlError) {
        console.log(`[TextToSQL] Reflect: SQL error detected, iteration ${newIteration}/${state.maxIterations}`);
        if (newIteration >= state.maxIterations) {
            return { satisfied: true, iteration: newIteration, reflectionFeedback: '' };
        }
        return {
            satisfied: false,
            iteration: newIteration,
            reflectionFeedback: `SQL error: ${state.sqlError}. Please fix the query.`,
        };
    }

    const model = createAgentModels({ ...requireModelConfig(state), maxTokens: 1024 }).reflector;

    const prompt = buildReflectionPrompt(
        state.question,
        state.generatedSQL,
        state.sqlResult,
        state.sqlError
    );

    const response = await model.invoke([
        new SystemMessage('You are a SQL query evaluator. Respond with JSON only.'),
        new HumanMessage(prompt),
    ]);

    const content = extractTextContent(response.content);

    // Parse JSON response
    let satisfied = true;
    let feedback = '';
    try {
        // Extract JSON from response (may have surrounding text)
        const jsonMatch = content.match(/\{[\s\S]*"satisfied"[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            satisfied = parsed.satisfied === true;
            feedback = parsed.feedback || '';
        }
    } catch {
        // If parsing fails, assume satisfied
        console.warn('[TextToSQL] Failed to parse reflection response, assuming satisfied');
    }

    console.log(`[TextToSQL] Reflect: satisfied=${satisfied}, iteration=${newIteration}/${state.maxIterations}, feedback=${feedback.slice(0, 100)}`);

    // If max iterations reached, force satisfied
    if (!satisfied && newIteration >= state.maxIterations) {
        console.log(`[TextToSQL] Max iterations reached, proceeding with best result`);
        return { satisfied: true, iteration: newIteration, reflectionFeedback: '' };
    }

    return { satisfied, iteration: newIteration, reflectionFeedback: satisfied ? '' : feedback };
}
