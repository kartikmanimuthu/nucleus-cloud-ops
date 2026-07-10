import { describe, it, expect } from 'vitest';
import { getProviderConfig, isConnectorProvider } from '@/lib/connectors/providers';

describe('providers', () => {
    it('exposes jira/slack/google configs', () => {
        expect(getProviderConfig('jira').authorizeUrl).toContain('auth.atlassian.com');
        expect(getProviderConfig('google').authorizeUrl).toContain('accounts.google.com');
        expect(getProviderConfig('slack').authorizeUrl).toContain('slack.com');
        expect(getProviderConfig('google').scopes).toContain('https://www.googleapis.com/auth/calendar');
    });
    it('throws on unknown provider', () => {
        expect(() => getProviderConfig('bad')).toThrow();
    });
    it('narrows valid providers', () => {
        expect(isConnectorProvider('jira')).toBe(true);
        expect(isConnectorProvider('nope')).toBe(false);
    });
});
