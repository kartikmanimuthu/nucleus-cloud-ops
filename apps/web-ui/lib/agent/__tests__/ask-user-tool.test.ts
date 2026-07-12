import { describe, it, expect } from 'vitest';
import { askUserTool } from '@/lib/agent/tools';

describe('askUserTool', () => {
    it('is registered under the exact name ask_user', () => {
        expect(askUserTool.name).toBe('ask_user');
    });

    it('returns a no-answer sentinel if it ever executes directly', async () => {
        // The approval_gate interrupt normally intercepts ask_user before execution;
        // direct execution means no answer was provided — the model must not invent one.
        const out = await askUserTool.invoke({ question: 'Which instance?', options: ['a', 'b'] });
        expect(String(out)).toContain('No answer was provided');
    });
});
