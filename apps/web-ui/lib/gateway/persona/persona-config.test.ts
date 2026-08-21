import { describe, it, expect, afterEach } from 'vitest';
import { chatbotPersonaEnabled } from './persona-config';

afterEach(() => {
    delete process.env.CHATBOT_PERSONA_ENABLED;
    delete process.env.CHATBOT_PERSONA_CHANNELS;
});

describe('chatbotPersonaEnabled', () => {
    it('defaults to disabled for every channel (opt-in rollout)', () => {
        expect(chatbotPersonaEnabled('telegram')).toBe(false);
        expect(chatbotPersonaEnabled('slack')).toBe(false);
    });

    it('defaults to Telegram only when the global flag is on with no allowlist', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'true';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
        expect(chatbotPersonaEnabled('slack')).toBe(false);
        expect(chatbotPersonaEnabled('discord')).toBe(false);
        expect(chatbotPersonaEnabled('jira')).toBe(false);
    });

    it('accepts TRUE and 1 as the global flag', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'TRUE';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);

        process.env.CHATBOT_PERSONA_ENABLED = '1';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
    });

    it('honours an explicit allowlist', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'true';
        process.env.CHATBOT_PERSONA_CHANNELS = 'telegram,discord';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
        expect(chatbotPersonaEnabled('discord')).toBe(true);
        expect(chatbotPersonaEnabled('slack')).toBe(false);
    });

    it('trims whitespace around allowlist entries', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'true';
        process.env.CHATBOT_PERSONA_CHANNELS = ' telegram , discord ';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
        expect(chatbotPersonaEnabled('discord')).toBe(true);
    });

    it('lowercases allowlist entries', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'true';
        process.env.CHATBOT_PERSONA_CHANNELS = 'Telegram';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
    });

    it('falls back to the Telegram default when the allowlist is empty', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'true';
        process.env.CHATBOT_PERSONA_CHANNELS = '';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
        expect(chatbotPersonaEnabled('slack')).toBe(false);
    });

    it('stays disabled when the global flag is explicitly false, even with an allowlist', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'false';
        process.env.CHATBOT_PERSONA_CHANNELS = 'telegram';
        expect(chatbotPersonaEnabled('telegram')).toBe(false);
    });
});
