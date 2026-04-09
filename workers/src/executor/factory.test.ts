import { describe, it, expect } from 'vitest';
import { createExecutor } from './factory.js';
import { VerticalExecutor } from './vertical.js';
import { HorizontalExecutor } from './horizontal.js';

describe('createExecutor', () => {
    it('returns VerticalExecutor for "vertical"', () => {
        const executor = createExecutor('vertical');
        expect(executor).toBeInstanceOf(VerticalExecutor);
    });

    it('returns HorizontalExecutor for "horizontal"', () => {
        const executor = createExecutor('horizontal');
        expect(executor).toBeInstanceOf(HorizontalExecutor);
    });

    it('throws for unknown arch value', () => {
        expect(() => createExecutor('bogus')).toThrow('Unknown WORKER_ARCH: "bogus"');
    });
});
