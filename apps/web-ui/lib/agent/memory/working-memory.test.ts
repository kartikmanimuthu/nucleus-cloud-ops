import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { workingMemoryEnabled, tokenBudget, keepRecent } from './working-memory';

describe('working-memory config', () => {
    const saved = { ...process.env };
    afterEach(() => { process.env = { ...saved }; });

    it('defaults: enabled=true, budget=60000, keep=8', () => {
        delete process.env.WORKING_MEMORY_ENABLED;
        delete process.env.WORKING_MEMORY_TOKEN_BUDGET;
        delete process.env.WORKING_MEMORY_KEEP_RECENT;
        expect(workingMemoryEnabled()).toBe(true);
        expect(tokenBudget()).toBe(60000);
        expect(keepRecent()).toBe(8);
    });

    it('WORKING_MEMORY_ENABLED=false disables', () => {
        process.env.WORKING_MEMORY_ENABLED = 'false';
        expect(workingMemoryEnabled()).toBe(false);
    });

    it('reads numeric overrides', () => {
        process.env.WORKING_MEMORY_TOKEN_BUDGET = '30000';
        process.env.WORKING_MEMORY_KEEP_RECENT = '4';
        expect(tokenBudget()).toBe(30000);
        expect(keepRecent()).toBe(4);
    });
});
