import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { narrationEnabled } from './narration-config';

describe('narrationEnabled', () => {
    beforeEach(() => delete process.env.NARRATION_CHANNELS);
    afterEach(() => delete process.env.NARRATION_CHANNELS);

    // A strict allowlist: an empty list allows nothing, so narration is opt-in per
    // channel and an unset variable can never silently enable it.
    it('narrates nowhere when unset', () => {
        expect(narrationEnabled('telegram')).toBe(false);
        expect(narrationEnabled('slack')).toBe(false);
        expect(narrationEnabled('discord')).toBe(false);
    });

    it('narrates nowhere when blank', () => {
        process.env.NARRATION_CHANNELS = '';
        expect(narrationEnabled('telegram')).toBe(false);
    });

    it('narrates nowhere when the value is only separators or spaces', () => {
        process.env.NARRATION_CHANNELS = ' , , ';
        expect(narrationEnabled('telegram')).toBe(false);
    });

    it('allows only the listed channels', () => {
        process.env.NARRATION_CHANNELS = 'telegram';
        expect(narrationEnabled('telegram')).toBe(true);
        expect(narrationEnabled('slack')).toBe(false);
    });

    it('allows several channels', () => {
        process.env.NARRATION_CHANNELS = 'telegram,slack';
        expect(narrationEnabled('telegram')).toBe(true);
        expect(narrationEnabled('slack')).toBe(true);
        expect(narrationEnabled('discord')).toBe(false);
    });

    it('tolerates spacing and casing', () => {
        process.env.NARRATION_CHANNELS = ' Telegram , SLACK ';
        expect(narrationEnabled('telegram')).toBe(true);
        expect(narrationEnabled('slack')).toBe(true);
    });
});
