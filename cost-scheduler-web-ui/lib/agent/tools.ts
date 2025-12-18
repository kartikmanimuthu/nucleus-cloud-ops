import { z } from 'zod';
import { tool } from 'ai';
import { executeCodeInSandbox } from './sandbox'; // Ensure this path matches your project

export const agentTools = {
    execute_javascript: tool({
        description: 'Execute JavaScript code in a secure sandbox. Use this to fetch data from AWS.',
        parameters: z.object({
            code: z.string().describe('The JavaScript code to execute')
        }),
        execute: async ({ code }: { code: string }) => {
            console.log("Executing Agent Code:\n", code);
            try {
                return await executeCodeInSandbox(code);
            } catch (error: any) {
                console.error("Sandbox Execution Error:", error);
                throw error; // Re-throw to let the AI SDK handle it, or return a string if we want the agent to see it. 
                // For now, re-throwing might be safer for debugging, or return string.
                // Let's return the string error so the model can self-correct.
                return `Error: ${error.message}`;
            }
        },
    }),
};